import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { WavePlace } from "./waves";
import { mapLabelAnchor, mapPadding } from "./MapLayers";
import { HourlyOutlook } from "./HourlyOutlook";
import { powerLayer, usePowerIncidents } from "./powerIncidents";
import { quickMapUrl } from "./highwayClosures";
import { useHighwayClosures } from "./HighwayClosurePanel";
import { demoRoadClosures } from "./demoRoadClosures";
import { demoShelters, demoShelterSources } from "./demoShelters";
import { redCrossFinder, useRedCrossShelters } from "./redCrossShelters";
import { reliefSources, useReliefCenters } from "./reliefCenters";
import {
  demoExtentSource,
  demoGeometrySource,
  demoStatusSource,
  emptyZones,
  useEvacuationZones,
  zoneSource,
} from "./evacuationZones";
import { cameraViewer } from "./CameraLayer";
import { Icon, type IconName } from "./Icons";
import { useFirePicker } from "./useFirePicker";
import { useAccount } from "./accountContext";
import { ForYouSteps } from "./PersonalBrief";
import type { PersonalDestination } from "./personalGuidance";
import { loadDrivingRoute, type DrivingRoute } from "./drivingRoute";
import { loadHomeAddressLocation, type HomeAddressPoint } from "./homeAddressLocation";
import { usePersonalLocation, type PersonalLocation } from "./personalLocation";
import { censusZipUrl, readZipOutline, type ZipOutline } from "./zipOutline";
import {
  DemoAir,
  DemoAlerts,
  DemoFire,
  DemoSmoke,
  DemoWeather,
  demoPerimeterUrl,
  demoTime,
  useDemoEvidence,
  type DemoEvidence,
} from "./DemoEvidence";
import LiveMap, { reportText, type Layers } from "./LiveMap";
import { PlacePicker } from "./PlacePicker";
import { mergeZips, readZips } from "./zipPlaces";
import { displayFireName } from "./units";
import { formatLaTimestamp } from "./formatLaTimestamp";
import { isStackedLayout } from "./layout";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { EvidenceCard, LoadingBars, UpdateAge } from "./EvidenceCard";
import { ForecastPanel, clearWeatherCache, type WeatherState } from "./ForecastPanel";
import "./WavesPanel.css";
import {
  readReportingAreas,
  nearbyAirReports,
  reportingAreaAtPoint,
  type ReportingArea,
} from "./reportingAreas";
import {
  airNowUrl,
  monitorUrl,
  perimeterUrl,
  incidentUrl,
  airNowObservation,
  airNowDailyMaximum,
  airNowPastDates,
  airNowReportingArchiveUrl,
  type AirNowDailyReading,
  emptyFeatures,
  noaaToday,
  parseNoaaKml,
  plumeAnalysisPeriod,
  perimeterQuery,
  incidentQuery,
  loadCaliforniaIncidents,
  pointOnlyFires,
  pointDistanceKm,
  loadCaliforniaPerimeters,
  loadCaliforniaAlerts,
  alertUrl,
  californiaAirReports,
  nearbyFireKm,
  plumeCovers,
  aqiHeadline,
  aqiCategoryCounts,
  airNowForecasts,
  californiaAirMonitors,
  currentAirMonitorQuery,
  verifiedSmokeDate,
  perimeterDistanceKm,
  perimeterProximity,
  incidentDirection,
} from "./wavesLive";

type Feed<T> = {
  data: T;
  retrievedAt: string;
  sourceUrl: string;
};

function californiaDate(now: number) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
type CurrentSmoke = {
  polygons: FeatureCollection;
  dateUtc: string;
  requestedDateUtc: string;
  earlier: boolean;
  sourceUpdatedAt: string | null;
  measurementPeriod: { start: string; end: string } | null;
};

async function fetchCurrent(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Source unavailable");
  return response;
}

function useCurrentReports(
  places: WavePlace[],
  placeName: string,
  exactLocation: PersonalLocation | null,
) {
  const [refresh, setRefresh] = useState(0);
  const [air, setAir] = useState<Feed<string> | null>(null);
  const [airMonitors, setAirMonitors] = useState<Feed<FeatureCollection> | null>(null);
  const [smoke, setSmoke] = useState<Feed<CurrentSmoke> | null>(null);
  const [fires, setFires] = useState<Feed<FeatureCollection> | null>(null);
  const [incidents, setIncidents] = useState<Feed<FeatureCollection> | null>(null);
  const [alerts, setAlerts] = useState<Feed<FeatureCollection> | null>(null);
  const [pending, setPending] = useState({
    air: true,
    smoke: true,
    fires: true,
    incidents: true,
    alerts: true,
    monitors: true,
  });
  const [smokeMessage, setSmokeMessage] = useState("Unavailable");
  const [smokeCheckedAt, setSmokeCheckedAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const today = noaaToday(now);
  const place = places.find((item) => item.name === placeName) || null;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setRefresh((value) => value + 1);
    }, 300000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    function resume() {
      if (!document.hidden) {
        setNow(new Date());
        setRefresh((value) => value + 1);
      }
    }
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPending((previous) => ({ ...previous, air: true, smoke: true }));
    setSmokeMessage("Unavailable");
    setAir(null);
    setSmoke(null);
    async function loadAir() {
      try {
        const response = await fetchCurrent(airNowUrl, controller.signal);
        const data = await response.text();
        if (!controller.signal.aborted)
          setAir({
            data,
            retrievedAt: new Date().toISOString(),
            sourceUrl: airNowUrl,
          });
      } catch {
      } finally {
        if (!controller.signal.aborted) setPending((previous) => ({ ...previous, air: false }));
      }
    }
    async function loadSmoke() {
      try {
        const response = await fetch("/noaa-smoke", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
          cache: "no-store",
          credentials: "omit",
        });
        if (!response.ok) {
          if (!controller.signal.aborted && response.status === 404)
            setSmokeMessage("No NOAA file available for today or the previous two UTC days");
          throw new Error("NOAA unavailable");
        }
        const source = await response.json();
        if (!verifiedSmokeDate(source, today) || !Number.isFinite(Date.parse(source.retrievedAt)))
          throw new Error("NOAA date unavailable");
        const polygons = parseNoaaKml(source.kml);
        if (!controller.signal.aborted)
          setSmoke({
            data: {
              polygons,
              dateUtc: source.dateUtc,
              requestedDateUtc: today,
              earlier: source.dateUtc !== today,
              sourceUpdatedAt: source.sourceUpdatedAt,
              measurementPeriod: plumeAnalysisPeriod(polygons),
            },
            retrievedAt: source.retrievedAt,
            sourceUrl: source.sourceUrl,
          });
      } catch {
        if (!controller.signal.aborted)
          setSmokeMessage((previous) =>
            previous.startsWith("No NOAA file")
              ? previous
              : "Could not retrieve or read today's NOAA file; availability unverified.",
          );
      } finally {
        if (!controller.signal.aborted) {
          setSmokeCheckedAt(new Date().toISOString());
          setPending((previous) => ({ ...previous, smoke: false }));
        }
      }
    }
    void loadAir();
    void loadSmoke();
    return () => {
      controller.abort();
    };
  }, [refresh, today]);
  useEffect(() => {
    const controller = new AbortController();
    setPending((previous) => ({ ...previous, monitors: true }));
    async function loadMonitors() {
      try {
        const response = await fetchCurrent(currentAirMonitorQuery(), controller.signal);
        const data = californiaAirMonitors(await response.json());
        if (!controller.signal.aborted)
          setAirMonitors({
            data,
            retrievedAt: new Date().toISOString(),
            sourceUrl: monitorUrl,
          });
      } catch {
        if (!controller.signal.aborted) setAirMonitors(null);
      } finally {
        if (!controller.signal.aborted)
          setPending((previous) => ({ ...previous, monitors: false }));
      }
    }
    void loadMonitors();
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setPending((previous) => ({ ...previous, incidents: true }));
    async function loadIncidents() {
      try {
        const data = await loadCaliforniaIncidents(async (url) => {
          const response = await fetchCurrent(url, controller.signal);
          return response.json();
        });
        if (!controller.signal.aborted)
          setIncidents({
            data,
            retrievedAt: new Date().toISOString(),
            sourceUrl: incidentQuery(),
          });
      } catch {
        if (!controller.signal.aborted) setIncidents(null);
      } finally {
        if (!controller.signal.aborted)
          setPending((previous) => ({ ...previous, incidents: false }));
      }
    }
    void loadIncidents();
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setPending((previous) => ({ ...previous, fires: true }));
    async function loadFires() {
      const sourceUrl = perimeterQuery();
      try {
        const data = await loadCaliforniaPerimeters(async (url) => {
          const response = await fetchCurrent(url, controller.signal);
          return response.json();
        });
        if (!controller.signal.aborted)
          setFires({
            data,
            retrievedAt: new Date().toISOString(),
            sourceUrl,
          });
      } catch {
        if (!controller.signal.aborted) setFires(null);
      } finally {
        if (!controller.signal.aborted) setPending((previous) => ({ ...previous, fires: false }));
      }
    }
    void loadFires();
    return () => {
      controller.abort();
    };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setAlerts(null);
    setPending((previous) => ({ ...previous, alerts: true }));
    async function loadAlerts() {
      try {
        const data = await loadCaliforniaAlerts(async (url) => {
          const response = await fetchCurrent(url, controller.signal);
          return response.json();
        });
        if (!controller.signal.aborted)
          setAlerts({
            data,
            sourceUrl: alertUrl,
            retrievedAt: new Date().toISOString(),
          });
      } catch {
      } finally {
        if (!controller.signal.aborted) setPending((previous) => ({ ...previous, alerts: false }));
      }
    }
    loadAlerts();
    return () => controller.abort();
  }, [refresh]);
  let aqi = null;
  let pm25 = null;
  if (air && place) {
    try {
      aqi = airNowObservation(air.data, place.reportingArea, now);
    } catch {}
    try {
      pm25 = airNowObservation(air.data, place.reportingArea, now, "PM2.5");
    } catch {}
  }
  const availableSmoke = smoke?.data.requestedDateUtc === today ? smoke : null;
  const regionalAir = useMemo(
    () => (air ? californiaAirReports(air.data, now) : emptyFeatures),
    [air, now],
  );
  const overheadPoint = exactLocation || place;
  const overhead =
    availableSmoke && overheadPoint
      ? plumeCovers(availableSmoke.data.polygons, overheadPoint.longitude, overheadPoint.latitude)
      : null;
  function refreshNow() {
    setNow(new Date());
    setRefresh((value) => value + 1);
  }
  return {
    place,
    refreshNow,
    air,
    monitors: airMonitors,
    smoke: availableSmoke,
    forecasts: air && place ? airNowForecasts(air.data, place.reportingArea, now) : [],
    fires,
    incidents,
    alerts,
    regionalAir,
    pending,
    smokeMessage,
    smokeCheckedAt,
    aqi,
    pm25,
    overhead,
    today,
    refresh,
    now: now.getTime(),
  };
}

