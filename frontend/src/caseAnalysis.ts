import type { CaseData } from "./types";

export function observationLocation(record: CaseData): [number, number] | null {
  const longitudeText = record.inventory.ObservationLongitude;
  const latitudeText = record.inventory.ObservationLatitude;
  if (!longitudeText?.trim() || !latitudeText?.trim()) return null;
  const longitude = Number(longitudeText);
  const latitude = Number(latitudeText);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -125 || longitude > -114 || latitude < 32 || latitude > 42.5) return null;
  return [longitude, latitude];
}
