import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export function historicalEvidenceProxy(python: string | undefined): Plugin {
  const root = path.resolve("..");
  const jobs = new Map<string, "pending" | "failed">();
  let queue = Promise.resolve();

  async function relay(request: IncomingMessage, response: ServerResponse) {
    function send(status: number, value: unknown) {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(value));
    }
    const query = new URL(request.url || "/", "http://localhost").searchParams;
    if (
      request.headers["sec-fetch-site"] === "cross-site" ||
      (request.headers.origin && request.headers.origin !== "http://" + request.headers.host)
    ) {
      send(403, {
        status: "failed",
        reason: "Only this local app can request evidence preparation.",
      });
      return;
    }
    const id = query.get("fire") || "";
    const product = query.get("product") || "";
    const job = id + ":" + product;
    if (
      request.method !== "GET" ||
      query.size !== 2 ||
      !["smoke", "rain", "recovery", "context", "goes", "hrrr"].includes(product) ||
      !/^(frap|mtbs|usgs|runout|archive):\d{1,4}:[a-zA-Z0-9-]+$/.test(id)
    ) {
      send(400, { status: "failed", reason: "Choose a catalog fire." });
      return;
    }
    try {
      const year = id.split(":")[1];
      const catalog = JSON.parse(
        await readFile(
          path.join(root, `frontend/public/data/historical-fires/${year}.json`),
          "utf8",
        ),
      );
      const record = catalog.records.find((row: { id: string }) => row.id === id);
      if (!record || !record.evidenceUrl) {
        send(404, {
          status: "failed",
          reason: "Fire identity could not be verified.",
        });
        return;
      }
      try {
        const evidence = JSON.parse(
          await readFile(path.join(root, "frontend/public", record.evidenceUrl), "utf8"),
        );
        if (evidence.fireId !== id) throw new Error("Identity mismatch");
        if (evidence.checks?.[product]) {
          send(200, evidence);
          return;
        }
      } catch {}
      if (!python) {
        send(503, {
          status: "not_checked",
          reason: "Historical evidence preparation is not configured on this server.",
        });
        return;
      }
      if (jobs.get(job) === "failed") {
        send(502, {
          status: "failed",
          reason:
            "The source check failed. No source absence was inferred. See the local builder log.",
        });
        return;
      }
      if (!jobs.has(job)) {
        let pending = 0;
        for (const state of jobs.values()) {
          if (state === "pending") pending++;
        }
        if (pending >= 2) {
          send(429, {
            status: "not_checked",
            reason:
              "The local source checker is busy. Select the fire again after the current check finishes.",
          });
          return;
        }
        jobs.set(job, "pending");
        queue = queue.then(
          () =>
            new Promise<void>((resolve) => {
              const child = spawn(
                python,
                [
                  path.join(root, "scripts/build_historical_evidence.py"),
                  "--fire",
                  id,
                  "--product",
                  product,
                ],
                {
                  cwd: root,
                  shell: false,
                  windowsHide: true,
                  env: {
                    ...process.env,
                    PYTHONPATH: path.join(root, ".interface-deps"),
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              child.stdout.on("data", (chunk) => process.stdout.write(chunk));
              child.stderr.on("data", (chunk) => process.stderr.write(chunk));
              child.on("error", () => {
                jobs.set(job, "failed");
                resolve();
              });
              child.on("close", (code) => {
                if (code !== 0) jobs.set(job, "failed");
                else jobs.delete(job);
                resolve();
              });
            }),
        );
      }
      send(202, {
        status: "checking",
        reason:
          "Checking official source records. First preparation can take several minutes; source files are cached.",
      });
    } catch {
      send(502, {
        status: "failed",
        reason: "Historical catalog could not be checked.",
      });
    }
  }
  return {
    name: "historical-evidence",
    configureServer(server) {
      server.middlewares.use("/historical-evidence", relay);
    },
  };
}
