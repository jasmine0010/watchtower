import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { WavePlace } from "../frontend/src/waves";
import { perimeterDistanceKm } from "../frontend/src/wavesLive";
import { readReportingAreas } from "../frontend/src/reportingAreas";

const root = new URL("../", import.meta.url);
const cache = new URL("data/raw/airnow-reporting-areas/", root);
const service =
  "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/AirNow_National_Air_Quality_Index_%28AQI%29_Forecast/FeatureServer";
const metadataUrl = "https://files.airnowtech.org/airnow/today/reportingarea_metadata.dat";
const refresh = process.argv.includes("--refresh");

async function download(name: string, url: string) {
  const path = new URL(name, cache);
  const receiptPath = new URL(name + ".source.json", cache);
  if (!refresh) {
    try {
      const body = await readFile(path);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      const hash = createHash("sha256").update(body).digest("hex");
      if (receipt.sourceUrl === url && receipt.sha256 === hash)
        return { text: body.toString("utf8"), ...receipt };
    } catch {}
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Source unavailable: ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  const receipt = {
    sourceUrl: url,
    retrievedAt: new Date().toISOString(),
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  await mkdir(cache, { recursive: true });
  await writeFile(path, body);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  return { text: body.toString("utf8"), ...receipt };
}

async function main() {
  const catalog = JSON.parse(
    await readFile(new URL("frontend/public/data/waves-cases.json", root), "utf8"),
  );
  const places: WavePlace[] = catalog.rightNowPlaces;
  const metadata = await download("reportingarea_metadata.dat", metadataUrl);
  const rows = metadata.text
    .trim()
    .split(/\r?\n/)
    .map((line: string) => line.split("|"));
  const regions: string[][] = rows.filter((row: string[]) => row[1] === "CA");
  const codesSeen = new Set<string>();
  const namesSeen = new Set<string>();
  for (const region of regions) {
    if (!region[9] || codesSeen.has(region[9]) || namesSeen.has(region[0]))
      throw new Error("Ambiguous California reporting-area identity.");
    codesSeen.add(region[9]);
    namesSeen.add(region[0]);
  }
  const serviceReceipt = await download("service.json", service + "?f=json");
  const serviceInfo = JSON.parse(serviceReceipt.text);
  const itemUrl = `https://www.arcgis.com/sharing/rest/content/items/${serviceInfo.serviceItemId}?f=json`;
  const itemReceipt = await download("publisher.json", itemUrl);
  const item = JSON.parse(itemReceipt.text);
  const terms = String(item.licenseInfo)
    .replace(/<[^>]*>/g, "")
    .replaceAll("&nbsp;", " ");
  if (
    item.owner !== "OAR_OSAP_EPA" ||
    item.access !== "public" ||
    !/Use constraints:\s*None\./.test(terms)
  )
    throw new Error("Recheck EPA publisher and reuse terms.");
  const layerReceipt = await download("layer.json", service + "/0?f=json");
  const layer = JSON.parse(layerReceipt.text);
  if (layer.geometryType !== "esriGeometryPolygon" || layer.spatialReference?.wkid !== 4326)
    throw new Error("Unexpected reporting-area geometry or CRS.");
  const params = new URLSearchParams({
    f: "geojson",
    where: "RACode LIKE 'ca%'",
    outFields: "OBJECTID,RACode,RAName,RAAgency,Latitude,Longitude",
    returnGeometry: "true",
    outSR: "4326",
  });
  const source = await download("california-boundaries.geojson", service + "/0/query?" + params);
  const payload = JSON.parse(source.text);
  if (
    payload.error ||
    payload.exceededTransferLimit ||
    payload.properties?.exceededTransferLimit ||
    !Array.isArray(payload.features)
  )
    throw new Error("Incomplete EPA geometry response.");
  const features = [];
  const checks = [];
  const missing = [];
  for (const region of regions) {
    const matches = payload.features.filter(
      (feature: { properties: { RACode: string } }) => feature.properties.RACode === region[9],
    );
    if (matches.length === 0) {
      missing.push({
        code: region[9],
        name: region[0],
        reason: "No polygon in the checked official service",
      });
      if (places.some((place) => place.reportingArea === region[0]))
        throw new Error(`Configured place boundary missing: ${region[9]}`);
      continue;
    }
    if (matches.length !== 1) throw new Error(`Duplicate source code: ${region[9]}`);
    const feature = matches[0];
    const properties = feature.properties;
    if (
      properties.RAName !== region[0] ||
      properties.RAAgency !== region[10] ||
      properties.Latitude !== Number(region[3]) ||
      properties.Longitude !== Number(region[4])
    )
      throw new Error(`AirNow metadata disagreement: ${region[9]}`);
    const assignedPlaces = [];
    for (const place of places) {
      if (place.reportingArea !== region[0]) continue;
      const pointInside =
        perimeterDistanceKm(feature.geometry, [place.longitude, place.latitude]) === 0;
      const check = { name: place.name, zipcode: place.zipcode, pointInside };
      assignedPlaces.push(check);
      checks.push({ ...check, code: region[9], reportingArea: region[0] });
    }
    features.push({
      type: "Feature",
      id: region[9],
      geometry: feature.geometry,
      properties: {
        code: region[9],
        name: region[0],
        state: region[1],
        agency: region[10],
        sourceObjectId: properties.OBJECTID,
        sourceUrl: source.sourceUrl,
        retrievedAt: source.retrievedAt,
        boundaryUpdatedAt: null,
        serviceUpdatedAt: layer.editingInfo?.lastEditDate
          ? new Date(layer.editingInfo.lastEditDate).toISOString()
          : null,
        places: assignedPlaces,
      },
    });
  }
  const output = { type: "FeatureCollection", features } as FeatureCollection<
    Polygon | MultiPolygon
  >;
  readReportingAreas(output);
  const path = new URL("frontend/public/data/airnow-reporting-areas.geojson", root);
  await writeFile(path, JSON.stringify(output) + "\n");
  await writeFile(
    new URL("assignment-audit.json", cache),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        metadataUrl,
        itemUrl,
        terms: item.licenseInfo,
        checks,
        metadataRegions: regions.length,
        verifiedPolygons: features.length,
        missing,
        note: "ZIP assignments are unchanged. Point containment is separate evidence, not a replacement assignment.",
      },
      null,
      2,
    ) + "\n",
  );
  console.table(checks);
  console.log(`${features.length} verified polygons; ${missing.length} absent, not approximated.`);
  console.log(fileURLToPath(path), (await readFile(path)).length, "bytes");
}

await main();
