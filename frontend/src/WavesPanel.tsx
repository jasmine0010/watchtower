import { useEffect, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as LibreMap } from "maplibre-gl";
import {
  readWaves,
  type WavesData,
  type WaveCatalog,
  waveCaseFor,
  soilGridFeatures,
  soilColors,
  type SoilSeries,
  type GoesProduct,
  type HrrrProduct,
} from "./waves";
import { StepPanel } from "./StepPanel";
import { EvidenceCard, LoadingBars } from "./EvidenceCard";
import {
  addBasemap,
  muteBasemap,
  boundaryLayout,
  perimeterPaint,
  mapPadding,
  cancelledMapRequest,
} from "./MapLayers";
import { type HazardMode, type HazardAssessment } from "./usgsHazards";
import { Icon } from "./Icons";
import { MapLegend } from "./MapLegend";
import type { HistoricalRecord } from "./historicalFires";
import { useHistoricalEvidence } from "./historicalEvidence";
import { RecoveryCards, RecoveryLayers } from "./RecoveryPanel";
import type { RecoveryData } from "./recovery";
import { utcDate } from "./usgsAssessments";
import type { CaseData } from "./types";
import { mtbsClasses } from "./mtbs";
import {
  useFireGround,
  GroundEvidence,
  FireGroundLayer,
  RecordedEvidence,
  type FireGround,
} from "./WavesRain";
import type { WaveStep } from "./navigation";
import type { PlumeDay } from "./waves";
import {
  SmokeMeasurements,
  SmokePlayback,
  SmokeLayerSwitch,
  UnavailableSmokePlayback,
} from "./WavesSmoke";
import { emptyFeatures } from "./wavesLive";
import { HrrrScaleLegend, WavesGoes, WavesHrrr, type HrrrScale } from "./WavesGoes";
import type { FeatureCollection } from "geojson";
import "./WavesPanel.css";
import { readLinkedRainScenarios, RainScenarioLayers, type RainScenarios } from "./RainScenarios";
import { RainPanel, type RainPanelView } from "./RainPanel";
import { hazardClasses } from "./usgsHazards";

export const waveSteps = [
  { id: "context", question: "Fire context" },
  { id: "rain", question: "Rain" },
  { id: "smoke", question: "Smoke" },
  { id: "recovery", question: "Recovery" },
] as const;
const unknownCoverage: Record<string, boolean | null> = {};

