import { useEffect, useState } from "react";
import type { FeatureCollection } from "geojson";
import type { FireAssessment } from "./mtbs";
import type { UsgsAssessment } from "./usgsAssessments";
import type { CompanionPin, RunoutEntry } from "./runout";

export type HistoricalRecord = {
  id: string;
  year: number;
  source: string;
  sourceId: string;
  name: string;
  ignition: string | null;
  sourceUrl: string;
  retrievedAt?: string;
  datasetUpdatedAt?: string | null;
  publicationDate?: string;
  assessmentDate?: string;
  bounds?: [number, number, number, number];
  archiveFiles?: { name: string; url: string; size: number }[];
  boundaryUrl?: string;
  record?: Record<string, unknown>;
  mtbs?: FireAssessment;
  assessment?: UsgsAssessment;
  runout?: RunoutEntry;
  coordinatedRain?: CompanionPin | null;
  boundaryId?: string;
  replayId?: string;
  associationStatus?: "unresolved";
  aliases?: string[];
  evidenceUrl?: string;
  sources?: {
    id: string;
    source: string;
    sourceId: string;
    sourceUrl: string;
    ignition?: string;
    assessmentDate?: string;
    publicationDate?: string;
  }[];
  linkEvidence?: { left: string; right: string; method: string }[];
  unconfirmedSources?: {
    id: string;
    sourceUrl: string;
    source: string;
    reason: string;
  }[];
};
export type HistoricalIndex = {
  schemaVersion: number;
  builtAt: string;
  recordCount: number;
  counts: Record<string, number>;
  years: { year: number; count: number; url: string }[];
  limitation: string;
  sources: Record<string, { status: string; count: number; sourceUrl: string; checkedAt?: string }>;
  productDefaults: Record<string, { status: string; reason: string }>;
  aliases: Record<string, { id: string; year: number }>;
  sourceRecordCount: number;
};

type ScopeDecision = {
  fireId: string;
  eligible: boolean;
  reasonCode: string;
  ignitionYear?: number;
  catalogYear?: number;
  mtbsMapIds?: number[];
  boundarySource?: { sourceUrl: string };
  boundarySha256?: string;
  californiaIntersects?: boolean;
  mtbs?: FireAssessment;
};
export type HistoricalScope = {
  schemaVersion: number;
  currentYear: number;
  yearRange: { start: number; end: number };
  eligibleFireCount: number;
  eligibleFireIds: string[];
  eligibleObservationIds: string[];
  decisions: ScopeDecision[];
};

export type HistoricalCounty = {
  geoid: string;
  name: string;
  overlapAreaKm2: number;
  overlapSharePercent: number;
};
export type HistoricalCountyRecord = {
  fireId: string;
  status: "single" | "multiple" | "unavailable";
  primaryCounty: string;
  counties: HistoricalCounty[];
  reason: string;
  boundary?: { sourceUrl: string; sha256: string };
};

function currentYear() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
    }).format(new Date()),
  );
}

export function readHistoricalScope(value: unknown, year = currentYear()): HistoricalScope {
  const scope = value as HistoricalScope;
  if (
    scope?.schemaVersion !== 1 ||
    scope.currentYear !== year ||
    scope.yearRange?.start !== year - 9 ||
    scope.yearRange?.end !== year ||
    !Array.isArray(scope.eligibleFireIds) ||
    !Array.isArray(scope.decisions)
  )
    throw new Error("Historical scope needs verification.");
  const ids = new Set(scope.eligibleFireIds);
  if (ids.size !== scope.eligibleFireCount || ids.size !== scope.eligibleFireIds.length)
    throw new Error("Historical scope identities differ.");
  const verified = new Set<string>();
  for (const row of scope.decisions) {
    if (!row.eligible) continue;
    if (
      !ids.has(row.fireId) ||
      verified.has(row.fireId) ||
      row.reasonCode !== "eligible" ||
      !Number.isInteger(row.ignitionYear) ||
      row.ignitionYear! < year - 9 ||
      row.ignitionYear! > year ||
      !Number.isInteger(row.catalogYear) ||
      !row.mtbsMapIds?.length ||
      row.mtbs?.incid_type !== "Wildfire" ||
      Number(row.mtbs.ig_date.slice(0, 4)) !== row.ignitionYear ||
      !row.mtbsMapIds.includes(row.mtbs.map_id) ||
      !row.boundarySource?.sourceUrl?.startsWith("https://") ||
      !/^[a-f0-9]{64}$/.test(row.boundarySha256 || "") ||
      row.californiaIntersects !== true
    )
      throw new Error("Historical fire eligibility is unverified.");
    verified.add(row.fireId);
  }
  if (verified.size !== ids.size) throw new Error("Historical eligibility is incomplete.");
  return scope;
}

