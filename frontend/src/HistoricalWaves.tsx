import { useEffect, useState, type ReactNode } from "react";
import type { FeatureCollection } from "geojson";
import type { HistoricalRecord } from "./historicalFires";
import { readHistoricalBoundary } from "./historicalFires";
import { boundaryBounds, loadFireBoundary } from "./mtbs";
import { loadAssessmentBoundary, hazardSource, type HazardMode } from "./usgsHazards";
import { useFireProducts } from "./useFireProducts";
import { useRunout } from "./runout";
import { StepPanel } from "./StepPanel";
import { waveSteps, SmokeCharts } from "./WavesPanel";
import { useHistoricalEvidence } from "./historicalEvidence";
import type { WavesData } from "./waves";
import { SmokePlayback, SmokeLayerSwitch, UnavailableSmokePlayback } from "./WavesSmoke";
import { readFireRainScenarios, type RainScenarios } from "./RainScenarios";
import { RainPanel, type RainPanelView } from "./RainPanel";
import { EvidenceCard, LoadingBars } from "./EvidenceCard";
import type { WaveStep } from "./navigation";
import { FireVisualizations } from "./FireVisualizations";
import HistoricalWavesMap from "./HistoricalWavesMap";
import { RecoveryCards } from "./RecoveryPanel";
import { useHistoricalObservations, observationPoints } from "./HistoricalObservations";
import { GroundEvidence, type FireGround } from "./WavesRain";
import { FireContextViewSelector } from "./burnArea";

function shortReason(reason: string | undefined) {
  if (
    reason ===
    "Checked EPA archives: no numeric observations in the selected hourly window among up to five audited sites within 50 km. More distant sites not evaluated."
  )
    return "No EPA monitor data found.";
  if (
    reason ===
    "Completed assessment catalog and annual attachment-index search; no verified fire-to-release link. No nearby assessment was substituted."
  )
    return "No rainfall assessment found.";
  if (
    reason ===
    "The approved limited-study registry was checked. This fire has no documented study link; regional health findings and other fires' soil results are not transferred."
  )
    return "No soil study linked to this fire.";
  return reason || "";
}

function useBoundary(record: HistoricalRecord | null) {
  const [loaded, setLoaded] = useState<{
    id: string;
    value: FeatureCollection;
  } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!record) return;
    const controller = new AbortController();
    async function load() {
      let value: FeatureCollection | null = null;
      if (record!.boundaryUrl) {
        const response = await fetch(record!.boundaryUrl, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Boundary request failed.");
        value = readHistoricalBoundary(await response.json(), record!);
      } else if (record!.mtbs)
        value = {
          type: "FeatureCollection",
          features: [await loadFireBoundary(record!.mtbs, controller.signal)],
        };
      else if (record!.assessment)
        value = await loadAssessmentBoundary(record!.assessment, controller.signal);
      if (!controller.signal.aborted && value) setLoaded({ id: record!.id, value });
    }
    load().catch(() => {
      if (!controller.signal.aborted) setFailure(record.id);
    });
    return () => controller.abort();
  }, [record]);
  return {
    value: loaded && loaded.id === record?.id ? loaded.value : null,
    failed: failure === record?.id,
  };
}

