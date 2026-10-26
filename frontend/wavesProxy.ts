import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { noaaToday } from "./src/wavesLive";

let cached: {
  date: string;
  at: number;
  status: number;
  payload: string;
} | null = null;

export function relayNoaa(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", "http://localhost");
  function send(status: number, body: string) {
    if (response.writableEnded) return;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }
  if (request.method !== "GET" || !["", "/"].includes(url.pathname) || url.search) {
    send(
      400,
      JSON.stringify({
        error: "Only the fixed NOAA smoke lookup is supported.",
      }),
    );
    return;
  }
  const date = noaaToday();
  if (cached && cached.date === date && Date.now() - cached.at < 300000) {
    send(cached.status, cached.payload);
    return;
  }
  let activeRequest: ReturnType<typeof https.get> | null = null;
  function fetchDay(daysBack: number) {
    const fileDate = new Date(Date.parse(date) - daysBack * 86400000).toISOString().slice(0, 10);
    const sourceUrl = `https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/${fileDate.slice(0, 4)}/${fileDate.slice(5, 7)}/hms_smoke${fileDate.replaceAll("-", "")}.kml`;
    const upstream = https.get(
      sourceUrl,
      {
        headers: {
          "User-Agent": "Watchtower/1.0 (NOAA educational preview)",
          Accept: "application/vnd.google-earth.kml+xml,application/xml",
        },
      },
      (noaaRes) => {
        if (noaaRes.statusCode !== 200) {
          noaaRes.resume();
          if (noaaRes.statusCode === 404) {
            if (daysBack < 2) {
              fetchDay(daysBack + 1);
              return;
            }
            const payload = JSON.stringify({
              error: "No NOAA file available for today or the previous two UTC days.",
              dateUtc: date,
              sourceUrl,
              checkedAt: new Date().toISOString(),
            });
            cached = { date, at: Date.now(), status: 404, payload };
            send(404, payload);
            return;
          }
          send(
            502,
            JSON.stringify({
              error: "Today's NOAA file unavailable.",
              sourceUrl,
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        noaaRes.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) upstream.destroy(new Error("NOAA file too large"));
          else chunks.push(chunk);
        });
        noaaRes.on("error", () =>
          send(502, JSON.stringify({ error: "NOAA download interrupted." })),
        );
        noaaRes.on("end", () => {
          if (size > 4 * 1024 * 1024) return;
          const kml = Buffer.concat(chunks).toString("utf8");
          if (!/<kml[\s>]/.test(kml)) {
            send(502, JSON.stringify({ error: "NOAA file unavailable." }));
            return;
          }
          const payload = JSON.stringify({
            dateUtc: fileDate,
            requestedDateUtc: date,
            earlier: daysBack > 0,
            sourceUrl,
            retrievedAt: new Date().toISOString(),
            sourceUpdatedAt: noaaRes.headers["last-modified"] || null,
            kml,
          });
          cached = { date, at: Date.now(), status: 200, payload };
          send(200, payload);
        });
      },
    );
    activeRequest = upstream;
    upstream.setTimeout(15000, () => upstream.destroy(new Error("NOAA timeout")));
    upstream.on("error", () => send(502, JSON.stringify({ error: "NOAA unavailable." })));
  }
  fetchDay(0);
  response.on("close", () => {
    if (!response.writableEnded) activeRequest?.destroy();
  });
}
