import { useEffect, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import {
  addBasemap,
  boundaryLayout,
  cancelledMapRequest,
  mapPadding,
  perimeterPaint,
  muteBasemap,
} from "./MapLayers";
import {
  CompanionRainLayers,
  basinLegend,
  type BasinMode,
  type CompanionRain,
} from "./CoordinatedRain";
import { runoutLevels, type RunoutState } from "./runout";
import {
  hazardClasses,
  hazardTileUrl,
  type HazardAssessment,
  type HazardMode,
} from "./usgsHazards";
import { mtbsClasses } from "./mtbs";
import { Icon } from "./Icons";
import { MapLegend } from "./MapLegend";
import type { PlumeDay } from "./waves";
import { RainScenarioLayers, type RainScenarios } from "./RainScenarios";
import { RecoveryLayers } from "./RecoveryPanel";
import type { RecoveryData } from "./recovery";
import type { SlopeLayer } from "./fireGround";
import type { GoesProduct, HrrrProduct } from "./waves";
import { HrrrScaleLegend, WavesGoes, WavesHrrr, type HrrrScale } from "./WavesGoes";
import { FireGroundLayer } from "./WavesRain";

export default function HistoricalWavesMap({
  name,
  geometry,
  bounds,
  raster,
  hazard,
  mode,
  companion,
  intensity,
  runout,
  plumeDay,
  onPlumeLoading,
  playback,
  smokeModeSwitch,
  onSatelliteFrameTime,
  rainScenarios,
  recovery,
  observations,
  slope,
  goes,
  hrrr,
}: {
  name: string;
  geometry: FeatureCollection | null;
  bounds: [number, number, number, number] | null;
  raster: {
    canvas: HTMLCanvasElement;
    bounds: [number, number, number, number];
  } | null;
  hazard: HazardAssessment | null;
  mode: HazardMode;
  companion: CompanionRain | null;
  intensity: number | null;
  runout: RunoutState;
  plumeDay?: PlumeDay;
  onPlumeLoading: (loading: boolean) => void;
  playback?: ReactNode;
  smokeModeSwitch?: ReactNode;
  onSatelliteFrameTime: (time: string | null) => void;
  rainScenarios: RainScenarios | null;
  recovery?: RecoveryData;
  observations?: FeatureCollection;
  slope?: SlopeLayer | null;
  goes?: GoesProduct & { caseId: string };
  hrrr?: HrrrProduct & { caseId: string };
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [failure, setFailure] = useState("");
  const [hrrrScale, setHrrrScale] = useState<HrrrScale | null>(null);
  const boundsKey = bounds?.join(",");
  function fit() {
    if (!mapRef.current || !bounds) return;
    mapRef.current.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      {
        padding: mapPadding(mapRef.current.getContainer()),
        maxZoom: 12,
        duration: 0,
      },
    );
  }
  useEffect(() => {
    if (!container.current) return;
    setFailure("");
    const instance = new maplibregl.Map({
      container: container.current,
      attributionControl: false,
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
      center: [-119.5, 37],
      zoom: 5,
      maxZoom: 16,
    });
    mapRef.current = instance;
    instance.getCanvas().setAttribute("aria-label", `Historical ${name} map`);
    instance.on("load", () => {
      addBasemap(instance);
      muteBasemap(instance);
      instance.addSource("historical-perimeter", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "perimeter",
        type: "line",
        source: "historical-perimeter",
        layout: boundaryLayout,
        paint: perimeterPaint,
      });
      setMap(instance);
    });
    instance.on("error", (event) => {
      if (!cancelledMapRequest(event.error))
        setFailure("A map layer could not load. Text evidence remains available.");
    });
    const dashboard = instance.getContainer().closest<HTMLElement>(".guided-dashboard");
    function resizeMap() {
      if (dashboard?.dataset.panelResizing === "true") return;
      instance.resize();
    }
    const observer = new ResizeObserver(resizeMap);
    observer.observe(container.current);
    dashboard?.addEventListener("panelresizeend", resizeMap);
    return () => {
      observer.disconnect();
      dashboard?.removeEventListener("panelresizeend", resizeMap);
      instance.remove();
      mapRef.current = null;
    };
  }, [name]);
  useEffect(() => {
    if (!map) return;
    const source = map.getSource("historical-perimeter") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(geometry || { type: "FeatureCollection", features: [] });
  }, [map, geometry]);
  useEffect(() => {
    if (map) fit();
  }, [map, boundsKey]);
  useEffect(() => {
    if (!map || !observations) return;
    map.addSource("recorded-observations", {
      type: "geojson",
      data: observations,
    });
    map.addLayer({
      id: "recorded-observations",
      type: "circle",
      source: "recorded-observations",
      paint: {
        "circle-radius": 4,
        "circle-color": "#176d91",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
    return () => {
      if (map.getLayer("recorded-observations")) map.removeLayer("recorded-observations");
      if (map.getSource("recorded-observations")) map.removeSource("recorded-observations");
    };
  }, [map, observations]);
  useEffect(() => {
    if (!map) {
      onPlumeLoading(!!plumeDay?.path && plumeDay.status === "available");
      return;
    }
    const smokeMap = map;
    if (!plumeDay?.path || plumeDay.status !== "available") {
      const source = smokeMap.getSource("historical-smoke") as maplibregl.GeoJSONSource | undefined;
      source?.setData({ type: "FeatureCollection", features: [] });
      onPlumeLoading(false);
      return;
    }
    const controller = new AbortController();
    const style = getComputedStyle(document.documentElement);
    onPlumeLoading(true);
    async function load() {
      const response = await fetch(plumeDay!.path!, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Smoke file could not load.");
      const data = (await response.json()) as FeatureCollection;
      if (
        data.type !== "FeatureCollection" ||
        !Array.isArray(data.features) ||
        data.features.some(
          (feature) =>
            !["medium", "heavy"].includes(feature.properties?.density) ||
            feature.properties?.dateUtc !== plumeDay!.dateUtc,
        )
      )
        throw new Error("Smoke file identity differs.");
      if (controller.signal.aborted) return;
      const source = smokeMap.getSource("historical-smoke") as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(data);
      else {
        smokeMap.addSource("historical-smoke", { type: "geojson", data });
        smokeMap.addLayer(
          {
            id: "historical-smoke",
            type: "fill",
            source: "historical-smoke",
            paint: {
              "fill-color": [
                "match",
                ["get", "density"],
                "heavy",
                style.getPropertyValue("--smoke-haze-heavy").trim(),
                style.getPropertyValue("--smoke-haze-medium").trim(),
              ],
              "fill-opacity": 0.4,
            },
          },
          "perimeter",
        );
      }
      onPlumeLoading(false);
    }
    void load().catch(() => {
      if (!controller.signal.aborted) {
        const source = smokeMap.getSource("historical-smoke") as
          maplibregl.GeoJSONSource | undefined;
        source?.setData({ type: "FeatureCollection", features: [] });
        onPlumeLoading(false);
        setFailure("The selected NOAA map could not load. Text evidence remains available.");
      }
    });
    return () => {
      controller.abort();
    };
  }, [map, plumeDay, onPlumeLoading]);
  useEffect(() => {
    if (!map || !raster) return;
    const [west, south, east, north] = raster.bounds;
    map.addSource("historical-severity", {
      type: "image",
      url: raster.canvas.toDataURL(),
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    });
    map.addLayer(
      {
        id: "historical-severity",
        type: "raster",
        source: "historical-severity",
        paint: {
          "raster-opacity": 0.75,
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
      },
      "perimeter",
    );
    return () => {
      if (map.getLayer("historical-severity")) map.removeLayer("historical-severity");
      if (map.getSource("historical-severity")) map.removeSource("historical-severity");
    };
  }, [map, raster]);
  useEffect(() => {
    if (!map || !hazard) return;
    map.addSource("historical-assessment", {
      type: "raster",
      tiles: [hazardTileUrl(hazard, mode, false)],
      tileSize: 256,
    });
    map.addLayer(
      {
        id: "historical-assessment",
        type: "raster",
        source: "historical-assessment",
        paint: { "raster-opacity": 0.7 },
      },
      "perimeter",
    );
    return () => {
      if (map.getLayer("historical-assessment")) map.removeLayer("historical-assessment");
      if (map.getSource("historical-assessment")) map.removeSource("historical-assessment");
    };
  }, [map, hazard, mode]);
  const legend: { label: string; color: string }[] = [];
  if (raster) legend.push(...mtbsClasses);
  if (hazard) legend.push(...hazardClasses[mode]);
  if (rainScenarios) legend.push(...hazardClasses[mode]);
  if (companion)
    legend.push(...basinLegend(companion, mode === "volume" ? "volume" : "likelihood"));
  if (runout.status === "available") legend.push(...runoutLevels);
  if (recovery?.damage.categories) {
    for (const category of recovery.damage.categories) {
      if (category.count > 0) legend.push({ label: category.label, color: category.color });
    }
  }
  return (
    <section className="map-section waves-map-section" aria-label="Historical fire map">
      <div className="map-frame">
        <div
          ref={container}
          className="map"
          role="img"
          aria-label={`${name}. Historical source boundary and the selected agency product; not current conditions.`}
        />
        <p className="sr-only">
          {name}. Only verified source geometry is drawn. Historical agency scenarios are not
          current warnings.
          {recovery &&
            " CAL FIRE structure inspection categories and counts are in the Building damage card. Not rebuilding progress or a property clearance."}
        </p>
        <div className="map-actions" role="group" aria-label="Historical map navigation">
          <button aria-label="Zoom in" onClick={() => map?.zoomIn()}>
            <Icon name="plus" />
          </button>
          <button aria-label="Zoom out" onClick={() => map?.zoomOut()}>
            <Icon name="minus" />
          </button>
          <button aria-label="Fit fire" onClick={fit}>
            <Icon name="fit" />
          </button>
        </div>
        {failure && (
          <p className="waves-map-message fine" role="status">
            {failure}
          </p>
        )}
        <MapLegend>
          {observations && <p className="fine">Blue dots: observation locations</p>}
          <div className="waves-legend-items">
            {legend.map((row) => (
              <div className="waves-legend-row" key={row.label}>
                <span className="swatch" style={{ background: row.color }} aria-hidden="true" />
                <span>{row.label}</span>
              </div>
            ))}
            {hrrr && hrrrScale && <HrrrScaleLegend scale={hrrrScale} />}
          </div>
        </MapLegend>
        {map && (
          <CompanionRainLayers
            map={map}
            data={companion}
            mode={(mode === "volume" ? "volume" : "likelihood") as BasinMode}
            intensity={intensity}
            runout={runout}
          />
        )}
        <RecoveryLayers map={map} data={recovery} />
        {map && slope && geometry && (
          <FireGroundLayer
            map={map}
            view="slope"
            perimeter={geometry}
            ground={{
              key: name,
              name,
              boundary: null,
              severity: null,
              slope,
              supplement: null,
              supplementMessage: "",
              message: "",
              retrievedAt: slope.retrievedAt,
            }}
          />
        )}
        {map && rainScenarios && intensity !== null && (
          <RainScenarioLayers map={map} data={rainScenarios} mode={mode} intensity={intensity} />
        )}
      </div>
      {playback && <div className="waves-smoke-controls historical-smoke-controls">{playback}</div>}
      {goes && (
        <div className="waves-smoke-controls historical-smoke-controls">
          <WavesGoes
            key={goes.caseId}
            map={map}
            product={goes}
            modeSwitch={smokeModeSwitch}
            onFrameTime={onSatelliteFrameTime}
          />
        </div>
      )}
      {hrrr && (
        <div className="waves-smoke-controls historical-smoke-controls">
          <WavesHrrr
            key={hrrr.caseId}
            map={map}
            product={hrrr}
            modeSwitch={smokeModeSwitch}
            startDate=""
            onScale={setHrrrScale}
          />
        </div>
      )}
    </section>
  );
}