export default function HistoricalWaves({
  record,
  failed,
  picker,
  step,
  onStep,
  mode,
  onMode,
}: {
  record: HistoricalRecord | null;
  failed: boolean;
  picker: ReactNode;
  step: WaveStep;
  onStep: (step: WaveStep) => void;
  mode: HazardMode;
  onMode: (mode: HazardMode) => void;
}) {
  const observations = useHistoricalObservations(record?.id || null, step === "rain");
  const [smokeSelection, setSmokeSelection] = useState({
    recordId: record?.id || "",
    layer: "hms",
  });
  const selectedSmokeLayer = smokeSelection.recordId === record?.id ? smokeSelection.layer : "hms";
  const [satelliteFrameTime, setSatelliteFrameTime] = useState<string | null>(null);
  const [contextView, setContextView] = useState<"severity" | "slope">("severity");
  const satellite = useHistoricalEvidence(record, step === "smoke" ? "goes" : null);
  const goesProduct = satellite?.data?.goes?.status === "available" ? satellite.data.goes : null;

  const evidence = useHistoricalEvidence(
    record,
    step === "smoke"
      ? "smoke"
      : step === "recovery"
        ? "recovery"
        : step === "rain" && !record?.coordinatedRain
          ? "rain"
          : step === "context"
            ? "context"
            : null,
  );
  const hrrrProduct = evidence?.data?.hrrr?.status === "available" ? evidence.data.hrrr : null;
  const slope = evidence?.data?.context?.slope || null;
  const activeContextView = slope ? contextView : "severity";
  const ground: FireGround | null = slope
    ? {
        key: record!.id,
        name: record!.name,
        boundary: null,
        severity: null,
        message: "",
        retrievedAt: slope.retrievedAt,
        supplement: null,
        slope,
        supplementMessage: "",
      }
    : null;
  const remoteBoundary = useBoundary(record);
  const cachedBoundary =
    evidence?.data?.perimeter?.status === "available" ? evidence.data.perimeter.value : null;
  const boundary = {
    value: cachedBoundary || remoteBoundary.value,
    failed: !cachedBoundary && remoteBoundary.failed,
  };
  const smoke =
    evidence?.data?.smoke.status === "available"
      ? (evidence.data.smoke as WavesData["smoke"])
      : null;
  const [plumeDate, setPlumeDate] = useState("");
  const [plumeLoading, setPlumeLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPlaying(false);
    setSatelliteFrameTime(null);
  }, [record?.id]);
  function changeSmokeLayer(layer: string) {
    setPlaying(false);
    if (layer !== "goes") setSatelliteFrameTime(null);
    setSmokeSelection({ recordId: record?.id || "", layer });
  }
  const replayDays =
    smoke?.plumes.days.filter((day) => day.dateUtc >= (record?.ignition || "")) || [];
  const dailyAvailable = replayDays.some((day) => day.status === "available");
  const smokeLayer =
    selectedSmokeLayer === "hms" && !dailyAvailable && hrrrProduct ? "hrrr" : selectedSmokeLayer;
  const smokeModeSwitch = (
    <SmokeLayerSwitch
      active={smokeLayer}
      dailyAvailable={dailyAvailable}
      goesAvailable={!!goesProduct}
      hrrrAvailable={!!hrrrProduct}
      dailyLabel={record && record.year <= 2020 ? "Observed smoke" : "Daily"}
      onSelect={changeSmokeLayer}
    />
  );
  const initialDate = replayDays[0]?.dateUtc || "";
  const selectedDate = replayDays.some((day) => day.dateUtc === plumeDate)
    ? plumeDate
    : initialDate;
  const plumeDay = replayDays.find((day) => day.dateUtc === selectedDate);
  let smokePlayback;
  if (record && step === "smoke" && smokeLayer === "hrrr" && !hrrrProduct) {
    smokePlayback = (
      <UnavailableSmokePlayback
        modeSwitch={smokeModeSwitch}
        status={evidence?.data?.checks.hrrr?.reason || evidence?.check?.reason || "Loading…"}
        label="Modeled smoke replay"
      />
    );
  } else if (record && step === "smoke" && smokeLayer === "hms") {
    if (dailyAvailable) {
      let plumeStatus;
      if (plumeLoading) {
        plumeStatus = "Loading…";
      } else if (plumeDay?.status === "available") {
        plumeStatus = "Available";
      } else if (plumeDay?.status === "not_elapsed") {
        plumeStatus = "Future day / not checked";
      } else {
        plumeStatus = "Source check failed or file unavailable";
      }
      smokePlayback = (
        <SmokePlayback
          days={replayDays}
          selectedDate={selectedDate}
          onDate={setPlumeDate}
          coverage={evidence?.data?.plumeCoverage || {}}
          status={plumeStatus}
          playing={playing}
          onPlaying={setPlaying}
          modeSwitch={smokeModeSwitch}
        />
      );
    } else {
      smokePlayback = (
        <UnavailableSmokePlayback
          modeSwitch={smokeModeSwitch}
          label="Smoke replay"
          status={evidence?.data ? "Choose a replay mode" : "Loading…"}
        />
      );
    }
  } else {
    smokePlayback = null;
  }
  const enabled = step === "context" || step === "rain";
  const products = useFireProducts(
    enabled ? record?.mtbs || null : null,
    enabled ? record?.assessment || null : null,
  );
  const [intensity, setIntensity] = useState<number | null>(null);
  const [rainResult, setRainResult] = useState<{
    fireId: string;
    url: string;
    data: RainScenarios | null;
    failed: boolean;
  } | null>(null);
  const rainUrl = evidence?.data?.rainUrl;
  const currentRainResult =
    rainResult?.fireId === record?.id && rainResult?.url === rainUrl ? rainResult : null;
  const rainArchive = currentRainResult?.data || null;
  const rainFailed = currentRainResult?.failed || false;
  useEffect(() => {
    const url = rainUrl;
    if (!record || !url) return;
    const controller = new AbortController();
    async function load() {
      const response = await fetch(url!, { signal: controller.signal });
      if (!response.ok) throw new Error("Assessment could not load.");
      const data = readFireRainScenarios(
        await response.json(),
        record!,
        record!.name,
        url,
        evidence?.data?.checks.rain?.releaseChecks,
      );
      if (!controller.signal.aborted)
        setRainResult({ fireId: record!.id, url: url!, data, failed: false });
    }
    void load().catch(() => {
      if (!controller.signal.aborted)
        setRainResult({ fireId: record.id, url, data: null, failed: true });
    });
    return () => controller.abort();
  }, [rainUrl, record, evidence?.data?.checks.rain?.releaseChecks]);
  const steps = rainArchive?.steps || [];
  const selected =
    intensity !== null && steps.includes(intensity)
      ? intensity
      : (rainArchive?.defaultIntensity ?? steps[0] ?? null);
  const runout = useRunout(record?.runout || null, false, selected || 0, 0);
  const activeMode = mode;
  const hazard =
    step === "rain" && !evidence?.data?.rainUrl ? products.hazards[mode] || null : null;
  let bounds =
    (step === "rain" ? rainArchive?.bounds : null) ||
    products.bounds ||
    record?.bounds ||
    (step === "context" ? slope?.bounds : null) ||
    null;
  if (!bounds && boundary.value?.features.length) {
    const feature = boundary.value.features[0];
    if (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon")
      bounds = boundaryBounds({ ...feature, geometry: feature.geometry });
  }
  if (step === "rain" && bounds && observations?.data) {
    bounds = [...bounds];
    for (const observation of observations.data.records) {
      bounds[0] = Math.min(bounds[0], observation.longitude);
      bounds[1] = Math.min(bounds[1], observation.latitude);
      bounds[2] = Math.max(bounds[2], observation.longitude);
      bounds[3] = Math.max(bounds[3], observation.latitude);
    }
  }
  const emptyRunout = {
    ...runout,
    status: "unavailable" as const,
    contours: null,
  };
  let rainView: RainPanelView = {
    kind: "unavailable",
    message: "No verified USGS scenario is linked to this record.",
  };
  if (rainArchive && selected !== null) {
    rainView = {
      kind: "archive",
      data: rainArchive,
      intensity: selected,
      onIntensity: setIntensity,
    };
  } else if (evidence?.data?.rainUrl) {
    rainView = rainFailed
      ? { kind: "unavailable", message: "No rainfall assessment found." }
      : { kind: "loading", label: "Loading rainfall assessment" };
  } else if (hazard) {
    rainView = {
      kind: "single",
      assessment: hazard,
      title: "USGS scenario",
      source: <a href={hazardSource}>USGS source</a>,
      availableModes: [activeMode],
    };
  } else if (record?.archiveFiles || record?.assessment || record?.mtbs) {
    if (record.archiveFiles && !record.assessment && !record.mtbs) {
      rainView = {
        kind: "unavailable",
        message: "USGS archive available; scenario layers have not been prepared for this release.",
      };
    } else if (
      products.loading &&
      !evidence?.data?.checks.rain?.reason &&
      !evidence?.check?.reason
    ) {
      rainView = { kind: "loading", label: "Loading rainfall assessment" };
    } else {
      rainView = {
        kind: "unavailable",
        message: shortReason(
          evidence?.data?.checks.rain?.reason ||
            evidence?.check?.reason ||
            products.association ||
            products.message ||
            "No verified USGS scenario is linked to this record.",
        ),
      };
    }
  }

  return (
    <>
      <HistoricalWavesMap
        key={record?.id || "no-fire"}
        name={record?.name || "Historical fire"}
        geometry={step === "rain" && rainArchive ? null : boundary.value}
        bounds={bounds}
        raster={step === "context" && activeContextView === "severity" ? products.severity : null}
        slope={step === "context" && activeContextView === "slope" ? slope : null}
        goes={step === "smoke" && smokeLayer === "goes" ? goesProduct || undefined : undefined}
        hrrr={step === "smoke" && smokeLayer === "hrrr" ? hrrrProduct || undefined : undefined}
        smokeModeSwitch={smokeModeSwitch}
        hazard={hazard}
        mode={activeMode}
        companion={null}
        intensity={selected}
        runout={emptyRunout}
        plumeDay={step === "smoke" && smokeLayer === "hms" ? plumeDay : undefined}
        onPlumeLoading={setPlumeLoading}
        playback={smokePlayback}
        onSatelliteFrameTime={setSatelliteFrameTime}
        rainScenarios={step === "rain" ? rainArchive : null}
        recovery={step === "recovery" ? evidence?.data?.recovery : undefined}
        observations={
          step === "rain" && observations?.data ? observationPoints(observations.data) : undefined
        }
      />
      <StepPanel
        context={picker}
        steps={waveSteps}
        active={step}
        onStep={onStep}
        selectionKey={record?.id || ""}
      >
        {!record &&
          (failed ? (
            <p role="status">Historical record could not load. Choose another record.</p>
          ) : (
            <LoadingBars className="compact-loading" label="Loading historical fire record" />
          ))}
        {record && step === "smoke" && smoke ? (
          <>
            {smoke.epaStatus === "unavailable" ? (
              <p className="quiet-failure">{shortReason(smoke.reason)}</p>
            ) : (
              <SmokeCharts
                data={{
                  case: {
                    name: record.name,
                    county: "",
                    ignition: record.ignition || "",
                    sourceUrl: record.sourceUrl,
                    retrievedAt: record.retrievedAt || "",
                    dataClass: "Historical",
                  },
                  smoke,
                }}
                selectedDate={selectedDate}
                selectedTime={smokeLayer === "goes" ? satelliteFrameTime : null}
              />
            )}
          </>
        ) : evidence?.data && "reason" in evidence.data.smoke ? (
          <p className="quiet-failure" role="status">
            {shortReason(evidence.data.smoke.reason)}
          </p>
        ) : evidence?.check?.reason ? (
          <p className="quiet-failure" role="status">
            {evidence.check.reason}
          </p>
        ) : (
          <LoadingBars className="compact-loading" label="Loading historical smoke evidence" />
        )}
        {record && step === "recovery" && (
          <>
            <RecoveryCards data={evidence?.data?.recovery} check={evidence?.check} />
            <p className="quiet-failure">
              Soil testing /{" "}
              {evidence?.data?.checks.soil
                ? shortReason(evidence.data.checks.soil.reason) ||
                  evidence.data.checks.soil.status.replaceAll("_", " ")
                : "Not checked - no verified sampling study is linked to this record."}
            </p>
          </>
        )}
        {record && step === "rain" && (
          <>
            <RainPanel view={rainView} mode={activeMode} onMode={onMode} />
          </>
        )}
        {record && step === "context" && (
          <>
            {slope && <FireContextViewSelector view={contextView} onView={setContextView} />}
            {activeContextView === "slope" && ground && (
              <GroundEvidence ground={ground} view="slope" onView={setContextView} />
            )}
            {(record.mtbs || record.assessment) && (
              <FireVisualizations
                fire={record.mtbs || null}
                agency={record.assessment || null}
                products={products}
                step="burn"
              />
            )}
            {!record.mtbs && !record.assessment && (
              <EvidenceCard
                title={record.archiveFiles ? "Assessment archive" : "Fire boundary"}
                kind="Historical"
                source={<a href={record.sourceUrl}>{record.source}</a>}
                caption={record.archiveFiles ? "Assessment extent" : "Fire perimeter"}
              >
                <p>
                  {record.name} / {record.ignition || record.year || "Date not supplied"}
                </p>
              </EvidenceCard>
            )}
            {!slope &&
              !evidence?.data &&
              (evidence?.check?.reason ? (
                <p className="quiet-failure" role="status">
                  {evidence.check.reason}
                </p>
              ) : (
                <LoadingBars className="compact-loading" label="Loading terrain coverage" />
              ))}
          </>
        )}
      </StepPanel>
    </>
  );
}
