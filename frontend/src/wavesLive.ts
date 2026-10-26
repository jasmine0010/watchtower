import type { FeatureCollection, Polygon, Geometry } from "geojson";
import type { WavePlace } from "./waves";

export const airNowUrl = "https://files.airnowtech.org/airnow/today/reportingarea.dat";
export const monitorUrl =
  "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air%20Now%20Current%20Monitor%20Data%20Public/FeatureServer/0";
export const perimeterUrl =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0";
export const incidentUrl =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0";
export const alertUrl = "https://api.weather.gov/alerts/active?area=CA";

export const nearbyFireKm = 25;
export const emptyFeatures: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export const aqiBands = [
  { label: "Good", low: 0, high: 50, color: "#85bf70" },
  { label: "Moderate", low: 50, high: 100, color: "#f3dc38" },
  {
    label: "Unhealthy for Sensitive Groups",
    low: 100,
    high: 150,
    color: "#f59a38",
  },
  { label: "Unhealthy", low: 150, high: 200, color: "#ed6d58" },
  { label: "Very Unhealthy", low: 200, high: 300, color: "#b86dca" },
  { label: "Hazardous", low: 300, high: 500, color: "#9b3158" },
];

export function aqiMarker(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 500) return null;
  return value / 5;
}

export function aqiCategoryCounts(reports: FeatureCollection) {
  const counts = [];
  for (const band of aqiBands) {
    let count = 0;
    for (const report of reports.features) {
      if (report.properties?.category === band.label) count++;
    }
    if (count > 0) counts.push({ ...band, count });
  }
  return counts;
}

export function aqiHeadline(reports: FeatureCollection) {
  const total = reports.features.length;
  if (total === 0) return "No usable reporting-area values";
  let elevated = 0;
  for (const report of reports.features) {
    if (report.properties!.value > 50) elevated++;
  }
  return `${elevated} of ${total} areas Moderate or worse`;
}

export function reportAge(
  time: string | number | null,
  now: number,
  stale = false,
  delayed = false,
) {
  if (time === null) return null;
  const timestamp = new Date(time).valueOf();
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  let label = "Updated just now";
  if (minutes >= 60) label = `Updated ${Math.floor(minutes / 60)} hr ago`;
  else if (minutes > 0) label = `Updated ${minutes} min ago`;
  let reportState;
  if (delayed) {
    reportState = "delayed";
  } else if (stale) {
    reportState = "stale";
  } else {
    reportState = "fresh";
  }
  return { label, state: reportState };
}

export function noaaToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function verifiedSmokeDate(
  source: { dateUtc: string; requestedDateUtc?: string; earlier?: boolean },
  today: string,
) {
  if (source.dateUtc === today) return true;
  const days = (Date.parse(today) - Date.parse(source.dateUtc)) / 86400000;

  return (
    source.earlier === true &&
    source.requestedDateUtc === today &&
    Number.isInteger(days) &&
    days >= 1 &&
    days <= 2
  );
}

export function windCompass(degrees: number | null | undefined) {
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) return null;
  const bearing = ((degrees % 360) + 360) % 360;
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return labels[Math.round(bearing / 45) % 8];
}

export function windMph(value: number | null | undefined, unit?: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (unit === "wmoUnit:km_h-1") return value / 1.609344;
  if (unit === "wmoUnit:m_s-1") return (value * 3.6) / 1.609344;
  return null;
}

