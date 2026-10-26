import type { LineString } from "geojson";

export type DrivingRoute = {
  path: LineString;
  distanceMeters: number;
  durationSeconds: number;
  checkedAt: string;
};

export async function loadDrivingRoute(
  origin: [number, number],
  destination: [number, number],
  signal: AbortSignal,
): Promise<DrivingRoute> {
  const response = await fetch("/driving-route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, destination }),
    signal,
  });
  if (!response.ok) throw new Error("Driving route unavailable");
  return response.json();
}
