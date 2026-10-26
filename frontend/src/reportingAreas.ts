import type { Feature, FeatureCollection, Polygon, MultiPolygon, Position } from "geojson";
import type { WavePlace } from "./waves";
import { pointDistanceKm } from "./wavesLive";

type AreaProperties = {
  code: string;
  name: string;
  state: string;
  agency: string;
  sourceUrl: string;
  retrievedAt: string;
  boundaryUpdatedAt: string | null;
  serviceUpdatedAt: string | null;
  places: { name: string; zipcode: string; pointInside: boolean }[];
};
export type ReportingArea = Feature<Polygon | MultiPolygon, AreaProperties>;

function validRing(value: unknown): value is Position[] {
  if (!Array.isArray(value) || value.length < 4) return false;
  for (const point of value) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) > 90
    )
      return false;
  }
  const first = value[0];
  const last = value[value.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

export function readReportingAreas(value: unknown): ReportingArea[] {
  const data = value as { type?: string; features?: ReportingArea[] } | null;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw new Error("Reporting-area boundary unavailable.");
  const codes = new Set<string>();
  for (const feature of data.features) {
    const properties = feature?.properties;
    const geometry = feature?.geometry;
    if (
      feature?.type !== "Feature" ||
      !properties ||
      typeof properties.code !== "string" ||
      !properties.code ||
      feature.id !== properties.code ||
      codes.has(properties.code) ||
      !properties.name ||
      !properties.state ||
      !properties.agency ||
      !properties.sourceUrl ||
      !properties.retrievedAt ||
      !Array.isArray(properties.places) ||
      (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon")
    )
      throw new Error("Reporting-area boundary unavailable.");
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length)
      throw new Error("Reporting-area boundary unavailable.");
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length || !polygon.every(validRing))
        throw new Error("Reporting-area boundary unavailable.");
    }
    for (const place of properties.places) {
      if (!place.name || !place.zipcode || typeof place.pointInside !== "boolean")
        throw new Error("Reporting-area boundary unavailable.");
    }
    codes.add(properties.code);
  }
  return data.features;
}

export function reportingAreaFor(areas: ReportingArea[], place: WavePlace) {
  const matches = areas.filter(
    (area) => area.properties.name === place.reportingArea && area.properties.state === "CA",
  );
  return matches.length === 1 ? matches[0] : null;
}

function ringContains(ring: Position[], point: [number, number]) {
  let inside = false;
  const [longitude, latitude] = point;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if (
      (y1 > latitude) !== (y2 > latitude) &&
      longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1
    )
      inside = !inside;
  }
  return inside;
}

function polygonContains(polygon: Position[][], point: [number, number]) {
  return (
    ringContains(polygon[0], point) &&
    polygon.slice(1).every((hole) => !ringContains(hole, point))
  );
}

export function reportingAreaAtPoint(areas: ReportingArea[], point: [number, number]) {
  const matches = areas.filter((area) => {
    if (area.properties.state !== "CA") return false;
    const geometry = area.geometry;
    if (geometry.type === "Polygon") return polygonContains(geometry.coordinates, point);
    return geometry.coordinates.some((polygon) => polygonContains(polygon, point));
  });
  return matches.length === 1 ? matches[0].properties.name : null;
}

export function mapAirReports(
  areas: ReportingArea[],
  reports: FeatureCollection,
  selectedName?: string,
) {
  const regions: FeatureCollection = {
    type: "FeatureCollection",
    features: [],
  };
  const points: FeatureCollection = { type: "FeatureCollection", features: [] };
  for (const report of reports.features) {
    const matches = areas.filter(
      (area) => area.properties.state === "CA" && area.properties.name === report.properties?.area,
    );
    const properties = {
      ...report.properties,
      highlighted: report.properties?.area === selectedName,
    };
    if (matches.length === 1) {
      regions.features.push({ ...matches[0], properties });
    } else {
      points.features.push({ ...report, properties });
    }
  }
  return { regions, points };
}

export function nearbyAirReports(
  reports: FeatureCollection,
  place: Pick<WavePlace, "longitude" | "latitude">,
) {
  const ranked = [];
  for (const report of reports.features) {
    if (report.geometry?.type !== "Point") continue;
    const distance = pointDistanceKm(
      [place.longitude, place.latitude],
      report.geometry.coordinates as [number, number],
    );
    ranked.push({ report, distance });
  }
  ranked.sort(
    (a, b) => a.distance - b.distance || String(a.report.id).localeCompare(String(b.report.id)),
  );
  return ranked.slice(0, 5);
}

export function airLabelPriority(reports: FeatureCollection, selectedName?: string) {
  const ranked = [...reports.features];
  ranked.sort((first, second) => {
    const difference = Number(second.properties?.value) - Number(first.properties?.value);
    return difference || String(first.id).localeCompare(String(second.id));
  });
  const labels: FeatureCollection = { type: "FeatureCollection", features: [] };
  for (const [index, report] of ranked.entries()) {
    labels.features.push({
      ...report,
      properties: {
        ...report.properties,
        labelRank: index,
        chosenLabel: report.properties!.area === selectedName,
        statewideLabel:
          index < 5 || report.properties!.value > 50 || report.properties!.area === selectedName,
      },
    });
  }
  return labels;
}