type CurrentReports = ReturnType<typeof useCurrentReports>;
export default function LivePanel({
  demo = false,
  places,
  placeName,
  weatherState,
  onWeatherState,
  onPlace,
  hasUserSelectedPlace,
  onUserSelectPlace,
}: {
  demo?: boolean;
  places: WavePlace[];
  placeName: string;
  weatherState: WeatherState;
  onWeatherState: (changes: Partial<WeatherState>) => void;
  onPlace: (name: string) => void;
  hasUserSelectedPlace: boolean;
  onUserSelectPlace: () => void;
}) {
  const { preferences, owner } = useAccount();
  const personalLocation = usePersonalLocation();
  const [homeAddressPoint, setHomeAddressPoint] = useState<HomeAddressPoint | null>(null);
  const [choosingPin, setChoosingPin] = useState(false);
  const restoredHome = useRef("");
  const [statewidePlaces, setStatewidePlaces] = useState<WavePlace[]>([]);
  const [zipLookup, setZipLookup] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/california-zip-places.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("California ZIP lookup unavailable");
        return response.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setStatewidePlaces(readZips(data));
        setZipLookup("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setZipLookup("failed");
      });
    return () => controller.abort();
  }, []);
  const allPlaces = useMemo(() => mergeZips(places, statewidePlaces), [places, statewidePlaces]);
  const homeZipPlace =
    preferences.homeLocationType === "zip"
      ? allPlaces.find((candidate) => candidate.zipcode === preferences.homeZip)
      : null;
  let homeMapLocation: HomeAddressPoint | null;
  if (preferences.homeLocationType === "address") {
    homeMapLocation = homeAddressPoint;
  } else if (homeZipPlace) {
    homeMapLocation = [homeZipPlace.longitude, homeZipPlace.latitude];
  } else {
    homeMapLocation = null;
  }
  useEffect(() => {
    const address =
      preferences.homeLocationType === "address" ? preferences.homeAddress.trim() : "";
    if (!address) {
      setHomeAddressPoint(null);
      return;
    }
    const controller = new AbortController();
    setHomeAddressPoint(null);
    loadHomeAddressLocation(address, controller.signal)
      .then((point) => {
        if (!controller.signal.aborted) setHomeAddressPoint(point);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHomeAddressPoint(null);
      });
    return () => controller.abort();
  }, [preferences.homeAddress, preferences.homeLocationType]);
  useEffect(() => {
    if (preferences.homeLocationType !== "zip" || !preferences.homeZip) return;
    const key = owner + ":" + preferences.homeZip;
    if (restoredHome.current === key || placeName) return;
    const home = allPlaces.find((place) => place.zipcode === preferences.homeZip);
    if (!home) return;
    restoredHome.current = key;
    onUserSelectPlace();
    onPlace(home.name);
  }, [
    allPlaces,
    owner,
    preferences.homeLocationType,
    preferences.homeZip,
    placeName,
    onPlace,
    onUserSelectPlace,
  ]);
  const current = useCurrentReports(allPlaces, placeName, demo ? null : personalLocation.location);
  const { evidence: demoEvidence, failed: demoFailed } = useDemoEvidence(demo);
  const currentShelters = useRedCrossShelters(current.refresh, current.now, !demo);
  const shelters = demo ? { snapshot: demoShelters, loading: false } : currentShelters;
  const power = usePowerIncidents(current.refresh);
  const [showPower, setShowPower] = useState(false);
  const [showShelters, setShowShelters] = useState(true);
  const currentHighways = useHighwayClosures(current.refresh, !demo);
  const highways = demo ? { snapshot: demoRoadClosures, loading: false } : currentHighways;
  const [showHighways, setShowHighways] = useState(false);
  const [showCameras, setShowCameras] = useState(false);
  const [cameraCount, setCameraCount] = useState<number | null>(null);
  const [heatCount, setHeatCount] = useState<number | null>(null);
  const [showReliefCenters, setShowReliefCenters] = useState(false);
  const [showEvacuationZones, setShowEvacuationZones] = useState(true);
  const [showDemoZones, setShowDemoZones] = useState(true);
  const zonesVisible = demo ? showDemoZones : showEvacuationZones;
  const evacuationZones = useEvacuationZones(!demo, current.refresh);
  const reliefCenters = useReliefCenters(true, current.refresh);
  const place = current.place;
  const liveLocation = demo ? null : personalLocation.location;
  const conditionPoint: [number, number] | null = liveLocation
    ? [liveLocation.longitude, liveLocation.latitude]
    : place
      ? [place.longitude, place.latitude]
      : null;
  const conditionLabel = liveLocation
    ? liveLocation.kind === "gps"
      ? "GPS location"
      : "Map pin"
    : place
      ? `ZIP ${place.zipcode}`
      : "selected location";
  const [zipOutline, setZipOutline] = useState<ZipOutline | null | undefined>();
  let activeZipOutline;
  if (zipOutline?.zip === place?.zipcode) {
    activeZipOutline = zipOutline;
  } else if (zipOutline === null) {
    activeZipOutline = null;
  } else {
    activeZipOutline = undefined;
  }
  useEffect(() => {
    const zip = place?.zipcode;
    setZipOutline(zip ? undefined : null);
    if (!zip || !/^\d{5}$/.test(zip)) return;
    const controller = new AbortController();
    fetch(censusZipUrl(zip), { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!controller.signal.aborted) setZipOutline(readZipOutline(data, zip));
      })
      .catch(() => {
        if (!controller.signal.aborted) setZipOutline(null);
      });
    return () => controller.abort();
  }, [place?.zipcode]);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const locationMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function closeLocationMenu(event: PointerEvent) {
      const menu = locationMenu.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    }
    document.addEventListener("pointerdown", closeLocationMenu);
    return () => document.removeEventListener("pointerdown", closeLocationMenu);
  }, []);
  const overviewCamera = useRef<maplibregl.JumpToOptions | null>(null);
  const [areas, setAreas] = useState<ReportingArea[]>([]);
  const [focusedReport, setFocusedReport] = useState<Feature | null>(null);
  const [chosenDestination, setChosenDestination] = useState<PersonalDestination | null>(null);
  const clearDestination = useCallback(() => setChosenDestination(null), []);
  const [drivingRoute, setDrivingRoute] = useState<DrivingRoute | null>(null);
  const [routeStatus, setRouteStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [selectedFireId, setSelectedFireId] = useState<number | null>(null);
  const [personalTarget, setPersonalTarget] = useState("");
  const [mapLayers, setMapLayers] = useState<Layers>({
    air: true,
    smoke: false,
    fires: true,
    heat: true,
  });
  const [smokeView, setSmokeView] = useState<"observed" | "forecast">("observed");
  useEffect(() => {
    const controller = new AbortController();
    async function loadAreas() {
      try {
        const response = await fetch("/data/airnow-reporting-areas.geojson", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          credentials: "omit",
        });
        if (!response.ok) throw new Error("Boundary unavailable");
        const checked = readReportingAreas(await response.json());
        if (!controller.signal.aborted) setAreas(checked);
      } catch {
        if (!controller.signal.aborted) setAreas([]);
      }
    }
    loadAreas();
    return () => controller.abort();
  }, []);
  const historyArea = liveLocation
    ? conditionPoint
      ? reportingAreaAtPoint(areas, conditionPoint)
      : null
    : place?.reportingArea || null;
  const fireFeatures = useMemo<FeatureCollection>(
    () =>
      demo
        ? demoEvidence?.fire || emptyFeatures
        : {
            type: "FeatureCollection",
            features: [
              ...(current.fires?.data.features || []),
              ...pointOnlyFires(
                current.fires?.data || emptyFeatures,
                current.incidents?.data || emptyFeatures,
              ).features,
            ],
          },
    [current.fires, current.incidents, demo, demoEvidence],
  );
  const selectedFire =
    fireFeatures.features.find((feature) => feature.properties?.OBJECTID === selectedFireId) ||
    null;
  let forecastPoint;
  if (selectedFire?.geometry?.type === "Point") {
    forecastPoint = selectedFire.geometry.coordinates as [number, number];
  } else if (selectedFire) {
    forecastPoint = mapLabelAnchor(selectedFire);
  } else {
    forecastPoint = null;
  }
  const layers: Layers = selectedFire
    ? { air: mapLayers.air, smoke: false, fires: true, heat: mapLayers.heat }
    : mapLayers;
  const layerChoices: (keyof Layers | "smoke-overhead" | "smoke-forecast")[] = [
    "fires",
    "air",
    "heat",
    "smoke-overhead",
    "smoke-forecast",
  ];
  let airCount;
  if (demo) {
    if (demoEvidence) {
      airCount = demoEvidence.air.features.length + demoEvidence.regionalAir.features.length;
    } else {
      airCount = "-";
    }
  } else if (current.air || current.monitors) {
    airCount = current.regionalAir.features.length + (current.monitors?.data.features.length || 0);
  } else {
    airCount = "-";
  }
  let fireCount;
  if (demo) {
    fireCount = demoEvidence?.fire.features.length ?? "-";
  } else if (current.fires || current.incidents) {
    fireCount = fireFeatures.features.length;
  } else {
    fireCount = "-";
  }
  const layerCounts = {
    air: airCount,
    smoke: demo
      ? (demoEvidence?.smoke.features.length ?? "-")
      : (current.smoke?.data.polygons.features.length ?? "-"),
    fires: fireCount,
    heat: heatCount ?? "-",
  };
  function refreshAll() {
    clearWeatherCache();
    current.refreshNow();
  }
  const showFeature = useCallback((feature: Feature) => {
    const map = mapRef.current;
    if (!map) return;
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450;
    if (feature.geometry?.type === "Point") {
      if (!feature.properties?.pointOnly) setFocusedReport(feature);
      map.flyTo({
        center: feature.geometry.coordinates as [number, number],
        zoom: 9,
        duration,
        padding: mapPadding(map.getContainer()),
      });
      if (feature.properties?.highwayClosure && isStackedLayout(map.getContainer()))
        map.getContainer().scrollIntoView({ block: "start" });
      return;
    }
    const geometry = feature.geometry;
    if (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") return;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const bounds = new maplibregl.LngLatBounds();
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const point of ring) bounds.extend(point as [number, number]);
      }
    }
    if (!bounds.isEmpty())
      map.fitBounds(bounds, {
        padding: mapPadding(map.getContainer()),
        maxZoom: 12,
        duration,
      });
  }, []);
  const selectFire = useCallback(
    (feature: Feature) => {
      const id = feature.properties?.OBJECTID;
      if (typeof id !== "number") return;
      const map = mapRef.current;
      if (selectedFireId === null && map) {
        overviewCamera.current = {
          center: map.getCenter(),
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
          padding: map.getPadding(),
        };
      }
      panelRef.current?.scrollTo(0, 0);
      setSelectedFireId(id);
      setFocusedReport(null);
      showFeature(feature);
    },
    [showFeature, selectedFireId],
  );
  const selectFireId = useCallback(
    (id: number) => {
      const feature = fireFeatures.features.find(
        (candidate) => candidate.properties?.OBJECTID === id,
      );
      if (feature) selectFire(feature);
    },
    [fireFeatures, selectFire],
  );
  function closeFire() {
    setSelectedFireId(null);
  }
  function openPersonalCard(target: string) {
    setSelectedFireId(null);
    if (target === "live-power") {
      setShowPower(true);
      setPersonalTarget("live-power-layer-toggle");
    } else setPersonalTarget(target);
  }
  useEffect(() => {
    if (selectedFireId !== null || !personalTarget) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(personalTarget);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
      setPersonalTarget("");
    });
    return () => cancelAnimationFrame(frame);
  }, [personalTarget, selectedFireId]);
  useEffect(() => {
    if (selectedFireId !== null || !overviewCamera.current) return;

    mapRef.current?.jumpTo(overviewCamera.current);
    overviewCamera.current = null;
    panelRef.current?.scrollTo(0, 0);
    if (isStackedLayout(panelRef.current)) panelRef.current?.scrollIntoView({ block: "start" });
    panelRef.current
      ?.querySelector<HTMLButtonElement>(".live-fire-search .fire-selector-trigger")
      ?.focus({ preventScroll: true });
  }, [selectedFireId]);
  function showShelter(feature: Feature) {
    setShowShelters(true);
    showFeature({
      ...feature,
      properties: { ...feature.properties, shelter: true },
    });
    if (isStackedLayout(mapRef.current?.getContainer() || null))
      mapRef.current?.getContainer().scrollIntoView({ block: "start" });
  }
  function chooseDestination(destination: PersonalDestination) {
    overviewCamera.current = null;
    setSelectedFireId(null);
    setFocusedReport(null);
    setChosenDestination(destination);
    if ("kind" in destination.properties) setShowReliefCenters(true);
    else setShowShelters(true);
    const map = mapRef.current;
    const origin = routeOrigin;
    if (map && origin) {
      const bounds = new maplibregl.LngLatBounds()
        .extend(origin)
        .extend(destination.geometry.coordinates as [number, number]);
      const safeArea = mapPadding(map.getContainer());
      const margin = 32;
      map.fitBounds(bounds, {
        padding: {
          top: safeArea.top + margin,
          right: safeArea.right + margin,
          bottom: safeArea.bottom + margin,
          left: safeArea.left + margin,
        },
        absolutePadding: true,
        maxZoom: 12,
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450,
      });
    }
    if (isStackedLayout(map?.getContainer() || null))
      map?.getContainer().scrollIntoView({ block: "start" });
  }

  const allLayersSelected =
    zonesVisible &&
    mapLayers.air &&
    mapLayers.smoke &&
    mapLayers.fires &&
    mapLayers.heat &&
    showShelters &&
    showReliefCenters &&
    showHighways &&
    showPower &&
    showCameras;
  let mapSources;
  if (demo) {
    mapSources = [
      { name: "CAL FIRE notice", href: demoStatusSource },
      { name: "Evacuation zones", href: demoGeometrySource },
      { name: "Maximum evacuation extent", href: demoExtentSource },
      { name: "Palisades progression", href: demoPerimeterUrl },
      {
        name: "U.S. EPA / AirNow",
        href: demoEvidence?.airSource || "https://files.airnowtech.org/",
      },
      { name: "NASA FIRMS", href: "https://firms.modaps.eosdis.nasa.gov/map/" },
      {
        name: "NOAA / HMS",
        href: demoEvidence?.smokeSource || "https://www.ospo.noaa.gov/products/land/hms.html",
      },
      ...demoShelterSources.map((href, index) => ({
        name: ["Cal OES / LA", "Cal OES / SoCal", "Cal OES / SoCal 2"][index],
        href,
      })),
      ...reliefSources.map((source) => ({
        name: source.name === "Statewide directory" ? "CARB" : source.name,
        href: source.page,
      })),
      { name: "Cal OES power", href: powerLayer },
      { name: "AlertCalifornia", href: cameraViewer },
    ];
  } else {
    mapSources = [
      { name: "Cal OES evacuation zones", href: zoneSource },
      { name: "NIFC / WFIGS perimeters", href: perimeterUrl },
      { name: "WFIGS incidents", href: incidentUrl },
      { name: "U.S. EPA / AirNow", href: airNowUrl },
      { name: "AirNow monitors", href: monitorUrl },
      { name: "NASA FIRMS", href: "https://firms.modaps.eosdis.nasa.gov/map/" },
      { name: "NOAA / HMS", href: "https://www.ospo.noaa.gov/products/land/hms.html" },
      {
        name: "NWS smoke forecast",
        href: "https://mapservices.weather.noaa.gov/raster/rest/services/air_quality/ndgd_smoke_sfc_1hr_avg_time/ImageServer",
      },
      { name: "Red Cross shelters", href: redCrossFinder },
      ...reliefSources.map((source) => ({
        name: source.name === "Statewide directory" ? "CARB" : source.name,
        href: source.page,
      })),
      { name: "Caltrans QuickMap", href: quickMapUrl },
      { name: "Cal OES power", href: powerLayer },
      { name: "AlertCalifornia", href: cameraViewer },
    ];
  }
  function toggleAllLayers() {
    const show = !allLayersSelected;
    setMapLayers({ air: show, smoke: show, fires: show, heat: show });
    if (demo) setShowDemoZones(show);
    else setShowEvacuationZones(show);
    setShowShelters(show);
    setShowReliefCenters(show);
    setShowHighways(show);
    setShowPower(show);
    setShowCameras(show);
  }
  let shelterCount;
  if (shelters.loading) {
    shelterCount = "-";
  } else if (shelters.snapshot) {
    shelterCount = shelters.snapshot.data.features.length;
  } else {
    shelterCount = "-";
  }
  let highwayCount;
  if (highways.loading) {
    highwayCount = "-";
  } else if (highways.snapshot) {
    highwayCount = highways.snapshot.closures.length;
  } else {
    highwayCount = "-";
  }
  let powerCount;
  if (power.loading) {
    powerCount = "-";
  } else if (power.snapshot) {
    powerCount = power.snapshot.data.features.length;
  } else {
    powerCount = "-";
  }
  const mapControls = (
    <section key="layers" className="live-map-controls" aria-labelledby="live-layer-label">
      <h3 id="live-layer-label">Map layers</h3>
      <div className="live-layer-control">
        <div className="live-layer-chips" role="group" aria-labelledby="live-layer-label">
          <button
            type="button"
            className="live-wide-layer"
            aria-pressed={zonesVisible}
            onClick={() =>
              demo ? setShowDemoZones(!showDemoZones) : setShowEvacuationZones(!showEvacuationZones)
            }
          >
            <Icon name="alert" />
            Evacuation zones
            <small title="Available zone records">
              {demo
                ? (demoEvidence?.evacuationZones.features.length ?? "-")
                : (evacuationZones.snapshot?.data.features.length ?? "-")}
            </small>
          </button>
          {layerChoices.map((layer) => {
            if (layer === "smoke-overhead" || layer === "smoke-forecast") {
              const smokeMode = layer === "smoke-overhead" ? "observed" : "forecast";
              const selected =
                layers.smoke && (demo ? smokeMode === "observed" : smokeView === smokeMode);
              return (
                <button
                  key={layer}
                  className="live-smoke-layer-choice"
                  type="button"
                  aria-pressed={selected}
                  disabled={demo && smokeMode === "forecast"}
                  title={
                    demo && smokeMode === "forecast" ? "Smoke forecast unavailable" : undefined
                  }
                  onClick={() => {
                    if (!selected) setSmokeView(smokeMode);
                    setMapLayers((previous) => ({ ...previous, smoke: !selected }));
                  }}
                >
                  <Icon name="smoke" />
                  <span>{smokeMode === "observed" ? "Smoke plumes" : "Smoke forecast"}</span>
                  <small
                    title={
                      smokeMode === "observed"
                        ? "All NOAA light, medium, and heavy smoke plume polygons; some may be outside the current map view"
                        : "No item count for this layer"
                    }
                  >
                    {smokeMode === "observed" ? layerCounts.smoke : "-"}
                  </small>
                </button>
              );
            }
            let layerTitle;
            if (layer === "heat") {
              layerTitle =
                "NASA FIRMS VIIRS S-NPP, NOAA-20 and NOAA-21 fire detections from the past 24 hours; not a fire perimeter";
            } else if (layer === "air") {
              if (demo) {
                layerTitle = `${demoEvidence?.regionalAir.features.length || 0} reporting areas and ${demoEvidence?.air.features.length || 0} monitor sites`;
              } else {
                layerTitle = `${current.regionalAir.features.length} reporting areas and ${current.monitors?.data.features.length || 0} current monitor sites`;
              }
            } else if (layer === "smoke") {
              layerTitle = "Light, medium, and heavy smoke plume polygons";
            } else {
              layerTitle = undefined;
            }
            let layerIcon: IconName;
            if (layer === "fires") {
              layerIcon = "fire";
            } else if (layer === "heat") {
              layerIcon = "weather";
            } else {
              layerIcon = layer;
            }
            let layerLabel;
            if (layer === "heat") {
              layerLabel = "Satellite heat detections";
            } else if (layer === "air") {
              layerLabel = "Air quality";
            } else {
              layerLabel = layer.charAt(0).toUpperCase() + layer.slice(1);
            }
            return (
              <button
                key={layer}
                type="button"
                aria-pressed={layers[layer]}
                title={layerTitle}
                onClick={() =>
                  setMapLayers((previous) => ({ ...previous, [layer]: !previous[layer] }))
                }
              >
                <Icon name={layerIcon} />
                {layerLabel}
                <small
                  title={layer === "heat" ? "Available satellite detections" : "Available records"}
                >
                  {layerCounts[layer]}
                </small>
              </button>
            );
          })}
          <button
            type="button"
            className="live-wide-layer"
            aria-pressed={showShelters}
            onClick={() => setShowShelters(!showShelters)}
          >
            <Icon name="building" />
            Open shelters <small title="Available shelter listings">{shelterCount}</small>
          </button>
          <button
            type="button"
            className="live-wide-layer"
            aria-pressed={showReliefCenters}
            onClick={() => setShowReliefCenters(!showReliefCenters)}
          >
            <Icon name="home" />
            Clean air and cooling centers
            <small title="Available center listings">
              {reliefCenters.loading ? "-" : (reliefCenters.snapshot?.data.features.length ?? "-")}
            </small>
          </button>
          <button
            type="button"
            className="live-wide-layer"
            aria-pressed={showHighways}
            onClick={() => setShowHighways(!showHighways)}
          >
            <Icon name="alert" />
            Highway closures <small title="Available highway restrictions">{highwayCount}</small>
          </button>
          <button
            type="button"
            className="live-wide-layer"
            id="live-power-layer-toggle"
            aria-pressed={showPower}
            onClick={() => setShowPower(!showPower)}
          >
            <Icon name="alert" />
            Power outages <small title="Available outage records">{powerCount}</small>
          </button>
          <button
            type="button"
            className="live-wide-layer"
            aria-pressed={showCameras}
            onClick={() => setShowCameras(!showCameras)}
          >
            <Icon name="camera" />
            Fire cameras
            <small title="Available camera feeds">{cameraCount ?? "-"}</small>
          </button>
          <button type="button" onClick={toggleAllLayers}>
            {allLayersSelected ? "Deselect all" : "Select all"}
          </button>
        </div>
        <p className="live-map-sources">
          Source:{" "}
          {mapSources.map((source, index) => (
            <span key={source.href}>
              {index > 0 && ", "} <a href={source.href}>{source.name}</a>
            </span>
          ))}
        </p>
      </div>
    </section>
  );
  const demoReports = demoEvidence?.regionalAir || emptyFeatures;
  const personalPoint: [number, number] | null =
    personalLocation.location
      ? [personalLocation.location.longitude, personalLocation.location.latitude]
      : place
        ? [place.longitude, place.latitude]
        : null;
  let routeOrigin: [number, number] | null;
  if (personalLocation.location) {
    routeOrigin = [personalLocation.location.longitude, personalLocation.location.latitude] as [
      number,
      number,
    ];
  } else if (hasUserSelectedPlace && place) {
    routeOrigin = [place.longitude, place.latitude] as [number, number];
  } else {
    routeOrigin = homeAddressPoint;
  }
  const originLongitude = routeOrigin?.[0];
  const originLatitude = routeOrigin?.[1];
  useEffect(() => {
    if (!chosenDestination || originLongitude === undefined || originLatitude === undefined) {
      setDrivingRoute(null);
      setRouteStatus("idle");
      return;
    }
    const controller = new AbortController();
    setDrivingRoute(null);
    setRouteStatus("loading");
    loadDrivingRoute(
      [originLongitude, originLatitude],
      chosenDestination.geometry.coordinates as [number, number],
      controller.signal,
    )
      .then((route) => {
        if (controller.signal.aborted) return;
        setDrivingRoute(route);
        setRouteStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setRouteStatus("failed");
      });
    return () => controller.abort();
  }, [chosenDestination, originLongitude, originLatitude]);
  async function requestLocation() {
    setChoosingPin(false);
    personalLocation.clear();
    const located = await personalLocation.request();
    const map = mapRef.current;
    if (!located || !map) return;
    overviewCamera.current = null;
    setSelectedFireId(null);
    setFocusedReport(null);
    map.flyTo({
      center: [located.longitude, located.latitude],
      zoom: 12,
      padding: mapPadding(map.getContainer()),
      duration: 0,
    });
    if (isStackedLayout(map.getContainer())) map.getContainer().scrollIntoView({ block: "start" });
  }
  function togglePin() {
    if (choosingPin) {
      setChoosingPin(false);
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    if (personalLocation.location?.kind !== "pin") {
      const center = map.getCenter();
      personalLocation.pin(center.lng, center.lat);
    }
    setFocusedReport(null);
    setChoosingPin(true);
    map.getContainer().scrollIntoView({ block: "start" });
  }
  const demoAqi = demoReports.features.find(
    (report) => report.properties?.area === place?.reportingArea,
  );
  let airCard;
  if (demo) {
    airCard = (
      <DemoAir key="air" evidence={demoEvidence} failed={demoFailed}>
        {demoAqi ? (
          <>
            <div className="live-headline">
              <span className="waves-aqi-dot" style={{ background: demoAqi.properties?.color }} />
              <strong>
                {demoAqi.properties?.value} ({demoAqi.properties?.category})
              </strong>
            </div>
          </>
        ) : (
          <>
            <p className="quiet-failure" role="status">
              No reporting-area AQI for this ZIP.
            </p>
          </>
        )}
        <section className="live-air-history" aria-label="Recent air quality">
          <div className="live-air-history-heading">
            <strong>Past 5 days</strong>
            <span>Daily max AQI</span>
          </div>
          <p className="quiet-failure">Daily readings unavailable.</p>
        </section>
      </DemoAir>
    );
  } else {
    airCard = (
      <AirReport
        key="air"
        current={current}
        point={conditionPoint}
        exactLocation={liveLocation !== null}
        historyArea={historyArea}
      />
    );
  }
  const smokeCard = demo ? (
    <DemoSmoke key="smoke" evidence={demoEvidence} failed={demoFailed} place={place} />
  ) : (
    <SmokeReport
      key="smoke"
      current={current}
      locationLabel={liveLocation ? "this selected location" : "this ZIP reference point"}
    />
  );
  const fireCard = demo ? (
    <DemoFire key="fires" evidence={demoEvidence} failed={demoFailed}>
      <p className="live-support">{demoEvidence?.fire.features.length || 0} across California</p>
      <FireList
        data={demoEvidence?.fire || emptyFeatures}
        place={place}
        limit={3}
        onLocate={selectFire}
        compact
        highlightNearby={false}
      />
    </DemoFire>
  ) : (
    <FireReport
      key="fires"
      current={current}
      point={conditionPoint}
      onFireSelect={selectFire}
    />
  );
  const weatherCard = demo ? (
    <>
      <DemoWeather
        key="weather"
        evidence={demoEvidence}
        failed={demoFailed}
        place={place}
        point={forecastPoint}
      />
      <DemoAlerts
        key="alerts"
        evidence={demoEvidence}
        failed={demoFailed}
        place={place}
        point={forecastPoint}
      />
    </>
  ) : (
    conditionPoint && (
      <ForecastPanel
        key="weather"
        point={conditionPoint}
        label={conditionLabel}
        state={weatherState}
        refresh={current.refresh}
        onState={onWeatherState}
      />
    )
  );
  const personalCards = [airCard, smokeCard, fireCard, weatherCard];

  return (
    <>
      <LiveMap
        zipOutline={activeZipOutline}
        personalLocation={personalLocation.location}
        homeLocation={homeMapLocation}
        hasUserSelectedPlace={hasUserSelectedPlace}
        choosingPin={choosingPin}
        onMovePin={personalLocation.pin}
        demo={demo}
        mapRef={mapRef}
        place={place}
        areas={areas}
        focusedReport={focusedReport}
        chosenDestination={chosenDestination}
        drivingRoute={drivingRoute}
        onClearDestination={clearDestination}
        airReports={demo ? demoReports : current.regionalAir}
        airMonitors={
          demo ? demoEvidence?.air || emptyFeatures : current.monitors?.data || emptyFeatures
        }
        alerts={
          demo
            ? demoEvidence?.weather.alerts || emptyFeatures
            : current.alerts?.data || emptyFeatures
        }
        available={{
          air: demo ? !!demoEvidence : !!current.air || !!current.monitors,
          fires: demo ? !!demoEvidence : !!current.fires || !!current.incidents,
          alerts: demo ? !!demoEvidence : !!current.alerts,
        }}
        smoke={
          demo
            ? demoEvidence?.smoke || emptyFeatures
            : current.smoke?.data.polygons || emptyFeatures
        }
        smokeView={demo ? "observed" : smokeView}
        forecastRefresh={current.refresh}
        highwayClosures={highways.snapshot?.closures || []}
        showHighways={showHighways}
        shelters={shelters.snapshot?.data || emptyFeatures}
        showShelters={showShelters}
        power={power.snapshot}
        showPower={showPower}
        showCameras={showCameras}
        onCameraCount={setCameraCount}
        onHeatCount={setHeatCount}
        reliefCenters={reliefCenters.snapshot?.data || emptyFeatures}
        showReliefCenters={showReliefCenters}
        evacuationZones={
          demo
            ? demoEvidence?.evacuationZones || emptyZones
            : evacuationZones.snapshot?.data || emptyZones
        }
        showEvacuationZones={zonesVisible}
        now={current.now}
        fires={fireFeatures}
        selectedFireId={selectedFire ? selectedFireId : null}
        smokeDate={demo ? "2025-01-08" : current.smoke?.data.dateUtc}
        earlierSmoke={!demo && (current.smoke?.data.earlier || false)}
        layers={layers}
        onSelectFire={selectFireId}
        onClearFire={() => {
          overviewCamera.current = null;
          setSelectedFireId(null);
        }}
      />
      <aside
        ref={panelRef}
        className="guide-panel live-panel"
        aria-label={demo ? "Palisades fire demonstration" : "Live conditions"}
      >
        <PanelResizeHandle />
        {selectedFire && (
          <button type="button" className="live-fire-back" onClick={closeFire}>
            <span aria-hidden="true">←</span> Back to map overview
          </button>
        )}
        <section className="guide-card" aria-labelledby="live-place-title">
          <LiveHeading
            demo={demo}
            current={current}
            fire={selectedFire}
            location={liveLocation}
          />
          {!selectedFire && (
            <FireSearch
              fires={fireFeatures}
              loading={current.pending.fires || current.pending.incidents}
              onSelect={selectFire}
            />
          )}
          {(!selectedFire || !place) && (
            <PlacePicker
              places={allPlaces}
              lookupStatus={zipLookup}
              value={placeName}
              onChange={(name) => {
                personalLocation.clear();
                setChoosingPin(false);
                onUserSelectPlace();
                overviewCamera.current = null;
                setSelectedFireId(null);
                onPlace(name);
              }}
            />
          )}
          {!selectedFire && (
            <div className="personal-location-actions">
              <details className="personal-menu personal-exact" ref={locationMenu}>
                <summary>Check my exact location</summary>
                <div>
                  <button
                    type="button"
                    disabled={personalLocation.loading}
                    onClick={() => {
                      if (locationMenu.current) locationMenu.current.open = false;
                      requestLocation();
                    }}
                  >
                    {personalLocation.loading ? "Finding location…" : "Use GPS"}
                  </button>
                  <button
                    type="button"
                    aria-pressed={choosingPin}
                    onClick={() => {
                      if (locationMenu.current) locationMenu.current.open = false;
                      togglePin();
                    }}
                  >
                    Place a pin
                  </button>
                </div>
              </details>
            </div>
          )}
          {!selectedFire && (
            <ForYouSteps
              demo={demo}
              zip={place?.zipcode}
              location={personalLocation}
              onRequestLocation={requestLocation}
              onRetry={demo ? () => window.location.reload() : refreshAll}
              zipOutline={activeZipOutline}
              highways={highways}
              referencePoint={personalPoint}
              shelters={shelters}
              relief={demo ? { snapshot: null, loading: false } : reliefCenters}
              onLocateDestination={(destination) => {
                overviewCamera.current = null;
                setSelectedFireId(null);
                if ("kind" in destination.properties) {
                  setShowReliefCenters(true);
                  showFeature(destination);
                } else showShelter(destination);
                if (isStackedLayout(mapRef.current?.getContainer() || null))
                  mapRef.current?.getContainer().scrollIntoView({ block: "start" });
              }}
              onChooseDestination={chooseDestination}
              drivingRoute={drivingRoute}
              routeStatus={routeStatus}
              onOpenCard={openPersonalCard}
              evacuation={{
                zones: demo
                  ? demoEvidence?.evacuationZones || emptyZones
                  : evacuationZones.snapshot?.data || emptyZones,
                loading: demo ? !demoEvidence && !demoFailed : evacuationZones.loading,
                failed: demo ? demoFailed : evacuationZones.failed,
                checkedAt: demo ? null : evacuationZones.checkedAt,
                outdated: demo ? 0 : evacuationZones.snapshot?.outdated || 0,
              }}
            />
          )}
          {selectedFire ? (
            <>
              <LiveFireCase
                fire={selectedFire}
                place={place}
                now={demo ? demoTime : current.now}
                demo={demo}
                sourceUrl={
                  demo
                    ? demoPerimeterUrl
                    : selectedFire.properties?.pointOnly
                      ? current.incidents!.sourceUrl
                      : current.fires!.sourceUrl
                }
              />
              {demo
                ? weatherCard
                : selectedFire &&
                  forecastPoint && (
                    <HourlyOutlook
                      latitude={forecastPoint[1]}
                      longitude={forecastPoint[0]}
                      label={
                        selectedFire.properties?.pointOnly
                          ? "the reported fire location"
                          : "the mapped fire boundary"
                      }
                      refresh={current.refresh}
                    />
                  )}
            </>
          ) : (
            <div className="live-reports">
              {place || liveLocation
                ? [
                    mapControls,
                    ...personalCards,
                    <NearbyAirReports
                      key="nearby"
                      point={conditionPoint!}
                      reports={demo ? demoReports : current.regionalAir}
                      sourceUrl={
                        demo
                          ? demoEvidence?.airSource || airNowUrl
                          : current.air?.sourceUrl || airNowUrl
                      }
                      sourceName="U.S. EPA / AirNow"
                      onLocate={showFeature}
                      onInspect={setFocusedReport}
                    />,
                  ]
                : [
                    mapControls,
                    <LiveOverview
                      key="overview"
                      current={current}
                      demo={demo}
                      demoEvidence={demoEvidence}
                      demoFailed={demoFailed}
                      onLocate={showFeature}
                      onFireSelect={selectFire}
                      onInspect={setFocusedReport}
                    />,
                  ]}
            </div>
          )}
        </section>
      </aside>
    </>
  );
}