export default function WavesPanel({
  catalog,
  record,
  caseId,
  step,
  mode,
  onStep,
  onMode,
  observations,
  resources,
  picker,
}: {
  catalog: WaveCatalog;
  record: HistoricalRecord | null;
  caseId: string | null;
  step: WaveStep;
  mode: HazardMode;
  onStep: (step: WaveStep) => void;
  onMode: (mode: HazardMode) => void;
  observations: CaseData[];
  resources: ReactNode;
  picker: ReactNode;
}) {
  const entry = waveCaseFor(catalog, caseId);
  const satellite = useHistoricalEvidence(record, step === "smoke" && !entry.goes ? "goes" : null);
  let goesProduct;
  if (entry.goes) {
    goesProduct = { ...entry.goes, caseId: entry.id };
  } else if (satellite?.data?.goes?.status === "available") {
    goesProduct = satellite.data.goes;
  } else {
    goesProduct = undefined;
  }
  const hrrrProduct = entry.hrrr || entry.regionalHrrr;
  const recoveryEvidence = useHistoricalEvidence(record, step === "recovery" ? "recovery" : null);
  const recovery = recoveryEvidence?.data?.recovery;
  const [recoveryMap, setRecoveryMap] = useState<"damage" | "soil">("damage");
  const showSoil = recovery?.damage.status !== "available" || recoveryMap === "soil";
  const [plumeSelection, setPlumeSelection] = useState({
    caseId: "",
    date: "",
  });
  const [playing, setPlaying] = useState(false);
  const [smokeSelection, setSmokeSelection] = useState({
    caseId: entry.id,
    layer: "hms",
  });
  const smokeLayer = smokeSelection.caseId === entry.id ? smokeSelection.layer : "hms";
  function setSmokeLayer(layer: string) {
    setSmokeSelection({ caseId: entry.id, layer });
  }
  const [satelliteFrameTime, setSatelliteFrameTime] = useState<string | null>(null);
  const [, setGoesDetails] = useState<ReactNode | null>(null);
  const [chemical, setChemical] = useState("lead");
  const [rainArchive, setRainArchive] = useState<{
    caseId: string;
    data: RainScenarios;
  } | null>(null);
  const [rainFailure, setRainFailure] = useState<string | null>(null);
  const [rainIntensity, setRainIntensity] = useState<number | null>(null);
  const [groundView, setGroundView] = useState<"severity" | "slope" | null>(null);
  const ground = useFireGround(entry);
  const defaultGroundView =
    ground?.message && ground.slope && !ground.severity ? "slope" : "severity";
  const activeGroundView = groundView ?? defaultGroundView;
  const rainRequested = Boolean(entry.rainScenarios);
  const rainScenarios = rainArchive?.caseId === entry.id ? rainArchive.data : null;
  const intensity =
    rainScenarios && rainIntensity !== null && rainScenarios.steps.includes(rainIntensity)
      ? rainIntensity
      : rainScenarios?.defaultIntensity || 0;
  useEffect(() => {
    setRainIntensity(null);
    setRainFailure(null);
    setGoesDetails(null);
    setSatelliteFrameTime(null);
    setGroundView(null);
  }, [entry.id]);
  useEffect(() => {
    if (step !== "rain" || !rainRequested || rainScenarios) return;
    const controller = new AbortController();
    async function load() {
      try {
        if (!record || record.replayId !== entry.id)
          throw new Error("Replay fire identity differs");
        const response = await fetch(entry.rainScenarios!.url, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Missing assessment");
        const archive = readLinkedRainScenarios(
          await response.json(),
          entry.rainScenarios!,
          record,
        );
        if (!controller.signal.aborted) setRainArchive({ caseId: entry.id, data: archive });
      } catch {
        if (!controller.signal.aborted) setRainFailure(entry.id);
      }
    }
    void load();
    return () => controller.abort();
  }, [entry.id, entry.name, entry.rainScenarios, record, step, rainScenarios, rainRequested]);
  useEffect(() => setPlaying(false), [entry.id, step]);
  useEffect(() => setPlumeSelection({ caseId: "", date: "" }), [entry.id]);
  const [loaded, setLoaded] = useState<{ id: string; data: WavesData } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (loaded?.id === entry.id) return;
    const controller = new AbortController();
    setFailed(null);
    async function load() {
      try {
        const response = await fetch(entry.snapshot, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Missing replay");
        const data = readWaves(await response.json());
        if (
          data.case.name !== entry.name ||
          data.case.ignition !== entry.ignition ||
          data.case.county !== entry.county ||
          data.rain.record.Fire_ID !== entry.usgsId
        )
          throw new Error("Wrong replay");
        if (entry.soilMap) {
          try {
            const response = await fetch(entry.soilMap, {
              signal: controller.signal,
            });
            if (!response.ok) throw new Error("Missing soil supplement");
            const soil = await response.json();
            if (soil.fireId !== entry.usgsId || !Array.isArray(soil.mapSeries))
              throw new Error("Wrong soil supplement");
            data.ash = {
              ...data.ash,
              geometry: soil.geometry,
              mapSeries: soil.mapSeries,
            };
          } catch {
            data.ash = {
              ...data.ash,
              geometry: {
                ...data.ash.geometry,
                status: "failed",
                reason: "Sampling-grid map could not load. Existing charts remain available.",
              },
            };
          }
        }
        if (!controller.signal.aborted) setLoaded({ id: entry.id, data });
      } catch {
        if (!controller.signal.aborted) setFailed(entry.id);
      }
    }
    void load();
    return () => controller.abort();
  }, [entry, loaded?.id]);
  const data = loaded?.id === entry.id ? loaded.data : null;
  const recorded = observations.filter(
    (record) =>
      `${record.inventory.FireName} Fire`.toUpperCase() === entry.name.toUpperCase() &&
      record.ignition === entry.ignition &&
      record.county === entry.county,
  );
  const soilSeries =
    data?.ash.mapSeries?.find((series) => series.id === chemical) || data?.ash.mapSeries?.[0];
  const coverage = entry.plumeCoverage || unknownCoverage;
  const replayDays =
    data?.smoke.plumes.days.filter((day) => day.dateUtc >= data.case.ignition) || [];
  const initialDate = replayDays[0]?.dateUtc || "";
  const selectedDate =
    plumeSelection.caseId === entry.id &&
    replayDays.some((day) => day.dateUtc === plumeSelection.date)
      ? plumeSelection.date
      : initialDate;
  const plumeDay = replayDays.find((day) => day.dateUtc === selectedDate);
  function advancePlumeDate(date: string) {
    setSmokeLayer("hms");
    setPlumeSelection({ caseId: entry.id, date });
  }
  let rainView: RainPanelView = {
    kind: "unavailable",
    message: "No verified USGS scenario is linked to this fire.",
  };
  if (rainRequested) {
    let scenarioView: RainPanelView;
    if (rainScenarios) {
      scenarioView = {
        kind: "archive",
        data: rainScenarios,
        intensity,
        onIntensity: setRainIntensity,
      };
    } else if (rainFailure === entry.id) {
      scenarioView = {
        kind: "unavailable",
        message: "Rainfall scenarios unavailable. The older assessment is not substituted.",
      };
    } else {
      scenarioView = { kind: "loading", label: "Loading rainfall scenarios" };
    }
    rainView = scenarioView;
  } else if (data?.rain.layers[mode].status === "available") {
    rainView = {
      kind: "single",
      assessment: assessment(data, mode),
      title: "Published rainfall scenario",
      source: <a href={data.rain.sourceUrl}>USGS</a>,
      availableModes: (["likelihood", "volume", "combined"] as HazardMode[]).filter(
        (choice) => data.rain.layers[choice].status === "available",
      ),
    };
  } else if (data) {
    rainView = {
      kind: "unavailable",
      message:
        "This USGS scenario layer is not available in the saved snapshot. Check Sources for the assessment.",
    };
  }
  return (
    <>
      {data && (
        <WavesMap
          key={entry.id}
          data={data}
          step={step}
          mode={mode}
          plumeDay={plumeDay}
          onPlumeDay={advancePlumeDate}
          playing={playing}
          onPlaying={setPlaying}
          coverage={coverage}
          smokeLayer={smokeLayer}
          onSatelliteFrameTime={setSatelliteFrameTime}
          onGoesDetails={setGoesDetails}
          goes={goesProduct}
          hrrr={hrrrProduct ? { ...hrrrProduct, caseId: entry.id } : undefined}
          soilSeries={soilSeries}
          showSoil={showSoil}
          recovery={step === "recovery" && !showSoil ? recovery : undefined}
          rainRequested={rainRequested}
          rainScenarios={rainScenarios}
          rainIntensity={intensity}
          onSmokeLayer={setSmokeLayer}
          ground={ground}
          groundView={activeGroundView}
        />
      )}
      <StepPanel
        context={picker}
        steps={waveSteps}
        active={step}
        onStep={onStep}
        selectionKey={entry.id}
      >
        {!data &&
          (failed === entry.id ? (
            <p className="quiet-failure" role="status">
              Replay unavailable. Choose another fire.
            </p>
          ) : (
            <LoadingBars className="compact-loading" label="Loading historical replay" />
          ))}
        {data && step === "smoke" && (
          <>
            <SmokeCharts
              data={data}
              selectedDate={selectedDate}
              selectedTime={smokeLayer === "goes" ? satelliteFrameTime : null}
            />
          </>
        )}
        {data && step === "recovery" && (
          <>
            {recovery?.damage.status === "available" &&
              (soilSeries ||
                data.ash.findings ||
                (data.ash.county && data.ash.grids.length > 0) ||
                data.ash.followup.length > 0) && (
                <div
                  className="view-toggle waves-modes fire-context-switch"
                  role="group"
                  aria-label="Recovery view"
                >
                  <button aria-pressed={!showSoil} onClick={() => setRecoveryMap("damage")}>
                    Building damage
                  </button>
                  <button aria-pressed={showSoil} onClick={() => setRecoveryMap("soil")}>
                    Soil testing
                  </button>
                </div>
              )}
            {showSoil ? (
              <SoilCharts data={data} soilSeries={soilSeries} onChemical={setChemical} />
            ) : (
              <RecoveryCards data={recovery} check={recoveryEvidence?.check} />
            )}
          </>
        )}
        {data && step === "rain" && (
          <div className="waves-rain">
            <RainPanel view={rainView} mode={mode} onMode={onMode} />
            {recorded.map((record) => (
              <RecordedEvidence key={record.observationId} data={record} fireName={entry.name} />
            ))}
          </div>
        )}
        {data && step === "context" && (
          <div className="waves-fire-context">
            <GroundEvidence ground={ground} view={activeGroundView} onView={setGroundView} />
          </div>
        )}
      </StepPanel>
      {!data && resources}
    </>
  );
}

