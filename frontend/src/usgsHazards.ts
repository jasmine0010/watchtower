import { polygonContainsLocation, type FireAssessment, type FireBoundary } from "./mtbs";
import { utcDate, type UsgsAssessment } from "./usgsAssessments";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { requestCache } from "./requestCache";

export const hazardSource = "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer";
export const hazardViews = {
  likelihood: { label: "Chance of a debris flow", basin: 2, segment: 1 },
  volume: { label: "Estimated debris amount", basin: 6, segment: 7 },
  combined: { label: "Combined assessment", basin: 4, segment: 5 },
} as const;
export type HazardMode = keyof typeof hazardViews;

const purple = ["#F2F0F7", "#CBC9E2", "#9E9AC8", "#756BB1", "#54278F"];
export const hazardClasses = {
  likelihood: [
    { value: "0-20%", label: "0-20%", color: purple[0] },
    { value: "20-40%", label: "20-40%", color: purple[1] },
    { value: "40-60%", label: "40-60%", color: purple[2] },
    { value: "60-80%", label: "60-80%", color: purple[3] },
    { value: "80-100%", label: "80-100%", color: purple[4] },
  ],
  volume: [
    { value: "<1,000", label: "< 1,000 m^3", color: purple[0] },
    { value: "1,000-10,000", label: "1,000 - 10,000 m^3", color: purple[1] },
    {
      value: "10,000-100,000",
      label: "10,000 - 100,000 m^3",
      color: purple[3],
    },
    { value: ">100,000", label: "> 100,000 m^3", color: purple[4] },
  ],
  combined: [
    { value: "Low", label: "Low", color: purple[0] },
    { value: "Moderate", label: "Moderate", color: purple[2] },
    { value: "High", label: "High", color: purple[4] },
  ],
};

export function hazardRenderer(layer: number) {
  const fields: Record<number, [HazardMode, string]> = {
    1: ["likelihood", "SP_Legend"],
    2: ["likelihood", "BP_Legend"],
    4: ["combined", "BCH_Legend"],
    5: ["combined", "SCH_Legend"],
    6: ["volume", "BV_Legend"],
    7: ["volume", "SV_Legend"],
  };
  const definition = fields[layer];
  if (!definition) throw new Error("Unsupported USGS display layer.");
  const [mode, field] = definition;
  const basin = hazardViews[mode].basin === layer;
  const legendEntries = [];
  for (const entry of hazardClasses[mode]) {
    const color = [];
    for (const start of [1, 3, 5]) color.push(parseInt(entry.color.slice(start, start + 2), 16));
    color.push(255);
    const symbol = basin
      ? {
          type: "esriSFS",
          style: "esriSFSSolid",
          color,
          outline: {
            type: "esriSLS",
            style: "esriSLSSolid",
            color: [110, 110, 110, 255],
            width: 0.4,
          },
        }
      : { type: "esriSLS", style: "esriSLSSolid", color, width: 2 };
    legendEntries.push({ value: entry.value, label: entry.label, symbol });
  }
  return { type: "uniqueValue", field1: field, uniqueValueInfos: legendEntries };
}

type LegendEntry = { label: string; imageData: string; contentType: string };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export type HazardAssessment = {
  record: UsgsAssessment;
  version: string;
  basins: boolean;
  segments: boolean;
  perimeter: boolean;
  notes: string[];
  basinLegend: LegendEntry[];
  segmentLegend: LegendEntry[];
  retrieved: string;
};

export function assessmentIdentity(record: UsgsAssessment) {
  return JSON.stringify([record.Fire_ID, record.assessment_date, record.status]);
}
const locationsCache = requestCache<UsgsAssessment[]>(1);

