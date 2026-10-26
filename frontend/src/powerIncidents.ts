import { useEffect, useState } from "react";
import type { FeatureCollection, Point } from "geojson";
import { formatLaTimestamp } from "./formatLaTimestamp";

export const powerLayer =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/Power_Outages_(View)/FeatureServer/0";
export const powerCoverage =
  "Cal OES: PG&E, SCE, SDG&E and SMUD only. Approximate locations; not address-level power status or complete California coverage.";
type PowerProperties = {
  UtilityCompany?: string;
  Cause?: string;
  OutageType?: string;
  OutageStatus?: string;
  ImpactedCustomers?: number | null;
  StartDate?: number | null;
  EstimatedRestoreDate?: number | null;
};
export type PowerFeatures = FeatureCollection<Point, PowerProperties>;
export type PowerSnapshot = { data: PowerFeatures; updated: number };

export function readPowerIncidents(value: unknown): PowerFeatures {
  const source = value as PowerFeatures & {
    exceededTransferLimit?: boolean;
    properties?: { exceededTransferLimit?: boolean };
  };
  if (
    source?.type !== "FeatureCollection" ||
    !Array.isArray(source.features) ||
    source.exceededTransferLimit ||
    source.properties?.exceededTransferLimit
  )
    throw new Error("Power outage feed unavailable or incomplete");
  return {
    type: "FeatureCollection",
    features: source.features.filter((feature) => {
      const point = feature.geometry;
      return (
        feature.properties?.OutageStatus === "Active" &&
        point?.type === "Point" &&
        point.coordinates.length >= 2 &&
        point.coordinates.every(Number.isFinite) &&
        point.coordinates[0] >= -125 &&
        point.coordinates[0] <= -114 &&
        point.coordinates[1] >= 32 &&
        point.coordinates[1] <= 42.5
      );
    }),
  };
}

function powerTime(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? formatLaTimestamp(value)
    : "Not supplied";
}

export function powerText(p: PowerProperties, updated: number) {
  const customers =
    typeof p.ImpactedCustomers === "number" && p.ImpactedCustomers >= 0
      ? p.ImpactedCustomers.toLocaleString()
      : "Not supplied";
  return `${p.UtilityCompany || "Utility not supplied"} / Reported outage. Type: ${p.OutageType || "Not supplied"}. Customers affected: ${customers} (accounts, not people). Cause: ${p.Cause || "Not supplied"}. Started: ${powerTime(p.StartDate)}. Estimated restoration: ${powerTime(p.EstimatedRestoreDate)} (an estimate, not a guarantee). Feed updated: ${powerTime(updated)}. ${powerCoverage} Planned outages are not necessarily wildfire shutoffs; some source records may describe a pending outage.`;
}

export function usePowerIncidents(refresh: number) {
  const [snapshot, setSnapshot] = useState<PowerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    async function load() {
      try {
        const options = {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          cache: "no-store" as const,
          credentials: "omit" as const,
        };
        const query = new URLSearchParams({
          where: "OutageStatus='Active'",
          outFields: "*",
          returnGeometry: "true",
          outSR: "4326",
          f: "geojson",
        });
        const [response, metadata] = await Promise.all([
          fetch(`${powerLayer}/query?${query}`, options),
          fetch(`${powerLayer}?f=json`, options),
        ]);
        if (!response.ok || !metadata.ok) throw new Error("Power outage feed unavailable");
        const data = readPowerIncidents(await response.json());
        const info = await metadata.json();
        const updated = info.editingInfo?.dataLastEditDate;
        if (typeof updated !== "number" || !Number.isFinite(updated) || updated <= 0)
          throw new Error("Power feed update unavailable");
        if (!controller.signal.aborted) setSnapshot({ data, updated });
      } catch {
        if (!controller.signal.aborted) setSnapshot(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [refresh]);
  return { snapshot, loading };
}
