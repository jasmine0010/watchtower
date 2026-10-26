import { useEffect, useState } from "react";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { ExpressionSpecification, Map as LibreMap, GeoJSONSource } from "maplibre-gl";
import { requestCache } from "./requestCache";
import { validScenarioResponse, type ScenarioResponse } from "./RainScenarios";
import {
  checkedFile,
  useRunoutCatalog,
  runoutLevels,
  type CompanionPin,
  type RunoutEntry,
  type RunoutState,
} from "./runout";

export type BasinMode = "likelihood" | "volume";
export type CompanionRain = {
  schemaVersion: number;
  releaseId: string;
  name: string;
  ignition: string;
  assessmentDate: string;
  publicationDate: string;
  version: string;
  sourceUrl: string;
  retrievedAt: string;
  dataClass: string;
  durationMinutes: number;
  intensityUnit: string;
  volumeUnit: string;
  steps: number[];
  bounds: [number, number, number, number];
  likelihoodBreaks: number[];
  likelihoodColors: string[];
  likelihoodLabels: string[];
  responseShares?: { likelihood: ScenarioResponse };
  volumeRamp: { value: number; label: string; color: string }[];
  initialization: { probability?: number };
  unmappedBasinIds: number[];
  basins: FeatureCollection<Polygon | MultiPolygon | null>;
};
export function basinLegend(data: CompanionRain, mode: BasinMode) {
  if (mode === "volume") return data.volumeRamp;
  return data.likelihoodColors.map((color, index) => ({
    color,
    label: data.likelihoodLabels[index],
  }));
}

export const travelColors: ExpressionSpecification = [
  "step",
  ["get", "dfsi_thr"],
  runoutLevels[0].color,
  0.3,
  runoutLevels[1].color,
  0.6,
  runoutLevels[2].color,
];