export function SmokeCharts({
  data,
  selectedDate,
  selectedTime,
}: {
  data: Pick<WavesData, "case" | "smoke">;
  selectedDate: string;
  selectedTime?: string | null;
}) {
  if (data.smoke.status !== "available" || !data.smoke.stations.length) return null;
  return (
    <>
      <EvidenceCard
        title="Fine particle pollution"
        kind="Observed"
        className="waves-card smoke-chart-card"
        source={<a href={data.smoke.sourceUrl}>EPA</a>}
      >
        <SmokeMeasurements data={data} selectedDate={selectedDate} selectedTime={selectedTime} />
      </EvidenceCard>
    </>
  );
}

function SoilCharts({
  data,
  soilSeries,
  onChemical,
}: {
  data: WavesData;
  soilSeries?: SoilSeries;
  onChemical: (id: string) => void;
}) {
  const county = data.ash.county;
  const limit = county?.screeningMgKg;
  const findings = data.ash.findings;
  return (
    <>
      {soilSeries && !county && (
        <SoilGridResults data={data} series={soilSeries} onChemical={onChemical} />
      )}
      {findings && !soilSeries && (
        <EvidenceCard
          title="County soil findings"
          kind="Historical"
          source={<a href={findings.sourceUrl}>LA County</a>}
        >
          <p className="chart-readout">{findings.areas.length} isolated areas</p>
          <dl>
            {findings.areas.map((chemicals, index) => (
              <div key={chemicals}>
                <dt>{index === 0 ? "One area" : "Another area"}</dt>
                <dd>{chemicals}</dd>
              </div>
            ))}
          </dl>
        </EvidenceCard>
      )}
      {!findings && (!county || data.ash.grids.length === 0) && (
        <p className="quiet-failure" role="status">
          {data.ash.reason || "Soil grid results have not been verified for this fire."}
        </p>
      )}
      {!findings && data.ash.followup.length === 0 && (
        <p className="quiet-failure" role="status">
          {data.ash.followupReason ||
            "Cleanup follow-up results have not been verified for this fire."}
        </p>
      )}
      {county && limit !== undefined && data.ash.grids.length > 0 && (
        <EvidenceCard
          title="Lead in soil"
          kind="Historical"
          className="waves-card"
          source={<a href={county.sourceUrl}>LA County</a>}
        >
          <figure
            aria-label={
              county.value +
              " of " +
              county.total +
              " grid means above " +
              limit +
              " mg/kg; counts, not mapped locations."
            }
          >
            <svg
              viewBox="0 0 360 160"
              role="img"
              aria-label={
                county.value +
                " of " +
                county.total +
                " grids above " +
                limit +
                " milligrams per kilogram"
              }
            >
              <text x="0" y="18">
                {county.value} of {county.total} above {limit} mg/kg
              </text>
              {Array.from({ length: county.total }, (_, index) => (
                <rect
                  key={index}
                  x={(index % 8) * 44}
                  y={32 + Math.floor(index / 8) * 36}
                  width="34"
                  height="28"
                  rx="3"
                  fill={index < county.value ? soilColors.above : soilColors.below}
                />
              ))}
            </svg>
          </figure>
        </EvidenceCard>
      )}
      {data.ash.followup.length > 0 && (
        <EvidenceCard
          title="Lead below screening level"
          kind="Historical"
          className="waves-card"
          source={<a href={data.ash.followup[0].sourceUrl}>EPA</a>}
        >
          <figure
            aria-label={data.ash.followup
              .map((row) => row.title + ": " + row.value + row.unit)
              .join("; ")}
          >
            <p className="fine">
              {data.ash.followup[0].total} properties / {data.ash.followup[0].unit}
            </p>
            {data.ash.followup.map((row) => (
              <div className="waves-bar-row" key={row.title}>
                <div>
                  <span>{row.title}</span>
                  <strong>{row.value}%</strong>
                </div>
                <div className="waves-bar-track">
                  <span style={{ width: row.value + "%" }} />
                </div>
              </div>
            ))}
          </figure>
        </EvidenceCard>
      )}
    </>
  );
}

