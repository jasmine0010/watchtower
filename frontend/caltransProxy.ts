import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import {
  readHighwayClosures,
  type CaltransRecord,
  type HighwaySnapshot,
} from "./src/highwayClosures";

async function loadSnapshot(): Promise<HighwaySnapshot> {
  const snapshot: HighwaySnapshot = {
    closures: [],
    unavailableDistricts: [],
    unmapped: 0,
    retrievedAt: new Date().toISOString(),
  };
  await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const district = index + 1;
      try {
        const url = `https://cwwp2.dot.ca.gov/data/d${district}/lcs/lcsStatusD${String(district).padStart(2, "0")}.json`;
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error("District unavailable");
        const body = (await response.json()) as { data: { lcs: CaltransRecord }[] };
        if (!Array.isArray(body.data)) throw new Error("Invalid district feed");
        const modified = Date.parse(response.headers.get("last-modified") || "");
        const parsed = readHighwayClosures(
          body.data.map((row) => row.lcs),
          district,
          Number.isFinite(modified) ? modified : null,
        );
        snapshot.closures.push(...parsed.closures);
        snapshot.unmapped += parsed.unmapped;
      } catch {
        snapshot.unavailableDistricts.push(district);
      }
    }),
  );
  snapshot.unavailableDistricts.sort((a, b) => a - b);
  return snapshot;
}

export function caltransProxy(): Plugin {
  let cached: Promise<HighwaySnapshot> | null = null;
  let expires = 0;
  function register(server: ViteDevServer | PreviewServer) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/caltrans-closures") return next();
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (!cached || Date.now() >= expires) {
        expires = Date.now() + 300000;
        cached = loadSnapshot();
      }
      void cached
        .then((snapshot) => {
          response.writeHead(snapshot.unavailableDistricts.length === 12 ? 502 : 200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify(snapshot));
        })
        .catch(next);
    });
  }
  return {
    name: "caltrans-highway-closures",
    configureServer: register,
    configurePreviewServer: register,
  };
}