export function readCompanionRain(value: unknown, pin: CompanionPin): CompanionRain {
  const data = value as CompanionRain;
  if (
    pin.url !== `/data/runout/${pin.releaseId}-basins.json` ||
    !/^[a-f0-9]{64}$/.test(pin.sha256) ||
    data?.schemaVersion !== 1 ||
    data.releaseId !== pin.releaseId ||
    data.sourceUrl !== `https://www.sciencebase.gov/catalog/item/${pin.releaseId}` ||
    data.dataClass !== "Historical" ||
    data.durationMinutes !== 15 ||
    data.intensityUnit !== "mm/hour" ||
    data.volumeUnit !== "m3" ||
    !data.name ||
    !data.version ||
    !Number.isFinite(Date.parse(data.retrievedAt)) ||
    ![data.ignition, data.assessmentDate, data.publicationDate].every((date) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date),
    ) ||
    !Array.isArray(data.steps) ||
    !data.steps.length ||
    data.steps.some(
      (step, index) =>
        !Number.isFinite(step) || step <= 0 || (index > 0 && step <= data.steps[index - 1]),
    ) ||
    !Array.isArray(data.bounds) ||
    data.bounds.length !== 4 ||
    !data.bounds.every(Number.isFinite) ||
    data.bounds[0] >= data.bounds[2] ||
    data.bounds[1] >= data.bounds[3] ||
    !Array.isArray(data.likelihoodBreaks) ||
    !Array.isArray(data.likelihoodColors) ||
    data.likelihoodColors.length !== data.likelihoodBreaks.length + 1 ||
    data.likelihoodLabels?.length !== data.likelihoodColors.length ||
    !Array.isArray(data.volumeRamp) ||
    data.volumeRamp.length < 2 ||
    data.basins?.type !== "FeatureCollection" ||
    !data.basins.features?.length ||
    !Array.isArray(data.unmappedBasinIds)
  )
    throw new Error("Companion assessment unavailable");
  if (
    !validScenarioResponse(data.responseShares?.likelihood, data.steps) ||
    (data.responseShares &&
      data.responseShares.likelihood.topClass !== data.likelihoodLabels.at(-1))
  )
    throw new Error("Companion area shares are invalid");
  for (let index = 0; index < data.likelihoodBreaks.length; index++) {
    const threshold = data.likelihoodBreaks[index];
    if (
      !Number.isFinite(threshold) ||
      threshold <= 0 ||
      threshold >= 1 ||
      (index > 0 && threshold <= data.likelihoodBreaks[index - 1])
    )
      throw new Error("Likelihood legend is invalid");
  }
  const colors = [...data.likelihoodColors];
  for (let index = 0; index < data.volumeRamp.length; index++) {
    const band = data.volumeRamp[index];
    if (
      !Number.isFinite(band.value) ||
      band.value < 0 ||
      !band.label ||
      (index > 0 && band.value <= data.volumeRamp[index - 1].value)
    )
      throw new Error("Volume display ramp is invalid");
    colors.push(band.color);
  }
  if (colors.some((color) => !/^#[0-9a-f]{6}$/i.test(color)))
    throw new Error("Assessment color is invalid");
  const ids = new Set<number>();
  const excluded = [];
  for (const feature of data.basins.features) {
    const props = feature.properties;
    if (
      !Number.isInteger(props?.SegmentID) ||
      ids.has(props!.SegmentID) ||
      typeof props!.mapped !== "boolean"
    )
      throw new Error("Basin identity mismatch");
    ids.add(props!.SegmentID);
    for (const step of data.steps) {
      for (const prefix of ["P", "V"]) {
        const number = props![`${prefix}_${step}`];
        if (
          number !== null &&
          (!Number.isFinite(number) || number < 0 || (prefix === "P" && number > 1))
        )
          throw new Error("Basin estimate unavailable");
      }
    }
    if (!props!.mapped) {
      if (feature.geometry !== null || !props!.exclusionReason)
        throw new Error("Invalid geometry must remain unfilled");
      excluded.push(props!.SegmentID);
      continue;
    }
    const geometry = feature.geometry;
    if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type))
      throw new Error("Basin geometry unavailable");
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons)
      for (const ring of polygon) {
        if (ring.length < 4 || JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1]))
          throw new Error("Incomplete basin ring");
        for (const point of ring)
          if (
            !point.every(Number.isFinite) ||
            point[0] <= -125 ||
            point[0] >= -113 ||
            point[1] <= 32 ||
            point[1] >= 43
          )
            throw new Error("Basin coordinates unavailable");
      }
  }
  if (
    JSON.stringify(excluded.sort((a, b) => a - b)) !==
    JSON.stringify([...data.unmappedBasinIds].sort((a, b) => a - b))
  )
    throw new Error("Basin coverage mismatch");
  return data;
}

export function sameCompanionRelease(data: CompanionRain, entry: RunoutEntry) {
  return (
    data.releaseId === entry.assessmentId &&
    data.name === entry.name &&
    data.ignition === entry.ignition &&
    data.assessmentDate === entry.assessmentDate &&
    data.publicationDate === entry.publicationDate &&
    data.version === entry.assessmentVersion &&
    JSON.stringify(data.steps) === JSON.stringify(entry.intensities)
  );
}

const cache = requestCache<CompanionRain>(3);
export function useCompanionRain(pin: CompanionPin | undefined, enabled: boolean) {
  const catalog = useRunoutCatalog(0, enabled && !!pin);
  const [loaded, setLoaded] = useState<{
    url: string;
    data: CompanionRain;
  } | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (!enabled || !pin) return;
    const controller = new AbortController();
    setFailed("");
    async function load() {
      let data = cache.get(pin!.url);
      if (!data)
        data = readCompanionRain(await checkedFile(pin!.url, pin!.sha256, controller.signal), pin!);
      if (!controller.signal.aborted) {
        cache.set(pin!.url, data);
        setLoaded({ url: pin!.url, data });
      }
    }
    load().catch(() => {
      if (!controller.signal.aborted) setFailed(pin!.url);
    });
    return () => controller.abort();
  }, [pin, enabled]);
  let data = loaded?.url === pin?.url ? loaded?.data || null : null;
  let entry = catalog.entries.find((item) => item.assessmentId === pin?.releaseId) || null;
  const mismatch = !!(data && entry && !sameCompanionRelease(data, entry));
  if (mismatch) {
    data = null;
    entry = null;
  }
  return {
    data,
    entry,
    mismatch,
    failed: failed === pin?.url,
    catalogStatus: catalog.status,
  };
}
export type CompanionState = ReturnType<typeof useCompanionRain>;

