import { useEffect, useRef, useState } from "react";
import type { Map as LibreMap } from "maplibre-gl";
import { EvidenceCard, LoadingBars } from "./EvidenceCard";
import { perimeterPaint } from "./MapLayers";
import {
  BurnSeverityPanel,
  FireContextViewSelector,
  loadBurnArea,
  type BurnAreaState,
} from "./burnArea";
import { observationLocation } from "./caseAnalysis";
import { displayDate, displayUnits } from "./units";
import {
  loadFireCatalog,
  loadFireBoundary,
  loadSeverity,
  mtbsSource,
  type FireBoundary,
} from "./mtbs";
import type { CaseData } from "./types";
import type { WaveCatalog } from "./waves";
import { readGroundSupplement, type GroundSupplement, type SlopeLayer } from "./fireGround";

export type FireGround = {
  key: string;
  name: string;
  boundary: FireBoundary | null;
  severity: Awaited<ReturnType<typeof loadSeverity>> | null;
  burnArea?: BurnAreaState;
  message: string;
  retrievedAt: string;
  supplement: GroundSupplement | null;
  slope: SlopeLayer | null;
  supplementMessage: string;
};

export function useFireGround(fire: WaveCatalog["cases"][number]) {
  const { name, ignition } = fire;
  const key = `${fire.id}:${fire.usgsId}:${ignition}`;
  const [loaded, setLoaded] = useState<FireGround | null>(null);
  const cached = useRef<FireGround | null>(null);
  useEffect(() => {
    if (cached.current?.key === key) {
      setLoaded(cached.current);
      return;
    }
    const controller = new AbortController();
    const result: FireGround = {
      key,
      name,
      boundary: null,
      severity: null,
      message: "",
      retrievedAt: new Date().toISOString(),
      supplement: null,
      slope: null,
      supplementMessage: "",
    };
    function publish() {
      if (!controller.signal.aborted) setLoaded({ ...result });
    }
    async function loadSlope() {
      try {
        const response = await fetch("/data/waves/ground.json", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Ground-product manifest could not load.");
        result.supplement = readGroundSupplement(await response.json(), fire);
        const layer = result.supplement.layers.slope;
        if (layer.status === "unavailable") throw new Error(layer.reason);
        const image = new Image();
        image.src = layer.file;
        try {
          await image.decode();
        } catch {
          throw new Error("Slope image could not load.");
        }
        if (image.width !== layer.width || image.height !== layer.height)
          throw new Error("Slope image dimensions do not match.");
        result.slope = layer;
      } catch (error) {
        result.supplementMessage = (error as Error).message;
      }
      publish();
    }
    async function loadMtbs() {
      try {
        const response = await fetch("/data/california-outline.geojson", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("California boundary could not load.");
        const fireName = name.replace(/ Fire$/, "");
        const records = await loadFireCatalog(
          Number(ignition.slice(0, 4)),
          await response.json(),
          controller.signal,
          fireName,
        );
        const matches = records.filter(
          (record) => record.incid_name.toUpperCase() === fireName.toUpperCase(),
        );
        if (matches.length !== 1) throw new Error("A unique MTBS fire record was not verified.");

        result.boundary = await loadFireBoundary(matches[0], controller.signal);
        result.severity = await loadSeverity(result.boundary, controller.signal);
        try {
          result.burnArea = await loadBurnArea(result.boundary, controller.signal);
        } catch (error) {
          result.burnArea = {
            status: "failed",
            reason: (error as Error).message,
          };
        }
      } catch (error) {
        result.message = (error as Error).message;
      }
      publish();
    }

    void Promise.all([loadSlope(), loadMtbs()]).then(() => {
      if (!controller.signal.aborted) cached.current = { ...result };
    });
    return () => controller.abort();
  }, [fire, name, ignition, key]);
  return loaded?.key === key ? loaded : null;
}

export function GroundEvidence({
  ground,
  onView,
  view,
}: {
  ground: FireGround | null;
  view: "severity" | "slope";
  onView: (view: "severity" | "slope") => void;
}) {
  const areaLoading = !ground || !ground.burnArea || ground.burnArea.status === "loading";
  let areaMessage = "Unavailable";
  if (ground?.burnArea?.status === "failed") areaMessage = "Couldn't load burn-area summary.";
  if (ground?.burnArea?.status === "unavailable") areaMessage = "Unavailable";
  if (view === "severity") {
    return (
      <>
        {ground?.severity && ground.slope && (
          <FireContextViewSelector view={view} onView={onView} />
        )}
        {ground?.burnArea?.status === "available" || ground?.burnArea?.status === "map" ? (
          <BurnSeverityPanel data={ground.burnArea} />
        ) : (
          <EvidenceCard
            title="Burn severity by area"
            kind="Historical"
            source={<a href={mtbsSource}>USGS / USFS MTBS</a>}
            caption={areaLoading ? undefined : "Area summary unavailable"}
            loading={areaLoading}
          >
            <p className="quiet-failure" role="status">
              {areaMessage}
            </p>
          </EvidenceCard>
        )}
      </>
    );
  }
  let terrainContent;
  if (ground?.severity || ground?.slope) {
    terrainContent = (
      <div className="ground-picker">
        {view === "slope" && ground?.slope && (
          <>
            <div className="slope-insight">
              <div className="slope-insight-heading">
                <strong>{Math.round(ground.slope.fireSteepPercent)}%</strong>
                <span>
                  of terrain inside the fire boundary is {ground.slope.thresholdDegrees}° or steeper
                </span>
              </div>
              <div className="slope-share-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${100 - ground.slope.fireSteepPercent}%`,
                    background: ground.slope.colors.below,
                  }}
                />
                <span
                  style={{
                    width: `${ground.slope.fireSteepPercent}%`,
                    background: ground.slope.colors.atOrAbove,
                  }}
                />
              </div>
            </div>
            <div className="ground-layer-key">
              <span>
                <i className="swatch" style={{ background: ground.slope.colors.below }} />
                Under {ground.slope.thresholdDegrees}°
              </span>
              <span>
                <i className="swatch" style={{ background: ground.slope.colors.atOrAbove }} />
                {ground.slope.thresholdDegrees}° or steeper
              </span>
            </div>
          </>
        )}
      </div>
    );
  } else if (ground?.message || ground?.supplementMessage) {
    terrainContent = (
      <p className="fine" role="status">
        {ground.message || ground.supplementMessage}
      </p>
    );
  } else {
    terrainContent = (
      <LoadingBars className="compact-loading" label="Loading verified ground layers" />
    );
  }
  return (
    <>
      {ground?.severity && ground.slope && <FireContextViewSelector view={view} onView={onView} />}
      <EvidenceCard
        title="Terrain steepness"
        kind="Historical"
        loading={!ground}
        source={
          <a
            href={
              view === "slope"
                ? ground?.slope?.sourceUrl || "https://www.usgs.gov/3d-elevation-program"
                : mtbsSource
            }
          >
            {view === "slope" ? "USGS 3DEP" : "USGS / USFS MTBS"}
          </a>
        }
      >
        {terrainContent}
      </EvidenceCard>
    </>
  );
}
export function FireGroundLayer({
  map,
  ground,
  view,
  perimeter,
}: {
  map: LibreMap;
  ground: FireGround;
  view: "severity" | "slope";
  perimeter: import("geojson").FeatureCollection;
}) {
  useEffect(() => {
    const layer = view === "slope" ? ground.slope : ground.severity;
    if (!layer || (view === "severity" && !ground.boundary)) return;
    const { bounds } = layer;
    const [west, south, east, north] = bounds;
    if (view === "severity" && ground.severity)
      map.addSource("waves-ground", {
        type: "canvas",
        canvas: ground.severity.canvas,
        animate: false,
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      });
    else if (ground.slope)
      map.addSource("waves-ground", {
        type: "image",
        url: ground.slope.file,
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      });
    map.addLayer({
      id: "waves-ground",
      type: "raster",
      source: "waves-ground",
      paint: {
        "raster-opacity": 0.75,
        "raster-resampling": "nearest",
        "raster-fade-duration": 0,
      },
    });
    map.addSource("waves-ground-boundary", {
      type: "geojson",
      data: view === "severity" ? ground.boundary! : perimeter,
    });
    map.addLayer({
      id: "waves-ground-boundary",
      type: "line",
      source: "waves-ground-boundary",
      paint: { ...perimeterPaint, "line-color": "#304638" },
    });
    return () => {
      if (!map.getStyle()) return;
      for (const id of ["waves-ground-boundary", "waves-ground"]) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
    };
  }, [map, ground, view, perimeter]);
  return null;
}

