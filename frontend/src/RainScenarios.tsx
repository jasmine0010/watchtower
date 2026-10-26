import { useEffect, type CSSProperties } from "react";
import type { FeatureCollection } from "geojson";
import type { ExpressionSpecification, Map as LibreMap } from "maplibre-gl";
import { boundaryLayout, perimeterPaint } from "./MapLayers";
import { hazardClasses, type HazardMode } from "./usgsHazards";
import type { RainScenarioLink } from "./waves";
import type { HistoricalRecord } from "./historicalFires";

export type RainScenarios = {
  schemaVersion: number;
  releaseId: string;
  name: string;
  version: string;
  ignition: string;
  assessmentDate: string | null;
  sourceMetadataDate?: string;
  metadataLimitations?: string[];
  publicationDate: string;
  sourceUrl: string;
  retrievedAt: string;
  steps: number[];
  defaultIntensity: number;
  durationMinutes: number;
  intensityUnit: string;
  volumeUnit: string;
  dataClass: string;
  classes: Record<string, string[]>;
  responseShares?: Partial<Record<HazardMode, ScenarioResponse>>;
  bounds: [number, number, number, number];
  unmappedBasinIds: number[];
  identityKind?: "source-row";
  unmappedSourceFeatureIndices?: number[];
  sources?: { sha256: string }[];
  basins: FeatureCollection;
  segments: FeatureCollection;
  perimeter: FeatureCollection;
  featureCounts: Record<string, number>;
  previousAssessment: {
    ignition: string;
    assessmentDate: string;
    sourceUrl: string;
  } | null;
};

export type ScenarioResponse = {
  topClass: string;
  steps: { intensity: number; percent: number }[];
};

export function validScenarioResponse(response: ScenarioResponse | undefined, steps: number[]) {
  return (
    !response ||
    (typeof response.topClass === "string" &&
      response.topClass.length > 0 &&
      Array.isArray(response.steps) &&
      response.steps.length === steps.length &&
      response.steps.every(
        (item, index) =>
          item.intensity === steps[index] &&
          Number.isFinite(item.percent) &&
          item.percent >= 0 &&
          item.percent <= 100,
      ))
  );
}

const prefixes = { likelihood: "P", volume: "V", combined: "H" };

