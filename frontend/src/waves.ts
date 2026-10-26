import type { FeatureCollection } from "geojson";
import type { UsgsAssessment } from "./usgsAssessments";
import type { HazardMode } from "./usgsHazards";
import type { CompanionPin } from "./runout";

export type WaveSource = {
  sourceUrl: string;
  retrievedAt: string;
  dataClass: "Observed" | "Historical";
};

export type SoilSeries = WaveSource & {
  id: string;
  name: string;
  fireId: string;
  thresholdMgKg: number;
  sourcePage: number;
  figure: number;
  measurementPeriod: string;
  publicationDate: string;
  values: Record<string, number>;
};

export const soilColors = {
  above: "#c67833",
  below: "#9baeb9",
  unknown: "#d8ddda",
};

export function soilGridFeatures(
  geometry: FeatureCollection,
  series: SoilSeries,
): FeatureCollection {
  const ids = new Set<string>();
  const features = [];
  for (const feature of geometry.features) {
    const id = feature.properties?.PageName;
    if (
      feature.geometry?.type !== "Polygon" ||
      typeof id !== "string" ||
      ids.has(id) ||
      feature.properties?.fireId !== series.fireId
    )
      throw new Error("Soil grid identity mismatch");
    ids.add(id);
    const value = Object.hasOwn(series.values, id) ? series.values[id] : null;
    if (value !== null && (!Number.isFinite(value) || value < 0))
      throw new Error("Invalid soil value");
    let status;
    if (value === null) {
      status = "unknown";
    } else if (value > series.thresholdMgKg) {
      status = "above";
    } else {
      status = "below";
    }
    features.push({ ...feature, properties: { gridId: id, value, status } });
  }
  for (const id of Object.keys(series.values)) {
    if (!ids.has(id)) throw new Error("Soil result has no matching grid");
  }
  return { type: "FeatureCollection", features };
}
export type WaveCatalog = {
  cases: {
    id: string;
    usgsId: string;
    name: string;
    county: string;
    ignition: string;
    snapshot: string;
    soilMap?: string;
    rainScenarios?: RainScenarioLink;
    coordinatedRain?: CompanionPin;
    goes?: GoesProduct;
    hrrr?: HrrrProduct;
    regionalHrrr?: HrrrProduct;
    comparisonObservationId?: string;
    plumeCoverage?: Record<string, boolean | null>;
  }[];
  rightNowPlaces: WavePlace[];
};
export type RainScenarioLink = {
  url: string;
  name: string;
  releaseId: string;
  ignition: string;
  assessmentDate: string;
  publicationDate: string;
  version: string;
};
export type GoesProduct = {
  manifest: string;
  coverageKey: string;
  timezone: string;
  cadenceMinutes: number;
};
export type HrrrProduct = {
  manifest: string;
  sourceCaseId?: string;
  forecastLeadHours: number;
  timezone: string;
  footprintFrom?: string;
};

export function waveCaseFor(catalog: WaveCatalog, id: string | null) {
  return catalog.cases.find((entry) => entry.id === id) || catalog.cases[0];
}

export type Reading = WaveSource & {
  value: number | null;
  timestamp: string;
  reason: string;
  qualifier: string | null;
};
export type WaveStation = WaveSource & {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
  expectedHours: number;
  sampleOffsetSeconds?: number;
  missingHours: number;
  negativeHours: number;
  parameter: number;
  poc: number;
  method: number;
  methodName: string;
  color: string;
  thresholdUgM3: number | null;
  windowEnd: string | null;
  nonnegativeSensitivityEnd: string | null;
  series: Reading[];
  dailyMeans: (WaveSource & {
    date: string;
    hours: number;
    value: number | null;
  })[];
};
export type PlumeDay = Omit<WaveSource, "retrievedAt"> & {
  retrievedAt: string | null;
  attemptedAt?: string;
  dateUtc: string;
  status: string;
  path: string | null;
  monitorCoverage: Record<string, boolean | null>;
  sourcePolygonCount?: number;
  firePolygonCount?: number;
  measurementPeriod: { start: string; end: string } | null;
};
export type WavePlace = WaveSource & {
  name: string;
  zipcode: string;
  reportingArea: string;
  latitude: number;
  longitude: number;
};
export type HealthFinding = WaveSource & {
  value: number;
  title: string;
  unit: string;
  baseline?: number;
  period: string;
  publicationDate: string;
  ci: [number, number] | null;
  contrast?: string;
};
export type WavesData = {
  schemaVersion: number;
  builtAt: string;
  case: WaveSource & { name: string; county: string; ignition: string };
  perimeter: WaveSource & { status: string; value: FeatureCollection };
  smoke: WaveSource & {
    epaStatus?: "available" | "unavailable";
    relationship?: "nearby_time_matched";
    status: string;
    selectionRule?: string;
    limitedCoverage?: boolean;
    reason?: string;
    stations: WaveStation[];
    window: {
      start: string;
      end: string;
      referenceYears: number[];
      referenceMonths: number[];
      minimumHoursPerDay: number;
      referenceSources: WaveSource[];
    };
    plumes: { days: PlumeDay[] };
    exclusions: { name: string; reason: string }[];
    timezone: string;
    health: HealthFinding[];
    aqiReference: WaveSource & {
      averagingHours: number;
      bands: { name: string; low: number; high: number; color: string }[];
    };
  };
  ash: {
    mapSeries?: SoilSeries[];
    findings?: WaveSource & {
      publicationDate: string;
      measurementPeriod: string;
      areas: string[];
      regionalFinding: string;
      limitation: string;
    };
    county:
      | (WaveSource & {
          value: number;
          total: number;
          screeningMgKg: number;
          date: string;
          title: string;
          measurementPeriod: string;
          publicationDate: string;
          reportDate: string;
        })
      | null;
    reason?: string;
    followupReason?: string;
    grids: (WaveSource & {
      id: string;
      value: number;
      unit: string;
      statistic: string;
    })[];
    geometry: WaveSource & {
      status: string;
      reason: string;
      path?: string;
      count?: number;
      termsUrl?: string;
    };
    followup: (WaveSource & {
      value: number;
      title: string;
      unit: string;
      total: number;
      date: string;
      publicationDate: string;
      measurementPeriod: string | null;
    })[];
    zipLink: string;
  };
  rightNowPlaces: WavePlace[];
  rain: WaveSource & {
    record: UsgsAssessment;
    layers: Record<
      HazardMode,
      WaveSource & {
        status: string;
        image: string;
        bounds: [number, number, number, number];
        classes: { value: string; label: string; color: string }[];
      }
    >;
  };
};