export function pointDistanceKm(first: number[], second: number[]) {
  const radians = Math.PI / 180;
  const latitude = (second[1] - first[1]) * radians;
  const longitude = (second[0] - first[0]) * radians;
  const a =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(first[1] * radians) * Math.cos(second[1] * radians) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

export function perimeterProximity(geometry: Geometry, point: number[]) {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return null;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let nearest = Infinity;
  let closest: number[] | null = null;

  const xScale = ((6371 * Math.PI) / 180) * Math.cos((point[1] * Math.PI) / 180);
  const yScale = (6371 * Math.PI) / 180;
  for (const rings of polygons) {
    let inside = ringContains(rings[0], point[0], point[1]);
    for (const hole of rings.slice(1)) {
      if (ringContains(hole, point[0], point[1])) inside = false;
    }
    if (inside) return { distanceKm: 0, point };
    for (const ring of rings) {
      for (let index = 1; index < ring.length; index++) {
        const x = (ring[index - 1][0] - point[0]) * xScale;
        const y = (ring[index - 1][1] - point[1]) * yScale;
        const dx = (ring[index][0] - ring[index - 1][0]) * xScale;
        const dy = (ring[index][1] - ring[index - 1][1]) * yScale;
        const lengthSquared = dx * dx + dy * dy;
        const along =
          lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(x * dx + y * dy) / lengthSquared));
        const candidate = [
          ring[index - 1][0] + along * (ring[index][0] - ring[index - 1][0]),
          ring[index - 1][1] + along * (ring[index][1] - ring[index - 1][1]),
        ];
        const distance = pointDistanceKm(point, candidate);
        if (distance < nearest) {
          nearest = distance;
          closest = candidate;
        }
      }
    }
  }
  return closest ? { distanceKm: nearest, point: closest } : null;
}

export function perimeterDistanceKm(geometry: Geometry, point: number[]) {
  return perimeterProximity(geometry, point)?.distanceKm ?? null;
}

export function incidentDirection(from: number[], to: number[]) {
  const radians = Math.PI / 180;
  const longitude = (to[0] - from[0]) * radians;
  const east = Math.cos(to[1] * radians) * Math.sin(longitude);
  const north =
    Math.cos(from[1] * radians) * Math.sin(to[1] * radians) -
    Math.sin(from[1] * radians) * Math.cos(to[1] * radians) * Math.cos(longitude);
  const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  const names = [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest",
  ];
  return { bearing, name: names[Math.round(bearing / 45) % 8] };
}

export function airNowObservation(
  text: string,
  area: string,
  now = new Date(),
  pollutant?: "PM2.5",
) {
  const matches = [];
  for (const line of text.split(/\r?\n/)) {
    const row = line.split("|");

    if (row[5] !== "O" || row[7] !== area || row[8] !== "CA") continue;
    if (pollutant ? row[11] !== pollutant : row[6] !== "Y") continue;
    const date = row[1].match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    const time = row[2].match(/^(\d{1,2}):([0-5]\d)$/);
    let offset;
    if (row[3] === "PST") {
      offset = "-08:00";
    } else if (row[3] === "PDT") {
      offset = "-07:00";
    } else {
      offset = null;
    }
    const value = Number(row[12]);
    if (!date || !offset || !time || Number(time[1]) > 23 || !/^\d+$/.test(row[12]))
      throw new Error("AQI unavailable");
    const dateIso = `20${date[3]}-${date[1]}-${date[2]}`;
    const calendar = new Date(dateIso + "T00:00:00Z");
    if (!Number.isFinite(calendar.valueOf()) || calendar.toISOString().slice(0, 10) !== dateIso)
      throw new Error("AQI date unavailable");
    const timestamp = `${dateIso}T${time[1].padStart(2, "0")}:${time[2]}:00${offset}`;
    const age = now.getTime() - Date.parse(timestamp);
    if (!Number.isFinite(age) || age < -3600000 || age > 6 * 3600000 || value > 500) continue;
    const band = aqiBands.find((item) => item.label.toLowerCase() === row[13]?.toLowerCase());
    if (!band || !row[11] || !row[16]) throw new Error("AQI unavailable");
    matches.push({
      value,
      category: row[13],
      color: band.color,
      pollutant: row[11],
      area: row[7],
      timestamp,
      issuedDate: row[0],
      agency: row[16],
      delayed: age > 2 * 3600000,
    });
  }

  if (matches.length !== 1) throw new Error("AQI unavailable or stale");
  return matches[0];
}

export type AirNowDailyReading = {
  date: string;
  value: number;
  category: string;
  color: string;
};

export function airNowDailyMaximum(
  text: string,
  area: string,
  date: string,
): AirNowDailyReading | null {
  const matches: AirNowDailyReading[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = line.split("|");
    const match = row[1]?.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    if (row[5] !== "Y" || row[7] !== area || row[8] !== "CA" || !match) continue;
    const rowDate = `20${match[3]}-${match[1]}-${match[2]}`;
    if (!/^\d{1,3}$/.test(row[12] || "")) continue;
    const value = Number(row[12]);
    const band = aqiBands.find((item) => value >= item.low && value <= item.high);
    if (rowDate !== date || !Number.isInteger(value) || !band) continue;
    matches.push({ date, value, category: band.label, color: band.color });
  }
  return matches.sort((first, second) => second.value - first.value)[0] || null;
}