export function readRainScenarios(value: unknown, expectedName: string) {
  const data = value as RainScenarios;
  if (
    data?.schemaVersion !== 1 ||
    data.name !== expectedName ||
    !/^[a-f0-9]{24}$/.test(data.releaseId) ||
    data.sourceUrl !== `https://www.sciencebase.gov/catalog/item/${data.releaseId}` ||
    data.dataClass !== "Historical" ||
    data.durationMinutes !== 15 ||
    data.intensityUnit !== "mm/hour" ||
    data.volumeUnit !== "m3" ||
    (data.identityKind !== undefined && data.identityKind !== "source-row") ||
    (data.metadataLimitations !== undefined &&
      (!Array.isArray(data.metadataLimitations) ||
        data.metadataLimitations.some((text) => typeof text !== "string"))) ||
    !Array.isArray(data.steps) ||
    !data.steps.length ||
    data.steps.some(
      (step, index) =>
        !Number.isFinite(step) || step <= 0 || (index > 0 && step <= data.steps[index - 1]),
    ) ||
    !data.steps.includes(data.defaultIntensity) ||
    typeof data.version !== "string" ||
    !data.version ||
    data.previousAssessment === undefined ||
    ![
      data.ignition,
      ...(data.assessmentDate ? [data.assessmentDate] : []),
      data.publicationDate,
      ...(data.previousAssessment
        ? [data.previousAssessment.ignition, data.previousAssessment.assessmentDate]
        : []),
    ].every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)) ||
    (!data.assessmentDate &&
      (data.identityKind !== "source-row" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.sourceMetadataDate || "") ||
        !data.metadataLimitations?.length)) ||
    !Number.isFinite(Date.parse(data.retrievedAt)) ||
    !Array.isArray(data.bounds) ||
    data.bounds.length !== 4 ||
    !data.bounds.every(Number.isFinite) ||
    data.bounds[0] >= data.bounds[2] ||
    data.bounds[1] >= data.bounds[3] ||
    !Array.isArray(data.unmappedBasinIds)
  )
    throw new Error("Assessment metadata unavailable");
  for (const mode of ["likelihood", "volume", "combined"] as const) {
    const categories = hazardClasses[mode].map((entry) => entry.value);
    const supplied = data.classes?.[prefixes[mode]];
    if (data.identityKind === "source-row") {
      if (
        !Array.isArray(supplied) ||
        new Set(supplied).size !== supplied.length ||
        supplied.some((category) => !categories.includes(category))
      )
        throw new Error("Assessment legend changed");
      continue;
    }
    if (JSON.stringify(data.classes?.[prefixes[mode]]) !== JSON.stringify(categories))
      throw new Error("Assessment legend changed");
  }
  for (const mode of ["likelihood", "volume", "combined"] as const) {
    const response = data.responseShares?.[mode];
    if (
      !validScenarioResponse(response, data.steps) ||
      (response && response.topClass !== data.classes[prefixes[mode]].at(-1))
    )
      throw new Error("Assessment area shares are invalid");
  }
  for (const kind of ["basins", "segments", "perimeter"] as const) {
    const collection = data[kind];
    const ids = new Set<number | string>();
    if (
      collection?.type !== "FeatureCollection" ||
      !collection.features?.length ||
      collection.features.length !== data.featureCounts?.[kind]
    )
      throw new Error("Assessment geometry unavailable");
    for (const feature of collection.features) {
      const allowed =
        kind === "segments" ? ["LineString", "MultiLineString"] : ["Polygon", "MultiPolygon"];
      const props = feature.properties;
      const missingGeometry =
        data.identityKind === "source-row" && feature.geometry === null && props?.mapped === false;
      if (
        (!missingGeometry && !allowed.includes(feature.geometry?.type)) ||
        typeof props?.mapped !== "boolean"
      )
        throw new Error("Assessment geometry mismatch");
      if (kind === "perimeter") continue;
      let identity: number | string = props.SegmentID;
      if (data.identityKind === "source-row") {
        if (
          !Number.isInteger(props.sourceFeatureIndex) ||
          props.sourceFeatureIndex < 0 ||
          typeof props.sourceLayer !== "string" ||
          !props.sourceLayer ||
          !/^[a-f0-9]{64}$/.test(props.archiveSha256) ||
          !data.sources?.some((source) => source.sha256 === props.archiveSha256) ||
          props.SegmentID !== undefined
        )
          throw new Error("Assessment source reference mismatch");
        identity = `${props.sourceLayer}:${props.sourceFeatureIndex}`;
      } else if (!Number.isInteger(identity)) {
        throw new Error("Assessment identifier mismatch");
      }
      if (ids.has(identity)) throw new Error("Assessment identifier mismatch");
      ids.add(identity);
      for (const step of data.steps) {
        for (const prefix of Object.values(prefixes)) {
          const field = `${prefix}_${step}`;
          const number = props[field];
          const category = props[field + "_LG"];
          if (
            number !== null &&
            (!Number.isFinite(number) || number < 0 || (prefix === "P" && number > 1))
          )
            throw new Error("Invalid assessment value");
          if (category !== null && !data.classes[prefix].includes(category))
            throw new Error("Invalid assessment category");
        }
      }
    }
  }
  const excluded = data.basins.features
    .filter((feature) => !feature.properties?.mapped)
    .map((feature) =>
      data.identityKind === "source-row"
        ? feature.properties!.sourceFeatureIndex
        : feature.properties!.SegmentID,
    )
    .sort((a, b) => a - b);
  if (
    JSON.stringify(excluded) !==
    JSON.stringify([...unmappedScenarioFeatures(data)].sort((a, b) => a - b))
  )
    throw new Error("Assessment coverage mismatch");
  return data;
}

export function readLinkedRainScenarios(
  value: unknown,
  link: RainScenarioLink,
  record: HistoricalRecord,
) {
  const data = readFireRainScenarios(value, record, link.name);
  if (
    data.releaseId !== link.releaseId ||
    data.ignition !== link.ignition ||
    data.assessmentDate !== link.assessmentDate ||
    data.publicationDate !== link.publicationDate ||
    data.version !== link.version
  )
    throw new Error("Linked assessment identity differs");
  return data;
}

