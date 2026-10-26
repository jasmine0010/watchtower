import type { FireBoundary, MapBurnArea } from "./mtbs";
import { mtbsClasses } from "./mtbs";
import { requestCache } from "./requestCache";
import { displayUnits } from "./units";
import { EvidenceCard } from "./EvidenceCard";
import { Icon } from "./Icons";

type AreaRecord = {
  mapId: number;
  eventId: string;
  year: number;
  ignition: string;
  postId: string | null;
  updatedAt: string | null;
  geometrySha256: string;
  rasterSha256: string;
  counts: number[];
  pixelAreaM2: number;
  polygonAreaKm2: number;
  boundarySource: { url: string; retrieved: string; sha256: string };
};
type AreaSource = {
  year: number;
  title: string;
  url: string;
  metadataUrl: string;
  sha256: string;
  rasterSha256: string;
  retrieved: string;
  license: string;
};
type AreaManifest = {
  version: number;
  scope: string;
  generatedAt: string;
  limitation: string;
  sources: AreaSource[];
  records: AreaRecord[];
  exclusions: {
    mapId: number;
    eventId: string;
    reason: string;
    geometrySha256?: string;
  }[];
};
type MapAreaRecord = {
  mapId: number;
  eventId: string;
  ignition: string;
  postId: string | null;
  updatedAt: string | null;
  geometrySha256: string;
  status: "available" | "unavailable" | "failed";
  reason?: string;
  area?: MapBurnArea;
  source?: { url: string; retrievedAt: string; sha256: string };
};
type MapAreaManifest = {
  schemaVersion: number;
  eligibleFireCount: number;
  nativeSummaryCount: number;
  records: MapAreaRecord[];
};
export type NativeBurnAreaState =
  | { status: "loading" | "unavailable" | "failed"; reason: string }
  | {
      status: "available";
      record: AreaRecord;
      source: AreaSource;
      generatedAt: string;
      limitation: string;
    };
export type BurnAreaState =
  | NativeBurnAreaState
  | {
      status: "map";
      area: MapBurnArea;
      source: NonNullable<MapAreaRecord["source"]>;
      year: number;
    };
const manifests = requestCache<unknown>(1);
const mapManifests = requestCache<unknown>(1);

export async function geometryHash(geometry: FireBoundary["geometry"]) {
  const values = [geometry.type === "Polygon" ? 1 : 2];
  function visit(node: number | unknown[]) {
    if (Array.isArray(node)) {
      values.push(node.length);
      for (const child of node) visit(child as number | unknown[]);
    } else values.push(node);
  }
  visit(geometry.coordinates);
  const buffer = new ArrayBuffer(values.length * 8);
  const view = new DataView(buffer);
  for (let index = 0; index < values.length; index++)
    view.setFloat64(index * 8, values[index], true);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  let hash = "";
  for (const byte of digest) hash += byte.toString(16).padStart(2, "0");
  return hash;
}

export async function readBurnArea(
  value: unknown,
  boundary: FireBoundary,
): Promise<NativeBurnAreaState> {
  const manifest = value as AreaManifest;
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.scope !== "fire-wide" ||
    !Array.isArray(manifest.records) ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.exclusions)
  ) {
    throw new Error("Numeric severity summary export is invalid.");
  }
  const fire = boundary.properties;
  const matches = manifest.records.filter(
    (record) => record.mapId === fire.map_id && record.eventId === fire.event_id,
  );
  if (!matches.length) {
    const excluded = manifest.exclusions.find(
      (record) => record.mapId === fire.map_id && record.eventId === fire.event_id,
    );
    const unchanged =
      !excluded?.geometrySha256 ||
      excluded.geometrySha256 === (await geometryHash(boundary.geometry));
    return {
      status: "unavailable",
      reason:
        (unchanged && excluded?.reason) ||
        "A numeric area summary has not been built for this exact MTBS selection. The map alone cannot supply accurate area percentages.",
    };
  }
  if (matches.length !== 1)
    throw new Error("Duplicate numeric area summaries; no record was chosen.");
  const record = matches[0];
  if (
    record.ignition !== fire.ig_date.slice(0, 10) ||
    record.postId !== fire.post_id ||
    record.updatedAt !== (fire.updated_at || null) ||
    record.year !== Number(fire.ig_date.slice(0, 4)) ||
    record.geometrySha256 !== (await geometryHash(boundary.geometry))
  ) {
    return {
      status: "unavailable",
      reason:
        "The saved summary's boundary or source metadata differs from the current MTBS selection. Rebuild it before displaying percentages.",
    };
  }
  const sources = manifest.sources.filter(
    (source) => source.rasterSha256 === record.rasterSha256 && source.year === record.year,
  );
  const counts = record.counts;
  if (
    sources.length !== 1 ||
    !Array.isArray(counts) ||
    counts.length !== 7 ||
    !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
    record.pixelAreaM2 !== 900 ||
    !Number.isFinite(record.polygonAreaKm2) ||
    record.polygonAreaKm2 <= 0
  ) {
    throw new Error("Numeric severity counts or raster provenance are invalid.");
  }
  let total = 0;
  let assessed = 0;
  for (let index = 0; index < counts.length; index++) {
    total += counts[index];
    if (index >= 1 && index <= 5) assessed += counts[index];
  }
  if (!Number.isSafeInteger(total) || assessed === 0)
    throw new Error("No assessed severity cells in this summary.");
  const source = sources[0];
  if (
    typeof manifest.generatedAt !== "string" ||
    typeof source.title !== "string" ||
    typeof source.retrieved !== "string" ||
    !/^https:\/\/www\.sciencebase\.gov\/catalog\/item\/[a-f0-9]{24}$/.test(source.metadataUrl) ||
    !/^[a-f0-9]{64}$/.test(source.rasterSha256) ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  ) {
    throw new Error("Unverified numeric severity source.");
  }
  return {
    status: "available",
    record,
    source,
    generatedAt: manifest.generatedAt,
    limitation: manifest.limitation,
  };
}

