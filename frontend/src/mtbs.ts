import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { CaseData } from "./types";

export function polygonContainsLocation(
  geometry: Polygon | MultiPolygon,
  longitude: number,
  latitude: number,
): boolean {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  function ringPosition(ring: number[][]): -1 | 0 | 1 {
    let inside = false;
    for (let index = 0; index < ring.length - 1; index++) {
      const [x, y] = ring[index];
      const [nextX, nextY] = ring[index + 1];
      const cross = (longitude - x) * (nextY - y) - (latitude - y) * (nextX - x);

      if (
        cross === 0 &&
        longitude >= Math.min(x, nextX) &&
        longitude <= Math.max(x, nextX) &&
        latitude >= Math.min(y, nextY) &&
        latitude <= Math.max(y, nextY)
      )
        return -1;
      if (
        y > latitude !== nextY > latitude &&
        longitude < ((nextX - x) * (latitude - y)) / (nextY - y) + x
      )
        inside = !inside;
    }
    return inside ? 1 : 0;
  }
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    if (ringPosition(polygon[0]) !== 1) continue;
    let excluded = false;
    for (const hole of polygon.slice(1)) {
      if (ringPosition(hole) !== 0) excluded = true;
    }
    if (!excluded) return true;
  }
  return false;
}

export const mtbsSource = "https://burnseverity.cr.usgs.gov/viewer/";
export const mtbsService = "/mtbs-service/";
const polygonLayer = "mtbs:fire_polygons";

export type FireAssessment = {
  event_id: string;
  map_id: number;
  incid_name: string;
  incid_type: string;
  ig_date: string;
  asmnt_type: string;
  pre_id: string | null;
  post_id: string | null;
  burnbndac: number | null;
  burnbndlat: string | number | null;
  burnbndlon: string | number | null;
  updated_at?: string | null;
};
export type FireBoundary = Feature<Polygon | MultiPolygon, FireAssessment>;

export function mappedFireArea(acres: number | null): number {
  if (typeof acres !== "number" || !Number.isFinite(acres) || acres < 0) return NaN;
  return acres * 0.0040468564224;
}

export const mtbsClasses = [
  { label: "Unburned to low", color: "#008080" },
  { label: "Low", color: "#52cccc" },
  { label: "Moderate", color: "#ffe820" },
  { label: "High", color: "#a80000" },
  { label: "Increased greenness", color: "#39b54a" },
  { label: "Processing mask", color: "#ffffff" },
];

export type MapBurnArea = {
  areasKm2: number[];
  unknownAreaKm2: number;
  unknownPercent: number;
  pixelCount: number;
};

export function measureMapBurnArea(
  image: ImageData,
  mask: ImageData,
  south: number,
  north: number,
  widthMetres: number,
): MapBurnArea | null {
  const areasKm2 = Array(7).fill(0) as number[];
  let unknownArea = 0;
  let pixelCount = 0;
  const radius = 6378137;
  const pixelWidth = widthMetres / image.width;
  const pixelHeight = (north - south) / image.height;
  for (let row = 0; row < image.height; row++) {
    const top = north - row * pixelHeight;
    const bottom = top - pixelHeight;
    const pixelArea =
      (radius * pixelWidth * (Math.tanh(top / radius) - Math.tanh(bottom / radius))) / 1e6;
    for (let column = 0; column < image.width; column++) {
      const index = (row * image.width + column) * 4;
      if (mask.data[index + 3] < 255) continue;
      pixelCount++;
      const alpha = image.data[index + 3];
      if (alpha === 0) {
        areasKm2[0] += pixelArea;
        continue;
      }
      let code = 0;
      for (let classIndex = 0; classIndex < mtbsClasses.length; classIndex++) {
        const color = mtbsClasses[classIndex].color;
        if (
          image.data[index] === parseInt(color.slice(1, 3), 16) &&
          image.data[index + 1] === parseInt(color.slice(3, 5), 16) &&
          image.data[index + 2] === parseInt(color.slice(5, 7), 16)
        ) {
          code = classIndex + 1;
          break;
        }
      }
      if (code && alpha === 255) areasKm2[code] += pixelArea;
      else unknownArea += pixelArea;
    }
  }
  const total = areasKm2.reduce((sum, area) => sum + area, unknownArea);
  if (!pixelCount || !total) return null;
  return {
    areasKm2,
    unknownAreaKm2: unknownArea,
    unknownPercent: (unknownArea / total) * 100,
    pixelCount,
  };
}

export function softenLowSeverity(pixels: Uint8ClampedArray) {
  for (let index = 0; index < pixels.length; index += 4) {
    const unburned = pixels[index] === 0 && pixels[index + 1] === 128 && pixels[index + 2] === 128;
    const low = pixels[index] === 82 && pixels[index + 1] === 204 && pixels[index + 2] === 204;
    if (unburned || low) pixels[index + 3] = Math.round(pixels[index + 3] * 0.4);
  }
}

export function imageDates(id: string | null): string[] {
  const dates = new Set<string>();
  for (const match of (id || "").matchAll(/(?:19|20)\d{6}/g)) {
    const digits = match[0];
    const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date)
      dates.add(date);
  }
  return [...dates].sort();
}