export function readWaves(payload: unknown): WavesData {
  const data = payload as WavesData;
  if (
    data?.schemaVersion !== 2 ||
    !data.case?.name ||
    !Array.isArray(data.smoke?.stations) ||
    !Array.isArray(data.smoke.plumes?.days) ||
    !Array.isArray(data.rightNowPlaces) ||
    !Array.isArray(data.ash?.grids) ||
    !data.rain?.layers ||
    !data.perimeter?.value?.features
  )
    throw new Error("Preview data unavailable");
  if (data.smoke.status === "available" && !data.smoke.stations.length)
    throw new Error("Preview measurements unavailable");
  for (const feature of data.perimeter.value.features) {
    if (
      feature.properties?.Fire_ID !== data.rain.record.Fire_ID ||
      feature.properties?.assessment_date !== data.rain.record.assessment_date ||
      feature.properties?.start_date !== data.rain.record.start_date
    )
      throw new Error("Preview data unavailable");
  }
  readSmoke(data.smoke);
  return data;
}

export function readSmoke(payload: unknown): WavesData["smoke"] {
  const smoke = payload as WavesData["smoke"];
  if (
    !Array.isArray(smoke?.stations) ||
    !Array.isArray(smoke.plumes?.days) ||
    !smoke.aqiReference?.bands?.length ||
    !smoke.window?.start ||
    !smoke.window?.end ||
    (smoke.status === "available" &&
      !smoke.stations.length &&
      !(
        smoke.epaStatus === "unavailable" &&
        smoke.plumes.days.some((day) => day.status === "available")
      ))
  )
    throw new Error("Historical smoke response is incomplete.");
  const stationIds = new Set<string>();
  for (const station of smoke.stations) {
    const offset = station.series[0]?.timestamp.match(/(Z|[+-]\d{2}:\d{2})$/)?.[0];
    const phase = station.sampleOffsetSeconds ?? 0;
    if (!Number.isInteger(phase) || phase < 0 || phase >= 3600)
      throw new Error("Invalid source sample alignment");
    const start = Date.parse(smoke.window.start + "T00:00:00" + offset) + phase * 1000;
    const end = Date.parse(smoke.window.end + "T00:00:00" + offset) + 86400000 + phase * 1000;
    const expectedHours = (end - start) / 3600000;
    if (
      stationIds.has(station.id) ||
      !Number.isInteger(expectedHours) ||
      expectedHours < 24 ||
      station.series.length !== expectedHours ||
      station.expectedHours !== expectedHours ||
      station.dailyMeans.length !== expectedHours / 24
    )
      throw new Error("Preview measurements unavailable");
    stationIds.add(station.id);
    for (let index = 0; index < station.dailyMeans.length; index++) {
      const expected = new Date(Date.parse(smoke.window.start + "T00:00:00Z") + index * 86400000)
        .toISOString()
        .slice(0, 10);
      if (station.dailyMeans[index].date !== expected)
        throw new Error("Preview measurements unavailable");
    }
    const times = new Set<string>();
    let previous = start - 3600000;
    for (const row of station.series) {
      if (
        !Number.isFinite(Date.parse(row.timestamp)) ||
        times.has(row.timestamp) ||
        Date.parse(row.timestamp) !== previous + 3600000 ||
        (row.value !== null && !Number.isFinite(row.value))
      )
        throw new Error("Preview measurements unavailable");
      times.add(row.timestamp);
      previous = Date.parse(row.timestamp);
    }
  }
  return smoke;
}

export function shortWaveDate(date: string): string {
  return new Date(date.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

export function dateTicks(length: number, maximum = 6): number[] {
  const ticks: number[] = [];
  const count = Math.min(length, maximum);
  for (let index = 0; index < count; index++) {
    ticks.push(Math.round((index * (length - 1)) / Math.max(1, count - 1)));
  }
  return ticks;
}

export function hourlyPath(
  series: Reading[],
  x: (index: number) => number,
  y: (value: number) => number,
) {
  let path = "";
  let connected = false;
  for (let index = 0; index < series.length; index++) {
    const value = series[index].value;
    if (value === null) {
      connected = false;
      continue;
    }
    path += `${connected ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)} `;
    connected = true;
  }
  return path;
}
