import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

const service =
  "https://mapservices.weather.noaa.gov/raster/rest/services/air_quality/ndgd_smoke_sfc_1hr_avg_time/ImageServer";
const hour = 3_600_000;
type ForecastRecord = {
  objectid: number;
  idp_validtime: number;
  idp_issueddate: number;
  idp_subset: string;
};
let catalog: { expires: number; records: Promise<ForecastRecord[]> } | null = null;

function currentRecords() {
  if (!catalog || catalog.expires < Date.now()) {
    const query = new URLSearchParams({
      where: "category=1",
      outFields: "objectid,idp_validtime,idp_issueddate,idp_subset",
      orderByFields: "idp_issueddate DESC,idp_validtime ASC",
      returnGeometry: "false",
      resultRecordCount: "1000",
      f: "json",
    });
    const records = fetch(`${service}/query?${query}`, {
      signal: AbortSignal.timeout(15000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("NWS metadata unavailable");
      const catalogReply = (await response.json()) as {
        features?: { attributes: ForecastRecord }[];
        exceededTransferLimit?: boolean;
      };
      if (!catalogReply.features?.length || catalogReply.exceededTransferLimit)
        throw new Error("NWS frame catalog unavailable or incomplete");
      return catalogReply.features.map((feature) => feature.attributes);
    });
    catalog = { expires: Date.now() + 5 * 60_000, records };
    records.catch(() => {
      catalog = null;
    });
  }
  return catalog.records;
}

async function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", "http://localhost");
  const imageTime = Number(url.searchParams.get("time"));
  const issuedTime = Number(url.searchParams.get("issued"));
  const bbox = (url.searchParams.get("bbox") || "").split(",").map(Number);
  const metadata = url.pathname === "/" && url.searchParams.size === 0;
  const tile =
    url.pathname === "/tile" &&
    url.searchParams.size === 3 &&
    Number.isSafeInteger(imageTime) &&
    Number.isSafeInteger(issuedTime) &&
    bbox.length === 4 &&
    bbox.every((value) => Number.isFinite(value) && Math.abs(value) <= 20_037_509) &&
    bbox[0] < bbox[2] &&
    bbox[1] < bbox[3];
  if (request.method !== "GET" || (!metadata && !tile)) {
    response.writeHead(400).end("Unsupported forecast request.");
    return;
  }
  try {
    const records = await currentRecords();
    const latestIssue = Math.max(...records.map((record) => record.idp_issueddate));
    if (!Number.isFinite(latestIssue) || latestIssue < Date.now() - 24 * hour)
      throw new Error("No current NWS forecast run");
    if (metadata) {
      const firstHour = Math.ceil(Date.now() / hour) * hour;
      const validTimes = new Set<number>();
      for (const record of records) {
        if (record.idp_issueddate === latestIssue && record.idp_validtime >= firstHour) {
          validTimes.add(record.idp_validtime);
        }
      }
      const times = [...validTimes].sort((a, b) => a - b);
      const frames = [];
      for (const time of times) {
        let nationwide = true;
        for (const region of ["conus", "alaska", "hawaii"]) {
          const covered = records.some(
            (record) =>
              record.idp_issueddate === latestIssue &&
              record.idp_validtime === time &&
              record.idp_subset === region,
          );
          if (!covered) {
            nationwide = false;
            break;
          }
        }
        if (nationwide) frames.push({ validTime: time });
      }
      if (!frames.length) throw new Error("No current nationwide NWS forecast frames");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ issuedTime: latestIssue, frames }));
      return;
    }
    const rasters = records.filter(
      (record) => record.idp_issueddate === issuedTime && record.idp_validtime === imageTime,
    );
    if (issuedTime !== latestIssue || !rasters.length) {
      response.writeHead(404).end("Forecast frame unavailable.");
      return;
    }
    const query = new URLSearchParams({
      bbox: bbox.join(","),
      bboxSR: "3857",
      imageSR: "3857",
      size: "512,512",
      format: "png32",
      transparent: "true",
      time: String(imageTime),
      mosaicRule: JSON.stringify({
        mosaicMethod: "esriMosaicLockRaster",
        lockRasterIds: rasters.map((record) => record.objectid),
      }),
      f: "image",
    });
    const imageRes = await fetch(`${service}/exportImage?${query}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!imageRes.ok || !imageRes.headers.get("content-type")?.includes("image/png"))
      throw new Error("NWS forecast image unavailable");
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
    });
    response.end(Buffer.from(await imageRes.arrayBuffer()));
  } catch {
    response.writeHead(502).end("NWS surface-smoke forecast unavailable.");
  }
}

function register(server: ViteDevServer | PreviewServer) {
  server.middlewares.use("/surface-smoke-forecast", (request, response) => {
    void serve(request, response);
  });
}

export function smokeForecastProxy(): Plugin {
  return {
    name: "nws-surface-smoke-forecast",
    configureServer: register,
    configurePreviewServer: register,
  };
}