export function readFireRainScenarios(
  value: unknown,
  record: HistoricalRecord,
  expectedName: string,
  preparedUrl?: string,
  releaseChecks?: { status: string; preparedUrl: string; sourceUrl: string }[],
) {
  const data = readRainScenarios(value, expectedName);
  const archive = record.sources?.find(
    (source) => source.source === "USGS archive" && source.sourceId === data.releaseId,
  );
  const fireBounds = record.bounds;
  const checkedRelease = releaseChecks?.find(
    (check) =>
      check.status === "available" &&
      check.preparedUrl === preparedUrl &&
      check.sourceUrl === data.sourceUrl,
  );
  const overlapsFire =
    !fireBounds ||
    (data.bounds[0] < fireBounds[2] &&
      data.bounds[2] > fireBounds[0] &&
      data.bounds[1] < fireBounds[3] &&
      data.bounds[3] > fireBounds[1]);
  if (
    (!archive && !checkedRelease) ||
    (archive && archive.sourceUrl !== data.sourceUrl) ||
    (archive && archive.ignition !== data.ignition) ||
    (archive?.assessmentDate && archive.assessmentDate !== data.assessmentDate) ||
    (archive?.publicationDate && archive.publicationDate !== data.publicationDate) ||
    !overlapsFire
  )
    throw new Error("Linked assessment identity differs");
  return data;
}

export function unmappedScenarioFeatures(data: RainScenarios) {
  if (data.identityKind === "source-row") {
    if (!Array.isArray(data.unmappedSourceFeatureIndices))
      throw new Error("Assessment coverage unavailable");
    return data.unmappedSourceFeatureIndices;
  }
  return data.unmappedBasinIds;
}

export function scenarioColors(mode: HazardMode, intensity: number): ExpressionSpecification {
  const colors: (string | number | unknown[])[] = [
    "match",
    ["get", `${prefixes[mode]}_${intensity}_LG`],
  ];
  for (const entry of hazardClasses[mode]) colors.push(entry.value, entry.color);

  colors.push("rgba(0,0,0,0)");
  return colors as ExpressionSpecification;
}

export function RainScenarioDetails({ data }: { data: RainScenarios }) {
  const unmappedCount = unmappedScenarioFeatures(data).length;
  const responseClasses = Object.entries(data.responseShares || {}).map(
    ([mode, response]) =>
      `${{ likelihood: "Chance", volume: "Amount", combined: "Combined" }[mode as HazardMode]} ${response.topClass}`,
  );
  return (
    <>
      <p>
        Published {data.publicationDate} / version {data.version}. Archive ignition: {data.ignition}
        .
      </p>
      <p>
        Peak 15-minute intensity, not a storm total. Colors use USGS-supplied categories; no
        estimates are calculated here.
      </p>
      {responseClasses.length > 0 && (
        <p>
          Response bars show the share of mapped, classified basin area in each top published class:{" "}
          {responseClasses.join(", ")}. Invalid source polygons are excluded from the area
          calculation.
        </p>
      )}
      <p>Hypothetical storms, not measured rain or a forecast.</p>
      <p>
        Basin/channel estimates, not a prediction for a home. Unmapped areas are not established
        safe.
      </p>
      <p>
        {data.basins.features.length - unmappedCount} of {data.basins.features.length} basin
        polygons mapped; {unmappedCount} have invalid source geometry and are left unfilled. All{" "}
        {data.segments.features.length} channels are included. Missing categories are transparent.
      </p>
      {data.identityKind === "source-row" && (
        <p>
          File row references identify display features only, not watersheds or observation matches.
        </p>
      )}
      {data.metadataLimitations?.map((limitation) => (
        <p key={limitation}>{limitation}</p>
      ))}
      {data.previousAssessment && (
        <p>
          The preserved streamed record lists ignition {data.previousAssessment.ignition} and
          assessment {data.previousAssessment.assessmentDate}; this archive lists ignition{" "}
          {data.ignition} and assessment {data.assessmentDate}. They are not merged. Smoke and
          Recovery retain their original evidence.
        </p>
      )}
      <p>
        The initial selection is the highest published intensity, not an agency recommendation. No
        intermediate scenarios are interpolated.
      </p>
      <a href={data.sourceUrl}>USGS assessment release</a>
    </>
  );
}