export function companionColors(
  mode: BasinMode,
  intensity: number,
  data: CompanionRain,
): ExpressionSpecification {
  const field: ExpressionSpecification = [
    "get",
    `${mode === "likelihood" ? "P" : "V"}_${intensity}`,
  ];
  let colors: ExpressionSpecification;
  if (mode === "likelihood") {
    const stops: (number | string)[] = [];
    for (let index = 0; index < data.likelihoodBreaks.length; index++)
      stops.push(data.likelihoodBreaks[index], data.likelihoodColors[index + 1]);
    colors = ["step", field, data.likelihoodColors[0], ...stops] as ExpressionSpecification;
  } else {
    const stops: (number | string)[] = [];
    for (const band of data.volumeRamp) stops.push(band.value, band.color);
    colors = ["interpolate", ["linear"], field, ...stops] as ExpressionSpecification;
  }
  return ["case", ["==", field, null], "rgba(0,0,0,0)", colors] as ExpressionSpecification;
}

export function CompanionRainLayers({
  map,
  data,
  mode,
  intensity,
  runout,
}: {
  map: LibreMap;
  data: CompanionRain | null;
  mode: BasinMode;
  intensity: number | null;
  runout: RunoutState;
}) {
  useEffect(() => {
    map.addSource("companion-basins", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("companion-travel", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer(
      {
        id: "companion-fill",
        type: "fill",
        source: "companion-basins",
        filter: ["==", ["get", "mapped"], true],
        paint: { "fill-color": "transparent", "fill-opacity": 0.62 },
      },
      "perimeter",
    );
    map.addLayer(
      {
        id: "companion-lines",
        type: "line",
        source: "companion-basins",
        filter: ["==", ["get", "mapped"], true],
        paint: { "line-color": "#65736c", "line-width": 0.6 },
      },
      "perimeter",
    );

    map.addLayer(
      {
        id: "companion-travel-fill",
        type: "fill",
        source: "companion-travel",
        layout: { "fill-sort-key": ["get", "dfsi_thr"] },
        paint: {
          "fill-color": travelColors,
          "fill-opacity": 0.16,
        },
      },
      "perimeter",
    );
    map.addLayer(
      {
        id: "companion-travel-lines",
        type: "line",
        source: "companion-travel",
        layout: { "line-sort-key": ["get", "dfsi_thr"] },
        paint: {
          "line-color": travelColors,
          "line-width": 1.8,
        },
      },
      "perimeter",
    );
    return () => {
      if (!map.getStyle()) return;
      for (const id of [
        "companion-travel-lines",
        "companion-travel-fill",
        "companion-lines",
        "companion-fill",
      ])
        if (map.getLayer(id)) map.removeLayer(id);
      for (const id of ["companion-travel", "companion-basins"])
        if (map.getSource(id)) map.removeSource(id);
    };
  }, [map]);
  useEffect(() => {
    const basins: FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };
    for (const feature of data?.basins.features || []) {
      if (feature.properties?.mapped && feature.geometry)
        basins.features.push({ ...feature, geometry: feature.geometry });
    }
    (map.getSource("companion-basins") as GeoJSONSource).setData(basins);
  }, [map, data]);
  useEffect(() => {
    map.setPaintProperty(
      "companion-fill",
      "fill-color",
      intensity !== null && data ? companionColors(mode, intensity, data) : "transparent",
    );
  }, [map, data, mode, intensity]);
  useEffect(() => {
    const empty: FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };

    (map.getSource("companion-travel") as GeoJSONSource).setData(
      runout.status === "available" && runout.contours?.features[0]?.properties.I15 === intensity
        ? runout.contours
        : empty,
    );
  }, [map, intensity, runout]);
  return null;
}
