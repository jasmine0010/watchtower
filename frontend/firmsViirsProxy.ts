import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

const feeds = [
  ["S-NPP", "suomi-npp-viirs-c2", "SUOMI_VIIRS_C2"],
  ["NOAA-20", "noaa-20-viirs-c2", "J1_VIIRS_C2"],
  ["NOAA-21", "noaa-21-viirs-c2", "J2_VIIRS_C2"],
] as const;

async function serve(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET" || request.url !== "/firms-viirs") {
    response.writeHead(404).end();
    return;
  }
  try {
    const sources = await Promise.all(
      feeds.map(async ([satellite, product, prefix]) => {
        const file = `${prefix}_USA_contiguous_and_Hawaii_24h.kml`;
        const url = `https://firms.modaps.eosdis.nasa.gov/data/active_fire/${product}/kml/${file}`;
        const feedRes = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!feedRes.ok) throw new Error("NASA FIRMS feed unavailable");
        return { satellite, kml: await feedRes.text() };
      }),
    );
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
    response.end(JSON.stringify({ sources }));
  } catch {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "NASA FIRMS VIIRS feeds unavailable." }));
  }
}

function register(server: ViteDevServer | PreviewServer) {
  server.middlewares.use((request, response, next) => {
    if (request.url !== "/firms-viirs") return next();
    void serve(request, response).catch(next);
  });
}

export function firmsViirsProxy(): Plugin {
  return {
    name: "firms-viirs-24h",
    configureServer: register,
    configurePreviewServer: register,
  };
}