export function RainIntensitySlider({
  steps,
  intensity,
  onIntensity,
  response,
  mode,
}: {
  steps: number[];
  intensity: number;
  onIntensity: (value: number) => void;
  response?: ScenarioResponse;
  mode?: HazardMode;
}) {
  const index = steps.indexOf(intensity);
  const readout = `${(intensity / 25.4).toFixed(2)} in/hour (${intensity} mm/hour)`;
  const progress = steps.length > 1 ? `${(index * 100) / (steps.length - 1)}%` : "0%";
  const style = { "--rain-progress": progress } as CSSProperties;
  return (
    <div className="rain-scenario-control">
      <div className="rain-scenario-hero" aria-live="polite">
        <div className="rain-hero-number">
          {(intensity / 25.4).toFixed(2)} <small>in/hour</small>
        </div>
        <div className="rain-metric">{intensity} mm/hour</div>
      </div>
      {steps.length > 1 ? (
        <div className="rain-slider-section">
          <div className="rain-slider-track" style={style}>
            <input
              id="waves-rain-scenario"
              type="range"
              min="0"
              max={steps.length - 1}
              step="1"
              value={index}
              aria-label="Published rainfall intensity"
              aria-valuetext={readout}
              onChange={(event) => onIntensity(steps[Number(event.target.value)])}
            />
            <div className="rain-slider-stops" aria-hidden="true">
              {steps.map((step, position) => (
                <i
                  key={step}
                  className={position <= index ? "selected" : ""}
                  title={`${step} mm/hour`}
                />
              ))}
            </div>
          </div>
          <div className="rain-scenario-ticks" aria-hidden="true">
            {steps.map((step, position) => (
              <span
                key={step}
                style={{ left: (position * 100) / (steps.length - 1) + "%" }}
                title={`${step} mm/hour`}
              >
                {(step / 25.4).toFixed(2)}
              </span>
            ))}
          </div>
          {response && mode && (
            <div className="rain-response">
              <p>
                Share of assessed area in the top{" "}
                {({ likelihood: "Chance", volume: "Amount", combined: "Combined" } as const)[mode]}{" "}
                class
              </p>
              <div
                className="rain-response-bars"
                role="group"
                aria-label="Select rainfall scenario by top-class area share"
              >
                {response.steps.map((item) => (
                  <button
                    key={item.intensity}
                    type="button"
                    className={item.intensity === intensity ? "selected" : ""}
                    onClick={() => onIntensity(item.intensity)}
                    title={`${item.intensity} mm/hour: ${item.percent.toFixed(1)}%`}
                    aria-label={`${(item.intensity / 25.4).toFixed(2)} inches per hour: ${item.percent.toFixed(1)}% of assessed basin area in ${response.topClass}`}
                  >
                    <span style={{ height: `${item.percent}%` }} />
                  </button>
                ))}
              </div>
              <small>{response.steps[index]?.percent.toFixed(1)}% at this scenario</small>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RainScenarioLayers({
  map,
  data,
  mode,
  intensity,
}: {
  map: LibreMap;
  data: RainScenarios;
  mode: HazardMode;
  intensity: number;
}) {
  useEffect(() => {
    for (const kind of ["basins", "segments", "perimeter"] as const) {
      const id = "rain-" + kind;
      map.addSource(id, {
        type: "geojson",
        data: data[kind],
      });
    }
    map.addLayer(
      {
        id: "rain-basins",
        source: "rain-basins",
        type: "fill",
        filter: ["==", ["get", "mapped"], true],
        paint: { "fill-opacity": 0.7, "fill-color": "transparent" },
      },
      "perimeter",
    );
    map.addLayer(
      {
        id: "rain-basin-lines",
        source: "rain-basins",
        type: "line",
        filter: ["==", ["get", "mapped"], true],
        paint: { "line-color": "#67766f", "line-width": 0.5 },
      },
      "perimeter",
    );
    map.addLayer(
      {
        id: "rain-segments",
        source: "rain-segments",
        type: "line",
        paint: { "line-width": 2, "line-color": "transparent" },
      },
      "perimeter",
    );
    map.addLayer(
      {
        id: "rain-perimeter",
        source: "rain-perimeter",
        type: "line",
        layout: boundaryLayout,
        paint: { ...perimeterPaint },
      },
      "perimeter",
    );
    return () => {
      if (!map.getStyle()) return;
      for (const id of ["rain-perimeter", "rain-segments", "rain-basin-lines", "rain-basins"])
        if (map.getLayer(id)) map.removeLayer(id);
      for (const kind of ["basins", "segments", "perimeter"])
        if (map.getSource("rain-" + kind)) map.removeSource("rain-" + kind);
    };
  }, [map, data]);
  useEffect(() => {
    const colors = scenarioColors(mode, intensity);
    map.setPaintProperty("rain-basins", "fill-color", colors);
    map.setPaintProperty("rain-segments", "line-color", colors);
  }, [map, data, mode, intensity]);
  return null;
}