let scopeCache: Promise<HistoricalScope> | null = null;
export function loadHistoricalScope() {
  if (!scopeCache) {
    scopeCache = fetch("/data/historical-fires/scope.json")
      .then(async (response) => {
        if (!response.ok) throw new Error("Historical scope could not load.");
        return readHistoricalScope(await response.json());
      })
      .catch((error) => {
        scopeCache = null;
        throw error;
      });
  }
  return scopeCache.then((scope) => readHistoricalScope(scope));
}

export function readHistoricalCountyLookup(value: unknown, scope: HistoricalScope) {
  const data = value as {
    schemaVersion: number;
    eligibleFireCount: number;
    records: HistoricalCountyRecord[];
  };
  if (
    data?.schemaVersion !== 1 ||
    data.eligibleFireCount !== scope.eligibleFireCount ||
    !Array.isArray(data.records) ||
    data.records.length !== scope.eligibleFireCount
  )
    throw new Error("Historical county lookup differs from fire scope.");

  const decisions = new Map(
    scope.decisions.filter((row) => row.eligible).map((row) => [row.fireId, row]),
  );
  const fireCounties = new Map<string, HistoricalCountyRecord>();
  for (const row of data.records) {
    const decision = decisions.get(row.fireId);
    if (!decision || fireCounties.has(row.fireId) || !Array.isArray(row.counties))
      throw new Error("Historical county identity differs.");
    if (row.counties.length === 0) {
      if (row.status !== "unavailable" || row.primaryCounty || !row.reason)
        throw new Error("Unresolved county result must include a reason.");
    } else {
      if (
        !row.boundary ||
        row.boundary.sha256 !== decision.boundarySha256 ||
        !row.boundary.sourceUrl.startsWith("https://") ||
        row.status !== (row.counties.length === 1 ? "single" : "multiple") ||
        row.primaryCounty !== row.counties[0].name
      )
        throw new Error("County result does not match the verified MTBS boundary.");
      const geoids = new Set<string>();
      for (const county of row.counties) {
        if (
          !county.geoid ||
          geoids.has(county.geoid) ||
          !county.name ||
          !Number.isFinite(county.overlapAreaKm2) ||
          county.overlapAreaKm2 <= 0 ||
          !Number.isFinite(county.overlapSharePercent) ||
          county.overlapSharePercent <= 0 ||
          county.overlapSharePercent > 100
        )
          throw new Error("County overlap is invalid.");
        geoids.add(county.geoid);
      }
    }
    fireCounties.set(row.fireId, row);
  }
  if (fireCounties.size !== decisions.size)
    throw new Error("Historical county lookup is incomplete.");
  return fireCounties;
}

let countyCache: Promise<unknown> | null = null;
export function loadHistoricalCountyLookup(scope: HistoricalScope) {
  if (!countyCache) {
    countyCache = fetch("/data/historical-fires/county-lookup.json")
      .then(async (response) => {
        if (!response.ok) throw new Error("Historical county lookup could not load.");
        return response.json();
      })
      .catch((error) => {
        countyCache = null;
        throw error;
      });
  }
  return countyCache.then((value) => readHistoricalCountyLookup(value, scope));
}

export function scopedHistoricalIndex(
  index: HistoricalIndex,
  scope: HistoricalScope,
): HistoricalIndex {
  const counts = new Map<number, number>();
  const decisions = new Map<string, ScopeDecision>();
  for (const row of scope.decisions) {
    if (!row.eligible) continue;
    decisions.set(row.fireId, row);
    counts.set(row.ignitionYear!, (counts.get(row.ignitionYear!) || 0) + 1);
  }
  const aliases: HistoricalIndex["aliases"] = {};
  for (const [alias, target] of Object.entries(index.aliases)) {
    const decision = decisions.get(target.id);
    if (decision) aliases[alias] = { id: target.id, year: decision.ignitionYear! };
  }
  const years: HistoricalIndex["years"] = [];
  for (const [year, count] of counts)
    years.push({ year, count, url: `/data/historical-fires/${year}.json` });
  years.sort((a, b) => b.year - a.year);
  return {
    ...index,
    recordCount: scope.eligibleFireCount,
    years,
    aliases,
    limitation: `California MTBS wildfires, ${scope.yearRange.start}-${scope.yearRange.end}. Product coverage varies; older and unconfirmed records are archived.`,
  };
}

export function historicalYear(id: string | null): number | null {
  const match = id?.match(/^(frap|mtbs|usgs|runout|archive):(\d{1,4}):[a-zA-Z0-9-]+$/);
  return match ? Number(match[2]) : null;
}

