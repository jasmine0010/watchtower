import { useEffect, useRef, useState, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { WavePlace } from "./waves";
import { Icon, iconPaths } from "./Icons";
import { MapLegend } from "./MapLegend";
import { locationAccuracy, type PersonalLocation } from "./personalLocation";
import {
  addBasemap,
  boundaryLayout,
  cancelledMapRequest,
  mapLabelAnchor,
  mapPadding,
  perimeterPaint,
} from "./MapLayers";
import { mapAirReports, type ReportingArea } from "./reportingAreas";
import { aqiBands, emptyFeatures, highlightLiveFeatures } from "./wavesLive";
import { formatLaTimestamp } from "./formatLaTimestamp";
import type { ZipOutline } from "./zipOutline";
import { SmokeForecast } from "./SmokeForecast";
import { closureText, closureUncertainty, type HighwayClosure } from "./highwayClosures";
import { shelterText, type ShelterProperties } from "./redCrossShelters";
import { CameraLayer } from "./CameraLayer";
import { powerText, type PowerSnapshot } from "./powerIncidents";
import { highwayPopup } from "./HighwayClosurePanel";
import { reliefKinds, type ReliefProperties } from "./reliefCenters";
import type { PersonalDestination } from "./personalGuidance";
import type { DrivingRoute } from "./drivingRoute";
import {
  demoExtentSource,
  demoGeometrySource,
  zoneColors,
  zoneSource,
  type EvacuationZones,
} from "./evacuationZones";

type Props = {
  zipOutline: ZipOutline | null | undefined;
  personalLocation: PersonalLocation | null;
  homeLocation: [number, number] | null;
  hasUserSelectedPlace: boolean;
  choosingPin: boolean;
  onMovePin: (longitude: number, latitude: number) => void;
  demo?: boolean;
  mapRef: RefObject<maplibregl.Map | null>;
  place: WavePlace | null;
  areas: ReportingArea[];
  focusedReport: Feature | null;
  chosenDestination: PersonalDestination | null;
  drivingRoute: DrivingRoute | null;
  onClearDestination: () => void;
  airReports: FeatureCollection;
  airMonitors: FeatureCollection;
  alerts: FeatureCollection;
  available: { air: boolean; fires: boolean; alerts: boolean };
  smoke: FeatureCollection;
  smokeView: "observed" | "forecast";
  forecastRefresh: number;
  highwayClosures: HighwayClosure[];
  showHighways: boolean;
  shelters: FeatureCollection;
  showShelters: boolean;
  power: PowerSnapshot | null;
  showPower: boolean;
  showCameras: boolean;
  onCameraCount: (count: number | null) => void;
  onHeatCount: (count: number | null) => void;
  reliefCenters: FeatureCollection;
  showReliefCenters: boolean;
  evacuationZones: EvacuationZones;
  showEvacuationZones: boolean;
  now: number;
  fires: FeatureCollection;
  selectedFireId: number | null;
  smokeDate?: string;
  earlierSmoke: boolean;
  layers: Layers;
  onSelectFire: (id: number) => void;
  onClearFire: () => void;
};
export type Layers = { air: boolean; smoke: boolean; fires: boolean; heat: boolean };

async function readHeat(signal: AbortSignal) {
  const response = await fetch("/firms-viirs", { signal });
  if (!response.ok) throw new Error("NASA FIRMS VIIRS unavailable");
  const { sources } = (await response.json()) as {
    sources: { satellite: string; kml: string }[];
  };
  const features: Feature[] = [];
  for (const source of sources) {
    const document = new DOMParser().parseFromString(source.kml, "application/xml");
    const placemarks = document.getElementsByTagNameNS(
      "http://www.opengis.net/kml/2.2",
      "Placemark",
    );
    for (const placemark of Array.from(placemarks)) {
      const coordinates = placemark
        .getElementsByTagNameNS("http://www.opengis.net/kml/2.2", "coordinates")[0]
        ?.textContent?.trim()
        .split(",");
      if (!coordinates) continue;
      const longitude = Number(coordinates[0]);
      const latitude = Number(coordinates[1]);
      if (longitude < -125 || longitude > -113 || latitude < 32 || latitude > 43) continue;
      features.push({
        type: "Feature",
        properties: { satellite: source.satellite },
        geometry: { type: "Point", coordinates: [longitude, latitude] },
      });
    }
  }
  return { type: "FeatureCollection", features } as FeatureCollection;
}

function setData(map: maplibregl.Map, name: string, data: FeatureCollection) {
  (map.getSource(name) as maplibregl.GeoJSONSource).setData(data);
}
function mapColor(map: maplibregl.Map, name: string) {
  return getComputedStyle(map.getContainer()).getPropertyValue(name).trim();
}
function markerSvg(pathData: string) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  icon.append(path);
  return icon;
}