async function request(path: string, signal: AbortSignal) {
  const response = await fetch(`/usgs-hazards/${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  if (!response.ok) throw new Error(`USGS returned HTTP ${response.status}.`);
  const data = await response.json();
  if (!data || data.error) throw new Error("USGS source unavailable or invalid.");
  return data;
}

export async function loadLocations(signal: AbortSignal) {
  const cached = locationsCache.get("locations");
  if (cached) return cached;
  const records: UsgsAssessment[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (true) {
    const page = await request(`locations?offset=${offset}`, signal);
    if (!Array.isArray(page.features)) throw new Error("USGS location catalog is invalid.");
    if (page.exceededTransferLimit && !page.features.length)
      throw new Error("USGS pagination stopped before completion.");
    for (const feature of page.features) {
      const raw = feature.attributes;
      if (typeof raw?.Fire_ID !== "string" || typeof raw.fire !== "string")
        throw new Error("USGS location identity is invalid.");
      const record = {
        ...raw,
        location: typeof raw.location === "string" ? raw.location : null,
        disclaimer: typeof raw.disclaimer === "string" ? raw.disclaimer : null,
      };
      const identity = assessmentIdentity(record);
      if (!record || seen.has(identity))
        throw new Error("Duplicate USGS locations; association unresolved.");
      seen.add(identity);
      records.push(record);
    }
    offset += page.features.length;
    if (!page.exceededTransferLimit) break;
  }
  locationsCache.set("locations", records);
  return records;
}

function sameFireName(record: UsgsAssessment, fire: FireAssessment) {
  return (
    typeof record.fire === "string" &&
    record.fire.trim().toUpperCase() === fire.incid_name.trim().toUpperCase()
  );
}

function sameIgnitionDay(record: UsgsAssessment, fire: FireAssessment) {
  return utcDate(record.start_date) === fire.ig_date.slice(0, 10);
}

export function matchHazardAssessment(
  records: UsgsAssessment[],
  fire: FireAssessment,
  boundary: FireBoundary,
) {
  if (boundary.properties.map_id !== fire.map_id || boundary.properties.event_id !== fire.event_id)
    throw new Error("MTBS boundary identity mismatch; USGS association unresolved.");
  const matches: UsgsAssessment[] = [];
  for (const record of records) {
    if (!sameFireName(record, fire) || !sameIgnitionDay(record, fire)) continue;
    if (
      typeof record.lon !== "number" ||
      typeof record.lat !== "number" ||
      !Number.isFinite(record.lon) ||
      !Number.isFinite(record.lat)
    )
      continue;
    if (!polygonContainsLocation(boundary.geometry, record.lon, record.lat)) continue;
    matches.push(record);
  }
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Multiple USGS assessments match; association unresolved."
        : "USGS association not confirmed: exact name, ignition day and polygon containment are required.",
    );
  const record = matches[0];
  return verifyScenario(record);
}

function verifyScenario(record: UsgsAssessment) {
  if (!/^[A-Za-z0-9_. '-]{1,150}$/.test(record.Fire_ID))
    throw new Error("USGS assessment identifier is unsupported.");
  if (utcDate(record.assessment_date) === "Unavailable")
    throw new Error("USGS assessment date unavailable.");
  if (typeof record.Rainfall !== "string" || !/^\d+(?:\.\d+)?\s*mm$/i.test(record.Rainfall.trim()))
    throw new Error("USGS rainfall scenario units are unverified; layer not displayed.");
  const version = (typeof record.status === "string" ? record.status : "").match(
    /^(?:Most Recent )?Version:\s*(\d+(?:\.\d+)+)\s*$/i,
  )?.[1];
  if (!version) throw new Error("USGS assessment version is unresolved.");
  return {
    record: {
      ...record,
      disclaimer: typeof record.disclaimer === "string" ? record.disclaimer : null,
    },
    version,
  };
}

export function checkHazardCoverage(
  payload: unknown,
  record: UsgsAssessment,
  version: string,
): boolean {
  if (
    !isRecord(payload) ||
    payload.error ||
    payload.exceededTransferLimit ||
    !Array.isArray(payload.features)
  )
    throw new Error("USGS layer identity response is incomplete or invalid.");
  if (!payload.features.length) return false;

  if (payload.features.length !== 1)
    throw new Error("USGS layer spans multiple assessments; not displayed.");
  const feature = payload.features[0];
  const row = isRecord(feature) && isRecord(feature.attributes) ? feature.attributes : null;
  if (
    !row ||
    (row.fire_id ?? row.Fire_ID) !== record.Fire_ID ||
    row.start_date !== record.start_date ||
    row.version !== version
  )
    throw new Error("USGS layer date/version differs from its rainfall metadata; not displayed.");
  if (row.assessment_date !== record.assessment_date)
    throw new Error(
      `USGS layer assessment date (${utcDate(row.assessment_date)}) differs from metadata (${utcDate(record.assessment_date)}); not displayed.`,
    );
  return true;
}

export function hazardLegend(payload: unknown, layer: number): LegendEntry[] {
  const selected =
    isRecord(payload) && Array.isArray(payload.layers)
      ? payload.layers.find((item: unknown) => isRecord(item) && item.layerId === layer)
      : null;
  const entries = isRecord(selected) ? selected.legend : null;
  if (!Array.isArray(entries) || !entries.length) throw new Error("USGS legend unavailable.");
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.label !== "string" ||
      entry.contentType !== "image/png" ||
      typeof entry.imageData !== "string" ||
      !/^[A-Za-z0-9+/=]+$/.test(entry.imageData)
    )
      throw new Error("USGS legend is invalid.");
  }
  return entries as LegendEntry[];
}

export async function loadHazardRecord(
  record: UsgsAssessment,
  mode: HazardMode,
  signal: AbortSignal,
): Promise<HazardAssessment> {
  const checked = verifyScenario(record);
  record = checked.record;
  const version = checked.version;
  const view = hazardViews[mode];
  const results = await Promise.allSettled(
    [view.basin, view.segment, 9].map(async (layer) => {
      const payload = await request(
        `coverage?layer=${layer}&id=${encodeURIComponent(record.Fire_ID)}`,
        signal,
      );
      return checkHazardCoverage(payload, record, version);
    }),
  );
  if (signal.aborted) throw signal.reason;
  const names = ["Basin estimates", "Channel estimates", "Assessment boundary"];
  const notes: string[] = [];
  const available: boolean[] = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    available.push(result.status === "fulfilled" && result.value);
    if (result.status === "rejected")
      notes.push(`${names[index]} unavailable: ${result.reason.message}`);
    else if (!result.value)
      notes.push(`${names[index]} not returned by the connected map service.`);
  }
  if (!available[0] && !available[1])
    throw new Error(`${notes.join(" ")} Archived GIS data may still exist.`);
  const legend = await request("legend", signal);
  const basinLegend = available[0] ? hazardLegend(legend, view.basin) : [];
  const segmentLegend = available[1] ? hazardLegend(legend, view.segment) : [];

  for (const entries of [basinLegend, segmentLegend]) {
    if (!entries.length) continue;
    const expected = hazardClasses[mode];
    if (
      entries.length !== expected.length ||
      entries.some((entry, index) => entry.label !== expected[index].label)
    )
      throw new Error("USGS categories differ from the checked display key; layer not displayed.");
  }
  if (
    available[0] &&
    available[1] &&
    (basinLegend.length !== segmentLegend.length ||
      basinLegend.some((entry, index) => entry.label !== segmentLegend[index].label))
  )
    throw new Error("USGS basin and channel legend categories disagree; not displayed.");
  return {
    record,
    version,
    basins: available[0],
    segments: available[1],
    perimeter: available[2],
    notes,
    basinLegend,
    segmentLegend,
    retrieved: new Date().toISOString(),
  };
}

export async function loadAssessmentBounds(
  record: UsgsAssessment,
  signal: AbortSignal,
): Promise<[number, number, number, number]> {
  const { version } = verifyScenario(record);
  const identity = await request(
    `coverage?layer=9&id=${encodeURIComponent(record.Fire_ID)}`,
    signal,
  );
  if (!checkHazardCoverage(identity, record, version))
    throw new Error("USGS assessment perimeter not returned.");
  const payload = await request(`bounds?id=${encodeURIComponent(record.Fire_ID)}`, signal);
  const extent = payload.extent;
  const bounds: [number, number, number, number] = [
    extent?.xmin,
    extent?.ymin,
    extent?.xmax,
    extent?.ymax,
  ];
  if (
    extent?.spatialReference?.wkid !== 4326 ||
    !bounds.every(Number.isFinite) ||
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -85 ||
    bounds[3] > 85 ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3]
  )
    throw new Error("USGS perimeter bounds are unavailable or untransformed.");
  return bounds;
}

export function hazardTileUrl(data: HazardAssessment, mode: HazardMode, perimeter: boolean) {
  const view = hazardViews[mode];
  const layers: number[] = [];
  if (data.basins) layers.push(view.basin);
  if (data.segments) layers.push(view.segment);
  if (data.perimeter && perimeter) layers.push(9);
  return mapUrl(data, layers);
}

export function checkedAssessmentBoundary(
  payload: unknown,
  record: UsgsAssessment,
): FeatureCollection<Polygon | MultiPolygon> {
  const { version } = verifyScenario(record);
  if (
    !isRecord(payload) ||
    payload.type !== "FeatureCollection" ||
    payload.exceededTransferLimit ||
    !Array.isArray(payload.features) ||
    !payload.features.length
  )
    throw new Error("USGS boundary geometry is unavailable or incomplete.");
  for (const feature of payload.features) {
    if (!isRecord(feature)) throw new Error("USGS boundary polygon is invalid.");
    const properties = isRecord(feature.properties) ? feature.properties : null;
    checkHazardCoverage(
      {
        features: [
          {
            attributes: {
              ...properties,
              version: properties?.version ?? properties?.Version,
            },
          },
        ],
      },
      record,
      version,
    );
    const geometry = isRecord(feature.geometry) ? feature.geometry : null;
    if (
      !geometry ||
      (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") ||
      !Array.isArray(geometry.coordinates) ||
      !geometry.coordinates.length
    )
      throw new Error("USGS boundary polygon is invalid.");
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length)
        throw new Error("USGS boundary polygon is empty.");
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4)
          throw new Error("USGS boundary ring is invalid.");
        for (const point of ring) {
          if (
            !Array.isArray(point) ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]) ||
            Math.abs(point[0]) > 180 ||
            Math.abs(point[1]) > 85
          )
            throw new Error("USGS boundary coordinates are unavailable or untransformed.");
        }
        if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
          throw new Error("USGS boundary ring is not closed.");
      }
    }
  }
  return payload as Record<string, unknown> & FeatureCollection<Polygon | MultiPolygon>;
}

const boundaryCache = requestCache<FeatureCollection<Polygon | MultiPolygon>>(8);
export async function loadAssessmentBoundary(record: UsgsAssessment, signal: AbortSignal) {
  const key = assessmentIdentity(record);
  const cached = boundaryCache.get(key);
  if (cached) return cached;
  const payload = await request(`boundary?id=${encodeURIComponent(record.Fire_ID)}`, signal);
  const boundary = checkedAssessmentBoundary(payload, record);
  if (!signal.aborted) boundaryCache.set(key, boundary);
  return boundary;
}

function mapUrl(data: HazardAssessment, layers: number[]) {
  const params = new URLSearchParams({
    id: data.record.Fire_ID,
    layers: layers.join(","),
  });
  return `${location.origin}/usgs-hazards/map?${params}&bbox={bbox-epsg-3857}`;
}