export function RecordedEvidence({ data, fireName }: { data: CaseData; fireName: string }) {
  const location = observationLocation(data);
  const source = <a href="https://doi.org/10.5066/P1R9VXC4">USGS observation inventory</a>;
  return (
    <>
      <EvidenceCard
        title="Recorded storms"
        accessibleName={`Recorded storms: ${fireName}, ${data.observationId}`}
        kind="Observed"
        source={source}
      >
        <dl className="rain-facts">
          <dt>Peak 15-minute intensity</dt>
          <dd>{displayUnits(data.rain, "rain").text}</dd>
          <dt>Storm date</dt>
          <dd>{displayDate(data.storm)}</dd>
          <dt>Gauge</dt>
          <dd>{data.inventory.GageName || "Unavailable"}</dd>
        </dl>
      </EvidenceCard>
      <EvidenceCard
        title="What was observed"
        accessibleName={`What was observed: ${fireName}, ${data.observationId}`}
        kind="Observed"
        source={source}
      >
        <dl className="rain-facts">
          <dt>Outcome</dt>
          <dd>{data.outcome}</dd>
          <dt>Recorded</dt>
          <dd>{displayDate(data.observedDate)}</dd>
          <dt>Location</dt>
          <dd>
            {location ? `${location[1].toFixed(5)}°, ${location[0].toFixed(5)}°` : "Unavailable"}
          </dd>
        </dl>
      </EvidenceCard>
    </>
  );
}