function SoilGridResults({
  data,
  series,
  onChemical,
}: {
  data: WavesData;
  series: SoilSeries;
  onChemical: (id: string) => void;
}) {
  const entries = Object.entries(series.values).sort(([left], [right]) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  let above = 0;
  for (const [, value] of entries) if (value > series.thresholdMgKg) above++;
  return (
    <EvidenceCard
      title="Soil in sampled grids"
      kind="Historical"
      source={<a href={series.sourceUrl}>LA County / Roux / Figure {series.figure}</a>}
    >
      <label htmlFor="soil-chemical">
        Chemical
        <select
          id="soil-chemical"
          value={series.id}
          onChange={(event) => onChemical(event.target.value)}
        >
          {data.ash.mapSeries?.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <p className="chart-readout">
        {above} of {entries.length} grids
      </p>
      <p>Above {series.thresholdMgKg} mg/kg</p>
      <svg
        className="soil-count-chart"
        viewBox={`0 0 360 ${Math.ceil(entries.length / 8) * 36}`}
        role="img"
        aria-label={`${above} of ${entries.length} verified grid means above ${series.thresholdMgKg} milligrams per kilogram; other reference cells have no verified result.`}
      >
        {entries.map(([id, value], index) => (
          <rect
            key={id}
            x={(index % 8) * 44}
            y={Math.floor(index / 8) * 36}
            width="34"
            height="28"
            rx="3"
            fill={value > series.thresholdMgKg ? soilColors.above : soilColors.below}
          />
        ))}
      </svg>
    </EvidenceCard>
  );
}

function assessment(data: WavesData, mode: HazardMode): HazardAssessment {
  const legend = data.rain.layers[mode].classes.map((entry) => ({
    ...entry,
    imageData: "",
    contentType: "image/png",
  }));
  return {
    record: data.rain.record,
    version: data.rain.record.status?.replace("Most Recent Version: ", "") || "Unavailable",
    basins: true,
    segments: true,
    perimeter: true,
    notes: [],
    basinLegend: legend,
    segmentLegend: legend,
    retrieved: data.rain.retrievedAt,
  };
}

function WavesMap({
  data,
  step,
  mode,
  plumeDay,
  onPlumeDay,
  coverage,
  playing,
  onPlaying,
  smokeLayer,
  onSatelliteFrameTime,
  onGoesDetails,
  goes,
  hrrr,
  soilSeries,
  showSoil,
  recovery,
  rainRequested,
  rainScenarios,
  rainIntensity,
  onSmokeLayer,
  ground,
  groundView,
}: {
  data: WavesData;
  step: WaveStep;
  mode: HazardMode;
  plumeDay: PlumeDay | undefined;
  onPlumeDay: (date: string) => void;
  coverage: Record<string, boolean | null>;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  smokeLayer: string;
  onSatelliteFrameTime: (time: string | null) => void;
  onGoesDetails: (details: ReactNode | null) => void;
  goes?: GoesProduct & { caseId: string };
  hrrr?: HrrrProduct & { caseId: string };
  soilSeries?: SoilSeries;
  showSoil: boolean;
  recovery?: RecoveryData;
  rainRequested: boolean;
  rainScenarios: RainScenarios | null;
  rainIntensity: number;
  onSmokeLayer: (layer: string) => void;
  ground: FireGround | null;
  groundView: "severity" | "slope";
}) {
  const groundActive = step === "context";
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const [readyMap, setReadyMap] = useState<LibreMap | null>(null);
  const [failure, setFailure] = useState({ source: "", message: "" });
  const [plumes, setPlumes] = useState<FeatureCollection>(emptyFeatures);
  const [plumeStatus, setPlumeStatus] = useState("Loading…");
  const [hrrrScale, setHrrrScale] = useState<HrrrScale | null>(null);
  const [soilGeometry, setSoilGeometry] = useState<FeatureCollection | null>(null);
  const [soilError, setSoilError] = useState("");
  const goesAvailable = !!goes;
  function changeSmokeLayer(layer: string) {
    onPlaying(false);
    if (layer !== "goes") {
      onSatelliteFrameTime(null);
      onGoesDetails(null);
    }
    onSmokeLayer(layer);
  }
  const smokeModeSwitch = (
    <SmokeLayerSwitch
      active={smokeLayer}
      dailyAvailable={data.smoke.plumes.days.some(
        (day) => day.status === "available" && day.dateUtc >= data.case.ignition,
      )}
      goesAvailable={goesAvailable}
      hrrrAvailable={!!hrrr}
      onSelect={changeSmokeLayer}
    />
  );
  const [unavailableDays, setUnavailableDays] = useState<Record<string, null>>({});
  const groundLayer = groundView === "slope" ? ground?.slope : ground?.severity;
  useEffect(() => {
    if (!container.current) return;
    const [west, south, east, north] =
      step === "rain" && rainRequested && rainScenarios
        ? rainScenarios.bounds
        : data.rain.layers.likelihood.bounds;
    const map = new maplibregl.Map({
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
      center: [(west + east) / 2, (south + north) / 2],
      zoom: 10,
      maxZoom: 16,
    });
    mapRef.current = map;
    map.getCanvas().setAttribute("aria-label", `Historical ${data.case.name} replay map`);
    map.on("error", (event) => {
      if (cancelledMapRequest(event.error)) return;
      const source =
        "sourceId" in event && typeof event.sourceId === "string" ? event.sourceId : "";
      setFailure({
        source,
        message:
          source === "usgs-topo"
            ? "Background map unavailable; historical layers and charts remain available."
            : "Map layer unavailable; chart data remains available.",
      });
    });
    map.on("sourcedata", (event) => {
      if (!event.isSourceLoaded || event.sourceDataType !== "content") return;
      if (event.tile && event.tile.state !== "loaded") return;
      setFailure((previous) =>
        previous.source === event.sourceId ? { source: "", message: "" } : previous,
      );
    });
    map.on("load", () => {
      addBasemap(map);
      muteBasemap(map);
      const style = getComputedStyle(container.current!);
      map.addSource("plumes", { type: "geojson", data: emptyFeatures });
      map.addLayer({
        id: "plumes",
        source: "plumes",
        type: "fill",
        paint: {
          "fill-color": [
            "match",
            ["get", "density"],
            "heavy",
            style.getPropertyValue("--smoke-haze-heavy").trim(),
            style.getPropertyValue("--smoke-haze-medium").trim(),
          ],
          "fill-opacity": 0.4,
          "fill-opacity-transition": {
            duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150,
            delay: 0,
          },
        },
      });
      for (const key of ["likelihood", "volume", "combined"] as const) {
        const layer = data.rain.layers[key];
        if (layer.status !== "available") continue;
        const [west, south, east, north] = layer.bounds;
        map.addSource(key, {
          type: "image",
          url: layer.image,
          coordinates: [
            [west, north],
            [east, north],
            [east, south],
            [west, south],
          ],
        });
        map.addLayer({
          id: key,
          type: "raster",
          source: key,
          layout: { visibility: "none" },
          paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 },
        });
      }
      map.addSource("perimeter", {
        type: "geojson",
        data: data.perimeter.value,
      });
      map.addSource("soil-grids", { type: "geojson", data: emptyFeatures });
      map.addLayer({
        id: "soil-grids",
        type: "fill",
        source: "soil-grids",
        layout: { visibility: "none" },
        paint: {
          "fill-color": [
            "match",
            ["get", "status"],
            "above",
            soilColors.above,
            "below",
            soilColors.below,
            soilColors.unknown,
          ],
          "fill-opacity": ["case", ["==", ["get", "status"], "unknown"], 0.12, 0.65],
        },
      });
      map.addLayer({
        id: "soil-lines",
        type: "line",
        source: "soil-grids",
        layout: { visibility: "none" },
        paint: { "line-color": "#53665a", "line-width": 1 },
      });
      map.addLayer({
        id: "perimeter",
        type: "line",
        source: "perimeter",
        layout: { ...boundaryLayout },
        paint: { ...perimeterPaint },
      });
      setReadyMap(map);
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [data]);
  useEffect(() => {
    if (step !== "recovery" || !showSoil || !data.ash.geometry.path) return;
    const controller = new AbortController();
    setSoilError("");
    async function load() {
      try {
        const response = await fetch(data.ash.geometry.path!, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Missing soil geometry");
        const geometry = await response.json();
        if (
          geometry.type !== "FeatureCollection" ||
          geometry.features?.length !== data.ash.geometry.count
        )
          throw new Error("Incomplete soil geometry");
        if (!controller.signal.aborted) setSoilGeometry(geometry);
      } catch {
        if (!controller.signal.aborted) {
          setSoilGeometry(null);
          setSoilError("Sampling-grid map could not load; chart results remain available.");
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [step, showSoil, data.ash.geometry]);
  useEffect(() => {
    const map = readyMap;
    if (!map) return;
    let features = emptyFeatures;
    if (step === "recovery" && showSoil && soilGeometry && soilSeries) {
      try {
        features = soilGridFeatures(soilGeometry, soilSeries);
        setSoilError("");
      } catch {
        setSoilError("Soil grid identities could not be matched; no values are mapped.");
      }
    }
    (map.getSource("soil-grids") as maplibregl.GeoJSONSource).setData(features);
    for (const id of ["soil-grids", "soil-lines"])
      map.setLayoutProperty(
        id,
        "visibility",
        step === "recovery" && showSoil && !groundActive ? "visible" : "none",
      );
    const popup = new maplibregl.Popup();
    function showGrid(event: maplibregl.MapLayerMouseEvent) {
      const props = event.features?.[0]?.properties;
      if (!props || !soilSeries) return;
      const value =
        props.value === null || props.status === "unknown"
          ? "No verified result"
          : `${props.value} mg/kg geometric mean`;
      popup
        .setLngLat(event.lngLat)
        .setText(`${props.gridId} / ${soilSeries.name}: ${value}. Not a property result.`)
        .addTo(event.target);
    }
    map.on("click", "soil-grids", showGrid);
    return () => {
      map.off("click", "soil-grids", showGrid);
      popup.remove();
    };
  }, [readyMap, step, showSoil, soilGeometry, soilSeries, groundActive]);
  useEffect(() => {
    const controller = new AbortController();

    if (step !== "smoke" || smokeLayer !== "hms") return;
    setPlumeStatus("Loading…");
    async function load() {
      try {
        if (!plumeDay || plumeDay.status !== "available" || !plumeDay.path)
          throw new Error("Missing NOAA file");
        const response = await fetch(plumeDay.path, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("NOAA file unavailable");
        const data = await response.json();
        if (data.type !== "FeatureCollection" || !Array.isArray(data.features))
          throw new Error("NOAA geometry unavailable");
        for (const feature of data.features) {
          if (
            feature.geometry?.type !== "Polygon" ||
            !["medium", "heavy"].includes(feature.properties?.density)
          )
            throw new Error("NOAA geometry unavailable");
        }
        if (!controller.signal.aborted) {
          setPlumes(data);
          setUnavailableDays((previous) => {
            const next = { ...previous };
            delete next[plumeDay.dateUtc];
            return next;
          });
          const intersects = coverage[plumeDay.dateUtc];
          let status = "Fire overlap not checked";
          if (intersects === true) status = "Medium/heavy smoke mapped over this fire";
          if (intersects === false) status = "No medium/heavy plume mapped over this fire";
          setPlumeStatus(status);
        }
      } catch {
        if (!controller.signal.aborted) {
          setPlumes(emptyFeatures);
          if (plumeDay)
            setUnavailableDays((previous) => ({
              ...previous,
              [plumeDay.dateUtc]: null,
            }));
          setPlumeStatus("NOAA plume layer unavailable; monitor data remains available.");
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [plumeDay, coverage, step, smokeLayer]);
  useEffect(() => {
    const map = mapRef.current;

    if (!map || map !== readyMap) return;
    const source = map.getSource("plumes") as maplibregl.GeoJSONSource;
    map.setLayoutProperty(
      "plumes",
      "visibility",
      step === "smoke" && !groundActive && smokeLayer === "hms" ? "visible" : "none",
    );
    source.setData(plumes);
  }, [readyMap, plumes, step, smokeLayer, groundActive]);
  function fit() {
    const map = mapRef.current;
    if (!map) return;
    const extent =
      ground?.severity?.bounds || ground?.slope?.bounds || data.rain.layers.likelihood.bounds;
    const bounds = new maplibregl.LngLatBounds([extent[0], extent[1]], [extent[2], extent[3]]);
    const padding = mapPadding(map.getContainer());
    map.fitBounds(bounds, {
      padding,
      maxZoom: 12,
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300,
    });
  }
  useEffect(() => {
    const map = mapRef.current;
    if (!map || map !== readyMap) return;
    for (const key of ["likelihood", "volume", "combined"] as const) {
      if (map.getLayer(key))
        map.setLayoutProperty(
          key,
          "visibility",
          step === "rain" && !groundActive && !rainRequested && mode === key ? "visible" : "none",
        );
    }
    map.setLayoutProperty(
      "perimeter",
      "visibility",
      (groundActive && groundLayer) || (step === "rain" && rainRequested) ? "none" : "visible",
    );
  }, [readyMap, step, mode, rainRequested, groundActive, groundLayer]);
  useEffect(() => {
    const map = readyMap;
    if (!map) return;
    fit();
    const dashboard = map.getContainer().closest<HTMLElement>(".guided-dashboard");
    const resizeMap = () => {
      if (dashboard?.dataset.panelResizing === "true") return;
      map.resize();
      fit();
    };
    const observer = new ResizeObserver(resizeMap);
    observer.observe(map.getContainer());
    dashboard?.addEventListener("panelresizeend", resizeMap);

    return () => {
      observer.disconnect();
      dashboard?.removeEventListener("panelresizeend", resizeMap);
    };
  }, [
    readyMap,
    step,
    smokeLayer,
    soilGeometry,
    showSoil,
    rainRequested,
    rainScenarios,
    ground,
    groundActive,
    groundView,
  ]);
  let rainDescription = `Historical USGS ${mode} under the published ${data.rain.record.Rainfall} scenario, ${utcDate(data.rain.record.assessment_date)}. Not a current warning.`;
  if (rainRequested) {
    rainDescription = "Rainfall scenario map unavailable; no older assessment substituted.";
    if (rainScenarios) {
      rainDescription = `Historical USGS ${mode}, ${rainIntensity} mm/hour peak 15-minute scenario. Assessed ${rainScenarios.assessmentDate}, version ${rainScenarios.version}. ${rainScenarios.unmappedBasinIds.length} invalid basin polygons unfilled. Not a current warning.`;
    }
  }
  if (groundActive) {
    let groundDescription;
    if (groundLayer) {
      if (groundView === "slope") {
        groundDescription = `Static USGS 3DEP slope for ${data.case.name}, under ${ground!.slope!.thresholdDegrees} degrees or at least that threshold. 10 m analysis grid. Elevation editions are not fire-date measurements. Not a debris-flow estimate.`;
      } else {
        groundDescription = `Historical MTBS burn severity for ${data.case.name}. Dates and source in ground evidence. Not a current assessment.`;
      }
    } else {
      groundDescription =
        "Ground layer unavailable or loading; the fire assessment boundary remains visible.";
    }
    rainDescription = groundDescription;
  }
  const legendItems: { label: string; color?: string; boundary?: boolean }[] = [];
  if (groundActive && groundView === "severity" && ground?.severity) {
    legendItems.push(...mtbsClasses);
  } else if (groundActive && groundView === "slope" && ground?.slope) {
    legendItems.push(
      {
        label: `Under ${ground.slope.thresholdDegrees}°`,
        color: ground.slope.colors.below,
      },
      {
        label: `${ground.slope.thresholdDegrees}° or steeper`,
        color: ground.slope.colors.atOrAbove,
      },
    );
  } else if (step === "rain") {
    if (rainScenarios || (!rainRequested && data.rain.layers[mode].status === "available")) {
      for (const entry of hazardClasses[mode]) {
        legendItems.push({
          label: entry.label.replaceAll("m^3", "m³"),
          color: entry.color,
        });
      }
    }
  } else {
    legendItems.push({
      label: `${data.case.name} assessment boundary`,
      boundary: true,
    });
    if (step === "recovery" && showSoil && soilSeries) {
      legendItems.push(
        { label: `Above ${soilSeries.thresholdMgKg}`, color: soilColors.above },
        {
          label: `Not above ${soilSeries.thresholdMgKg}`,
          color: soilColors.below,
        },
        { label: "No verified result", color: soilColors.unknown },
      );
    }
    if (step === "smoke" && smokeLayer === "hms") {
      legendItems.push(
        { label: "Medium smoke overhead", color: "var(--smoke-haze-medium)" },
        { label: "Heavy smoke overhead", color: "var(--smoke-haze-heavy)" },
      );
    }
    if (step === "smoke" && smokeLayer === "goes") {
      legendItems.push(
        {
          label: "GOES smoke detected overhead",
          color: "var(--smoke-haze-heavy)",
        },
        { label: "Unknown / excluded", color: "#aeb4ba" },
      );
    }
  }
  if (step === "recovery" && recovery?.damage.categories) {
    for (const category of recovery.damage.categories) {
      if (category.count > 0) legendItems.push({ label: category.label, color: category.color });
    }
  }
  let recoveryDescription;
  if (recovery) {
    recoveryDescription =
      "CAL FIRE exterior structure inspections, colored by recorded damage. Category counts and limitations are in the Building damage card. Not rebuilding progress or property clearance.";
  } else {
    recoveryDescription = `${soilGeometry && soilSeries && !soilError ? `County reference sampling cells: ${soilSeries.name} geometric means; screening level ${soilSeries.thresholdMgKg} mg/kg. Unlabeled cells have no verified result. Values in chart Details.` : "Sampling-grid map unavailable."} Not contamination boundaries or individual property results.`;
  }
  let mapDescription;
  if (groundActive) {
    mapDescription = rainDescription;
  } else if (step === "smoke") {
    let smokeDescription;
    if (smokeLayer === "hrrr") {
      smokeDescription =
        "NOAA modeled near-surface smoke, historical, in micrograms per cubic metre. Model estimate, not a monitor reading or smoke attributed to a single fire. Pacific valid time and numerical scale in playback controls.";
    } else if (smokeLayer === "goes") {
      smokeDescription =
        "Historical GOES-18 smoke detections overhead; gray means unknown. Frame time and coverage in GOES controls, not ground-level PM2.5.";
    } else {
      smokeDescription = `NOAA medium/heavy smoke detected overhead, not measured at ground level. ${plumeDay?.dateUtc || "Unavailable"} UTC: ${plumeStatus}.`;
    }
    mapDescription = `${smokeDescription}`;
  } else if (step === "recovery") {
    mapDescription = recoveryDescription;
  } else {
    mapDescription = rainDescription;
  }
  let smokePlayback;
  if (step === "smoke" && !groundActive) {
    if (smokeLayer === "hrrr" && hrrr) {
      smokePlayback = (
        <WavesHrrr
          map={readyMap}
          product={hrrr}
          modeSwitch={smokeModeSwitch}
          startDate={data.case.ignition}
          onScale={setHrrrScale}
        />
      );
    } else if (smokeLayer === "goes" && goes) {
      smokePlayback = (
        <WavesGoes
          map={readyMap}
          product={goes}
          modeSwitch={smokeModeSwitch}
          onFrameTime={onSatelliteFrameTime}
          onDetails={onGoesDetails}
        />
      );
    } else if (plumeDay) {
      smokePlayback = (
        <SmokePlayback
          days={data.smoke.plumes.days.filter((day) => day.dateUtc >= data.case.ignition)}
          selectedDate={plumeDay.dateUtc}
          onDate={onPlumeDay}
          coverage={{ ...coverage, ...unavailableDays }}
          status={plumeStatus}
          playing={playing}
          onPlaying={onPlaying}
          modeSwitch={smokeModeSwitch}
        />
      );
    } else {
      smokePlayback = (
        <UnavailableSmokePlayback modeSwitch={smokeModeSwitch} status="Daily map unavailable" />
      );
    }
  }
  return (
    <section
      className={`map-section waves-map-section${step === "smoke" && !groundActive ? " waves-smoke-map" : ""}`}
      data-smoke-layer={smokeLayer}
      aria-label="Historical fire map"
    >
      <div className="map-frame">
        <div
          ref={container}
          className="map"
          role="img"
          aria-label={`${data.case.name}, ${data.case.county}. ${mapDescription}`}
        />
        <div className="map-actions" role="group" aria-label="Historical map navigation">
          <button aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
            <Icon name="plus" />
          </button>
          <button aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
            <Icon name="minus" />
          </button>
          <button aria-label="Fit fire" onClick={fit}>
            <Icon name="fit" />
          </button>
        </div>
        {failure.message && (
          <div className="waves-map-message fine" role="status">
            {failure.message}
          </div>
        )}
        {step === "recovery" &&
          showSoil &&
          !groundActive &&
          (soilError || data.ash.geometry.status !== "available") && (
            <div className="waves-map-message fine" role="status">
              {soilError || data.ash.geometry.reason}
            </div>
          )}
        <MapLegend hidden={legendItems.length === 0}>
          <div
            className={
              groundActive && groundView === "severity"
                ? "waves-legend-items severity-legend"
                : "waves-legend-items"
            }
          >
            {legendItems.map((item) => (
              <div className="waves-legend-row" key={item.label}>
                <span
                  className={item.boundary ? "swatch usgs-boundary" : "swatch"}
                  style={item.color ? { background: item.color } : undefined}
                />
                <span>{item.label}</span>
              </div>
            ))}
            {step === "smoke" && smokeLayer === "hrrr" && hrrrScale && (
              <HrrrScaleLegend scale={hrrrScale} />
            )}
          </div>
        </MapLegend>
      </div>
      <RecoveryLayers map={readyMap} data={recovery} />
      {groundActive && groundLayer && ground && readyMap && (
        <FireGroundLayer
          map={readyMap}
          ground={ground}
          view={groundView}
          perimeter={data.perimeter.value}
        />
      )}
      {step === "rain" && !groundActive && rainRequested && rainScenarios && readyMap && (
        <RainScenarioLayers
          map={readyMap}
          data={rainScenarios}
          mode={mode}
          intensity={rainIntensity}
        />
      )}
      {step === "smoke" && !groundActive && (
        <div className="waves-smoke-controls historical-smoke-controls">{smokePlayback}</div>
      )}
    </section>
  );
}
