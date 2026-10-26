import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { hazardRenderer } from "./src/usgsHazards";
import { relayNoaa } from "./wavesProxy";

async function relay(request: IncomingMessage, response: ServerResponse) {
  function fail(status: number, message: string) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(message);
  }
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (
      !["/wfs", "/wms"].includes(url.pathname) ||
      !["GET", "POST"].includes(request.method || "")
    ) {
      fail(400, "Only MTBS read-only map requests are supported.");
      return;
    }
    let body = "";
    if (request.method === "POST") {
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 64000) {
          fail(413, "MTBS query too large.");
          return;
        }
      }
    }
    const params = request.method === "POST" ? new URLSearchParams(body) : url.searchParams;
    const allowed =
      url.pathname === "/wfs"
        ? [
            "service",
            "version",
            "request",
            "typeNames",
            "outputFormat",
            "srsName",
            "count",
            "startIndex",
            "sortBy",
            "CQL_FILTER",
            "propertyName",
          ]
        : [
            "service",
            "version",
            "request",
            "layers",
            "styles",
            "format",
            "transparent",
            "srs",
            "bbox",
            "width",
            "height",
          ];
    for (const key of params.keys()) {
      if (!allowed.includes(key) || params.getAll(key).length !== 1) {
        fail(400, "Unsupported or repeated MTBS parameter.");
        return;
      }
    }
    const wfs =
      url.pathname === "/wfs" &&
      params.get("service") === "WFS" &&
      params.get("request") === "GetFeature" &&
      params.get("typeNames") === "mtbs:fire_polygons";
    const wms =
      url.pathname === "/wms" &&
      request.method === "GET" &&
      params.get("service") === "WMS" &&
      params.get("request") === "GetMap" &&
      /^mtbs:mtbs_CONUS_\d{4}$/.test(params.get("layers") || "") &&
      params.get("format") === "image/png" &&
      params.get("srs") === "EPSG:3857" &&
      Number(params.get("width")) > 0 &&
      Number(params.get("width")) <= 1536 &&
      Number(params.get("height")) > 0 &&
      Number(params.get("height")) <= 1536;
    if (!wfs && !wms) {
      fail(400, "Unsupported MTBS layer or operation.");
      return;
    }

    const upstreamUrl = `https://edcintl.cr.usgs.gov/geoserver${url.pathname}${request.method === "GET" ? "?" + params : ""}`;
    const upstream = https.request(
      upstreamUrl,
      {
        method: request.method,
        headers: {
          "User-Agent": "Watchtower/1.0 (historical MTBS education)",
          Accept: "application/json,image/png",
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (upstreamRes) => {
        response.writeHead(upstreamRes.statusCode || 502, {
          "Content-Type": upstreamRes.headers["content-type"] || "application/octet-stream",
          "Cache-Control": request.method === "GET" ? "public, max-age=300" : "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        let size = 0;
        upstreamRes.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            upstream.destroy();
            fail(502, "MTBS response too large.");
          }
        });
        upstreamRes.on("error", () => fail(502, "MTBS response interrupted."));
        upstreamRes.pipe(response);
      },
    );
    upstream.setTimeout(25000, () => upstream.destroy(new Error("MTBS timeout")));
    upstream.on("error", () => fail(502, "Official MTBS service unavailable or timed out."));
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    if (body) upstream.write(body);
    upstream.end();
  } catch {
    fail(502, "MTBS request could not be completed.");
  }
}

export function mtbsProxy(): Plugin {
  return {
    name: "read-only-mtbs-relay",
    configureServer(server) {
      server.middlewares.use("/noaa-smoke", relayNoaa);
      server.middlewares.use("/mtbs-service", relay);
      server.middlewares.use("/usgs-assessments", relayAssessment);
      server.middlewares.use("/usgs-hazards", relayHazard);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/mtbs-service", relay);
      server.middlewares.use("/usgs-assessments", relayAssessment);
      server.middlewares.use("/usgs-hazards", relayHazard);
    },
  };
}

