import { useEffect, useState } from "react";
import type { FeatureCollection, Point } from "geojson";

export const reliefSources = [
  {
    name: "Contra Costa",
    where: "1=1",
    page: "https://www.arcgis.com/home/item.html?id=c41dc7a7fc7b4154aa73225dd6f2071b",
    layer:
      "https://services3.arcgis.com/42Dx6OWonqK9LoEE/arcgis/rest/services/Contra_Costa_Weather_Relief_Centers_Survey_(Active_View)/FeatureServer/1",
    fields:
      "facility_name,facility_address,facility_status,additional_display_info,contact_display_info,hours_open",
  },
  {
    name: "San Diego",
    where: "1=1",
    page: "https://www.sandiegocounty.gov/content/sdc/hhsa/programs/phs/PublicHealthPreparednesandResponse/cool-zones/",
    layer:
      "https://services1.arcgis.com/1vIhDJwtG5eNmiqX/arcgis/rest/services/HLTH_COOL_ZONES_PUBLIC/FeatureServer/0",
    fields: "Organization,Address,City,State,ZipCode,Phone,OperationalHours,PetPolicy,NAME",
  },
  {
    name: "Statewide directory",
    page: "https://ww2.arb.ca.gov/cleanaircenters",
    layer:
      "https://services6.arcgis.com/x7ftScCDR8g2kVFB/arcgis/rest/services/Clean_Air_Centers_Public/FeatureServer/0",
    where: "center_activated='Yes'",
    fields:
      "center_activated,center_name,center_type,center_address,center_phone,center_location_description,monday,tuesday,wednesday,thursday,friday,saturday,sunday,EditDate",
  },
] as const;

export type ReliefSourceName = (typeof reliefSources)[number]["name"];
export const reliefKinds = [
  { kind: "clean-air", label: "Clean air center", color: "#237e7a" },
  { kind: "cooling", label: "Cooling center", color: "#356e9b" },
] as const;
export type ReliefProperties = {
  name: string;
  address: string;
  kind: (typeof reliefKinds)[number]["kind"];
  source: ReliefSourceName;
  hours: string;
  contact: string;
  pets?: string;
  note: string;
  updated?: number;
};
export type ReliefFeatures = FeatureCollection<Point, ReliefProperties>;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function readReliefCenters(value: unknown, sourceName: ReliefSourceName): ReliefFeatures {
  const source = value as FeatureCollection & {
    exceededTransferLimit?: boolean;
    properties?: { exceededTransferLimit?: boolean };
  };
  if (
    source?.type !== "FeatureCollection" ||
    !Array.isArray(source.features) ||
    source.exceededTransferLimit ||
    source.properties?.exceededTransferLimit
  )
    throw new Error("Center data unavailable or incomplete");
  const data: ReliefFeatures = { type: "FeatureCollection", features: [] };
  for (const feature of source.features) {
    const p = feature.properties;
    const geometry = feature.geometry;
    if (
      !p ||
      geometry?.type !== "Point" ||
      geometry.coordinates.length < 2 ||
      !geometry.coordinates.every(Number.isFinite) ||
      geometry.coordinates[0] < -125 ||
      geometry.coordinates[0] > -114 ||
      geometry.coordinates[1] < 32 ||
      geometry.coordinates[1] > 42.5
    )
      continue;
    let properties: ReliefProperties;
    if (sourceName === "Statewide directory") {
      if (p.center_activated !== "Yes") continue;
      const hours = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        .filter((day) => text(p[day.toLowerCase()]))
        .map((day) => `${day.slice(0, 3)}: ${text(p[day.toLowerCase()])}`)
        .join("; ");
      properties = {
        name: text(p.center_name),
        address: text(p.center_address),
        kind: "clean-air",
        source: sourceName,
        hours,
        contact: text(p.center_phone),
        note: text(p.center_location_description),
        updated: typeof p.EditDate === "number" && Number.isFinite(p.EditDate) ? p.EditDate : 0,
      };
    } else if (sourceName === "Contra Costa") {
      let kind: ReliefProperties["kind"];
      if (p.facility_status === "Active - Clean Air Facility Only") kind = "clean-air";
      else if (
        p.facility_status === "Active - Cooling Center Only" ||
        p.facility_status === "Active - Cooling Center (Experiencing Homelessness)"
      )
        kind = "cooling";
      else continue;
      properties = {
        name: text(p.facility_name),
        address: text(p.facility_address),
        kind,
        source: sourceName,
        hours: text(p.hours_open),
        contact: text(p.contact_display_info),
        note: text(p.additional_display_info),
      };
    } else {
      if (p.State !== "CA") continue;
      const name = text(p.Organization) || text(p.NAME);
      const hours = text(p.OperationalHours);
      properties = {
        name,
        address: text(p.Address)
          ? [text(p.Address), text(p.City), "CA", String(p.ZipCode || "")]
              .filter(Boolean)
              .join(", ")
          : "",
        kind: "cooling",
        source: sourceName,
        contact: text(p.Phone),
        note: text(p.PetPolicy),
        pets: text(p.PetPolicy) || "Not supplied",

        hours: hours === name || hours === text(p.NAME) ? "" : hours,
      };
    }
    if (!properties.name || !properties.address) continue;
    data.features.push({ type: "Feature", geometry, properties });
  }
  if (sourceName === "Statewide directory") {
    data.features.sort((a, b) => (b.properties.updated || 0) - (a.properties.updated || 0));
    const locations = new Set<string>();
    data.features = data.features.filter((feature) => {
      const key =
        feature.properties.address.toLowerCase() +
        "|" +
        feature.geometry.coordinates.map((value) => value.toFixed(4)).join("|");
      if (locations.has(key)) return false;
      locations.add(key);
      return true;
    });
  }
  return data;
}

type ReliefSnapshot = { data: ReliefFeatures; failed: ReliefSourceName[] };

export function useReliefCenters(enabled: boolean, refresh: number) {
  const [snapshot, setSnapshot] = useState<ReliefSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    async function load() {
      const results = await Promise.all(
        reliefSources.map(async (source) => {
          try {
            const query = new URLSearchParams({
              where: source.where,
              outFields: source.fields,
              returnGeometry: "true",
              outSR: "4326",
              f: "geojson",
            });
            const response = await fetch(source.layer + "/query?" + query, {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
              credentials: "omit",
            });
            if (!response.ok) throw new Error("Center data unavailable");
            return readReliefCenters(await response.json(), source.name);
          } catch {
            return null;
          }
        }),
      );
      if (controller.signal.aborted) return;
      setSnapshot(
        results.every((result) => result === null)
          ? null
          : {
              data: {
                type: "FeatureCollection",
                features: results.flatMap((result) => result?.features || []),
              },
              failed: reliefSources
                .filter((_, index) => results[index] === null)
                .map((source) => source.name),
            },
      );
      setLoading(false);
    }
    void load();
    return () => controller.abort();
  }, [enabled, refresh]);
  return { snapshot, loading };
}