export async function readMapBurnArea(
  value: unknown,
  boundary: FireBoundary,
): Promise<BurnAreaState | null> {
  const manifest = value as MapAreaManifest;
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.records))
    throw new Error("Map-image area summary export is invalid.");
  const fire = boundary.properties;
  const matches = manifest.records.filter(
    (record) => record.mapId === fire.map_id && record.eventId === fire.event_id,
  );
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Duplicate map-image area summaries.");
  const record = matches[0];
  if (
    record.ignition !== fire.ig_date.slice(0, 10) ||
    record.postId !== fire.post_id ||
    record.updatedAt !== (fire.updated_at || null) ||
    record.geometrySha256 !== (await geometryHash(boundary.geometry))
  ) {
    return {
      status: "unavailable",
      reason: "Saved map summary does not match this MTBS boundary or version.",
    };
  }
  if (record.status !== "available")
    return {
      status: record.status,
      reason: record.reason || "Map summary unavailable.",
    };
  const area = record.area;
  const source = record.source;
  if (
    !area ||
    !source ||
    !Array.isArray(area.areasKm2) ||
    area.areasKm2.length !== 7 ||
    !area.areasKm2.every((number) => Number.isFinite(number) && number >= 0) ||
    !Number.isFinite(area.unknownAreaKm2) ||
    area.unknownAreaKm2 < 0 ||
    !Number.isFinite(area.unknownPercent) ||
    area.unknownPercent > 1 ||
    !area.areasKm2.slice(1, 6).some(Boolean) ||
    !Number.isSafeInteger(area.pixelCount) ||
    area.pixelCount <= 0 ||
    !source.url.startsWith("https://edcintl.cr.usgs.gov/geoserver/wms?") ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    !source.retrievedAt
  ) {
    throw new Error("Map-image area summary values or source are invalid.");
  }
  return {
    status: "map",
    area,
    source,
    year: Number(fire.ig_date.slice(0, 4)),
  };
}

export async function loadBurnArea(boundary: FireBoundary, signal: AbortSignal) {
  let manifest = manifests.get("export");
  if (!manifest) {
    const response = await fetch("/data/fire-burn-summaries.json", { signal });
    if (response.status === 404)
      return {
        status: "unavailable",
        reason: "The numeric burn-area summary export is not installed. The map can still be used.",
      } as NativeBurnAreaState;
    if (!response.ok)
      throw new Error(`Numeric area summary request failed (HTTP ${response.status}).`);
    manifest = await response.json();
    if (!signal.aborted) manifests.set("export", manifest);
  }
  const native = await readBurnArea(manifest, boundary);
  if (native.status !== "unavailable") return native;
  let mapManifest = mapManifests.get("export");
  if (!mapManifest) {
    const response = await fetch("/data/fire-burn-map-summaries.json", {
      signal,
    });
    if (response.status === 404) return native;
    if (!response.ok) throw new Error("Map-image area summary could not load.");
    mapManifest = await response.json();
    if (!signal.aborted) mapManifests.set("export", mapManifest);
  }
  return (await readMapBurnArea(mapManifest, boundary)) || native;
}

export function burnAreaShares(record: AreaRecord) {
  let total = 0;
  for (const count of record.counts) total += count;
  const shares = [];
  for (let code = 1; code <= 6; code++) {
    shares.push({
      code,
      ...mtbsClasses[code - 1],
      percent: (record.counts[code] / total) * 100,
      areaKm2: (record.counts[code] * record.pixelAreaM2) / 1e6,
    });
  }
  shares.push({
    code: 0,
    label: "Background / no data",
    color: "#dce1de",
    percent: (record.counts[0] / total) * 100,
    areaKm2: (record.counts[0] * record.pixelAreaM2) / 1e6,
  });
  return shares;
}

