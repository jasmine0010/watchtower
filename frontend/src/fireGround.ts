import { validBounds } from "./fireProducts";
import type { WaveCatalog } from "./waves";

export type MissingGroundLayer = {
  status: "unavailable";
  reason: string;
  sourceUrl: string;
};
export type SlopeLayer = {
  status: "available";
  file: string;
  bounds: [number, number, number, number];
  width: number;
  height: number;
  thresholdDegrees: number;
  pixelSizeMetres: number;
  minimumDegrees: number;
  maximumDegrees: number;
  nativeValidPercent: number;
  fireSteepPercent: number;
  fireValidPercent: number;
  fireValidCells: number;
  colors: { below: string; atOrAbove: string };
  sourceUrl: string;
  license: string;
  retrievedAt: string;
  dataClass: "Historical";
  processing: string;
  limitation: string;
  sources: {
    sourceUrl: string;
    publicationDate: string;
    retrievedAt: string;
    bytes: number;
    sha256: string;
  }[];
};
export type GroundSupplement = {
  id: string;
  usgsId: string;
  name: string;
  ignition: string;
  layers: {
    pre: MissingGroundLayer;
    post: MissingGroundLayer;
    dnbr: MissingGroundLayer;
    slope: SlopeLayer | MissingGroundLayer;
  };
};

export function readGroundSupplement(
  raw: unknown,
  fire: WaveCatalog["cases"][number],
): GroundSupplement {
  const manifest = raw as { schemaVersion: number; cases: GroundSupplement[] };
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.cases))
    throw new Error("Ground manifest is invalid");
  const ids = new Set<string>();
  const fireIds = new Set<string>();
  for (const item of manifest.cases) {
    if (!item?.id || !item.usgsId || ids.has(item.id) || fireIds.has(item.usgsId))
      throw new Error("Ground identities are ambiguous");
    ids.add(item.id);
    fireIds.add(item.usgsId);
  }
  const item = manifest.cases.find((record) => record.id === fire.id);
  if (
    !item ||
    item.usgsId !== fire.usgsId ||
    item.name !== fire.name ||
    item.ignition !== fire.ignition
  )
    throw new Error("Ground products do not match this fire");
  for (const key of ["pre", "post", "dnbr"] as const) {
    const layer = item.layers?.[key];
    if (
      layer?.status !== "unavailable" ||
      !layer.reason ||
      !layer.sourceUrl?.startsWith("https://")
    )
      throw new Error("Unverified ground-product status");
  }
  const slope = item.layers.slope;
  readSlopeLayer(slope, fire.id);
  return item;
}

export function readSlopeLayer(value: unknown, id: string): SlopeLayer | MissingGroundLayer {
  const slope = value as SlopeLayer | MissingGroundLayer;
  if (slope?.status === "unavailable") {
    if (!slope.reason) throw new Error("Missing slope reason");
    return slope;
  }
  if (
    slope?.status !== "available" ||
    !validBounds(slope.bounds) ||
    slope.dataClass !== "Historical"
  )
    throw new Error("Slope bounds or class unverified");
  const expectedPrefix = `/data/waves/${id}-slope-`;
  if (
    !slope.file?.startsWith(expectedPrefix) ||
    !/^[a-f0-9]{12}\.png$/.test(slope.file.slice(expectedPrefix.length))
  )
    throw new Error("Slope image is not linked to this fire");
  for (const dimension of [slope.width, slope.height]) {
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192)
      throw new Error("Slope image size invalid");
  }
  if (
    ![
      slope.minimumDegrees,
      slope.maximumDegrees,
      slope.thresholdDegrees,
      slope.pixelSizeMetres,
      slope.nativeValidPercent,
      slope.fireSteepPercent,
      slope.fireValidPercent,
    ].every(Number.isFinite) ||
    slope.minimumDegrees < 0 ||
    slope.maximumDegrees > 90 ||
    slope.minimumDegrees > slope.maximumDegrees ||
    slope.thresholdDegrees <= 0 ||
    slope.thresholdDegrees >= 90 ||
    slope.pixelSizeMetres <= 0 ||
    slope.nativeValidPercent <= 0 ||
    slope.nativeValidPercent > 100 ||
    slope.fireSteepPercent < 0 ||
    slope.fireSteepPercent > 100 ||
    slope.fireValidPercent <= 0 ||
    slope.fireValidPercent > 100 ||
    !Number.isInteger(slope.fireValidCells) ||
    slope.fireValidCells < 1
  )
    throw new Error("Slope range or coverage invalid");
  if (
    !slope.sourceUrl?.startsWith("https://") ||
    !slope.license ||
    !slope.processing ||
    !slope.limitation ||
    !Number.isFinite(Date.parse(slope.retrievedAt)) ||
    !slope.sources?.length
  )
    throw new Error("Slope provenance missing");
  if (slope.colors?.below !== "#e0e7e1" || slope.colors.atOrAbove !== "#4d7778")
    throw new Error("Slope class colors changed");
  return slope;
}
