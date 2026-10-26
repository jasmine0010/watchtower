import type { ReactNode } from "react";
import { EvidenceCard, LoadingBars } from "./EvidenceCard";
import { Icon, type IconName } from "./Icons";
import { designStormText } from "./usgsAssessments";
import { RainIntensitySlider, type RainScenarios } from "./RainScenarios";
import type { CompanionState } from "./CoordinatedRain";
import type { RunoutState } from "./runout";
import type { HazardAssessment, HazardMode } from "./usgsHazards";

function ScenarioRainfall({ data }: { data: HazardAssessment }) {
  const rainfall = designStormText(data.record.Rainfall);
  const readout = rainfall.replace(" (peak 15-minute intensity)", "");
  return (
    <figure className="guide-chart agency-chart">
      <Icon name="droplet" />
      <p className="chart-readout">{readout}</p>
    </figure>
  );
}

export type RainPanelView =
  | { kind: "loading"; label: string }
  | {
      kind: "coordinated";
      state: CompanionState;
      intensity: number | null;
      onIntensity: (value: number) => void;
      showTravel: boolean;
      onTravel: (value: boolean) => void;
      runout: RunoutState;
    }
  | {
      kind: "archive";
      data: RainScenarios;
      intensity: number;
      onIntensity: (value: number) => void;
    }
  | {
      kind: "single";
      assessment: HazardAssessment;
      title: string;
      source: ReactNode;
      availableModes?: HazardMode[];
    }
  | { kind: "unavailable"; message: string };

export function RainPanel({
  view,
  mode,
  onMode,
}: {
  view: RainPanelView;
  mode: HazardMode;
  onMode: (mode: HazardMode) => void;
}) {
  if (view.kind === "loading")
    return <LoadingBars className="compact-loading" label={view.label} />;
  if (view.kind === "unavailable")
    return (
      <p className="quiet-failure" role="status">
        {view.message}
      </p>
    );

  const coordinated = view.kind === "coordinated";
  const release = coordinated ? view.state.data || view.state.entry : null;
  if (coordinated && !release) {
    let message;
    if (view.state.mismatch) {
      message = "Assessment versions do not match.";
    } else if (
      view.state.failed ||
      view.state.catalogStatus === "failed" ||
      view.state.catalogStatus === "available"
    ) {
      message = "Coordinated assessment unavailable. Other assessment remains separate.";
    } else {
      message = null;
    }
    return message ? (
      <p className="quiet-failure" role="status">
        {message}
      </p>
    ) : (
      <LoadingBars className="compact-loading" label="Loading coordinated rainfall assessment" />
    );
  }

  let title = "Published rainfall scenarios";
  let source: ReactNode;
  let content: ReactNode;

  if (view.kind === "coordinated") {
    const assessment = release!;
    const steps = view.state.data?.steps || view.state.entry!.intensities;
    source = <a href={assessment.sourceUrl}>USGS runout release</a>;
    content = (
      <>
        <RainIntensitySlider
          steps={steps}
          intensity={view.intensity ?? steps[0]}
          onIntensity={view.onIntensity}
          response={mode === "likelihood" ? view.state.data?.responseShares?.likelihood : undefined}
          mode={mode}
        />
        <div className="rain-panel-meta">
          <label className="context-option">
            <input
              type="checkbox"
              checked={view.showTravel}
              onChange={(event) => view.onTravel(event.target.checked)}
            />
            Show travel extent
          </label>
        </div>
        {!view.state.data && view.state.failed && (
          <p className="quiet-failure" role="status">
            Basin estimates unavailable; travel extent can still load.
          </p>
        )}
        {!view.state.data && !view.state.failed && (
          <LoadingBars className="compact-loading" label="Loading basin estimates" />
        )}
        {view.showTravel &&
          view.intensity !== null &&
          view.runout.status !== "available" &&
          (view.state.catalogStatus === "failed" ||
          (!view.state.entry && view.state.catalogStatus === "available") ||
          view.runout.status === "failed" ? (
            <p className="fine rain-panel-status" role="status">
              {view.state.catalogStatus === "failed" ||
              (!view.state.entry && view.state.catalogStatus === "available")
                ? "Travel release unavailable; basin estimates remain available."
                : "Travel extent unavailable; basin estimates remain available."}
            </p>
          ) : (
            <LoadingBars className="compact-loading" label="Loading travel extent" />
          ))}
      </>
    );
  } else if (view.kind === "archive") {
    const data = view.data;
    source = <a href={data.sourceUrl}>USGS assessment archive</a>;
    content = (
      <>
        <RainIntensitySlider
          steps={data.steps}
          intensity={view.intensity}
          onIntensity={view.onIntensity}
          response={data.responseShares?.[mode]}
          mode={mode}
        />
      </>
    );
  } else {
    title = view.title;
    source = view.source;
    content = <ScenarioRainfall data={view.assessment} />;
  }

  let choices: HazardMode[];
  if (coordinated) {
    choices = ["likelihood", "volume"];
  } else if (view.kind === "single") {
    choices = view.availableModes || [mode];
  } else {
    choices = (["likelihood", "volume", "combined"] as HazardMode[]).filter(
      (choice) =>
        view.kind === "archive" &&
        view.data.classes[{ likelihood: "P", volume: "V", combined: "H" }[choice]]?.length,
    );
  }
  const names = { likelihood: "Chance", volume: "Amount", combined: "Combined" };
  const icons: Record<HazardMode, IconName> = {
    likelihood: "alert",
    volume: "droplet",
    combined: "map",
  };
  return (
    <EvidenceCard title={title} className="rain-panel-card" kind="Historical" source={source}>
      <div
        className="view-toggle waves-modes fire-context-switch"
        role="group"
        aria-label={coordinated ? "Coordinated basin metric" : "Agency scenario metric"}
      >
        {choices.map((choice) => (
          <button key={choice} aria-pressed={mode === choice} onClick={() => onMode(choice)}>
            <Icon name={icons[choice]} />
            {names[choice]}
          </button>
        ))}
      </div>
      {content}
    </EvidenceCard>
  );
}