function LiveOverview({
  current,
  demo,
  demoEvidence,
  demoFailed,
  onLocate,
  onFireSelect,
  onInspect,
}: {
  current: CurrentReports;
  demo: boolean;
  demoEvidence: DemoEvidence | null;
  demoFailed: boolean;
  onLocate: (feature: Feature) => void;
  onFireSelect: (feature: Feature) => void;
  onInspect: (feature: Feature | null) => void;
}) {
  const air = demo
    ? demoEvidence && { retrievedAt: new Date(demoTime).toISOString() }
    : current.air;
  const monitors = demo
    ? demoEvidence && { data: demoEvidence.air, retrievedAt: new Date(demoTime).toISOString() }
    : current.monitors;
  const regionalAir = demo ? demoEvidence?.regionalAir || emptyFeatures : current.regionalAir;
  const fires = demo
    ? demoEvidence && {
        data: demoEvidence.fire,
        sourceUrl: demoPerimeterUrl,
        retrievedAt: new Date(demoTime).toISOString(),
      }
    : current.fires;
  const pending = demo
    ? {
        ...current.pending,
        air: !demoEvidence && !demoFailed,
        monitors: !demoEvidence && !demoFailed,
        fires: !demoEvidence && !demoFailed,
      }
    : current.pending;
  const counts = aqiCategoryCounts(regionalAir);
  const countSummary = counts.map((band) => `${band.count} ${band.label}`).join(", ");
  return (
    <div className="live-reports">
      <EvidenceCard
        title="Air today"
        accessibleName="Air quality"
        id="live-air"
        icon="air"
        kind="Observed"
        className="live-card live-air"
        source={
          <a href={demo ? demoEvidence?.airSource || airNowUrl : airNowUrl}>U.S. EPA / AirNow</a>
        }
        loading={pending.air && pending.monitors}
        data={!!air || !!monitors}
      >
        {air && (
          <>
            <p className="live-headline live-state-headline">{aqiHeadline(regionalAir)}</p>
            <div
              className="live-category-bar"
              role="img"
              aria-label={countSummary || "No usable reports"}
            >
              {counts.map((band) => (
                <span
                  key={band.label}
                  style={{
                    flex: band.count,
                    backgroundColor: band.color,
                  }}
                  title={`${band.count} ${band.label}`}
                />
              ))}
            </div>
            <div className="live-category-labels">
              {counts.map((band) => (
                <span key={band.label}>
                  <i style={{ backgroundColor: band.color }} />
                  <b>{band.count}</b> {band.label}
                </span>
              ))}
            </div>
            {monitors && (
              <>
                <h4 className="live-list-title">Highest monitor readings</h4>
                <AirMonitorList
                  reports={monitors.data.features}
                  onLocate={onLocate}
                  onInspect={onInspect}
                />
              </>
            )}
          </>
        )}
        {!air && !monitors && (
          <p className="quiet-failure" role="status">
            Couldn't load air quality.
          </p>
        )}
      </EvidenceCard>
      <EvidenceCard
        title="Mapped fires"
        accessibleName="Mapped fire boundaries"
        id="live-fires"
        icon="fire"
        kind="Observed"
        className="live-card live-fires"
        source={
          <a href={fires?.sourceUrl || perimeterQuery()}>
            {demo ? "Palisades fire progression" : "NIFC / WFIGS"}
          </a>
        }
        loading={pending.fires}
        data={!!fires}
      >
        {fires ? (
          <>
            <p className="live-headline">
              <strong>{fires.data.features.length}</strong> across California
            </p>
            {fires.data.features.length ? (
              <FireList data={fires.data} place={null} onLocate={onFireSelect} limit={3} compact />
            ) : (
              <p className="live-support">None mapped in this area.</p>
            )}
          </>
        ) : (
          <p className="quiet-failure" role="status">
            Couldn't load fire boundaries.
          </p>
        )}
      </EvidenceCard>
    </div>
  );
}

