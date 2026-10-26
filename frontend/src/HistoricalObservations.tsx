import { useEffect, useState } from "react";
import type { FeatureCollection } from "geojson";

export type RecordedObservation = {
  id: string;
  fireId: string;
  assessmentSegmentId: string;
  assessmentLinked: boolean;
  insideFirePerimeter: boolean | null;
  longitude: number;
  latitude: number;
  stormDate: string;
  recordingDate: string | null;
  response: 0 | 1;
  PeakI15: number | null;
  HM23: number | null;
  UpstreamArea: number | null;
  gauge: string | null;
  gaugeId: string | null;
  gaugeStormId: string;
  source: string;
  geometryMatch: string;
  spatialStatus: string;
  relationship: "fire_specific";
  dataClass: "Observed";
  rainfallThreshold?: {
    status: string;
    reason?: string;
    depthMm?: number;
    probability?: number;
    durationMinutes?: number;
    scope?: string;
    assessmentDate?: string;
    sourceUrl?: string;
  };
};
type Inventory = {
  schemaVersion: number;
  fireId: string;
  sourceUrl: string;
  retrievedAt: string;
  publicationDate: string;
  limitation: string;
  records: RecordedObservation[];
};

export function readHistoricalObservations(value: unknown, id: string): Inventory {
  const data = value as Inventory;
  if (
    data?.schemaVersion !== 1 ||
    data.fireId !== id ||
    !Array.isArray(data.records) ||
    !data.sourceUrl?.startsWith("https://") ||
    !Number.isFinite(Date.parse(data.retrievedAt)) ||
    !Number.isFinite(Date.parse(data.publicationDate)) ||
    !data.limitation
  )
    throw new Error("Observation identity differs");
  const seen = new Set<string>();
  for (const row of data.records) {
    if (
      !row.id ||
      seen.has(row.id) ||
      row.fireId !== id ||
      ![0, 1].includes(row.response) ||
      row.dataClass !== "Observed" ||
      row.relationship !== "fire_specific" ||
      !Number.isFinite(row.longitude) ||
      !Number.isFinite(row.latitude) ||
      Math.abs(row.longitude) > 180 ||
      Math.abs(row.latitude) > 90 ||
      !Number.isFinite(Date.parse(row.stormDate)) ||
      !row.gaugeStormId
    )
      throw new Error("Invalid or duplicate observation");
    for (const key of ["PeakI15", "HM23", "UpstreamArea"] as const) {
      if (row[key] !== null && (!Number.isFinite(row[key]) || row[key] < 0))
        throw new Error("Invalid inventory input");
    }
    if (row.HM23 !== null && row.HM23 > 1) throw new Error("Invalid fraction");
    const threshold = row.rainfallThreshold;
    if (
      threshold?.status === "available" &&
      (threshold.probability !== 0.5 ||
        threshold.durationMinutes !== 15 ||
        !Number.isFinite(threshold.depthMm) ||
        threshold.depthMm! <= 0 ||
        !threshold.sourceUrl?.startsWith("https://"))
    )
      throw new Error("Unverified rainfall threshold");
    seen.add(row.id);
  }
  return data;
}

export function observationPoints(data: Inventory): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.records.map((row) => ({
      type: "Feature",
      id: row.id,
      properties: { id: row.id },
      geometry: { type: "Point", coordinates: [row.longitude, row.latitude] },
    })),
  };
}

export function useHistoricalObservations(id: string | null, enabled: boolean) {
  const [loaded, setLoaded] = useState<{
    id: string;
    data?: Inventory;
  } | null>(null);
  useEffect(() => {
    if (!id || !enabled) return;
    const controller = new AbortController();
    async function load() {
      try {
        const audit = await fetch("/data/historical-fires/observation-audit.json", {
          signal: controller.signal,
        });
        if (!audit.ok) throw new Error("Not checked.");
        const index = await audit.json();
        if (!Object.hasOwn(index.fires, id!)) {
          setLoaded({ id: id! });
          return;
        }
        const response = await fetch(
          `/data/historical-fires/observations/${id!.replaceAll(":", "-")}.json`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Prepared observations could not load.");
        const data = readHistoricalObservations(await response.json(), id!);
        if (!controller.signal.aborted) setLoaded({ id: id!, data });
      } catch {
        if (!controller.signal.aborted) setLoaded({ id: id! });
      }
    }
    void load();
    return () => controller.abort();
  }, [id, enabled]);
  return loaded?.id === id ? loaded : null;
}
