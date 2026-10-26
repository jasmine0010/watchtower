import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "../frontend/node_modules/playwright/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scopePath = path.join(root, "frontend/public/data/historical-fires/scope.json");
const nativePath = path.join(root, "frontend/public/data/fire-burn-summaries.json");
const outputPath = path.join(root, "frontend/public/data/fire-burn-map-summaries.json");
const cacheDir = path.join(root, "data/raw/waves");
const baseUrl = process.env.WILDFIRE_BASE_URL || "http://127.0.0.1:5173";
const limit = Number(
  process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] || Infinity,
);

function checksum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(", ")}]`;
  if (value && typeof value === "object") {
    const fields = Object.keys(value).sort();
    const entries = [];
    for (const key of fields) {
      const name = JSON.stringify(key);
      const content = sortedJson(value[key]);
      entries.push(`${name}: ${content}`);
    }
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

function geometryHash(geometry) {
  const values = [geometry.type === "Polygon" ? 1 : 2];
  function visit(value) {
    if (Array.isArray(value)) {
      values.push(value.length);
      for (const child of value) visit(child);
    } else values.push(value);
  }
  visit(geometry.coordinates);
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return checksum(bytes);
}

async function cachedBoundaries(decisions) {
  const wanted = new Set(decisions.map((decision) => decision.boundarySource.sourceUrl));
  const found = new Map();
  const names = await readdir(cacheDir);
  for (const name of names) {
    if (!name.endsWith(".source.json")) continue;
    const receipt = JSON.parse(await readFile(path.join(cacheDir, name), "utf8"));
    const url = receipt.sourceUrl || receipt.url;
    if (wanted.has(url)) found.set(url, name.slice(0, -".source.json".length));
    if (found.size === wanted.size) break;
  }
  return found;
}

async function nativeMatches(decision, record, boundaryFiles) {
  if (
    !record ||
    record.ignition !== decision.mtbs.ig_date.slice(0, 10) ||
    record.postId !== decision.mtbs.post_id ||
    record.updatedAt !== decision.mtbs.updated_at
  )
    return false;
  const file = boundaryFiles.get(decision.boundarySource.sourceUrl);
  if (!file) return false;
  const bytes = await readFile(path.join(cacheDir, file));
  if (checksum(bytes) !== decision.boundarySource.sha256) return false;
  const features = JSON.parse(bytes.toString("utf8")).features;
  if (
    features?.length !== 1 ||
    features[0].properties.map_id !== record.mapId ||
    features[0].properties.event_id !== record.eventId
  )
    return false;
  return geometryHash(features[0].geometry) === record.geometrySha256;
}

async function save() {
  const temporary = outputPath + ".partial";
  await writeFile(temporary, JSON.stringify(output, null, 2) + "\n");
  await rename(temporary, outputPath);
}

async function measure(page, decision) {
  const result = await page.evaluate(async (fire) => {
    const mtbs = await import("/src/mtbs.ts");
    const area = await import("/src/burnArea.tsx");
    const signal = new AbortController().signal;
    const boundary = await mtbs.loadFireBoundary(fire, signal);
    const request = mtbs.severityRequest(
      Number(fire.ig_date.slice(0, 4)),
      mtbs.boundaryBounds(boundary),
    );
    const response = await fetch(request.url, { signal });
    if (!response.ok || !response.headers.get("content-type")?.includes("image/png")) {
      throw new Error("The MTBS response is not a PNG image.");
    }
    const image = await response.blob();
    const severity = await mtbs.loadSeverity(boundary, signal, true, image);
    const encoded = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(image);
    });
    return {
      properties: boundary.properties,
      geometry: boundary.geometry,
      geometrySha256: await area.geometryHash(boundary.geometry),
      mapArea: severity.mapArea,
      request,
      encoded,
    };
  }, decision.mtbs);
  const bytes = Buffer.from(result.encoded, "base64");
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("The MTBS response is not a PNG image.");
  }
  const { encoded, ...measured } = result;
  return { ...measured, bytes };
}

function checkIdentity(decision, measured) {
  const expected = decision.mtbs;
  const actual = measured.properties;
  for (const field of ["map_id", "event_id", "ig_date", "post_id", "updated_at"]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`MTBS boundary identity changed: ${field}.`);
    }
  }
  if (checksum(sortedJson(measured.geometry)) !== decision.boundarySha256) {
    throw new Error("The verified MTBS boundary geometry changed.");
  }
}

function recordFor(decision, measured, source) {
  const area = measured.mapArea;
  const base = {
    fireId: decision.fireId,
    mapId: decision.mtbs.map_id,
    eventId: decision.mtbs.event_id,
    ignition: decision.mtbs.ig_date.slice(0, 10),
    postId: decision.mtbs.post_id,
    updatedAt: decision.mtbs.updated_at,
    geometrySha256: measured.geometrySha256,
    boundarySource: decision.boundarySource,
    source,
  };
  if (
    !area ||
    !Array.isArray(area.areasKm2) ||
    area.areasKm2.length !== 7 ||
    !area.areasKm2.every((value) => Number.isFinite(value) && value >= 0) ||
    area.unknownPercent > 1 ||
    !area.areasKm2.slice(1, 6).some(Boolean)
  ) {
    return {
      ...base,
      status: "unavailable",
      reason: "No verifiable categorical map coverage inside this boundary.",
    };
  }
  return { ...base, status: "available", area };
}

async function processFire(page, decision) {
  const id = decision.mtbs.map_id;
  const prior = output.records.find((record) => record.mapId === id);
  if (
    prior?.status === "available" &&
    prior.eventId === decision.mtbs.event_id &&
    prior.boundarySource?.sha256 === decision.boundarySource.sha256
  ) {
    try {
      const cached = await readFile(path.join(cacheDir, prior.source.cacheFile));
      if (checksum(cached) === prior.source.sha256) return prior;
    } catch {}
  }
  try {
    const measured = await measure(page, decision);
    checkIdentity(decision, measured);
    const file = `burn-map-${id}.png`;
    await writeFile(path.join(cacheDir, file), measured.bytes);
    const source = {
      url:
        "https://edcintl.cr.usgs.gov/geoserver" + measured.request.url.replace("/mtbs-service", ""),
      retrievedAt: new Date().toISOString(),
      sha256: checksum(measured.bytes),
      width: measured.request.width,
      height: measured.request.height,
      cacheFile: file,
    };
    await writeFile(
      path.join(cacheDir, file + ".source.json"),
      JSON.stringify(source, null, 2) + "\n",
    );
    return recordFor(decision, measured, source);
  } catch (error) {
    return {
      fireId: decision.fireId,
      mapId: id,
      eventId: decision.mtbs.event_id,
      status: "failed",
      reason: String(error.message || error),
    };
  }
}

async function validate(page, decisions, nativeRecords) {
  const results = [];
  if (!decisions.length) return results;
  const nativeById = new Map(nativeRecords.map((record) => [record.mapId, record]));
  const eligible = decisions.filter((entry) => nativeById.has(entry.mtbs.map_id));
  const years = [...new Set(eligible.map((entry) => entry.ignitionYear))].sort();
  const sampleYears = [years[0], years[Math.floor(years.length / 2)], years.at(-1)];
  for (const year of new Set(sampleYears)) {
    const candidates = eligible
      .filter((entry) => entry.ignitionYear === year)
      .sort((left, right) => left.mtbs.burnbndac - right.mtbs.burnbndac);
    const decision = candidates[Math.floor(candidates.length / 2)];
    const id = decision.mtbs.map_id;
    const native = nativeById.get(id);
    try {
      const measured = await measure(page, decision);
      checkIdentity(decision, measured);
      const map = measured.mapArea.areasKm2;
      const mapTotal = map.reduce((sum, value) => sum + value, measured.mapArea.unknownAreaKm2);
      const nativeTotal =
        (native.counts.reduce((sum, value) => sum + value, 0) * native.pixelAreaM2) / 1e6;
      const largestShareDifference = Math.max(
        ...map.map((value, code) =>
          Math.abs(
            (value / mapTotal) * 100 -
              ((native.counts[code] * native.pixelAreaM2) / 1e6 / nativeTotal) * 100,
          ),
        ),
      );
      results.push({
        mapId: id,
        name: decision.mtbs.incid_name,
        mapAreaKm2: mapTotal,
        nativeAreaKm2: nativeTotal,
        largestShareDifferencePoints: largestShareDifference,
      });
    } catch (error) {
      results.push({
        mapId: id,
        status: "failed",
        reason: String(error.message || error),
      });
    }
  }
  return results;
}

const scope = JSON.parse(await readFile(scopePath, "utf8"));
const native = JSON.parse(await readFile(nativePath, "utf8"));
const decisions = scope.decisions.filter((entry) => entry.eligible);
await mkdir(cacheDir, { recursive: true });
const boundaryFiles = await cachedBoundaries(decisions);
const nativeById = new Map(native.records.map((record) => [record.mapId, record]));
const nativeIds = new Set();
for (const decision of decisions) {
  const record = nativeById.get(decision.mtbs.map_id);
  if (await nativeMatches(decision, record, boundaryFiles)) {
    nativeIds.add(`${record.mapId}:${record.eventId}`);
  }
}
const missing = decisions.filter(
  (entry) => !nativeIds.has(`${entry.mtbs.map_id}:${entry.mtbs.event_id}`),
);
let output = {
  schemaVersion: 1,
  builtAt: new Date().toISOString(),
  scopeBuiltAt: scope.builtAt,
  eligibleFireCount: decisions.length,
  nativeSummaryCount: decisions.length - missing.length,
  method:
    "Categorical MTBS WMS pixels clipped to the exact verified boundary; Web Mercator pixels weighted by ground area.",
  validation: [],
  records: [],
};
try {
  const previous = JSON.parse(await readFile(outputPath, "utf8"));
  if (previous.scopeBuiltAt === scope.builtAt) output.records = previous.records;
} catch {}
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  output.validation = await validate(
    page,
    decisions.filter((entry) => nativeIds.has(`${entry.mtbs.map_id}:${entry.mtbs.event_id}`)),
    native.records,
  );
  await save();
  for (const decision of missing.slice(0, limit)) {
    const record = await processFire(page, decision);
    output.records = output.records.filter((entry) => entry.mapId !== record.mapId);
    output.records.push(record);
    output.builtAt = new Date().toISOString();
    await save();
    console.log(record.mapId, decision.mtbs.incid_name, record.status, record.reason || "");
  }
  console.log(
    JSON.stringify(
      {
        eligible: decisions.length,
        native: output.nativeSummaryCount,
        map: output.records.filter((record) => record.status === "available").length,
        unavailable: output.records.filter((record) => record.status === "unavailable").length,
        failed: output.records.filter((record) => record.status === "failed").length,
        validation: output.validation,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