export function projectMetres(point: number[]): [number, number] {
  const longitude = (point[0] * Math.PI) / 180;
  const latitude = (point[1] * Math.PI) / 180;
  return [6378137 * longitude, 6378137 * Math.log(Math.tan(Math.PI / 4 + latitude / 2))];
}

export function californiaFilter(outline: FeatureCollection) {
  const polygons: number[][][][] = [];
  for (const feature of outline.features) {
    if (feature.geometry.type === "Polygon") polygons.push(feature.geometry.coordinates);
    if (feature.geometry.type === "MultiPolygon") polygons.push(...feature.geometry.coordinates);
  }
  if (!polygons.length)
    throw new Error(
      "California boundary unavailable; the fire catalog cannot be spatially filtered.",
    );
  const parts: string[] = [];
  for (const polygon of polygons) {
    const rings: string[] = [];
    for (const ring of polygon)
      rings.push(`(${ring.map((point) => projectMetres(point).join(" ")).join(",")})`);
    parts.push(`(${rings.join(",")})`);
  }

  return `INTERSECTS(geom,MULTIPOLYGON(${parts.join(",")}))`;
}

async function officialFetch(url: string, signal: AbortSignal, body?: URLSearchParams) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    ...(body ? { method: "POST", body } : {}),
  });
  if (!response.ok) throw new Error(`MTBS service returned HTTP ${response.status}.`);
  return response;
}

export async function loadFireCatalog(
  year: number | null,
  outline: FeatureCollection,
  signal: AbortSignal,
  name = "",
) {
  if (year !== null && (!Number.isInteger(year) || year < 1984 || year > new Date().getFullYear()))
    throw new Error("Choose a year from 1984 through the present.");
  const search = name.trim();
  if (search && !/^[\p{L}\p{N} .'()/-]{1,100}$/u.test(search))
    throw new Error("Use a plain fire name, up to 100 characters.");
  if (year === null && !search) throw new Error("Enter a fire name to search across years.");
  let filter = `map_prog='MTBS' AND incid_type='Wildfire' AND ${californiaFilter(outline)}`;
  if (year !== null) filter += ` AND ig_date >= '${year}-01-01' AND ig_date < '${year + 1}-01-01'`;
  if (search)
    filter += ` AND strToUpperCase(incid_name) LIKE '%${search.toUpperCase().replaceAll("'", "''")}%'`;
  const records = new Map<number, FireAssessment>();
  let offset = 0;
  while (true) {
    const body = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: polygonLayer,
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: "200",
      startIndex: String(offset),
      sortBy: "map_id A",
      CQL_FILTER: filter,
      propertyName:
        "event_id,map_id,incid_name,incid_type,ig_date,asmt_type,post_id,burnbndac,burnbndlat,burnbndlon,updated_at",
    });
    const response = await officialFetch(`${mtbsService}wfs`, signal, body);
    const page = await response.json();
    if (!Array.isArray(page.features)) throw new Error("MTBS catalog response was not GeoJSON.");
    const before = records.size;
    for (const feature of page.features) {
      const record = readFireAssessment(feature.properties);
      if (year !== null && record.ig_date.slice(0, 4) !== String(year))
        throw new Error("MTBS returned an unexpected assessment record.");
      if (records.has(record.map_id))
        throw new Error(
          "MTBS returned duplicate assessment IDs; catalog completeness is unresolved.",
        );
      records.set(record.map_id, record);
    }
    offset += page.features.length;
    if (page.features.length === 0) {
      if (Number(page.numberMatched) > offset)
        throw new Error("MTBS pagination ended before all matching assessments were returned.");
      break;
    }
    if (records.size === before) throw new Error("MTBS pagination did not advance.");
    if (Number.isFinite(Number(page.numberMatched)) && offset >= Number(page.numberMatched)) break;
  }
  return [...records.values()].sort(
    (a, b) => a.incid_name.localeCompare(b.incid_name) || a.map_id - b.map_id,
  );
}

function readFireAssessment(properties: Record<string, unknown>): FireAssessment {
  if (
    !properties ||
    !Number.isInteger(properties.map_id) ||
    typeof properties.event_id !== "string" ||
    !/^[A-Z0-9]+$/.test(properties.event_id) ||
    properties.incid_type !== "Wildfire" ||
    typeof properties.incid_name !== "string" ||
    typeof properties.ig_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}Z?$/.test(properties.ig_date)
  )
    throw new Error("MTBS returned an unexpected assessment record.");
  return {
    event_id: properties.event_id,
    map_id: properties.map_id as number,
    incid_name: properties.incid_name,
    incid_type: properties.incid_type,
    ig_date: properties.ig_date,
    asmnt_type: typeof properties.asmt_type === "string" ? properties.asmt_type : "",

    pre_id: null,
    post_id: typeof properties.post_id === "string" ? properties.post_id : null,
    burnbndac:
      typeof properties.burnbndac === "number" && Number.isFinite(properties.burnbndac)
        ? properties.burnbndac
        : null,
    burnbndlat:
      typeof properties.burnbndlat === "number" || typeof properties.burnbndlat === "string"
        ? properties.burnbndlat
        : null,
    burnbndlon:
      typeof properties.burnbndlon === "number" || typeof properties.burnbndlon === "string"
        ? properties.burnbndlon
        : null,
    updated_at: typeof properties.updated_at === "string" ? properties.updated_at : null,
  };
}