export function airNowPastDates(today: string, count = 5) {
  const date = new Date(`${today}T12:00:00Z`);
  if (!Number.isFinite(date.valueOf())) return [];
  const dates: string[] = [];
  for (let daysAgo = 1; daysAgo <= count; daysAgo++) {
    date.setUTCDate(date.getUTCDate() - 1);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

export function airNowReportingArchiveUrl(date: string) {
  const [year, month, day] = date.split("-");
  return `https://files.airnowtech.org/airnow/${year}/${year}${month}${day}/reportingarea.dat`;
}

export function airNowForecasts(text: string, area: string, now = new Date()) {
  const dates: string[] = [];
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  for (let day = 0; day <= 1; day++) {
    dates.push(new Date(Date.parse(localDate) + day * 86400000).toISOString().slice(0, 10));
  }
  const forecasts = [];
  for (const date of dates) {
    const matches = [];
    for (const line of text.split(/\r?\n/)) {
      const row = line.split("|");
      if (row[5] !== "F" || row[6] !== "Y" || row[7] !== area || row[8] !== "CA") continue;
      const valid = row[1]?.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
      if (!valid || `20${valid[3]}-${valid[1]}-${valid[2]}` !== date) continue;
      const band = aqiBands.find((item) => item.label.toLowerCase() === row[13]?.toLowerCase());
      if (!band || !row[16]) continue;
      matches.push({
        date,
        day: date === dates[0] ? "Today" : "Tomorrow",
        category: band.label,
        issuedDate: row[0],
        agency: row[16],
      });
    }

    if (matches.length === 1) forecasts.push(matches[0]);
  }
  return forecasts;
}

function ringContains(ring: number[][], longitude: number, latitude: number) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[previous];
    const [x2, y2] = ring[index];
    const cross = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1);
    if (
      Math.abs(cross) < 1e-12 &&
      longitude >= Math.min(x1, x2) &&
      longitude <= Math.max(x1, x2) &&
      latitude >= Math.min(y1, y2) &&
      latitude <= Math.max(y1, y2)
    )
      return true;
    if (
      y1 > latitude !== y2 > latitude &&
      longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1
    )
      inside = !inside;
  }
  return inside;
}

export function plumeCovers(data: FeatureCollection, longitude: number, latitude: number) {
  for (const feature of data.features) {
    if (feature.geometry?.type !== "Polygon") throw new Error("Smoke geometry unavailable");
    const rings = feature.geometry.coordinates;
    if (!ringContains(rings[0], longitude, latitude)) continue;
    let inHole = false;
    for (const hole of rings.slice(1)) {
      if (ringContains(hole, longitude, latitude)) inHole = true;
    }
    if (!inHole) return true;
  }
  return false;
}

function polygonContains(polygon: number[][][], point: number[]) {
  if (!ringContains(polygon[0], point[0], point[1])) return false;
  for (const hole of polygon.slice(1)) if (ringContains(hole, point[0], point[1])) return false;
  return true;
}

