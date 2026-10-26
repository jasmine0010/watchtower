import type { FeatureCollection, Point } from "geojson";

type Check = { status: string; reason?: string };
export type DamageCategory = { label: string; count: number; color: string };
export type DamageData = Check & {
  sourceUrl?: string;
  retrievedAt?: string;
  incidentId?: string | null;
  recordDatesSupplied?: boolean;
  spatialChecked?: boolean;
  incidentDate?: string;
  sourceDates?: string[];
  sourceUpdatedAt?: string;
  categories?: DamageCategory[];
  total?: number;
  geometryUrl?: string;
  mappedCount?: number;
  audit?: {
    duplicates: number;
    dateConflicts: number;
    missingGeometry: number;
    inside: number;
    outside: number;
  };
  match?: {
    method: string;
    note?: string;
    sourceUrl?: string;
    termsUrl?: string;
  };
  license?: string;
};
export type WaterNotice = {
  provider: string;
  sourceId: string;
  sourceUrl: string;
  retrievedAt: string;
  publicationDate: string | null;
  events: { date: string; label: string; scope: string }[];
};
export type RecoveryData = {
  schemaVersion: number;
  fireId: string;
  builtAt: string;
  damage: DamageData;
  power: Check & {
    sourceUrl?: string;
    checkedAt?: string;
    publicationDate?: string;
    seriesUrl?: string;
    retrievedAt?: string;
    dataClass?: string;
    relationship?: string;
    unit?: string;
    license?: string;
    recordCount?: number;
    countyCount?: number;
  };
  water: Check & {
    notices: WaterNotice[];
    failures: { provider: string; sourceUrl: string; reason: string }[];
    completeHistory: boolean;
  };
};

export function readRecovery(value: unknown, id: string): RecoveryData {
  const data = value as RecoveryData;
  if (
    data?.schemaVersion !== 1 ||
    data.fireId !== id ||
    !data.builtAt ||
    !data.damage?.status ||
    !data.power?.status ||
    !data.water?.status ||
    !Array.isArray(data.water.notices) ||
    !Array.isArray(data.water.failures)
  )
    throw new Error("Recovery evidence identity differs.");
  const damage = data.damage;
  if (damage.status === "available") {
    if (
      !damage.sourceUrl?.startsWith("https://") ||
      !damage.retrievedAt ||
      !damage.incidentDate ||
      !damage.audit ||
      !damage.match ||
      !Array.isArray(damage.categories) ||
      damage.geometryUrl !==
        `/data/historical-fires/recovery/${id.replaceAll(":", "-")}-damage.geojson`
    )
      throw new Error("Inspection source is incomplete.");
    const labels = new Set<string>();
    let total = 0;
    for (const row of damage.categories) {
      if (
        labels.has(row.label) ||
        !row.label ||
        !Number.isInteger(row.count) ||
        row.count < 0 ||
        !/^#[0-9a-f]{6}$/i.test(row.color)
      )
        throw new Error("Inspection category is invalid.");
      labels.add(row.label);
      total += row.count;
    }
    if (
      total !== damage.total ||
      !Number.isInteger(damage.mappedCount) ||
      damage.mappedCount! > total
    )
      throw new Error("Inspection counts differ.");
  }
  for (const notice of data.water.notices) {
    if (
      !notice.provider ||
      !notice.sourceId ||
      !notice.sourceUrl?.startsWith("https://") ||
      !notice.retrievedAt ||
      !notice.events?.length
    )
      throw new Error("Water notice source is incomplete.");
    let previous = "";
    for (const event of notice.events) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
        event.date < previous ||
        !event.label ||
        !event.scope
      )
        throw new Error("Water notice chronology is invalid.");
      previous = event.date;
    }
  }
  if (
    data.power.status === "available" &&
    (data.power.seriesUrl !== `/data/historical-fires/power/${id.replaceAll(":", "-")}.json` ||
      data.power.dataClass !== "Historical" ||
      data.power.relationship !== "nearby_time_matched" ||
      data.power.unit !== "reported customers without power" ||
      !data.power.license ||
      !data.power.retrievedAt ||
      !Number.isInteger(data.power.recordCount) ||
      data.power.recordCount! <= 0)
  )
    throw new Error("County outage series has not been verified.");
  return data;
}

export function readDamageGeometry(value: unknown, data: RecoveryData): FeatureCollection<Point> {
  const geometry = value as FeatureCollection<Point> & { fireId: string };
  if (
    geometry?.type !== "FeatureCollection" ||
    geometry.fireId !== data.fireId ||
    !Array.isArray(geometry.features) ||
    geometry.features.length !== data.damage.mappedCount
  )
    throw new Error("Inspection map identity differs.");
  const ids = new Set<string>();
  const labels = new Set(data.damage.categories?.map((row) => row.label));
  for (const feature of geometry.features) {
    const id = feature.properties?.id;
    const coordinates = feature.geometry?.coordinates;
    if (
      feature.geometry?.type !== "Point" ||
      !id ||
      ids.has(id) ||
      !coordinates ||
      coordinates.length !== 2 ||
      !coordinates.every(Number.isFinite) ||
      Math.abs(coordinates[0]) > 180 ||
      Math.abs(coordinates[1]) > 90 ||
      !labels.has(feature.properties?.damage)
    )
      throw new Error("Inspection map contains invalid records.");
    ids.add(id);
  }
  return geometry;
}
