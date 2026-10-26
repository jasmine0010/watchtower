import { useEffect, useState } from "react";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

export const zoneSource =
  "https://data.ca.gov/@california-office-of-emergency-services/california-evacuation-aggregation-layer";
export const demoStatusSource =
  "https://www.fire.ca.gov/incidents/2025/1/7/palisades-fire/updates/87c9519f-dbb7-4066-81ba-566cd11fa60b";
export const demoGeometrySource =
  "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Evacuation_Zones_Jan_13_2025/FeatureServer/0";
export const demoExtentSource =
  "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Maximum_Extent_Evacuation_Zones/FeatureServer/0";
const layer =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0";
export const zoneQuery =
  `${layer}/query?` +
  new URLSearchParams({
    where: "STATUS IN ('Evacuation Order','Evacuation Warning','Shelter In Place')",
    outFields: "OBJECTID,COUNTY,ZONE_NAME,STATUS,EDIT_DATE,PUBLIC_INFO,CRITICAL_INFO",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "2000",
    f: "geojson",
  });

export const zoneColors: Record<string, string> = {
  "Evacuation Order": "#c76264",
  "Evacuation Warning": "#d6ae35",
  "Shelter In Place": "#9b6cc1",
};

export type EvacuationZones = FeatureCollection<Polygon | MultiPolygon>;
export const emptyZones: EvacuationZones = { type: "FeatureCollection", features: [] };

export function readZones(raw: unknown, now: number) {
  const source = raw as FeatureCollection & {
    exceededTransferLimit?: boolean;
    properties?: { exceededTransferLimit?: boolean };
  };
  if (
    source?.type !== "FeatureCollection" ||
    !Array.isArray(source.features) ||
    source.exceededTransferLimit ||
    source.properties?.exceededTransferLimit
  )
    throw new Error("Evacuation zones unavailable or incomplete");
  const currentZones: EvacuationZones = { type: "FeatureCollection", features: [] };
  let outdated = 0;
  for (const feature of source.features) {
    const status = Object.keys(zoneColors).find(
      (name) => name.toLowerCase() === String(feature.properties?.STATUS).toLowerCase(),
    );
    if (
      (feature.geometry?.type !== "Polygon" && feature.geometry?.type !== "MultiPolygon") ||
      !status
    )
      continue;
    const edited = feature.properties?.EDIT_DATE;

    if (typeof edited !== "number" || edited > now || now - edited > 7 * 86400000) {
      outdated++;
      continue;
    }
    currentZones.features.push({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        ...feature.properties,
        STATUS: status,
        color: zoneColors[status],
      },
    });
  }
  return { data: currentZones, outdated };
}

export function useEvacuationZones(enabled: boolean, refresh: number) {
  const [snapshot, setSnapshot] = useState<ReturnType<typeof readZones> | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setSnapshot(null);
    function load() {
      setLoading(true);
      setFailed(false);
      fetch(zoneQuery, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error("Evacuation zones unavailable");
          return response.json();
        })
        .then((value) => {
          if (controller.signal.aborted) return;
          setSnapshot(readZones(value, Date.now()));
          setCheckedAt(Date.now());
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSnapshot(null);
            setFailed(true);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    load();
    const interval = setInterval(load, 5 * 60000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [enabled, refresh]);
  return { snapshot, loading, failed, checkedAt };
}