function edgesCross(a: number[], b: number[], c: number[], d: number[]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const ex = d[0] - c[0],
    ey = d[1] - c[1];
  const cross = dx * ey - dy * ex;
  if (Math.abs(cross) < 1e-12) return false;
  const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / cross;
  const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / cross;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function polygonsOverlap(first: number[][][], second: number[][][]) {
  const bounds = (ring: number[][]) => {
    let west = Infinity,
      south = Infinity,
      east = -Infinity,
      north = -Infinity;
    for (const [x, y] of ring) {
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    }
    return { west, south, east, north };
  };
  const a = bounds(first[0]),
    b = bounds(second[0]);
  if (a.east < b.west || b.east < a.west || a.north < b.south || b.north < a.south) return false;
  for (const point of first[0]) if (polygonContains(second, point)) return true;
  for (const point of second[0]) if (polygonContains(first, point)) return true;
  for (const ring of first)
    for (const other of second) {
      for (let i = 1; i < ring.length; i++)
        for (let j = 1; j < other.length; j++) {
          if (edgesCross(ring[i - 1], ring[i], other[j - 1], other[j])) return true;
        }
    }
  return false;
}

export function smokeOverRegion(smoke: FeatureCollection, outline: FeatureCollection) {
  const regions: number[][][][] = [];
  for (const feature of outline.features) {
    if (feature.geometry?.type === "Polygon") regions.push(feature.geometry.coordinates);
    if (feature.geometry?.type === "MultiPolygon") regions.push(...feature.geometry.coordinates);
  }
  if (!regions.length) return null;
  const features = [];
  for (const feature of smoke.features) {
    if (feature.geometry?.type !== "Polygon") return null;
    for (const region of regions) {
      if (polygonsOverlap(feature.geometry.coordinates, region)) {
        features.push(feature);
        break;
      }
    }
  }
  return { type: "FeatureCollection" as const, features };
}

export function parseNoaaKml(text: string): FeatureCollection<Polygon> {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "kml")
    throw new Error("NOAA file unavailable");
  const features: FeatureCollection<Polygon>["features"] = [];
  for (const placemark of document.getElementsByTagNameNS("*", "Placemark")) {
    const description = placemark.getElementsByTagNameNS("*", "description")[0]?.textContent || "";
    const density = /Density:\s*([A-Za-z]+)/.exec(description)?.[1].toLowerCase();
    if (!["light", "medium", "heavy"].includes(density || ""))
      throw new Error("NOAA density unavailable");
    const times: Record<string, string | null> = {};
    for (const [label, key] of [
      ["Start", "analysisStart"],
      ["End", "analysisEnd"],
    ]) {
      const match = new RegExp(label + " Time:\\s*(\\d{4})(\\d{3})\\s+(\\d{2})(\\d{2})UTC").exec(
        description,
      );
      times[key] = match
        ? new Date(
            Date.UTC(Number(match[1]), 0, Number(match[2]), Number(match[3]), Number(match[4])),
          ).toISOString()
        : null;
    }
    const polygons = placemark.getElementsByTagNameNS("*", "Polygon");
    if (!polygons.length) throw new Error("NOAA geometry unavailable");
    for (const polygon of polygons) {
      const coordinates: number[][][] = [];
      const boundaries = [
        ...polygon.getElementsByTagNameNS("*", "outerBoundaryIs"),
        ...polygon.getElementsByTagNameNS("*", "innerBoundaryIs"),
      ];
      if (!boundaries.length) throw new Error("NOAA geometry unavailable");
      for (const boundary of boundaries) {
        const content = boundary.getElementsByTagNameNS("*", "coordinates")[0]?.textContent || "";
        const ring: number[][] = [];
        for (const item of content.trim().split(/\s+/)) {
          const values = item.split(",");
          const longitude = Number(values[0]);
          const latitude = Number(values[1]);
          if (
            values.length < 2 ||
            !values[0].trim() ||
            !values[1].trim() ||
            !Number.isFinite(longitude) ||
            !Number.isFinite(latitude) ||
            Math.abs(longitude) > 180 ||
            Math.abs(latitude) > 90
          )
            throw new Error("NOAA coordinates unavailable");
          ring.push([longitude, latitude]);
        }
        if (
          ring.length < 4 ||
          ring[0][0] !== ring[ring.length - 1][0] ||
          ring[0][1] !== ring[ring.length - 1][1]
        )
          throw new Error("NOAA polygon unavailable");
        coordinates.push(ring);
      }
      features.push({
        type: "Feature",
        properties: { density, ...times },
        geometry: { type: "Polygon", coordinates },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export function plumeAnalysisPeriod(data: FeatureCollection) {
  let start: string | null = null;
  let end: string | null = null;
  for (const feature of data.features) {
    const first = feature.properties?.analysisStart;
    const last = feature.properties?.analysisEnd;
    if (typeof first !== "string" || typeof last !== "string") return null;
    if (!start || first < start) start = first;
    if (!end || last > end) end = last;
  }
  return start && end ? { start, end } : null;
}

export function perimeterQuery(offset = 0) {
  const query = new URLSearchParams({
    where: "attr_IncidentTypeCategory='WF' AND attr_POOState='US-CA'",
    outSR: "4326",
    outFields: [
      "OBJECTID,poly_IncidentName,poly_DateCurrent,poly_GISAcres,poly_IRWINID,attr_UniqueFireIdentifier",
      "attr_ActiveFireCandidate,attr_POOState,attr_IncidentSize,attr_PercentContained,attr_FireDiscoveryDateTime",
      "attr_POOCounty,attr_POOProtectingAgency,attr_POOProtectingUnit,attr_FireCause,attr_FireCauseGeneral,attr_FireCauseSpecific,attr_IsFireCauseInvestigated,attr_FireBehaviorGeneral,attr_FireBehaviorGeneral1,attr_FireBehaviorGeneral2,attr_FireBehaviorGeneral3,attr_IncidentShortDescription",
      "attr_TotalIncidentPersonnel,attr_ResidencesThreatened,attr_ResidencesDestroyed,attr_OtherStructuresThreatened,attr_OtherStructuresDestroyed",
      "attr_CpxName,attr_ContainmentDateTime,attr_ControlDateTime,attr_FireOutDateTime,attr_ModifiedOnDateTime_dt,attr_IncidentManagementOrg",
    ].join(","),
    orderByFields: "OBJECTID ASC",
    resultOffset: String(offset),
    resultRecordCount: "1000",
    returnGeometry: "true",
    f: "geojson",
  });
  return perimeterUrl + "/query?" + query;
}

type AgencyPage = FeatureCollection & {
  error?: unknown;
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
  pagination?: { next?: string };
};

export async function loadCaliforniaPerimeters(get: (url: string) => Promise<AgencyPage>) {
  const features: FeatureCollection["features"] = [];
  const ids = new Set();
  let offset = 0;
  while (true) {
    const page = await get(perimeterQuery(offset));

    const more = page.exceededTransferLimit || page.properties?.exceededTransferLimit;
    if (page.error || page.type !== "FeatureCollection" || !Array.isArray(page.features))
      throw new Error("Perimeters unavailable");
    for (const feature of page.features) {
      if (
        !["Polygon", "MultiPolygon"].includes(feature.geometry?.type) ||
        feature.properties?.attr_ActiveFireCandidate !== 1
      )
        throw new Error("Current perimeter identity unavailable");
      const id = feature.properties.OBJECTID;
      if (more && !Number.isFinite(id)) throw new Error("Fire page lacks identifiers");
      if (id !== undefined) {
        if (ids.has(id)) throw new Error("Repeated fire page");
        ids.add(id);
      }
      features.push(feature);
    }
    if (!more) break;
    if (!page.features.length) throw new Error("Incomplete fire page");
    offset += page.features.length;
  }
  return { type: "FeatureCollection", features } as FeatureCollection;
}

export function incidentQuery(offset = 0) {
  const query = new URLSearchParams({
    where: "IncidentTypeCategory='WF' AND POOState='US-CA'",
    outSR: "4326",
    outFields: [
      "OBJECTID,IrwinID,UniqueFireIdentifier,IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt",
      "ActiveFireCandidate,POOCounty,POOProtectingAgency,POOProtectingUnit,FireCause,FireCauseGeneral,FireCauseSpecific,IsFireCauseInvestigated",
      "FireBehaviorGeneral,FireBehaviorGeneral1,FireBehaviorGeneral2,FireBehaviorGeneral3,IncidentShortDescription,TotalIncidentPersonnel",
      "ResidencesThreatened,ResidencesDestroyed,OtherStructuresThreatened,OtherStructuresDestroyed,CpxName,ContainmentDateTime,ControlDateTime,FireOutDateTime,IncidentManagementOrganization",
    ].join(","),
    orderByFields: "OBJECTID ASC",
    resultOffset: String(offset),
    resultRecordCount: "1000",
    returnGeometry: "true",
    f: "geojson",
  });
  return incidentUrl + "/query?" + query;
}

export async function loadCaliforniaIncidents(get: (url: string) => Promise<AgencyPage>) {
  const features: FeatureCollection["features"] = [];
  let offset = 0;
  while (true) {
    const page = await get(incidentQuery(offset));
    if (page.error || page.type !== "FeatureCollection" || !Array.isArray(page.features))
      throw new Error("Incident locations unavailable");
    for (const feature of page.features) {
      if (
        feature.geometry?.type !== "Point" ||
        feature.properties?.ActiveFireCandidate !== 1 ||
        !Number.isFinite(feature.properties?.OBJECTID)
      )
        continue;
      features.push(feature);
    }
    const more = page.exceededTransferLimit || page.properties?.exceededTransferLimit;
    if (!more) break;
    if (!page.features.length) throw new Error("Incomplete incident page");
    offset += page.features.length;
  }
  return { type: "FeatureCollection", features } as FeatureCollection;
}

export function pointOnlyFires(
  perimeters: FeatureCollection,
  incidents: FeatureCollection,
): FeatureCollection {
  const mapped = new Set<string>();
  for (const fire of perimeters.features) {
    for (const id of [fire.properties?.poly_IRWINID, fire.properties?.attr_UniqueFireIdentifier]) {
      if (typeof id === "string" && id) mapped.add(id.toLowerCase());
    }
  }
  const features = incidents.features
    .filter((fire) => {
      const ids = [fire.properties?.IrwinID, fire.properties?.UniqueFireIdentifier];
      return !ids.some((id) => typeof id === "string" && mapped.has(id.toLowerCase()));
    })
    .map((fire) => {
      const data = fire.properties || {};
      const properties: Record<string, unknown> = {
        OBJECTID: -data.OBJECTID,
        pointOnly: true,
        poly_IncidentName: data.IncidentName,
      };
      for (const field of [
        "IncidentSize",
        "PercentContained",
        "FireDiscoveryDateTime",
        "ModifiedOnDateTime_dt",
        "POOCounty",
        "POOProtectingAgency",
        "POOProtectingUnit",
        "FireCause",
        "FireCauseGeneral",
        "FireCauseSpecific",
        "IsFireCauseInvestigated",
        "FireBehaviorGeneral",
        "FireBehaviorGeneral1",
        "FireBehaviorGeneral2",
        "FireBehaviorGeneral3",
        "IncidentShortDescription",
        "TotalIncidentPersonnel",
        "ResidencesThreatened",
        "ResidencesDestroyed",
        "OtherStructuresThreatened",
        "OtherStructuresDestroyed",
        "CpxName",
        "ContainmentDateTime",
        "ControlDateTime",
        "FireOutDateTime",
      ])
        properties["attr_" + field] = data[field];
      properties.attr_IncidentManagementOrg = data.IncidentManagementOrganization;
      return { ...fire, properties };
    });
  return { type: "FeatureCollection", features };
}

export async function loadCaliforniaAlerts(get: (url: string) => Promise<AgencyPage>) {
  const features: FeatureCollection["features"] = [];
  const visited = new Set<string>();
  const ids = new Set<string>();
  let next: string | null = alertUrl;
  while (next) {
    const url = new URL(next);
    if (
      url.origin !== "https://api.weather.gov" ||
      !["/alerts", "/alerts/active"].includes(url.pathname) ||
      (url.pathname === "/alerts" && url.searchParams.get("active") !== "true") ||
      url.searchParams.get("area") !== "CA" ||
      visited.has(next)
    )
      throw new Error("Invalid alert page");
    visited.add(next);
    const page = await get(next);
    if (page.type !== "FeatureCollection" || !Array.isArray(page.features))
      throw new Error("Alerts unavailable");
    for (const feature of page.features) {
      const id = feature.id || feature.properties?.id;
      if (
        typeof id !== "string" ||
        ids.has(id) ||
        typeof feature.properties?.event !== "string" ||
        !Number.isFinite(Date.parse(feature.properties?.expires))
      )
        throw new Error("Alert identity unavailable");
      ids.add(id);
      features.push(feature);
    }
    next = page.pagination?.next || null;
  }
  return { type: "FeatureCollection", features } as FeatureCollection;
}

export function californiaAirReports(text: string, now = new Date()) {
  const areas = new Map<string, string[][]>();
  for (const line of text.split(/\r?\n/)) {
    const row = line.split("|");
    if (row[5] !== "O" || row[6] !== "Y" || row[8] !== "CA") continue;
    const records = areas.get(row[7]) || [];
    records.push(row);
    areas.set(row[7], records);
  }
  const features: FeatureCollection["features"] = [];
  for (const [name, records] of areas) {
    try {
      const report = airNowObservation(text, name, now);
      if (records.length !== 1) continue;
      const latitude = Number(records[0][9]);
      const longitude = Number(records[0][10]);
      if (
        !records[0][9] ||
        !records[0][10] ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      )
        continue;
      features.push({
        type: "Feature",
        id: name,
        properties: report,
        geometry: { type: "Point", coordinates: [longitude, latitude] },
      });
    } catch {}
  }
  return { type: "FeatureCollection", features } as FeatureCollection;
}

export function currentAirMonitorQuery() {
  const query = new URLSearchParams({
    where: "StateName='CA'",
    outFields:
      "AQSID,DataSource,Latitude,Longitude,OZONEPM_AQI,PM_AQI,PM25,PM25_Measured,PM25_Unit,SiteName,StateName,ValidTime,Status,MonitorType",
    outSR: "4326",
    returnGeometry: "true",
    f: "geojson",
  });
  return `${monitorUrl}/query?${query}`;
}

export function californiaAirMonitors(value: unknown, now = new Date()) {
  const data = value as { type?: string; features?: FeatureCollection["features"] };
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw new Error("California monitor data unavailable");
  const features: FeatureCollection["features"] = [];
  function numberField(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }
  for (const feature of data.features) {
    const source = feature.properties || {};
    const geometry = feature.geometry;
    const overall = numberField(source.OZONEPM_AQI);
    const particle = numberField(source.PM_AQI);
    const useParticle =
      particle !== null && particle >= 0 && (overall === null || particle > overall);
    const value = useParticle ? particle : overall;
    const timestamp = source.ValidTime;
    const measuredAt = new Date(timestamp as string | number).valueOf();
    const age = now.getTime() - measuredAt;
    if (
      geometry?.type !== "Point" ||
      !Array.isArray(geometry.coordinates) ||
      !Number.isFinite(geometry.coordinates[0]) ||
      !Number.isFinite(geometry.coordinates[1]) ||
      geometry.coordinates[0] < -125 ||
      geometry.coordinates[0] > -113 ||
      geometry.coordinates[1] < 32 ||
      geometry.coordinates[1] > 43 ||
      source.StateName !== "CA" ||
      !source.AQSID ||
      !source.SiteName ||
      value === null ||
      value < 0 ||
      value > 500 ||
      !Number.isFinite(measuredAt) ||
      age < -3600000 ||
      age > 6 * 3600000
    )
      continue;
    const band = aqiBands.find((candidate) => value <= candidate.high) || aqiBands.at(-1)!;
    const pm25 = numberField(source.PM25);
    features.push({
      ...feature,
      id: String(source.AQSID),
      properties: {
        area: String(source.SiteName),
        siteName: String(source.SiteName),
        siteId: String(source.AQSID),
        value,
        category: band.label,
        color: band.color,
        pollutant: useParticle ? "PM2.5 / PM10" : "Ozone / PM2.5",
        timestamp: new Date(measuredAt).toISOString(),
        agency: String(source.DataSource || "AirNow monitoring site"),
        pm25: pm25 !== null && pm25 >= 0 ? pm25 : null,
        pm25Unit: typeof source.PM25_Unit === "string" ? source.PM25_Unit : null,
        delayed: age > 2 * 3600000,
      },
    });
  }
  return { type: "FeatureCollection", features } as FeatureCollection;
}

export function highlightLiveFeatures(
  data: FeatureCollection,
  place: WavePlace | null,
  fires = false,
): FeatureCollection {
  const features = [];
  for (const feature of data.features) {
    if (!feature.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) continue;
    let highlighted = false;
    if (place) {
      const distance = perimeterDistanceKm(feature.geometry, [place.longitude, place.latitude]);
      highlighted = distance !== null && distance <= (fires ? nearbyFireKm : 0);
    }
    features.push({
      ...feature,
      properties: { ...feature.properties, highlighted },
    });
  }
  return { type: "FeatureCollection", features };
}
