import type { Feature, Point, Geometry, Position } from "geojson";
import type { ShelterProperties } from "./redCrossShelters";
import type { ReliefProperties } from "./reliefCenters";
import { nearbyHighwayClosures, type HighwayClosure } from "./highwayClosures";
import type { PersonalLocation } from "./personalLocation";
import type { EvacuationZones } from "./evacuationZones";
import { perimeterDistanceKm } from "./wavesLive";

export type PersonalDestination = Feature<Point, ShelterProperties | ReliefProperties>;
const evacuationPriority = ["Evacuation Order", "Shelter In Place", "Evacuation Warning"];

export function highestEvacuationZone(zones: EvacuationZones["features"]) {
  for (const status of evacuationPriority) {
    const zone = zones.find((zone) => zone.properties?.STATUS === status);
    if (zone) return zone;
  }
  return undefined;
}

export function destinationKind(destination: PersonalDestination) {
  const p = destination.properties;
  if ("kind" in p) {
    if (p.kind === "clean-air") {
      return "Clean air center";
    } else {
      return "Cooling center";
    }
  } else {
    return "Shelter";
  }
}

export function travelRestrictions(
  closures: HighwayClosure[],
  origin: [number, number] | null,
  destination: PersonalDestination | null,
) {
  const found = new Map<string, ReturnType<typeof nearbyHighwayClosures>[number]>();
  const points = [origin, destination?.geometry.coordinates];
  for (const point of points) {
    if (!point) continue;
    const context: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: point },
    };
    for (const match of nearbyHighwayClosures(closures, context)) {
      const id = String(match.closure.id);
      const previous = found.get(id);
      if (!previous || (match.distanceKm ?? Infinity) < (previous.distanceKm ?? Infinity))
        found.set(id, match);
    }
  }
  return [...found.values()];
}

export function locationIsOld(location: PersonalLocation | null, now: number) {
  return !!location && location.kind === "gps" && now - location.timestamp > 5 * 60000;
}

export function polygonsOverlap(first: Geometry, second: Geometry) {
  if (
    (first.type !== "Polygon" && first.type !== "MultiPolygon") ||
    (second.type !== "Polygon" && second.type !== "MultiPolygon")
  )
    return false;
  const firstPolygons = first.type === "Polygon" ? [first.coordinates] : first.coordinates;
  const secondPolygons = second.type === "Polygon" ? [second.coordinates] : second.coordinates;
  const firstRings = firstPolygons.flat();
  const secondRings = secondPolygons.flat();
  function bounds(rings: Position[][]) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of rings)
      for (const [x, y] of ring) {
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
    return box;
  }
  const a = bounds(firstRings),
    b = bounds(secondRings);
  if (a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]) return false;
  if (
    firstPolygons.some((polygon) => perimeterDistanceKm(second, polygon[0][0]) === 0) ||
    secondPolygons.some((polygon) => perimeterDistanceKm(first, polygon[0][0]) === 0)
  )
    return true;
  function side(a: Position, b: Position, c: Position) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  }

  for (const ring of firstRings)
    for (const other of secondRings) {
      for (let i = 1; i < ring.length; i++)
        for (let j = 1; j < other.length; j++) {
          const a = ring[i - 1],
            b = ring[i],
            c = other[j - 1],
            d = other[j];
          if (
            Math.max(a[0], b[0]) < Math.min(c[0], d[0]) ||
            Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
            Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
            Math.max(c[1], d[1]) < Math.min(a[1], b[1])
          )
            continue;
          if (side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0) return true;
        }
    }
  return false;
}

function distanceToEdge(zone: EvacuationZones["features"][number], location: PersonalLocation) {
  const polygons =
    zone.geometry.type === "Polygon" ? [zone.geometry.coordinates] : zone.geometry.coordinates;
  const scaleX = 111320 * Math.cos((location.latitude * Math.PI) / 180);
  let distance = Infinity;
  for (const polygon of polygons)
    for (const ring of polygon)
      for (let index = 1; index < ring.length; index++) {
        const x = (ring[index - 1][0] - location.longitude) * scaleX;
        const y = (ring[index - 1][1] - location.latitude) * 111320;
        const dx = (ring[index][0] - ring[index - 1][0]) * scaleX;
        const dy = (ring[index][1] - ring[index - 1][1]) * 111320;
        const length = dx * dx + dy * dy;
        const along = length ? Math.max(0, Math.min(1, -(x * dx + y * dy) / length)) : 0;
        distance = Math.min(distance, Math.hypot(x + along * dx, y + along * dy));
      }
  return distance;
}

export function matchingEvacuationZones(
  zones: EvacuationZones,
  location: PersonalLocation | null,
  now: number,
) {
  if (!location || locationIsOld(location, now)) return [];
  const matches = [];
  for (const zone of zones.features) {
    const inside =
      perimeterDistanceKm(zone.geometry, [location.longitude, location.latitude]) === 0;

    const uncertain = distanceToEdge(zone, location) <= location.accuracy * 1.05;
    if (inside || uncertain) matches.push({ zone, possible: !inside || uncertain });
  }
  return matches.sort(
    (a, b) =>
      evacuationPriority.indexOf(a.zone.properties!.STATUS) -
      evacuationPriority.indexOf(b.zone.properties!.STATUS),
  );
}

export function reportedInstructions(zone: Feature) {
  return [zone.properties?.CRITICAL_INFO, zone.properties?.PUBLIC_INFO]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map((value) => value.replace(/<[^>]*>/g, " ").trim());
}
