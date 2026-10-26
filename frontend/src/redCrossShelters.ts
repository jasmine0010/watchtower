import { useEffect, useMemo, useState } from "react";
import type { FeatureCollection, Point } from "geojson";
import { pointDistanceKm } from "./wavesLive";
import { formatLaTimestamp } from "./formatLaTimestamp";

export const redCrossFinder =
  "https://www.redcross.org/get-help/disaster-relief-and-recovery-services/find-an-open-shelter.html";
const shelterLayer =
  "https://services.arcgis.com/pGfbNJoYypmNq86F/arcgis/rest/services/Shelters_Prod_EA_view/FeatureServer/0";
export const redCrossQuery =
  shelterLayer +
  "/query?" +
  new URLSearchParams({
    where: "active_state='CA' AND active_site_status='Open' AND hide_from_public='No'",
    outFields:
      "ObjectID,active_site_name,active_site_address,active_site_status,active_state,active_site_pet_shelter_type,hide_from_public,EditDate",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });

export type ShelterProperties = {
  name: string;
  address: string;
  pets: string;
  updated: number | null;
  archivedDays?: string;
};
export type ShelterFeatures = FeatureCollection<Point, ShelterProperties>;

export function sheltersByDistance(data: ShelterFeatures, longitude: number, latitude: number) {
  return data.features
    .map((feature) => ({
      feature,
      miles: pointDistanceKm([longitude, latitude], feature.geometry.coordinates) / 1.609344,
    }))
    .sort((a, b) => a.miles - b.miles);
}

export function readRedCrossShelters(value: unknown, now: number) {
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
    throw new Error("Red Cross shelter feed unavailable or incomplete");
  const data: ShelterFeatures = { type: "FeatureCollection", features: [] };
  let withheld = 0;
  for (const feature of source.features) {
    const p = feature.properties;
    if (p?.active_state !== "CA" || p.active_site_status !== "Open" || p.hide_from_public !== "No")
      continue;
    const geometry = feature.geometry;
    const updated = p.EditDate;
    if (
      geometry?.type !== "Point" ||
      geometry.coordinates.length < 2 ||
      geometry.coordinates[0] < -125 ||
      geometry.coordinates[0] > -114 ||
      geometry.coordinates[1] < 32 ||
      geometry.coordinates[1] > 42.5 ||
      !geometry.coordinates.every(Number.isFinite) ||
      typeof p.active_site_name !== "string" ||
      !p.active_site_name.trim() ||
      typeof p.active_site_address !== "string" ||
      !p.active_site_address.trim()
    ) {
      withheld++;
      continue;
    }
    data.features.push({
      type: "Feature",
      geometry,
      properties: {
        name: p.active_site_name,
        address: p.active_site_address,
        pets:
          typeof p.active_site_pet_shelter_type === "string" &&
          p.active_site_pet_shelter_type.trim()
            ? p.active_site_pet_shelter_type
            : "Not supplied",

        updated:
          typeof updated === "number" &&
          Number.isFinite(updated) &&
          updated > 0 &&
          updated <= now + 5 * 60000
            ? updated
            : null,
      },
    });
  }
  return { data, withheld };
}

export function shelterText(p: ShelterProperties) {
  if (p.archivedDays) return `${p.name}. ${p.address}. Open shelter.`;
  const time = p.updated
    ? formatLaTimestamp(p.updated, "not supplied", "Invalid Date")
    : "not supplied";
  const pets =
    p.pets && p.pets !== "Not supplied" ? ` Pet accommodation: ${p.pets} (source wording).` : "";
  return `${p.name}. ${p.address}. Reported open by the Red Cross.${pets} Source updated ${time}; not an on-site verification time. Space and status can change. Follow local evacuation instructions.`;
}

export function useRedCrossShelters(refresh: number, now: number, enabled = true) {
  const [source, setSource] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    async function load() {
      try {
        const response = await fetch(redCrossQuery, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          credentials: "omit",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Red Cross unavailable");
        const value: unknown = await response.json();
        readRedCrossShelters(value, Date.now());
        if (!controller.signal.aborted) setSource(value);
      } catch {
        if (!controller.signal.aborted) setSource(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [refresh, enabled]);
  const snapshot = useMemo(
    () => (source ? readRedCrossShelters(source, now) : null),
    [source, now],
  );
  return { snapshot, loading };
}