export async function loadFireBoundary(
  fire: FireAssessment,
  signal: AbortSignal,
): Promise<FireBoundary> {
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: polygonLayer,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    CQL_FILTER: `map_id=${fire.map_id} AND event_id='${fire.event_id}' AND map_prog='MTBS'`,
  });
  const response = await officialFetch(`${mtbsService}wfs?${query}`, signal);
  const result = await response.json();
  const feature = result.features?.[0] as FireBoundary | undefined;
  if (
    result.features?.length !== 1 ||
    feature?.properties.map_id !== fire.map_id ||
    feature.properties.event_id !== fire.event_id ||
    !["Polygon", "MultiPolygon"].includes(feature.geometry?.type)
  )
    throw new Error("The exact MTBS assessment boundary is unavailable or ambiguous.");
  return { ...feature, properties: readFireAssessment(feature.properties) };
}

export function boundaryBounds(feature: Feature<Polygon | MultiPolygon>): CaseData["bounds"] {
  const bounds: CaseData["bounds"] = [Infinity, Infinity, -Infinity, -Infinity];
  const polygons =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  for (const polygon of polygons)
    for (const ring of polygon)
      for (const point of ring) {
        if (!point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) >= 85)
          throw new Error("MTBS boundary coordinates are not geographic longitude/latitude.");
        bounds[0] = Math.min(bounds[0], point[0]);
        bounds[1] = Math.min(bounds[1], point[1]);
        bounds[2] = Math.max(bounds[2], point[0]);
        bounds[3] = Math.max(bounds[3], point[1]);
      }
  if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3])
    throw new Error("MTBS boundary has no usable extent.");
  return bounds;
}

export function severityRequest(year: number, bounds: CaseData["bounds"]) {
  const [west, south] = projectMetres([bounds[0], bounds[1]]);
  const [east, north] = projectMetres([bounds[2], bounds[3]]);
  const ratio = (east - west) / (north - south);
  const width = Math.max(1, Math.round(1536 * Math.min(1, ratio)));
  const height = Math.max(1, Math.round(1536 * Math.min(1, 1 / ratio)));
  const query = new URLSearchParams({
    service: "WMS",
    version: "1.1.1",
    request: "GetMap",
    layers: `mtbs:mtbs_CONUS_${year}`,
    styles: "",
    format: "image/png",
    transparent: "true",
    srs: "EPSG:3857",
    bbox: [west, south, east, north].join(","),
    width: String(width),
    height: String(height),
  });
  return {
    url: `${mtbsService}wms?${query}`,
    width,
    height,
    west,
    south,
    east,
    north,
  };
}

export async function loadSeverity(
  feature: FireBoundary,
  signal: AbortSignal,
  measure = false,
  sourceImage?: Blob,
) {
  const bounds = boundaryBounds(feature);
  const request = severityRequest(Number(feature.properties.ig_date.slice(0, 4)), bounds);
  const image = sourceImage || (await officialFetch(request.url, signal)).blob();
  const blob = await image;
  if (!blob.type.includes("image/png"))
    throw new Error("The annual MTBS severity mosaic is unavailable for this year.");
  const bitmap = await createImageBitmap(blob);
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const canvas = document.createElement("canvas");
    canvas.width = request.width;
    canvas.height = request.height;
    const context = canvas.getContext("2d")!;
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    const path = new Path2D();
    for (const polygon of polygons)
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const [x, y] = projectMetres(ring[i]);
          const px = ((x - request.west) / (request.east - request.west)) * canvas.width;
          const py = ((request.north - y) / (request.north - request.south)) * canvas.height;
          if (i === 0) path.moveTo(px, py);
          else path.lineTo(px, py);
        }
        path.closePath();
      }

    context.clip(path, "evenodd");
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const display = context.getImageData(0, 0, canvas.width, canvas.height);
    let mapArea: MapBurnArea | null = null;
    if (measure) {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = canvas.width;
      maskCanvas.height = canvas.height;
      const maskContext = maskCanvas.getContext("2d")!;
      maskContext.fillStyle = "#ffffff";
      maskContext.fill(path, "evenodd");
      const mask = maskContext.getImageData(0, 0, canvas.width, canvas.height);
      mapArea = measureMapBurnArea(
        display,
        mask,
        request.south,
        request.north,
        request.east - request.west,
      );
    }
    softenLowSeverity(display.data);
    context.putImageData(display, 0, 0);
    const pixels = display.data;
    let visible = false;
    for (let i = 3; i < pixels.length; i += 4)
      if (pixels[i] > 0) {
        visible = true;
        break;
      }
    if (!visible)
      throw new Error("The annual mosaic has no displayed coverage inside this fire boundary.");
    return { canvas, bounds, url: request.url, mapArea };
  } finally {
    bitmap.close();
  }
}
