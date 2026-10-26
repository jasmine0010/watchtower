import type { CaseData, Catalog } from "./types";

export type BuiltLayer = {
  status: "available";
  file: string;
  bounds: CaseData["bounds"];
  date?: string;
  sensor?: string;
  preDate?: string;
  postDate?: string;
  kind?: "dnbr" | "mtbs-classes";
  pixelSizeMetres: number;
  thresholdDegrees?: number;
  sourceEdition?: string;
  limitation?: string;
  processing: string;
  sourceUrl: string;
};
export type BuiltCase = {
  assessmentId: string;
  assessmentFireId: string;
  bounds: CaseData["bounds"];
  size: [number, number];
  limitation: string;
  layers: Record<
    "pre" | "post" | "dnbr" | "severity" | "slope",
    BuiltLayer | { status: "unavailable"; reason: string }
  >;
};

export function caseProductFor(data: CaseData): BuiltCase | null {
  const product = data.products;
  if (
    !product ||
    product.assessmentId !== data.id ||
    product.assessmentFireId !== data.inventory.AssessmentFireID
  )
    return null;
  if (!validBounds(product.bounds) || !containsBounds(product.bounds, data.bounds)) return null;
  if (
    !Array.isArray(product.size) ||
    product.size.length !== 2 ||
    !product.size.every((v) => Number.isInteger(v) && v > 0)
  )
    return null;
  for (const kind of ["pre", "post", "dnbr", "severity", "slope"] as const) {
    const layer = product.layers?.[kind];
    if (!layer) return null;
    if (layer.status === "unavailable") {
      if (typeof layer.reason !== "string" || !layer.reason) return null;
      continue;
    }
    if (layer.status !== "available" || !/^[A-Za-z0-9_-]+\.png$/.test(layer.file)) return null;
    if (!layer.file.startsWith(data.observationId + "-")) return null;
    if (!validBounds(layer.bounds) || layer.bounds.some((value, i) => value !== product.bounds[i]))
      return null;
    if (!Number.isFinite(layer.pixelSizeMetres) || layer.pixelSizeMetres <= 0) return null;

    if (kind === "dnbr" && layer.kind !== "dnbr") return null;
    if (kind === "severity" && layer.kind !== "mtbs-classes") return null;
    if (kind === "dnbr" || kind === "severity") {
      if (
        !layer.preDate ||
        !layer.postDate ||
        !/^\d{4}-\d{2}-\d{2}$/.test(layer.preDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(layer.postDate) ||
        layer.preDate >= layer.postDate
      )
        return null;
    }
    if (
      kind === "slope" &&
      (!Number.isFinite(layer.thresholdDegrees) ||
        layer.thresholdDegrees! <= 0 ||
        layer.thresholdDegrees! >= 90)
    )
      return null;
    if (kind === "pre" || kind === "post") {
      if (!layer.date || !/^\d{4}-\d{2}-\d{2}$/.test(layer.date) || layer.date >= data.storm)
        return null;
      if (kind === "pre" && layer.date >= data.ignition) return null;
      if (kind === "post" && layer.date < data.ignition) return null;
    }
  }
  if (data.summaries?.slope.status === "available") {
    const summary = data.summaries.slope.value;
    const slope = product.layers.slope;
    if (
      !validBounds(summary.bounds) ||
      !summary.bounds.every((value, index) => value === data.bounds[index])
    )
      return null;
    if (slope.status !== "available" || summary.thresholdDegrees !== slope.thresholdDegrees)
      return null;
  }
  return product;
}

export function validBounds(bounds: unknown): bounds is CaseData["bounds"] {
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  if (!bounds.every(Number.isFinite)) return false;
  return (
    bounds[0] >= -180 &&
    bounds[2] <= 180 &&
    bounds[1] > -85 &&
    bounds[3] < 85 &&
    bounds[0] < bounds[2] &&
    bounds[1] < bounds[3]
  );
}

export function containsBounds(outer: CaseData["bounds"], inner: CaseData["bounds"]) {
  return (
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
  );
}

export function readCatalog(value: unknown): Catalog {
  const catalog = value as Catalog;
  if (catalog?.version !== 1 || !Array.isArray(catalog.cases))
    throw new Error("Case catalog is invalid.");
  const seen = new Set<string>();
  for (const record of catalog.cases) {
    if (!record.observationId || seen.has(record.observationId))
      throw new Error("Case catalog has missing or duplicate observation IDs.");
    seen.add(record.observationId);
    if (record.products && !caseProductFor(record))
      throw new Error("Case catalog has an invalid product association.");
    if (!record.products && !record.productReason)
      throw new Error("Missing products require a reason.");
    for (const kind of ["burn", "slope"] as const) {
      const summary = record.summaries?.[kind];
      if (!summary || (summary.status === "unavailable" && !summary.reason))
        throw new Error("Missing summaries require a reason.");
    }
  }
  if (!seen.has(catalog.defaultCaseId)) throw new Error("Default case is absent from the catalog.");
  return catalog;
}