function AqiChip({ report }: { report: Feature }) {
  const p = report.properties!;
  return (
    <strong
      className="live-aqi-chip"
      style={{
        background: p.demoPM25 ? "#eef3ef" : p.color,
        borderColor: p.color,
        color: p.category === "Hazardous" ? "#ffffff" : "#17251f",
      }}
    >
      {p.demoPM25 ? p.pm25 : p.value}
    </strong>
  );
}

function AirMonitorList({
  reports,
  place,
  onLocate,
  onInspect,
}: {
  reports: Feature[];
  place?: WavePlace;
  onLocate: (feature: Feature) => void;
  onInspect: (feature: Feature | null) => void;
}) {
  const ranked = place
    ? nearbyAirReports({ type: "FeatureCollection", features: reports }, place)
    : [...reports]
        .sort((first, second) => Number(second.properties?.value) - Number(first.properties?.value))
        .slice(0, 5)
        .map((report) => ({ report, distance: null }));
  return (
    <ol className="live-nearby-list live-monitor-list">
      {ranked.map(({ report, distance }) => (
        <li key={report.id}>
          <button
            aria-description={reportText(report)}
            onClick={() => onLocate(report)}
            onFocus={() => onInspect(report)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onInspect(null);
            }}
          >
            <AqiChip report={report} />
            <span>
              {report.properties?.siteName || report.properties?.area}
              <small>
                {report.properties?.demoPM25
                  ? "Hourly PM2.5 / µg/m³"
                  : `${report.properties?.pollutant} / ${report.properties?.category}`}
                {distance !== null && ` / ${distance.toFixed(1)} km`}
              </small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

type AirHistoryDay = {
  date: string;
  reading: AirNowDailyReading | null;
  unavailable: boolean;
};

function AirQualityHistory({ area, today }: { area: string; today: string }) {
  const key = `${area}:${today}`;
  const dates = useMemo(() => airNowPastDates(today), [today]);
  const [history, setHistory] = useState<{
    key: string;
    loading: boolean;
    days: AirHistoryDay[];
  } | null>(null);
  const requested = useRef("");

  useEffect(() => {
    if (requested.current === key) return;
    requested.current = key;
    const controller = new AbortController();
    setHistory({ key, loading: true, days: [] });
    Promise.all(
      dates.map(async (date, index): Promise<AirHistoryDay> => {
        const archiveDate = index === 0 ? today : dates[index - 1];
        try {
          const response = await fetchCurrent(
            airNowReportingArchiveUrl(archiveDate),
            controller.signal,
          );
          const text = await response.text();
          return {
            date,
            reading: airNowDailyMaximum(text, area, date),
            unavailable: false,
          };
        } catch {
          return { date, reading: null, unavailable: true };
        }
      }),
    ).then((days) => {
      if (!controller.signal.aborted) setHistory({ key, loading: false, days });
    });
    return () => controller.abort();
  }, [area, dates, key, today]);

  const result = history?.key === key ? history : null;
  return (
    <section className="live-air-history" aria-label="Recent air quality">
      <div className="live-air-history-heading">
        <strong>Past 5 days</strong>
        <span>Daily max AQI</span>
      </div>
      {result?.loading || !result ? (
        <LoadingBars className="compact-loading" label="Loading air-quality history" />
      ) : (
        <ol>
          {result.days.map(({ date, reading, unavailable }) => {
            const label = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
              timeZone: "America/Los_Angeles",
              month: "short",
              day: "numeric",
            });
            const status = unavailable ? "Unavailable" : "No report";
            return (
              <li
                key={date}
                aria-label={`${label}: ${reading ? `AQI ${reading.value}, ${reading.category}` : status}`}
              >
                <time dateTime={date}>{label}</time>
                {reading ? (
                  <strong style={{ backgroundColor: reading.color }}>{reading.value}</strong>
                ) : (
                  <span title={status}>-</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AirReport({
  current,
  point,
  exactLocation,
  historyArea,
}: {
  current: CurrentReports;
  point: [number, number] | null;
  exactLocation: boolean;
  historyArea: string | null;
}) {
  const { place, aqi, air, pending, monitors } = current;
  if (exactLocation) {
    const nearest =
      point && monitors
        ? nearbyAirReports(monitors.data, { longitude: point[0], latitude: point[1] })[0]
        : null;
    const monitor = nearest?.report;
    return (
      <EvidenceCard
        title="Air quality"
        id="live-air"
        icon="air"
        className="live-card live-air"
        updated={
          monitor && (
            <UpdateAge
              time={String(monitor.properties?.timestamp || "")}
              now={current.now}
              delayed={!!monitor.properties?.delayed}
            />
          )
        }
        kind="Observed"
        data={!!monitor}
        loading={!monitor && pending.monitors}
        source={<a href={monitors?.sourceUrl || monitorUrl}>U.S. EPA / AirNow</a>}
      >
        {monitor ? (
          <>
            <div className="live-headline">
              <span
                className="waves-aqi-dot"
                style={{ background: String(monitor.properties?.color || "#9aa39d") }}
              />
              <strong>
                {monitor.properties?.value} ({monitor.properties?.category})
              </strong>
            </div>
            <p className="live-support">
              {monitor.properties?.siteName} / Nearest monitor / {nearest!.distance.toFixed(1)} km
            </p>
          </>
        ) : (
          !pending.monitors && (
            <p className="quiet-failure" role="status">
              No current monitor reading near this location.
            </p>
          )
        )}
        {historyArea ? (
          <>
            <p className="live-support">Reporting area: {historyArea}</p>
            <AirQualityHistory area={historyArea} today={californiaDate(current.now)} />
          </>
        ) : (
          <p className="live-support">Five-day area history unavailable for this location.</p>
        )}
      </EvidenceCard>
    );
  }
  if (!place) return null;
  return (
    <>
      {aqi && air && (
        <EvidenceCard
          title="Air quality"
          id="live-air"
          icon="air"
          className="live-card live-air"
          updated={<UpdateAge time={aqi.timestamp} now={current.now} delayed={aqi.delayed} />}
          kind="Observed"
          source={<a href={air.sourceUrl}>U.S. EPA / AirNow</a>}
          caption={aqi.delayed ? "Delayed" : undefined}
        >
          <div className="live-headline">
            <span className="waves-aqi-dot" style={{ background: aqi.color }} />
            <strong>
              {aqi.value} ({aqi.category})
            </strong>
          </div>
          <AirQualityHistory area={aqi.area} today={californiaDate(current.now)} />
        </EvidenceCard>
      )}
      {!aqi && (
        <EvidenceCard
          title="Air quality"
          id="live-air"
          icon="air"
          className="live-card live-air"
          kind="Observed"
          data={false}
          loading={pending.air}
          source={<a href={airNowUrl}>U.S. EPA / AirNow</a>}
        >
          {!pending.air && (
            <p className="quiet-failure" role="status">
              {current.monitors?.data.features.length
                ? "No current reporting-area AQI for this ZIP; nearby monitor readings are listed below."
                : "Couldn't load air quality."}
            </p>
          )}
          <AirQualityHistory area={place.reportingArea} today={californiaDate(current.now)} />
        </EvidenceCard>
      )}
    </>
  );
}

function NearbyAirReports({
  point,
  reports,
  sourceUrl,
  sourceName,
  onLocate,
  onInspect,
}: {
  point: [number, number];
  reports: FeatureCollection;
  sourceUrl: string;
  sourceName: string;
  onLocate: (feature: Feature) => void;
  onInspect: (feature: Feature | null) => void;
}) {
  return (
    <>
      <EvidenceCard
        title="Nearby areas"
        accessibleName="Nearby reporting areas"
        kind="Observed"
        icon="air"
        className="live-card live-nearby"
        source={<a href={sourceUrl}>{sourceName}</a>}
      >
        {reports.features.length ? (
          <ol className="live-nearby-list">
            {nearbyAirReports(reports, { longitude: point[0], latitude: point[1] }).map(
              ({ report, distance }) => (
                <li key={report.id}>
                  <button
                    aria-description={`${reportText(report)} ${distance.toFixed(1)} km to representative point.`}
                    onClick={() => onLocate(report)}
                    onFocus={() => onInspect(report)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") onInspect(null);
                    }}
                  >
                    <AqiChip report={report} />
                    <span>
                      {report.properties!.area}
                      <small>
                        {report.properties!.category} / {distance.toFixed(1)} km
                      </small>
                    </span>
                  </button>
                </li>
              ),
            )}
          </ol>
        ) : (
          <p className="quiet-failure">No usable regional reports.</p>
        )}
      </EvidenceCard>
    </>
  );
}

function SmokeReport({
  current,
  locationLabel,
}: {
  current: CurrentReports;
  locationLabel: string;
}) {
  const { smoke, overhead, pending } = current;
  return (
    <>
      {smoke && overhead !== null && (
        <EvidenceCard
          title="Smoke overhead"
          id="live-smoke"
          icon="smoke"
          className="live-card live-smoke"
          updated={
            <UpdateAge
              time={smoke.data.sourceUpdatedAt || smoke.retrievedAt}
              now={current.now}
              stale={smoke.data.earlier}
            />
          }
          kind="Observed"
          source={<a href={smoke.sourceUrl}>NOAA / HMS</a>}
        >
          <p className="live-smoke-readout">
            <Icon name="smoke" />
            {overhead
              ? `Smoke plume mapped over ${locationLabel}`
              : `No smoke plume mapped over ${locationLabel}`}
          </p>
        </EvidenceCard>
      )}
      {!smoke && (
        <EvidenceCard
          title="Smoke overhead"
          id="live-smoke"
          icon="smoke"
          className="live-card live-smoke"
          kind="Observed"
          data={false}
          loading={pending.smoke}
          source={<a href="https://www.ospo.noaa.gov/products/land/hms.html">NOAA / HMS</a>}
        >
          {!pending.smoke && (
            <p className="quiet-failure" role="status">
              Couldn't load smoke. {current.smokeMessage}
            </p>
          )}
        </EvidenceCard>
      )}
    </>
  );
}

function FireReport({
  current,
  point,
  onFireSelect,
}: {
  current: CurrentReports;
  point: [number, number] | null;
  onFireSelect: (feature: Feature) => void;
}) {
  const { place, fires, pending } = current;
  if (!place && !point) return null;
  return (
    <>
      <EvidenceCard
        key={fires ? "fires-available" : "fires-unavailable"}
        title="Mapped fires"
        accessibleName="Mapped fire boundaries"
        id="live-fires"
        icon="fire"
        className="live-card live-fires"
        updated={fires && <UpdateAge time={fires.retrievedAt} now={current.now} />}
        kind="Observed"
        data={!!fires}
        loading={!fires && pending.fires}
        source={fires ? <a href={fires.sourceUrl}>NIFC / WFIGS</a> : "NIFC / WFIGS"}
      >
        {fires ? (
          <>
            <p className="live-support">{fires.data.features.length} across California</p>
            {fires.data.features.length === 0 && (
              <p className="live-support">None mapped in this area.</p>
            )}
            <FireList
              data={fires.data}
              place={place}
              point={point}
              limit={3}
              onLocate={onFireSelect}
              compact
            />
          </>
        ) : (
          !pending.fires && (
            <p className="quiet-failure" role="status">
              Couldn't load fire boundaries.
            </p>
          )
        )}
      </EvidenceCard>
    </>
  );
}

function LiveHeading({
  demo,
  current,
  fire,
  location,
}: {
  demo: boolean;
  current: CurrentReports;
  fire: Feature | null;
  location: PersonalLocation | null;
}) {
  return (
    <div className={`live-place-heading${fire ? " is-fire" : ""}`}>
      <div>
        <div className="live-place-name">
          <h2 id="live-place-title">
            {fire && <Icon name="fire" />}
            {demo && !fire && "Demo: "}
            {fire
              ? displayFireName(String(fire.properties?.poly_IncidentName || "Unnamed fire"))
              : location?.kind === "gps"
                ? "GPS location"
                : location?.kind === "pin"
                  ? "Map pin"
                  : current.place?.name || "California"}
          </h2>
          {!demo &&
            !fire &&
            current.place &&
            (location || current.place.name !== `ZIP ${current.place.zipcode}`) && (
              <small>
                {location ? `ZIP ${current.place.zipcode}` : current.place.zipcode}
              </small>
            )}
        </div>
      </div>
    </div>
  );
}

function FireSearch({
  fires,
  loading,
  onSelect,
}: {
  fires: FeatureCollection;
  loading: boolean;
  onSelect: (fire: Feature) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = fires.features
    .filter((fire) =>
      String(fire.properties?.poly_IncidentName || "")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) =>
      String(a.properties?.poly_IncidentName || "").localeCompare(
        String(b.properties?.poly_IncidentName || ""),
      ),
    );
  const visible = matches.slice(0, 50);
  const {
    open,
    setActive,
    position,
    trigger,
    searchField,
    popover,
    chosenIndex,
    openPicker,
    closePicker,
    choose,
    onSearchKey,
    onDialogKey,
  } = useFirePicker(visible, onSelect, "button");
  return (
    <div className="live-fire-search">
      <button
        ref={trigger}
        type="button"
        className="fire-selector-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (open) closePicker();
          else {
            setQuery("");
            openPicker();
          }
        }}
      >
        Find a fire <span className="fire-selector-chevron" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <>
            <div className="fire-selector-backdrop" onClick={closePicker} aria-hidden="true" />
            <div
              ref={popover}
              className="fire-selector-popover"
              role="dialog"
              aria-label="Choose a current fire"
              aria-modal="true"
              style={{ left: position.left, top: position.top, width: position.width }}
              onKeyDown={onDialogKey}
            >
              <div className="fire-selector-search-row">
                <input
                  ref={searchField}
                  id="live-fire-search"
                  role="combobox"
                  aria-label="Search current fires"
                  aria-controls="live-fire-results"
                  aria-expanded="true"
                  aria-activedescendant={
                    visible[chosenIndex] ? `live-fire-option-${chosenIndex}` : undefined
                  }
                  type="search"
                  placeholder="Search fires by name"
                  autoComplete="off"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onSearchKey}
                />
                <button
                  type="button"
                  className="fire-selector-close"
                  aria-label="Close fire selector"
                  onClick={closePicker}
                >
                  <Icon name="close" />
                </button>
              </div>
              <p className="fire-selector-count" role="status" aria-live="polite">
                {visible.length} of {matches.length}
              </p>
              <div
                id="live-fire-results"
                className="fire-selector-results"
                role="listbox"
                aria-label="Current fire results"
              >
                {visible.map((fire, index) => (
                  <button
                    key={fire.properties?.OBJECTID}
                    id={`live-fire-option-${index}`}
                    className="fire-selector-option live-fire-option"
                    type="button"
                    role="option"
                    aria-selected="false"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(fire)}
                  >
                    <span>
                      <strong>
                        {displayFireName(
                          String(fire.properties?.poly_IncidentName || "Unnamed fire"),
                        )}
                      </strong>
                      {fire.properties?.attr_POOCounty && (
                        <small>{String(fire.properties.attr_POOCounty)}</small>
                      )}
                    </span>
                  </button>
                ))}
                {visible.length === 0 && (
                  <p className="fire-selector-empty">
                    {loading ? "Loading fires…" : "No current fire matches."}
                  </p>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

function incidentAge(value: unknown, now: number) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const elapsed = now - new Date(value).valueOf();
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function LiveFireCase({
  fire,
  place,
  now,
  demo = false,
  sourceUrl,
}: {
  fire: Feature;
  place: WavePlace | null;
  now: number;
  demo?: boolean;
  sourceUrl: string;
}) {
  const data = fire.properties || {};
  const pointOnly = data.pointOnly === true;
  const reportedAcres =
    typeof data.attr_IncidentSize === "number" && data.attr_IncidentSize >= 0
      ? data.attr_IncidentSize
      : null;
  const mappedAcres =
    typeof data.poly_GISAcres === "number" && data.poly_GISAcres >= 0 ? data.poly_GISAcres : null;
  const displayedAcres = reportedAcres ?? mappedAcres;
  const containment =
    typeof data.attr_PercentContained === "number" &&
    data.attr_PercentContained >= 0 &&
    data.attr_PercentContained <= 100
      ? data.attr_PercentContained
      : null;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const date = (value: unknown) => {
    const formatted = value ? formatLaTimestamp(value) : "Not supplied";
    return formatted === "Not supplied" ? null : formatted;
  };
  const count = (value: unknown) =>
    typeof value === "number" && value >= 0 ? value.toLocaleString() : null;
  let proximity;
  if (place && fire.geometry) {
    if (pointOnly && fire.geometry.type === "Point") {
      proximity = {
        distanceKm: pointDistanceKm(fire.geometry.coordinates as [number, number], [
          place.longitude,
          place.latitude,
        ]),
        point: fire.geometry.coordinates as [number, number],
      };
    } else {
      proximity = perimeterProximity(fire.geometry, [place.longitude, place.latitude]);
    }
  } else {
    proximity = null;
  }
  const direction =
    place && proximity && proximity.distanceKm > 0
      ? incidentDirection([place.longitude, place.latitude], proximity.point)
      : null;
  const miles = proximity ? proximity.distanceKm / 1.609344 : null;
  let distanceLabel = null;
  if (miles === 0)
    distanceLabel = pointOnly
      ? "Reported near your selected place"
      : "Your selected place is inside the mapped perimeter";
  else if (miles !== null && direction && place) {
    const rounded = Math.round(miles);
    let distance;
    if (miles < 0.5) {
      distance = "Less than 1 mile";
    } else {
      distance = `${rounded.toLocaleString()} ${rounded === 1 ? "mile" : "miles"}`;
    }
    distanceLabel = `→ ${distance} ${direction.name} of ${place.name}`;
  }
  const behavior = [
    ...new Set(
      [
        data.attr_FireBehaviorGeneral,
        data.attr_FireBehaviorGeneral1,
        data.attr_FireBehaviorGeneral2,
        data.attr_FireBehaviorGeneral3,
      ]
        .map(text)
        .filter((value): value is string => !!value),
    ),
  ];
  const agency = text(data.attr_POOProtectingAgency);
  const agencyName = agency && /[a-z]{3,}\s+[a-z]{3,}/i.test(agency) ? agency : null;
  const discoveredAgo = incidentAge(data.attr_FireDiscoveryDateTime, now);
  const updatedAge = incidentAge(data.attr_ModifiedOnDateTime_dt, now);
  const perimeterAge = incidentAge(data.poly_DateCurrent, now);
  let lastUpdate;
  if (updatedAge) {
    lastUpdate = `Updated ${updatedAge}`;
  } else if (perimeterAge) {
    lastUpdate = `Perimeter mapped ${perimeterAge}`;
  } else {
    lastUpdate = null;
  }
  const updateDate = updatedAge
    ? date(data.attr_ModifiedOnDateTime_dt)
    : date(data.poly_DateCurrent);
  const timelineUpdate = updatedAge ? "Incident report" : "Perimeter mapped";
  return (
    <section className="plain-card live-fire-case" aria-label="Fire incident details">
      <div className="evidence-heading">
        <h3>Incident details</h3>
      </div>
      {lastUpdate && (
        <span className="live-age" title={updateDate || undefined}>
          {lastUpdate}
        </span>
      )}
      {pointOnly && (
        <p className="live-fire-distance-note">Reported location / no perimeter shown</p>
      )}
      {!place && <p className="live-fire-distance-note">Enter a ZIP above to see distance.</p>}
      {distanceLabel && <p className="live-fire-distance">{distanceLabel}</p>}
      {displayedAcres !== null && (
        <div className="live-fire-size">
          <strong>
            {Math.round(displayedAcres).toLocaleString()} <span>acres</span>
          </strong>
        </div>
      )}
      {containment !== null && (
        <div className="live-fire-containment">
          <span className="live-fire-status">{containment}% contained</span>
          <progress value={containment} max="100" aria-label={`${containment}% contained`} />
        </div>
      )}
      {(discoveredAgo || containment !== null || lastUpdate) && (
        <ol className="live-fire-timeline">
          {discoveredAgo && (
            <li title={date(data.attr_FireDiscoveryDateTime) || undefined}>
              Discovered {discoveredAgo}
            </li>
          )}
          {containment !== null && <li>Current containment / {containment}%</li>}
          {lastUpdate && (
            <li>
              {timelineUpdate} / {updateDate}
            </li>
          )}
          {date(data.attr_ControlDateTime) && <li>Controlled {date(data.attr_ControlDateTime)}</li>}
          {date(data.attr_FireOutDateTime) && <li>Out {date(data.attr_FireOutDateTime)}</li>}
        </ol>
      )}
      {behavior.length > 0 && (
        <div className="live-fire-behavior">
          <h4>Fire behavior</h4>
          <div>
            {behavior.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>
      )}
      {(count(data.attr_TotalIncidentPersonnel) || agencyName) && (
        <div className="live-fire-response">
          {count(data.attr_TotalIncidentPersonnel) && (
            <p>
              <Icon name="people" /> {count(data.attr_TotalIncidentPersonnel)} personnel
            </p>
          )}
          {agencyName && <p>{agencyName}</p>}
        </div>
      )}
      <p className="live-fire-source">
        Source: <a href={sourceUrl}>{demo ? "Palisades progression" : "NIFC / WFIGS"}</a>
      </p>
    </section>
  );
}

function FireList({
  data,
  place,
  point,
  onLocate,
  limit,
  compact = false,
  highlightNearby = true,
}: {
  data: FeatureCollection;
  place: WavePlace | null;
  point?: [number, number] | null;
  onLocate?: (feature: Feature) => void;
  limit?: number;
  compact?: boolean;
  highlightNearby?: boolean;
}) {
  const records = [];
  for (const fire of data.features) {
    const referencePoint =
      point || (place ? ([place.longitude, place.latitude] as [number, number]) : null);
    const distance = referencePoint ? perimeterDistanceKm(fire.geometry, referencePoint) : null;
    let acres;
    if (
      typeof fire.properties?.attr_IncidentSize === "number" &&
      fire.properties.attr_IncidentSize > 0
    ) {
      acres = fire.properties.attr_IncidentSize;
    } else if (
      typeof fire.properties?.poly_GISAcres === "number" &&
      fire.properties.poly_GISAcres > 0
    ) {
      acres = fire.properties.poly_GISAcres;
    } else {
      acres = null;
    }
    records.push({
      name: displayFireName(String(fire.properties?.poly_IncidentName || "Unnamed")),
      acres: acres,
      distance,
      feature: fire,
    });
  }
  records.sort((first, second) => (second.acres ?? 0) - (first.acres ?? 0));
  return (
    <ul className={`live-fire-list${compact ? " is-compact" : ""}`}>
      {records.slice(0, limit).map((record, index) => (
        <li
          key={index}
          className={
            highlightNearby && record.distance !== null && record.distance <= nearbyFireKm
              ? "is-highlighted"
              : ""
          }
        >
          {onLocate ? (
            <button type="button" onClick={() => onLocate(record.feature)}>
              <span>
                {record.name}
                {record.acres !== null && (
                  <small>{Math.round(record.acres).toLocaleString()} acres</small>
                )}
                {compact && (place || point) && (
                  <small>
                    {record.distance === null
                      ? "Distance unavailable"
                      : `${(record.distance / 1.609344).toFixed(1)} mi`}
                  </small>
                )}
              </span>
              {!compact && (place || point) && (
                <small>
                  {record.distance === null
                    ? "Distance unavailable"
                    : `${(record.distance / 1.609344).toFixed(1)} mi`}
                </small>
              )}
            </button>
          ) : (
            <span>
              {record.name}
              {record.acres !== null && (
                <small>{Math.round(record.acres).toLocaleString()} acres</small>
              )}
            </span>
          )}
          {(place || point) && !compact && !onLocate && (
            <small>
              {record.distance === null
                ? "Distance unavailable"
                : (record.distance / 1.609344).toFixed(1) + " mi"}
            </small>
          )}
        </li>
      ))}
    </ul>
  );
}
