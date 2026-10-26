import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

type Coordinates = [number, number];

function validPoint(value: unknown): value is Coordinates {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, key: string) {
  if (!key) {
    response.writeHead(503).end();
    return;
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 512) {
      response.writeHead(413).end();
      return;
    }
  }
  let points: { origin?: unknown; destination?: unknown };
  try {
    points = JSON.parse(body);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!points || !validPoint(points.origin) || !validPoint(points.destination)) {
    response.writeHead(400).end();
    return;
  }

  try {
    const upstream = await fetch(
      "https://api.tomtom.com/maps/orbis/routing/routes/calculate?apiVersion=3",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "TomTom-Api-Key": key,
          Attributes: "routes",
        },
        body: JSON.stringify({
          routePlanningLocations: {
            origin: { type: "Point", coordinates: points.origin },
            destination: { type: "Point", coordinates: points.destination },
          },
          traffic: "live",
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!upstream.ok) throw new Error("Routing unavailable");
    const routeReply = (await upstream.json()) as {
      routes?: Array<{
        summary?: { lengthInMeters?: number; travelDurationInSeconds?: number };
        legs?: Array<{ path?: { type: string; coordinates: Coordinates[] } }>;
      }>;
    };
    const route = routeReply.routes?.[0];
    const path = route?.legs?.[0]?.path;
    if (
      path?.type !== "LineString" ||
      !Array.isArray(path.coordinates) ||
      path.coordinates.length < 2
    )
      throw new Error("Route missing");
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        path,
        distanceMeters: route?.summary?.lengthInMeters,
        durationSeconds: route?.summary?.travelDurationInSeconds,
        checkedAt: new Date().toISOString(),
      }),
    );
  } catch {
    response.writeHead(502).end();
  }
}

async function homeAddressRequest(request: IncomingMessage, response: ServerResponse, key: string) {
  if (!key) {
    response.writeHead(503).end();
    return;
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024) {
      response.writeHead(413).end();
      return;
    }
  }
  let address: unknown;
  try {
    address = JSON.parse(body)?.address;
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (typeof address !== "string" || !address.trim() || address.length > 300) {
    response.writeHead(400).end();
    return;
  }

  try {
    const url = new URL("https://api.tomtom.com/maps/orbis/places/geocode");
    url.searchParams.set("query", address.trim());
    url.searchParams.set("countryCodesIso2", "US");
    url.searchParams.set("types", "address");
    url.searchParams.set("maxResults", "1");
    const upstream = await fetch(url, {
      headers: {
        "TomTom-Api-Key": key,
        "TomTom-Api-Version": "2",
        Attributes: "results(position)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) throw new Error("Address lookup unavailable");
    const geocodeReply = (await upstream.json()) as {
      results?: Array<{ position?: { coordinates?: unknown } }>;
    };
    const coordinates = geocodeReply.results?.[0]?.position?.coordinates;
    if (!validPoint(coordinates)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ point: coordinates }));
  } catch {
    response.writeHead(502).end();
  }
}

export function tomtomRouteProxy(key: string): Plugin {
  function register(server: ViteDevServer | PreviewServer) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/driving-route" && request.url !== "/home-address-location")
        return next();
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const serve = request.url === "/driving-route" ? routeRequest : homeAddressRequest;
      void serve(request, response, key).catch(() => {
        if (!response.headersSent) response.writeHead(502).end();
      });
    });
  }
  return {
    name: "tomtom-driving-route",
    configureServer: register,
    configurePreviewServer: register,
  };
}