export function readHistoricalIndex(value: unknown): HistoricalIndex {
  const data = value as HistoricalIndex;
  if (
    data?.schemaVersion !== 2 ||
    !Array.isArray(data.years) ||
    !data.sources ||
    !data.aliases ||
    !Number.isInteger(data.sourceRecordCount) ||
    !data.productDefaults
  )
    throw new Error("Historical catalog could not load.");
  const years = new Set<number>();
  let count = 0;
  for (const row of data.years) {
    if (
      !Number.isInteger(row.year) ||
      row.year < 0 ||
      years.has(row.year) ||
      !Number.isInteger(row.count) ||
      row.count < 1 ||
      row.url !== `/data/historical-fires/${row.year}.json`
    )
      throw new Error("Historical catalog year is invalid.");
    years.add(row.year);
    count += row.count;
  }
  if (count !== data.recordCount) throw new Error("Historical catalog count differs.");
  return data;
}

export function readHistoricalYear(value: unknown, year: number): HistoricalRecord[] {
  const data = value as {
    schemaVersion: number;
    year: number;
    records: HistoricalRecord[];
  };
  if (data?.schemaVersion !== 1 || data.year !== year || !Array.isArray(data.records))
    throw new Error("Historical fire list could not load.");
  const ids = new Set<string>();
  for (const row of data.records) {
    if (
      row.year !== year ||
      historicalYear(row.id) !== year ||
      ids.has(row.id) ||
      !row.sourceId ||
      !row.name ||
      row.evidenceUrl !== `/data/historical-fires/evidence/${row.id.replaceAll(":", "-")}.json` ||
      !row.sourceUrl?.startsWith("https://")
    )
      throw new Error("Historical fire identity differs.");
    ids.add(row.id);
  }
  return data.records;
}

let indexCache: Promise<HistoricalIndex> | null = null;
export function loadHistoricalIndex() {
  if (!indexCache) {
    indexCache = fetch("/data/historical-fires/index.json")
      .then(async (response) => {
        if (!response.ok) throw new Error("Historical catalog could not load.");
        const index = readHistoricalIndex(await response.json());
        return scopedHistoricalIndex(index, await loadHistoricalScope());
      })
      .catch((error) => {
        indexCache = null;
        throw error;
      });
  }
  return indexCache;
}

const yearCache = new Map<number, HistoricalRecord[]>();
export async function loadHistoricalYear(year: number, signal: AbortSignal) {
  const scope = await loadHistoricalScope();
  const cached = yearCache.get(year);
  if (cached) return cached;
  const decisions = scope.decisions.filter((row) => row.eligible && row.ignitionYear === year);
  const ids = new Set(decisions.map((row) => row.fireId));
  const catalogYears = new Set(decisions.map((row) => row.catalogYear!));
  const records: HistoricalRecord[] = [];
  for (const catalogYear of catalogYears) {
    const response = await fetch(`/data/historical-fires/${catalogYear}.json`, {
      signal,
    });
    if (!response.ok) throw new Error("Historical fire list could not load.");
    for (const row of readHistoricalYear(await response.json(), catalogYear)) {
      if (!ids.has(row.id)) continue;
      const decision = decisions.find((item) => item.fireId === row.id)!;
      if (decision.mtbs) records.push({ ...row, mtbs: decision.mtbs });
      else records.push(row);
    }
  }
  if (records.length !== ids.size) throw new Error("Eligible fire records are incomplete.");
  if (!signal.aborted) yearCache.set(year, records);
  return records;
}

export function useHistoricalSelection(id: string | null) {
  const [loaded, setLoaded] = useState<{
    id: string;
    record: HistoricalRecord;
  } | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (!id) return;
    const requested = id;
    const controller = new AbortController();
    async function load() {
      const index = await loadHistoricalIndex();
      const target = index.aliases[requested];
      const year = target?.year ?? historicalYear(requested);
      if (year === null) throw new Error("Unknown fire identity.");
      const rows = await loadHistoricalYear(year, controller.signal);
      const record = rows.find((row) => row.id === (target?.id || id));
      if (!record) throw new Error("Historical fire not found in this snapshot.");
      if (!controller.signal.aborted) setLoaded({ id: id!, record });
    }
    load().catch(() => {
      if (!controller.signal.aborted) setFailed(id);
    });
    return () => controller.abort();
  }, [id]);
  return {
    record: loaded?.id === id ? loaded.record : null,
    failed: !!id && failed === id,
  };
}

export function readHistoricalBoundary(
  value: unknown,
  record: HistoricalRecord,
): FeatureCollection {
  const data = value as FeatureCollection;
  if (
    data?.type !== "FeatureCollection" ||
    data.features?.length !== 1 ||
    data.features[0].properties?.GlobalID !== (record.boundaryId || record.sourceId) ||
    !["Polygon", "MultiPolygon"].includes(data.features[0].geometry?.type)
  )
    throw new Error("Exact CAL FIRE boundary could not be verified.");
  const geometry = data.features[0].geometry;
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")
    throw new Error("Historical boundary geometry is invalid.");
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 4 || JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1]))
        throw new Error("Historical boundary ring is incomplete.");
      for (const point of ring) {
        if (!point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) >= 85)
          throw new Error("Historical boundary coordinates are not geographic.");
      }
    }
  }
  return data;
}