function addAqiHatch(map: maplibregl.Map) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const context = canvas.getContext("2d")!;
  context.strokeStyle = "rgba(35, 55, 48, 0.35)";
  context.lineWidth = 0.8;
  context.beginPath();
  context.moveTo(-16, 0);
  context.lineTo(16, 32);
  context.stroke();
  map.addImage("aqi-hatch", context.getImageData(0, 0, 16, 16));
}
function addRoadClosureIcons(map: maplibregl.Map) {
  const pixelRatio = 4;
  for (const [name, background, foreground] of [
    ["road-closure-reported", "#a04d37", "#fff"],
    ["road-closure-unverified", "#fff", "#a04d37"],
  ]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 24 * pixelRatio;
    const context = canvas.getContext("2d")!;
    context.scale(pixelRatio, pixelRatio);
    context.beginPath();
    context.arc(12, 12, 10.5, 0, 2 * Math.PI);
    context.fillStyle = background;
    context.fill();
    context.strokeStyle = foreground;
    context.lineWidth = 1.5;
    context.stroke();
    context.fillStyle = foreground;
    context.fillRect(11, 6, 2, 8);
    context.beginPath();
    context.arc(12, 17, 1.3, 0, 2 * Math.PI);
    context.fill();
    map.addImage(name, context.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio });
  }
}
function addFireIcon(map: maplibregl.Map) {
  const pixelRatio = 4;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 24 * pixelRatio;
  const context = canvas.getContext("2d")!;
  context.scale(pixelRatio, pixelRatio);
  const path = new Path2D(iconPaths.fire);
  context.fillStyle = mapColor(map, "--live-fire");
  context.fill(path, "evenodd");
  context.strokeStyle = "#fff";
  context.lineWidth = 1.5;
  context.stroke(path);
  map.addImage("live-fire-icon", context.getImageData(0, 0, canvas.width, canvas.height), {
    pixelRatio,
  });
}
function addLayers(map: maplibregl.Map) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150;
  addAqiHatch(map);
  addRoadClosureIcons(map);
  for (const name of [
    "reporting-area",
    "reporting-area-no-data",
    "air-monitors",
    "zip-outline",
    "smoke",
    "evacuation-zones",
    "fires",
    "fire-markers",
  ])
    map.addSource(name, { type: "geojson", data: emptyFeatures });
  map.addSource("fire-polygons", { type: "geojson", data: emptyFeatures });
  map.addSource("viirs-heat", {
    type: "geojson",
    data: emptyFeatures,
  });
  const opacity = (name: string) => Number(mapColor(map, name));
  map.addLayer({
    id: "reporting-area-no-data",
    type: "line",
    source: "reporting-area-no-data",
    layout: { ...boundaryLayout },
    paint: {
      "line-color": mapColor(map, "--live-area-outline"),
      "line-width": 0.8,
      "line-opacity": 0.4,
    },
  });
  map.addLayer({
    id: "reporting-area-fill",
    type: "fill",
    source: "reporting-area",
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": [
        "case",
        ["get", "delayed"],
        0,
        ["<=", ["get", "value"], 50],
        opacity("--live-aqi-good-opacity"),
        ["<=", ["get", "value"], 100],
        opacity("--live-aqi-moderate-opacity"),
        opacity("--live-aqi-high-opacity"),
      ],
      "fill-opacity-transition": { duration: motion },
    },
  });
  map.addLayer({
    id: "reporting-area-hatch",
    type: "fill",
    source: "reporting-area",
    paint: { "fill-pattern": "aqi-hatch", "fill-opacity": 0.16 },
  });
  map.addLayer({
    id: "reporting-area",
    type: "line",
    source: "reporting-area",
    paint: {
      "line-color": mapColor(map, "--live-area-outline"),
      "line-width": ["case", [">", ["get", "value"], 100], 1.5, 0.6],
    },
  });
  map.addLayer({
    id: "air-monitors",
    type: "circle",
    source: "air-monitors",
    paint: {
      "circle-radius": 4,
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: "smoke",
    type: "fill",
    source: "smoke",
    paint: {
      "fill-color": [
        "match",
        ["get", "density"],
        "heavy",
        mapColor(map, "--smoke-haze-heavy"),
        "light",
        mapColor(map, "--smoke-haze-light"),
        mapColor(map, "--smoke-haze-medium"),
      ],
      "fill-opacity": 0.2,
    },
  });
  map.addLayer({
    id: "smoke-highlight",
    type: "line",
    source: "smoke",
    paint: {
      "line-color": mapColor(map, "--smoke-haze-heavy"),
      "line-width": 2,
      "line-opacity": ["case", ["get", "highlighted"], 1, 0],
    },
  });
  map.addLayer({
    id: "evacuation-zone-fill",
    type: "fill",
    source: "evacuation-zones",
    layout: { visibility: "none" },
    paint: { "fill-color": ["get", "color"], "fill-opacity": 0.13 },
  });
  map.addLayer({
    id: "evacuation-zone-line",
    type: "line",
    source: "evacuation-zones",
    layout: { visibility: "none" },
    paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [2, 1.5] },
  });
  map.addLayer({
    id: "fire-fill",
    type: "fill",
    source: "fire-polygons",
    paint: {
      "fill-color": mapColor(map, "--live-fire"),
      "fill-opacity": 0.2,
    },
  });
  map.addLayer({
    id: "viirs-heat",
    type: "circle",
    source: "viirs-heat",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 3,
      "circle-color": "#e36d35",
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 0.6,
    },
  });
  map.addLayer({
    id: "fires",
    type: "line",
    source: "fires",
    layout: { ...boundaryLayout },
    paint: {
      ...perimeterPaint,
      "line-color": mapColor(map, "--live-fire"),
      "line-width": 2,
    },
  });
  addFireIcon(map);
  map.addLayer({
    id: "fire-markers",
    type: "symbol",
    source: "fire-markers",

    filter: [
      "any",
      ["get", "selected"],
      [">=", ["coalesce", ["get", "acres"], 0], ["step", ["zoom"], 100, 5, 10, 6, 1, 6.5, 0]],
    ],
    layout: {
      "icon-image": "live-fire-icon",
      "icon-size": ["+", ["get", "iconSize"], ["case", ["get", "selected"], 0.1, 0]],
      "icon-allow-overlap": true,
    },
  });
  map.addLayer({
    id: "zip-outline",
    type: "line",
    source: "zip-outline",
    layout: { ...boundaryLayout },
    paint: {
      ...perimeterPaint,
      "line-color": mapColor(map, "--live-area-outline"),
    },
  });
  map.addSource("driving-route", { type: "geojson", data: emptyFeatures });
  map.addLayer({
    id: "driving-route-casing",
    type: "line",
    source: "driving-route",
    paint: { "line-color": "#fff", "line-width": 7, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "driving-route",
    type: "line",
    source: "driving-route",
    paint: { "line-color": "#376958", "line-width": 3.5 },
  });

  map.addSource("highway-closures", { type: "geojson", data: emptyFeatures });
  map.addLayer({
    id: "highway-closure-symbols",
    type: "symbol",
    source: "highway-closures",
    layout: {
      "icon-image": [
        "case",
        ["get", "unverified"],
        "road-closure-unverified",
        "road-closure-reported",
      ],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 1],
      "icon-anchor": "center",
      "icon-allow-overlap": false,
      "icon-ignore-placement": true,
      "icon-padding": 4,
    },
  });
  const shelterPixelRatio = 4;
  const shelterCanvas = document.createElement("canvas");
  shelterCanvas.width = shelterCanvas.height = 28 * shelterPixelRatio;
  const shelterContext = shelterCanvas.getContext("2d")!;
  shelterContext.scale(shelterPixelRatio, shelterPixelRatio);
  shelterContext.fillStyle = "#fff";
  shelterContext.beginPath();
  shelterContext.arc(14, 14, 12.5, 0, 2 * Math.PI);
  shelterContext.fill();
  shelterContext.strokeStyle = "#2e6c81";
  shelterContext.lineWidth = 1.5;
  shelterContext.stroke();
  shelterContext.translate(5.4, 4);
  shelterContext.scale(0.72, 0.72);
  shelterContext.lineWidth = 2;
  shelterContext.stroke(new Path2D(iconPaths.building));
  map.addImage(
    "shelter-icon",
    shelterContext.getImageData(0, 0, shelterCanvas.width, shelterCanvas.height),
    { pixelRatio: shelterPixelRatio },
  );
  map.addSource("shelters", { type: "geojson", data: emptyFeatures });
  map.addLayer({
    id: "shelters",
    type: "symbol",
    source: "shelters",
    layout: {
      "icon-image": "shelter-icon",
      "icon-anchor": "center",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });

  const powerCanvas = document.createElement("canvas");
  powerCanvas.width = powerCanvas.height = 48;
  const powerContext = powerCanvas.getContext("2d")!;
  powerContext.scale(2, 2);
  powerContext.fillStyle = "#655080";
  powerContext.strokeStyle = "#fff";
  powerContext.lineWidth = 1.5;
  powerContext.beginPath();
  powerContext.arc(12, 12, 11, 0, 2 * Math.PI);
  powerContext.fill();
  powerContext.stroke();
  powerContext.stroke(new Path2D("M14 4 7 13h5l-2 7 7-10h-5Z"));
  map.addImage("power-icon", powerContext.getImageData(0, 0, 48, 48), { pixelRatio: 2 });
  map.addSource("power-outages", { type: "geojson", data: emptyFeatures });
  map.addLayer({
    id: "power-outages",
    type: "symbol",
    source: "power-outages",
    layout: {
      "icon-image": "power-icon",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  map.addSource("relief-centers", { type: "geojson", data: emptyFeatures });
  map.addLayer({
    id: "relief-centers",
    type: "circle",
    source: "relief-centers",
    paint: {
      "circle-radius": 7,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#fff",
      "circle-color": [
        "match",
        ["get", "kind"],
        "clean-air",
        reliefKinds[0].color,
        reliefKinds[1].color,
      ],
    },
  });
  for (const id of [
    "smoke",
    "smoke-highlight",
    "reporting-area-fill",
    "reporting-area-hatch",
    "reporting-area",
    "reporting-area-no-data",
    "fire-fill",
    "evacuation-zone-fill",
    "fires",
    "zip-outline",
    "evacuation-zone-line",
    "air-monitors",
    "driving-route-casing",
    "driving-route",
    "viirs-heat",
    "relief-centers",
    "power-outages",
    "shelters",
    "highway-closure-symbols",
    "fire-markers",
  ])
    map.moveLayer(id);
}
export function reportText(feature: Feature) {
  const p = feature.properties!;
  if (p.highwayClosure) return closureText(feature as HighwayClosure, Date.now());
  const time = new Date(p.timestamp).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  if (p.demoPM25)
    return `${p.siteName}: hourly PM2.5 ${p.pm25} µg/m³. Monitor reading, not AQI or a ZIP-wide estimate.`;
  if (p.siteName)
    return `${p.siteName}: AQI ${p.value}, ${p.category} / ${p.pollutant}. ${time}${p.delayed ? "; delayed report" : ""}. ${p.agency}. Preliminary reading at this monitor, not a ZIP-wide estimate.`;
  return `${p.area}: AQI ${p.value}, ${p.category} / ${p.pollutant}. ${time}${p.delayed ? "; delayed report" : ""}. ${p.agency}. Preliminary regional report-not uniform air quality.`;
}

function popupContent(
  title: string,
  lines: string[],
  kind: string,
  description?: string,
  boldFirstLine = false,
) {
  const content = document.createElement("section");
  content.className = `map-popup map-popup-${kind}`;
  if (description) content.setAttribute("aria-description", description);
  const heading = document.createElement("h3");
  heading.textContent = title;
  content.append(heading);
  for (const [index, line] of lines.entries()) {
    const paragraph = document.createElement("p");
    if (boldFirstLine && index === 0) {
      const strong = document.createElement("strong");
      strong.textContent = line;
      paragraph.append(strong);
    } else {
      paragraph.textContent = line;
    }
    content.append(paragraph);
  }
  return content;
}

function airPopup(feature: Feature, boundaryAvailable = true) {
  const p = feature.properties!;
  if (p.demoPM25)
    return popupContent(
      p.siteName,
      [
        `PM2.5 ${p.pm25} µg/m³`,
        "Monitor reading, not AQI or a ZIP-wide value.",
        ...(p.qualifier ? [`EPA qualifier: ${p.qualifier}.`] : []),
      ],
      "air",
    );
  const pollutant = p.pollutant === "OZONE" ? "Ozone" : p.pollutant;
  const lines = [
    `AQI ${p.value} (${p.category})`,
    `${pollutant} AQI`,
    formatLaTimestamp(p.timestamp),
  ];
  if (p.aqsPm25 !== undefined)
    lines.push(
      `EPA AQS hourly PM2.5: ${p.aqsPm25} µg/m³${p.aqsQualifier ? ` / qualifier ${p.aqsQualifier}` : ""}. Not an AQI value.`,
    );
  if (!p.siteName && !boundaryAvailable) lines.push("Area boundary unavailable.");
  return popupContent(
    p.siteName || p.area || "Air quality",
    lines,
    "air",
    reportText(feature),
    true,
  );
}

function shelterPopup(p: ShelterProperties) {
  if (p.archivedDays) return popupContent(p.name, ["Open", p.address], "shelter", shelterText(p));
  return popupContent(
    p.name,
    ["Reported open", p.address, `Updated ${formatLaTimestamp(p.updated)}`],
    "shelter",
    shelterText(p),
  );
}

function reliefPopup(p: ReliefProperties) {
  return popupContent(
    p.name,
    [
      p.address,
      ...(p.contact ? [p.contact] : []),
      ...(p.hours ? [p.hours] : []),
      ...(p.note ? [p.note] : []),
    ],
    p.kind,
  );
}

function outagePopup(feature: Feature, updated: number, now: number) {
  const p = feature.properties!;
  const utilityNames: Record<string, string> = {
    PGE: "PG&E",
    SCE: "SCE",
    SDGE: "SDG&E",
    SMUD: "SMUD",
  };
  const utility = utilityNames[p.UtilityCompany] || p.UtilityCompany || "Utility not supplied";
  const affected =
    typeof p.ImpactedCustomers === "number" && p.ImpactedCustomers >= 0
      ? `${p.ImpactedCustomers.toLocaleString()} customer accounts affected.`
      : "Affected account count not supplied.";
  const lines = [affected];
  if (now - updated > 60 * 60000) lines.push("Update delayed; current status unconfirmed.");
  if (p.OutageType === "Planned") lines.push("Planned outage reported; it may not have started.");
  lines.push(
    typeof p.EstimatedRestoreDate === "number" && p.EstimatedRestoreDate > 0
      ? `Expected to be restored by ${formatLaTimestamp(p.EstimatedRestoreDate)}.`
      : "Restoration time unknown.",
  );
  return popupContent(`${utility} / Outage reported`, lines, "power", powerText(p, updated), true);
}

export default function LiveMap(props: Props) {
  const {
    personalLocation,
    homeLocation,
    hasUserSelectedPlace,
    choosingPin,
    onMovePin,
    demo = false,
    mapRef,
    place,
    areas,
    focusedReport,
    chosenDestination,
    drivingRoute,
    onClearDestination,
    airReports,
    airMonitors,
    smoke,
    smokeView,
    forecastRefresh,
    highwayClosures,
    showHighways,
    shelters,
    showShelters,
    power,
    showPower,
    showCameras,
    onCameraCount,
    onHeatCount,
    reliefCenters,
    showReliefCenters,
    evacuationZones,
    showEvacuationZones,
    now,
    fires,
    selectedFireId,
    alerts,
    available,
    smokeDate,
    earlierSmoke,
    layers,
    onSelectFire,
    onClearFire,
  } = props;
  const container = useRef<HTMLDivElement>(null);
  const destinationMarker = useRef<maplibregl.Marker | null>(null);
  const locationPopup = useRef<maplibregl.Popup | null>(null);
  const [viirsFeatures, setViirsFeatures] = useState<FeatureCollection>(emptyFeatures);
  const [viirsStatus, setViirsStatus] = useState("checking…");
  const { zipOutline } = props;
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState("");
  const [forecastTime, setForecastTime] = useState<number | null>(null);
  function showLocationMessage(message: string, button: HTMLButtonElement) {
    const map = mapRef.current;
    if (!map) return;
    const mapBounds = map.getContainer().getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    locationPopup.current?.remove();
    locationPopup.current = new maplibregl.Popup({
      closeButton: false,
      maxWidth: "220px",
      anchor: "left",
      offset: 8,
    })
      .setLngLat(
        map.unproject([
          buttonBounds.right - mapBounds.left,
          buttonBounds.top + buttonBounds.height / 2 - mapBounds.top,
        ]),
      )
      .setText(message)
      .addTo(map);
  }
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, "relief-centers", reliefCenters);
    map.setLayoutProperty("relief-centers", "visibility", showReliefCenters ? "visible" : "none");
  }, [ready, reliefCenters, showReliefCenters]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, "evacuation-zones", evacuationZones);
    for (const id of ["evacuation-zone-fill", "evacuation-zone-line"])
      map.setLayoutProperty(id, "visibility", showEvacuationZones ? "visible" : "none");
  }, [ready, evacuationZones, showEvacuationZones]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, "shelters", shelters);
    map.setLayoutProperty("shelters", "visibility", showShelters ? "visible" : "none");
  }, [ready, shelters, showShelters]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(
      map,
      "driving-route",
      drivingRoute
        ? {
            type: "FeatureCollection",
            features: [{ type: "Feature", properties: {}, geometry: drivingRoute.path }],
          }
        : emptyFeatures,
    );
  }, [ready, drivingRoute]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, "power-outages", power?.data || emptyFeatures);
    map.setLayoutProperty("power-outages", "visibility", showPower ? "visible" : "none");
  }, [ready, power, showPower]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, "highway-closures", {
      type: "FeatureCollection",
      features: highwayClosures.map((closure) => ({
        ...closure,
        properties: {
          ...closure.properties,
          highwayId: String(closure.id),
          unverified: !!closureUncertainty(closure, now),
        },
      })),
    });
    map.setLayoutProperty(
      "highway-closure-symbols",
      "visibility",
      showHighways ? "visible" : "none",
    );
  }, [ready, highwayClosures, showHighways, now]);
  const joined = mapAirReports(areas, airReports, place?.reportingArea);
  const fireLocationOnly =
    selectedFireId !== null &&
    (!layers.fires ||
      fires.features.find((fire) => fire.properties?.OBJECTID === selectedFireId)?.properties
        ?.pointOnly);
  const reportedCodes = new Set(joined.regions.features.map((feature) => feature.id));
  const missingAreas: FeatureCollection = {
    type: "FeatureCollection",
    features: areas.filter((area) => !reportedCodes.has(area.id)),
  };
  const activeZipOutline = place && zipOutline?.zip === place.zipcode ? zipOutline : null;
  useEffect(() => {
    const map = mapRef.current;
    if (
      !ready ||
      !map ||
      !place ||
      !activeZipOutline ||
      personalLocation ||
      choosingPin ||
      selectedFireId !== null
    )
      return;
    const label = document.createElement("span");
    label.className = "map-feature-label live-zip-label";
    label.textContent = `ZIP ${place.zipcode}`;
    const marker = new maplibregl.Marker({ element: label, anchor: "center" })
      .setLngLat(activeZipOutline.point)
      .addTo(map);
    return () => {
      marker.remove();
    };
  }, [ready, place?.zipcode, activeZipOutline, personalLocation, choosingPin, selectedFireId]);
  function fitState() {
    const map = mapRef.current!;
    if (!map) return;
    map.fitBounds(
      [
        [-124.6, 32.3],
        [-114, 42.1],
      ],
      { padding: mapPadding(map.getContainer()), maxZoom: 6, duration: 0 },
    );
  }
  function fitPlace() {
    const map = mapRef.current!;
    if (!map || !place) return;
    if (activeZipOutline) {
      const geometry = activeZipOutline.geometry.features[0].geometry;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      const bounds = new maplibregl.LngLatBounds();
      for (const polygon of polygons)
        for (const ring of polygon)
          for (const coordinate of ring) bounds.extend(coordinate as [number, number]);
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, {
          padding: mapPadding(map.getContainer()),
          maxZoom: 12,
          duration: 0,
        });
        return;
      }
    }
    map.fitBounds(
      [
        [place.longitude - 0.25, place.latitude - 0.25],
        [place.longitude + 0.25, place.latitude + 0.25],
      ],
      { padding: mapPadding(map.getContainer()), maxZoom: 11, duration: 0 },
    );
  }
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      attributionControl: false,
      fadeDuration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150,
      center: [-119, 37],
      zoom: 5,
      maxZoom: 16,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#e8ede8" },
          },
        ],
      },
    });
    mapRef.current = map;
    map.on("dataloading", () => map.getContainer().removeAttribute("data-idle"));
    map.on("movestart", () => map.getContainer().removeAttribute("data-idle"));
    map.on("idle", () => map.getContainer().setAttribute("data-idle", "true"));
    map
      .getCanvas()
      .setAttribute(
        "aria-label",
        demo ? "Palisades fire demonstration map" : "California live context map",
      );
    map.on("error", (event) => {
      if (!cancelledMapRequest(event.error))
        setFailure("Map layer unavailable; source reports remain available.");
    });
    map.on("load", () => {
      addBasemap(map);

      map.setPaintProperty("usgs-topo", "raster-saturation", -0.25);
      addLayers(map);
      fitState();
      setReady(true);
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);
  useEffect(() => {
    const map = mapRef.current!;
    if (!ready || !map) return;
    setData(map, "reporting-area", joined.regions);
    setData(map, "reporting-area-no-data", missingAreas);
    setData(map, "air-monitors", airMonitors);
    setData(map, "smoke", highlightLiveFeatures(smoke, place));
    const visibleFires: FeatureCollection =
      selectedFireId === null
        ? fires
        : {
            type: "FeatureCollection",
            features: fires.features.filter((fire) => fire.properties?.OBJECTID === selectedFireId),
          };
    const mappedFires: FeatureCollection = {
      type: "FeatureCollection",
      features: visibleFires.features.filter(
        (fire) => fire.geometry?.type === "Polygon" || fire.geometry?.type === "MultiPolygon",
      ),
    };
    setData(map, "fire-polygons", highlightLiveFeatures(mappedFires, place, true));
    setData(map, "fires", highlightLiveFeatures(mappedFires, place, true));

    const fireMarkers: FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };
    for (const fire of fires.features) {
      const anchor =
        fire.geometry?.type === "Point"
          ? (fire.geometry.coordinates as [number, number])
          : mapLabelAnchor(fire);
      if (!anchor) continue;
      const reportedAcres = fire.properties?.attr_IncidentSize;
      const mappedAcres = fire.properties?.poly_GISAcres;
      const acres =
        typeof reportedAcres === "number" && reportedAcres > 0 ? reportedAcres : mappedAcres;
      const iconSize =
        typeof acres === "number" && acres > 0
          ? Math.min(1.8, Math.max(0.75, 0.75 + 0.25 * Math.log10(acres)))
          : 1;
      fireMarkers.features.push({
        type: "Feature",
        properties: {
          OBJECTID: fire.properties?.OBJECTID,
          selected: fire.properties?.OBJECTID === selectedFireId,
          acres: typeof acres === "number" && acres > 0 ? acres : null,
          iconSize,
        },
        geometry: { type: "Point", coordinates: anchor },
      });
    }
    setData(map, "fire-markers", fireMarkers);
  }, [ready, areas, airReports, airMonitors, smoke, fires, place, selectedFireId, demo]);
  useEffect(() => {
    const controller = new AbortController();
    readHeat(controller.signal)
      .then((features) => {
        setViirsFeatures(features);
        onHeatCount(features.features.length);
        setViirsStatus(
          features.features.length
            ? `${features.features.length.toLocaleString()} detections / last 24h`
            : "No detections in last 24h",
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setViirsStatus("unavailable");
          onHeatCount(null);
        }
      });
    return () => controller.abort();
  }, [onHeatCount]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setData(map, "viirs-heat", viirsFeatures);
    map.setLayoutProperty(
      "viirs-heat",
      "visibility",
      layers.heat && viirsFeatures.features.length ? "visible" : "none",
    );
  }, [ready, viirsFeatures, layers.heat]);
  useEffect(() => {
    const map = mapRef.current!;
    if (!ready || !map) return;
    setData(map, "zip-outline", activeZipOutline?.geometry || emptyFeatures);
  }, [ready, place?.zipcode, activeZipOutline]);
  useEffect(() => {
    const map = mapRef.current!;
    if (!ready || !map) return;
    for (const id of [
      "reporting-area-no-data",
      "reporting-area-fill",
      "reporting-area-hatch",
      "reporting-area",
      "air-monitors",
    ])
      map.setLayoutProperty(id, "visibility", layers.air ? "visible" : "none");
    for (const id of ["smoke", "smoke-highlight"])
      map.setLayoutProperty(
        id,
        "visibility",
        layers.smoke && smokeView === "observed" && (id === "smoke" || !demo) ? "visible" : "none",
      );
    for (const id of ["fire-fill", "fires"])
      map.setLayoutProperty(id, "visibility", layers.fires ? "visible" : "none");
    let mapLabel;
    if (demo) {
      mapLabel = "Palisades fire demonstration map";
    } else if (smokeView === "forecast") {
      mapLabel = "United States surface-smoke forecast map";
    } else {
      mapLabel = "California live context map";
    }
    map.getCanvas().setAttribute("aria-label", mapLabel);
    map.setLayoutProperty(
      "fire-markers",
      "visibility",
      layers.fires || selectedFireId !== null ? "visible" : "none",
    );
  }, [ready, layers, selectedFireId, smokeView, demo]);
  useEffect(() => {
    if (ready && selectedFireId === null) {
      if (place) fitPlace();
      else fitState();
    }
  }, [ready, place?.name, zipOutline, selectedFireId]);
  useEffect(() => {
    const map = mapRef.current;
    if (
      !ready ||
      !map ||
      !homeLocation ||
      personalLocation ||
      hasUserSelectedPlace ||
      chosenDestination ||
      selectedFireId !== null
    )
      return;
    map.flyTo({
      center: homeLocation,
      zoom: 11,
      padding: mapPadding(map.getContainer()),
      duration: 0,
    });
  }, [
    ready,
    homeLocation,
    personalLocation,
    hasUserSelectedPlace,
    chosenDestination,
    selectedFireId,
  ]);
  useEffect(() => {
    const map = mapRef.current!;
    if (!ready || !map) return;
    if (!map.getSource("personal-accuracy")) {
      map.addSource("personal-accuracy", { type: "geojson", data: emptyFeatures });
      map.addLayer(
        {
          id: "personal-accuracy",
          type: "fill",
          source: "personal-accuracy",
          paint: { "fill-color": "#356e9b", "fill-opacity": 0.12 },
        },
        "evacuation-zone-line",
      );
      map.addLayer(
        {
          id: "personal-accuracy-edge",
          type: "line",
          source: "personal-accuracy",
          paint: { "line-color": "#356e9b", "line-width": 1 },
        },
        "evacuation-zone-line",
      );
    }
    setData(map, "personal-accuracy", locationAccuracy(personalLocation));
    if (personalLocation) {
      const isPin = personalLocation.kind === "pin";
      const editable = isPin && choosingPin;
      const point: [number, number] = [personalLocation.longitude, personalLocation.latitude];
      const element = document.createElement("span");
      element.className = isPin ? "live-chosen-marker" : "live-gps-marker";
      element.setAttribute("role", editable ? "button" : "img");
      let markerLabel;
      if (editable) {
        markerLabel = "Drag location pin";
      } else if (isPin) {
        markerLabel = "Selected location pin";
      } else {
        markerLabel = "Current GPS location";
      }
      element.setAttribute("aria-label", markerLabel);
      element.tabIndex = editable ? 0 : -1;
      if (isPin) {
        const icon = markerSvg(iconPaths["map-pin"]);
        icon.setAttribute("fill", "white");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "1.8");
        element.append(icon);
      }
      const marker = new maplibregl.Marker({
        element,
        anchor: isPin ? "bottom" : "center",
        draggable: editable,
      })
        .setLngLat(point)
        .addTo(map);
      if (editable) {
        marker.on("dragend", () => {
          const point = marker.getLngLat();
          onMovePin(point.lng, point.lat);
        });
        element.addEventListener("keydown", (event) => {
          const offsets: Record<string, [number, number]> = {
            ArrowLeft: [-10, 0],
            ArrowRight: [10, 0],
            ArrowUp: [0, -10],
            ArrowDown: [0, 10],
          };
          const offset = offsets[event.key];
          if (!offset) return;
          event.preventDefault();
          event.stopPropagation();
          const pixel = map.project(marker.getLngLat());
          const point = map.unproject([pixel.x + offset[0], pixel.y + offset[1]]);
          onMovePin(point.lng, point.lat);
          requestAnimationFrame(() =>
            map
              .getContainer()
              .querySelector<HTMLElement>('[aria-label="Drag location pin"]')
              ?.focus({ preventScroll: true }),
          );
        });
      }
      return () => {
        marker.remove();
      };
    }
  }, [ready, personalLocation, choosingPin, onMovePin]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !homeLocation) return;
    const element = document.createElement("button");
    element.type = "button";
    element.className = "live-home-marker";
    element.setAttribute("aria-label", "My House");
    const icon = markerSvg(iconPaths.home);
    icon.setAttribute("aria-hidden", "true");
    element.append(icon);
    const popup = new maplibregl.Popup({ closeButton: false, maxWidth: "160px" }).setText(
      "My House",
    );
    const marker = new maplibregl.Marker({ element, anchor: "center" })
      .setLngLat(homeLocation)
      .setPopup(popup)
      .addTo(map);
    return () => {
      marker.remove();
    };
  }, [ready, homeLocation]);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !chosenDestination) return;
    const element = document.createElement("button");
    element.type = "button";
    element.className = "live-destination-marker";
    element.setAttribute("aria-label", "Chosen destination");
    const icon = markerSvg(iconPaths["map-pin"]);
    icon.setAttribute("aria-hidden", "true");
    icon.firstElementChild!.setAttribute("fill-rule", "evenodd");
    element.append(icon);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "live-destination-delete";
    removeButton.textContent = "delete";
    removeButton.addEventListener("click", onClearDestination);
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "160px",
    }).setDOMContent(removeButton);
    const marker = new maplibregl.Marker({ element, anchor: "bottom" })
      .setLngLat(chosenDestination.geometry.coordinates as [number, number])
      .setPopup(popup)
      .addTo(map);
    destinationMarker.current = marker;
    return () => {
      marker.remove();
      destinationMarker.current = null;
    };
  }, [ready, chosenDestination, onClearDestination]);
  useEffect(() => {
    const map = mapRef.current!;
    if (!ready || !map || choosingPin) return;
    const popup = new maplibregl.Popup({
      maxWidth: "320px",
      closeButton: false,
      closeOnClick: false,
      focusAfterOpen: false,
    });
    function showHighway(closure: HighwayClosure) {
      popup
        .setLngLat(closure.geometry.coordinates as [number, number])
        .setDOMContent(highwayPopup(closure, now))
        .addTo(map)
        .addClassName("live-highway-popup");
    }
    if (
      focusedReport?.geometry.type === "Point" &&
      (!focusedReport.properties?.highwayClosure || showHighways)
    ) {
      const matches = areas.filter(
        (candidate) => candidate.properties.name === focusedReport.properties?.area,
      );
      const point = focusedReport.geometry.coordinates as [number, number];
      if (focusedReport.properties?.highwayClosure) {
        const closure = highwayClosures.find((item) => item.id === focusedReport.id);
        if (closure) showHighway(closure);
      } else if (focusedReport.properties?.shelter) {
        if (showShelters)
          popup
            .setLngLat(point)
            .setDOMContent(shelterPopup(focusedReport.properties as ShelterProperties))
            .addTo(map);
      } else if (
        focusedReport.properties?.kind === "clean-air" ||
        focusedReport.properties?.kind === "cooling"
      ) {
        if (showReliefCenters)
          popup
            .setLngLat(point)
            .setDOMContent(reliefPopup(focusedReport.properties as ReliefProperties))
            .addTo(map);
      } else
        popup
          .setLngLat(point)
          .setDOMContent(airPopup(focusedReport, matches.length === 1))
          .addTo(map);
    }
    function inspect(event: maplibregl.MapMouseEvent) {
      const target = event.originalEvent.target as Element;
      if (target.closest(".maplibregl-popup")) return;
      const destinationPopup = destinationMarker.current?.getPopup();
      if (popup.isOpen() || destinationPopup?.isOpen()) {
        popup.remove();
        if (destinationPopup?.isOpen()) destinationMarker.current?.togglePopup();
        return;
      }
      if (target.closest(".maplibregl-marker")) {
        if (target.closest(".live-camera-preview")) popup.remove();
        return;
      }
      if (
        showCameras &&
        map.getLayer("camera-points") &&
        map.queryRenderedFeatures(event.point, { layers: ["camera-points"] }).length
      ) {
        popup.remove();
        return;
      }
      const features = map
        .queryRenderedFeatures(event.point, {
          layers: [
            "fire-markers",
            "highway-closure-symbols",
            "shelters",
            "power-outages",
            "relief-centers",
            "viirs-heat",
            "air-monitors",
            "evacuation-zone-fill",
            "fire-fill",
            "fires",
            "reporting-area-fill",
            "reporting-area-hatch",
          ],
        })
        .filter((feature) => {
          let radius;
          if (feature.layer.id === "shelters") {
            radius = 14;
          } else if (feature.layer.id === "power-outages") {
            radius = 11.75;
          } else if (feature.layer.id === "relief-centers") {
            radius = 8.5;
          } else {
            radius = null;
          }
          if (radius === null || feature.geometry.type !== "Point") return true;
          const center = map.project(feature.geometry.coordinates as [number, number]);
          return Math.hypot(center.x - event.point.x, center.y - event.point.y) <= radius;
        });
      if (!features.length) {
        popup.remove();
        return;
      }
      const feature =
        features.find((item) => item.layer.id === "fire-markers") ||
        features.find((item) => item.layer.id === "highway-closure-symbols") ||
        features.find((item) => item.layer.id === "shelters") ||
        features.find((item) => item.layer.id === "power-outages") ||
        features.find((item) => item.layer.id === "relief-centers") ||
        features.find((item) => item.layer.id === "evacuation-zone-fill") ||
        features.find((item) => ["fire-fill", "fires"].includes(item.layer.id)) ||
        features.find((item) => item.layer.id === "viirs-heat") ||
        features.find((item) => item.layer.id === "air-monitors") ||
        features[0];
      if (["fire-fill", "fires", "fire-markers"].includes(feature.layer.id)) {
        const id = Number(feature.properties?.OBJECTID);
        if (Number.isFinite(id)) onSelectFire(id);
        popup.remove();
        return;
      }
      const point =
        feature.geometry.type === "Point"
          ? (feature.geometry.coordinates as [number, number])
          : event.lngLat;
      popup.removeClassName("live-highway-popup");
      if (feature.layer.id === "relief-centers") {
        popup
          .setLngLat(point)
          .setDOMContent(reliefPopup(feature.properties as ReliefProperties))
          .addTo(map);
        return;
      }
      if (feature.layer.id === "shelters" || feature.layer.id === "power-outages") {
        const content =
          feature.layer.id === "shelters"
            ? shelterPopup(feature.properties as ShelterProperties)
            : outagePopup(feature, power!.updated, now);
        popup.setLngLat(point).setDOMContent(content).addTo(map);
        return;
      }
      if (feature.layer.id === "highway-closure-symbols") {
        const closure = highwayClosures.find(
          (item) => String(item.id) === feature.properties.highwayId,
        );
        if (!closure) return;
        showHighway(closure);
        return;
      }
      if (feature.layer.id === "evacuation-zone-fill") {
        const p = feature.properties;
        const archived = Boolean(p.DEMO_ARCHIVED);
        const lines = archived
          ? [p.ZONE_NAME, "Reported status. Boundary approximate."]
          : [
              p.ZONE_NAME || p.COUNTY || "Zone name not supplied",
              `Record updated ${formatLaTimestamp(p.EDIT_DATE)}. Confirm with the issuing local authority.`,
            ];
        if (!archived)
          for (const detail of [p.CRITICAL_INFO, p.PUBLIC_INFO])
            if (detail) lines.push(String(detail));
        const content = popupContent(p.STATUS, lines, "evacuation");
        const source = document.createElement("a");
        let sourceUrl;
        if (archived) {
          if (p.DEMO_RECONSTRUCTED) {
            sourceUrl = demoExtentSource;
          } else {
            sourceUrl = demoGeometrySource;
          }
        } else {
          sourceUrl = zoneSource;
        }
        source.href = sourceUrl;
        source.textContent = archived ? "County boundaries" : "Cal OES statewide layer";
        content.append(source);
        popup.setLngLat(point).setDOMContent(content).addTo(map);
        return;
      }
      const content = airPopup(feature as Feature);
      popup.setLngLat(point).setDOMContent(content).addTo(map);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") popup.remove();
    }
    function onEnter() {
      map.getCanvas().style.cursor = "pointer";
    }
    function onLeave() {
      map.getCanvas().style.cursor = "";
    }
    map.on("click", inspect);
    map.on("mouseenter", "highway-closure-symbols", onEnter);
    map.on("mouseleave", "highway-closure-symbols", onLeave);
    map.on("mouseenter", "shelters", onEnter);
    map.on("mouseleave", "shelters", onLeave);
    map.on("mouseenter", "power-outages", onEnter);
    map.on("mouseleave", "power-outages", onLeave);
    map.on("mouseenter", "relief-centers", onEnter);
    map.on("mouseleave", "relief-centers", onLeave);
    map.getContainer().addEventListener("keydown", escape);
    return () => {
      popup.remove();
      map.off("click", inspect);
      map.off("mouseenter", "highway-closure-symbols", onEnter);
      map.off("mouseleave", "highway-closure-symbols", onLeave);
      map.off("mouseenter", "shelters", onEnter);
      map.off("mouseleave", "shelters", onLeave);
      map.off("mouseenter", "power-outages", onEnter);
      map.off("mouseleave", "power-outages", onLeave);
      map.off("mouseenter", "relief-centers", onEnter);
      map.off("mouseleave", "relief-centers", onLeave);
      map.getContainer().removeEventListener("keydown", escape);
    };
  }, [
    ready,
    focusedReport,
    areas,
    onSelectFire,
    highwayClosures,
    showHighways,
    shelters,
    showShelters,
    power,
    showPower,
    showCameras,
    reliefCenters,
    showReliefCenters,
    showEvacuationZones,
    now,
    choosingPin,
  ]);

  function mapDescription() {
    if (demo)
      return `Demo map: Palisades fire, ${airReports.features.length} air quality areas, ${highwayClosures.length} highway closures, and ${shelters.features.length} open shelters. ${place?.name || "No ZIP"} selected.`;
    const mapTitle =
      smokeView === "forecast"
        ? "United States smoke forecast; California live reports"
        : "California live map";
    const fireDescription = available.fires
      ? `${fires.features.filter((fire) => fire.geometry?.type !== "Point").length} mapped fire perimeters and ${fires.features.filter((fire) => fire.geometry?.type === "Point").length} fire locations without perimeters`
      : "Fire data unavailable or loading";
    const airDescription = available.air
      ? `${airReports.features.length} reporting-area AQI readings`
      : "AQI data unavailable or loading";
    const alertDescription = available.alerts
      ? `${alerts.features.length} NWS alerts`
      : "NWS alerts unavailable or loading";
    const placeDescription = place
      ? `${place.name} selected; other data remains available.`
      : "No place selected.";
    let smokeDescription;
    if (smokeView === "forecast") {
      if (forecastTime) {
        smokeDescription = `NWS modeled surface-smoke forecast valid ${new Date(forecastTime).toISOString()}`;
      } else {
        smokeDescription = "NWS surface-smoke forecast unavailable";
      }
    } else {
      smokeDescription = `Light, medium, and heavy NOAA smoke plumes ${smokeDate ? `for ${smokeDate} UTC${earlierSmoke ? ", earlier map, not today" : ""}` : "where available"}`;
    }

    return [
      `${mapTitle}: ${fireDescription}; ${airDescription}. ${alertDescription}.`,
      placeDescription,
      `${joined.regions.features.length} verified reporting areas shaded; ${joined.points.features.length} reports without verified outlines remain available in the panel.`,
      "Reporting-area values are not uniform air quality. No AQI interpolation.",
      `${smokeDescription}.`,
      `Air ${layers.air ? "on" : "off"}, Smoke ${layers.smoke ? "on" : "off"}, Fires ${layers.fires ? "on" : "off"}, VIIRS heat ${layers.heat ? "on" : "off"} (${viirsStatus}, satellite detections).`,
    ].join(" ");
  }

  let smokeLabel;
  if (smokeView === "forecast") {
    if (forecastTime) {
      smokeLabel = "Modeled surface smoke";
    } else {
      smokeLabel = "Surface smoke forecast unavailable or loading";
    }
  } else {
    smokeLabel = "Smoke plumes";
  }
  let fireLabel;
  if (fireLocationOnly) {
    fireLabel = "Fire location";
  } else if (selectedFireId === null) {
    fireLabel = "Fire perimeter + locations";
  } else {
    fireLabel = "Fire perimeter";
  }
  return (
    <section
      className="map-section waves-live-map"
      aria-label={demo ? "Palisades fire demonstration map" : "Live context map"}
      data-smoke-view={smokeView}
      data-relief-centers={showReliefCenters ? reliefCenters.features.length : "off"}
    >
      <div className="map-frame">
        <div
          ref={container}
          className="map"
          data-ready={ready}
          role="group"
          aria-label={mapDescription()}
        />
        <div
          className="map-actions"
          role="group"
          aria-label={demo ? "Demo map navigation" : "Live map navigation"}
        >
          <button aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
            <Icon name="plus" />
          </button>
          <button aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
            <Icon name="minus" />
          </button>
          <button
            type="button"
            aria-label="Show selected location"
            onClick={(event) => {
              const map = mapRef.current;
              if (!personalLocation)
                return showLocationMessage("Set a user location first.", event.currentTarget);
              if (!map) return;
              map.flyTo({
                center: [personalLocation.longitude, personalLocation.latitude],
                zoom: 12,
                padding: mapPadding(map.getContainer()),
                duration: 0,
              });
            }}
          >
            <Icon name="map-pin" />
          </button>
          <button
            type="button"
            aria-label={homeLocation ? "My House" : "Show home location"}
            onClick={(event) => {
              if (!homeLocation)
                return showLocationMessage("Set a home location first.", event.currentTarget);
              if (selectedFireId !== null) onClearFire();
              mapRef.current?.flyTo({
                center: homeLocation,
                zoom: 12,
                padding: mapPadding(mapRef.current.getContainer()),
              });
            }}
          >
            <Icon name="home" />
          </button>
        </div>
        {failure && (
          <div className="waves-map-message fine" role="status">
            {failure}
          </div>
        )}
      </div>
      {!demo && (
        <SmokeForecast
          map={ready ? mapRef.current : null}
          active={smokeView === "forecast" && layers.smoke && selectedFireId === null}
          refresh={forecastRefresh}
          onFrame={setForecastTime}
        />
      )}
      <MapLegend>
        <CameraLayer
          map={ready ? mapRef.current : null}
          visible={showCameras}
          refresh={forecastRefresh}
          onCount={onCameraCount}
        />
        {showShelters && shelters.features.length > 0 && (
          <div className="live-legend-row live-shelter-legend">
            <span className="live-shelter-swatch" aria-hidden="true">
              <Icon name="building" />
            </span>
            <span>Open shelters</span>
          </div>
        )}
        {homeLocation && (
          <div className="live-legend-row live-home-legend">
            <Icon name="home" />
            <span>Saved home address</span>
          </div>
        )}
        {showReliefCenters &&
          reliefKinds
            .filter((band) =>
              reliefCenters.features.some((feature) => feature.properties?.kind === band.kind),
            )
            .map((band) => (
              <div key={band.kind} className="live-legend-row live-relief-legend">
                <span
                  className="live-relief-dot"
                  style={{ background: band.color }}
                  aria-hidden="true"
                />
                <span>{band.label}</span>
              </div>
            ))}
        {showPower && power && power.data.features.length > 0 && (
          <div className="live-legend-row live-power-legend">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="11" fill="#655080" stroke="#fff" strokeWidth="1.5" />
              <path d="M14 4 7 13h5l-2 7 7-10h-5Z" fill="none" stroke="#fff" strokeWidth="1.5" />
            </svg>
            <span>Power outage{now - power.updated > 60 * 60000 ? " / delayed feed" : ""}</span>
          </div>
        )}
        {showHighways && highwayClosures.length > 0 && (
          <div className="live-highway-legend">
            <div className="live-legend-row">
              <span
                className={`live-highway-dot${demo ? " is-unverified" : ""}`}
                aria-hidden="true"
              />
              <span>Highway restriction</span>
            </div>
            {!demo && (
              <div className="live-legend-row">
                <span className="live-highway-dot is-unverified" aria-hidden="true" />
                <span>Status unverified</span>
              </div>
            )}
          </div>
        )}
        {showEvacuationZones &&
          evacuationZones.features.length > 0 &&
          Object.entries(zoneColors)
            .filter(([status]) =>
              evacuationZones.features.some((feature) => feature.properties?.STATUS === status),
            )
            .map(([status, color]) => (
              <div key={status} className="live-legend-row">
                <span
                  className="live-zone-swatch"
                  style={{ borderColor: color }}
                  aria-hidden="true"
                />
                <span>{status}</span>
              </div>
            ))}
        {drivingRoute && (
          <div className="live-legend-row">
            <span className="live-route-swatch" aria-hidden="true" />
            <span>TomTom path / not evacuation-verified</span>
          </div>
        )}
        {selectedFireId === null && layers.air && (
          <>
            <div className="live-legend-row">
              <span className="live-air-swatch" aria-hidden="true" />
              <span>Air quality</span>
            </div>
            <div
              className="live-legend-scale"
              role="img"
              aria-label={`AQI colors: ${aqiBands.map((band) => band.label).join(", ")}`}
            >
              <div>
                {aqiBands.map((band) => (
                  <i key={band.label} style={{ background: band.color }} />
                ))}
              </div>
              <div className="live-legend-scale-labels">
                <span>Good</span>
                <span>Hazardous</span>
              </div>
            </div>
          </>
        )}
        {selectedFireId === null && layers.smoke && (
          <div
            className={`live-legend-row${smokeView === "forecast" ? " live-legend-forecast" : ""}`}
          >
            <span
              className="live-smoke-swatch"
              aria-hidden="true"
              title={smokeView === "observed" ? "Light, medium, and heavy smoke" : undefined}
            />
            <span>{smokeLabel}</span>
          </div>
        )}
        {(layers.fires || selectedFireId !== null) && (
          <div className="live-legend-row live-fire-legend">
            {fireLocationOnly ? (
              <Icon name="fire" />
            ) : (
              <span className="live-fire-swatch" aria-hidden="true" />
            )}
            <span>{fireLabel}</span>
          </div>
        )}
        {layers.heat && (
          <div className="live-legend-row">
            <span className="live-heat-swatch" aria-hidden="true" />
            <span>Satellite heat detections</span>
          </div>
        )}
        {selectedFireId === null && (
          <>
            {place && activeZipOutline && (
              <div className="live-legend-row">
                <span className="live-zip-swatch" aria-hidden="true" />
                <span>{`ZIP ${place.zipcode} area`}</span>
              </div>
            )}
            {place && zipOutline === null && (
              <div className="live-legend-row">
                <span>ZIP outline unavailable</span>
              </div>
            )}
          </>
        )}
      </MapLegend>
    </section>
  );
}