export function mapBurnAreaShares(area: MapBurnArea) {
  const total = area.areasKm2.reduce((sum, value) => sum + value, area.unknownAreaKm2);
  if (!total) return [];
  const shares = [];
  for (let code = 1; code <= 6; code++) {
    shares.push({
      code,
      ...mtbsClasses[code - 1],
      percent: (area.areasKm2[code] / total) * 100,
      areaKm2: area.areasKm2[code],
    });
  }
  shares.push({
    code: 0,
    label: "Background / no data",
    color: "#dce1de",
    percent: (area.areasKm2[0] / total) * 100,
    areaKm2: area.areasKm2[0],
  });
  if (area.unknownAreaKm2) {
    shares.push({
      code: 7,
      label: "Unclassified image pixels",
      color: "#b2b8b4",
      percent: (area.unknownAreaKm2 / total) * 100,
      areaKm2: area.unknownAreaKm2,
    });
  }
  return shares;
}

export function sharePercent(value: number) {
  return value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`;
}

function shareArea(value: number) {
  return value > 0 && value < 0.01 ? "<0.01 km²" : `${value.toFixed(2)} km²`;
}

export function roundedBurnAreaShares(shares: { percent: number }[]) {
  const rounded = shares.map((share) => Math.floor(share.percent));
  const remaining = 100 - rounded.reduce((sum, value) => sum + value, 0);
  const order = shares
    .map((share, index) => ({ index, remainder: share.percent - rounded[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index++) rounded[order[index].index]++;
  return rounded;
}

export function BurnSeverityPanel({
  data,
}: {
  data: Extract<BurnAreaState, { status: "available" | "map" }>;
}) {
  const native = data.status === "available";
  const shares = native ? burnAreaShares(data.record) : mapBurnAreaShares(data.area);
  const moderate = shares.find((share) => share.code === 3)?.percent || 0;
  const high = shares.find((share) => share.code === 4)?.percent || 0;
  const mappedKm2 = shares.reduce((sum, share) => sum + share.areaKm2, 0);
  const sourceUrl = data.status === "available" ? data.source.metadataUrl : data.source.url;
  const sourceName = native ? "USGS / USFS source and metadata" : "USGS / USFS MTBS map service";
  return (
    <EvidenceCard
      title="Burn severity by area"
      kind="Historical"
      className="fire-area-summary"
      source={<a href={sourceUrl}>{sourceName}</a>}
    >
      <div className="burn-area-headline">
        <div className="burn-area-primary">
          <strong>{Math.round(moderate + high)}%</strong>
          <span>burned moderate or high</span>
        </div>
        <div className="burn-area-total">
          <span>Total mapped area</span>
          <strong>{displayUnits(mappedKm2, "area").text}</strong>
        </div>
      </div>
      <BurnAreaFigure shares={shares} />
    </EvidenceCard>
  );
}

export function FireContextViewSelector({
  view,
  onView,
}: {
  view: "severity" | "slope";
  onView: (view: "severity" | "slope") => void;
}) {
  return (
    <div
      className="view-toggle waves-modes fire-context-switch"
      role="group"
      aria-label="Fire context map layer"
    >
      <button aria-pressed={view === "severity"} onClick={() => onView("severity")}>
        <Icon name="fire" />
        Burn severity
      </button>
      <button aria-pressed={view === "slope"} onClick={() => onView("slope")}>
        <Icon name="slope" />
        Slope
      </button>
    </div>
  );
}

function BurnAreaFigure({ shares }: { shares: ReturnType<typeof burnAreaShares> }) {
  const rounded = roundedBurnAreaShares(shares);
  return (
    <figure
      className="guide-chart burn-chart"
      aria-label={shares
        .map((share) => `${share.label}: ${sharePercent(share.percent)}`)
        .join("; ")}
    >
      <div className="guide-severity-bar">
        {shares.map((share, index) => (
          <div
            key={share.code}
            className="burn-segment"
            style={{
              width: `${rounded[index]}%`,
              backgroundColor: share.color,
            }}
            title={`${share.label}: ${sharePercent(share.percent)} / ${shareArea(share.areaKm2)}`}
          >
            {rounded[index] >= 8 && (
              <span className={share.code === 1 || share.code === 4 ? "light-label" : ""}>
                {rounded[index]}%
              </span>
            )}
          </div>
        ))}
      </div>
      <ul className="guide-chart-key">
        {shares.map((share, index) => (
          <li
            key={share.code}
            tabIndex={0}
            title={`${share.label}: ${sharePercent(share.percent)} / ${shareArea(share.areaKm2)}`}
          >
            <span className="swatch" style={{ backgroundColor: share.color }} />
            <span>{share.label}</span>
            <span>{rounded[index]}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