function relayHazard(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", "http://localhost");
  const params = url.searchParams;
  const id = params.get("id") || "";
  const validId = /^[A-Za-z0-9_. '-]{1,150}$/.test(id);
  const offset = params.get("offset") || "0";
  const layer = params.get("layer") || "";
  const query = new URLSearchParams({ f: "json" });
  let endpoint = "";
  let image = false;
  let valid = request.method === "GET";
  let allowed: string[] = [];
  if (url.pathname === "/locations") {
    allowed = ["offset"];
    valid &&= /^\d{1,8}$/.test(offset);
    endpoint = "0/query";
    query.set("where", "1=1");
    query.set(
      "outFields",
      "Fire_ID,fire,lat,lon,location,size,status,disclaimer,Rainfall,start_date,assessment_date,ScienceBaseURL",
    );
    query.set("returnGeometry", "false");
    query.set("orderByFields", "OBJECTID");
    query.set("resultOffset", offset);
    query.set("resultRecordCount", "2000");
  } else if (url.pathname === "/coverage") {
    allowed = ["id", "layer"];
    valid &&= validId && ["1", "2", "4", "5", "6", "7", "9"].includes(layer);
    endpoint = `${layer}/query`;
    query.set("where", `fire_id='${id.replaceAll("'", "''")}'`);
    query.set("outFields", "fire_id,assessment_date,start_date,version");
    query.set("returnGeometry", "false");
    query.set("returnDistinctValues", "true");
  } else if (url.pathname === "/legend") {
    endpoint = "legend";
  } else if (url.pathname === "/bounds") {
    allowed = ["id"];
    valid &&= validId;
    endpoint = "9/query";
    query.set("where", `fire_id='${id.replaceAll("'", "''")}'`);
    query.set("returnExtentOnly", "true");
    query.set("outSR", "4326");
  } else if (url.pathname === "/boundary") {
    allowed = ["id"];
    valid &&= validId;
    endpoint = "9/query";
    query.set("f", "geojson");
    query.set("where", `fire_id='${id.replaceAll("'", "''")}'`);
    query.set("outFields", "fire_id,assessment_date,start_date,version");
    query.set("returnGeometry", "true");
    query.set("outSR", "4326");
  } else if (url.pathname === "/map") {
    allowed = ["id", "layers", "bbox"];
    const layers = (params.get("layers") || "").split(",");
    const groups = [
      ["2", "1", "9"],
      ["6", "7", "9"],
      ["4", "5", "9"],
    ];
    const bbox = (params.get("bbox") || "").split(",").map(Number);
    valid &&=
      validId &&
      new Set(layers).size === layers.length &&
      groups.some((group) => layers.every((value) => group.includes(value))) &&
      bbox.length === 4 &&
      bbox.every((value) => Number.isFinite(value) && Math.abs(value) <= 20037509) &&
      bbox[0] < bbox[2] &&
      bbox[1] < bbox[3];
    endpoint = "export";
    image = true;
    query.set("f", "image");
    query.set("bbox", bbox.join(","));
    query.set("bboxSR", "3857");
    query.set("imageSR", "3857");
    query.set("size", "256,256");
    query.set("format", "png32");
    query.set("transparent", "true");
    query.set("layers", `show:${layers.join(",")}`);
    const definitions: Record<string, string> = {};
    for (const value of layers) definitions[value] = `fire_id='${id.replaceAll("'", "''")}'`;
    query.set("layerDefs", JSON.stringify(definitions));

    if (valid) {
      const dynamicLayers = [];
      for (const layer of layers) {
        const dynamicLayer: Record<string, unknown> = {
          id: Number(layer),
          source: { type: "mapLayer", mapLayerId: Number(layer) },
          definitionExpression: definitions[layer],
        };
        if (layer !== "9") dynamicLayer.drawingInfo = { renderer: hazardRenderer(Number(layer)) };
        dynamicLayers.push(dynamicLayer);
      }
      query.set("dynamicLayers", JSON.stringify(dynamicLayers));
    }
  } else valid = false;
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) valid = false;
  }
  if (!valid) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Unsupported USGS read-only map request." }));
    return;
  }
  const body = query.toString();
  let finished = false;
  function fail() {
    if (finished || response.writableEnded) return;
    finished = true;
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Official USGS source unavailable." }));
  }

  const upstream = https.request(
    `https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/${endpoint}?${params}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Watchtower/1.0 (historical education)",
      },
    },
    (upstreamRes) => {
      const chunks: Buffer[] = [];
      let length = 0;
      upstreamRes.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 2000000) upstream.destroy(new Error("USGS response too large"));
        else chunks.push(chunk);
      });
      upstreamRes.on("error", fail);
      upstreamRes.on("end", () => {
        if (finished || response.writableEnded) return;
        const bytes = Buffer.concat(chunks);
        const png =
          bytes.length >= 8 &&
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        if (upstreamRes.statusCode !== 200 || (image && !png)) {
          fail();
          return;
        }
        finished = true;
        response.writeHead(200, {
          "Content-Type": image ? "image/png" : "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
      });
    },
  );
  upstream.setTimeout(25000, () => upstream.destroy(new Error("USGS timeout")));
  upstream.on("error", fail);
  response.on("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });
  upstream.end(body);
}

function relayAssessment(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", "http://localhost");
  const id = url.searchParams.get("id") || "";
  if (
    request.method !== "GET" ||
    url.pathname !== "/" ||
    url.searchParams.size !== 1 ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(id)
  ) {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("Only an exact USGS assessment ID lookup is supported.");
    return;
  }
  const params = new URLSearchParams({
    where: `Fire_ID='${id}'`,
    outFields:
      "Fire_ID,fire,lat,lon,location,size,status,disclaimer,Rainfall,start_date,assessment_date,ScienceBaseURL,download_url",
    returnGeometry: "false",
    f: "json",
  });
  const upstream = https.get(
    `https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/0/query?${params}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Watchtower/1.0 (historical education)",
      },
    },
    (upstreamRes) => {
      let body = "";
      upstreamRes.setEncoding("utf8");
      upstreamRes.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 512000) upstream.destroy(new Error("Metadata response too large"));
      });
      upstreamRes.on("error", () => upstream.destroy(new Error("Metadata response interrupted")));
      upstreamRes.on("end", () => {
        if (response.writableEnded) return;
        response.writeHead(upstreamRes.statusCode || 502, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(body);
      });
    },
  );
  upstream.setTimeout(15000, () => upstream.destroy(new Error("USGS timeout")));
  upstream.on("error", () => {
    if (response.writableEnded) return;
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Official USGS metadata unavailable." }));
  });
  response.on("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });
}
