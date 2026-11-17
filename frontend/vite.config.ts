import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { mtbsProxy } from "./mtbsProxy";
import { historicalEvidenceProxy } from "./historicalEvidenceProxy";
import { firmsViirsProxy } from "./firmsViirsProxy";
import { smokeForecastProxy } from "./smokeForecastProxy";
import { caltransProxy } from "./caltransProxy";
import { tomtomRouteProxy } from "./tomtomRouteProxy";

// MapLibre loads its worker from "./maplibre-gl-worker.mjs" next to the bundled module.
// The dev server serves it from node_modules; a production build must copy it into assets.
function maplibreWorker(): Plugin {
  return {
    name: "maplibre-worker",
    apply: "build",
    generateBundle() {
      const require = createRequire(import.meta.url);
      const source = require.resolve("maplibre-gl/dist/maplibre-gl-worker.mjs");
      this.emitFile({
        type: "asset",
        fileName: "assets/maplibre-gl-worker.mjs",
        source: readFileSync(source),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "WILDFIRE_");
  return {
    optimizeDeps: { exclude: ["maplibre-gl"] },
    plugins: [
      maplibreWorker(),
      tomtomRouteProxy(
        process.env.WILDFIRE_TOMTOM_API_KEY || environment.WILDFIRE_TOMTOM_API_KEY || "",
      ),
      caltransProxy(),
      firmsViirsProxy(),
      smokeForecastProxy(),
      mtbsProxy(),
      historicalEvidenceProxy(process.env.WILDFIRE_PYTHON || environment.WILDFIRE_PYTHON),
    ],

    preview: {
      // Hosting platforms reach the server through their own domain name.
      allowedHosts: [
        ".onrender.com",
        ...(process.env.WILDFIRE_ALLOWED_HOSTS || environment.WILDFIRE_ALLOWED_HOSTS || "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      ],
    },
    server: {
      watch: {
        ignored: [
          "**/public/data/historical-fires/evidence/**",
          "**/public/data/historical-fires/recovery/**",
          "**/public/data/waves/plumes/**",
          "**/public/data/waves/*-rain-scenarios.json",
        ],
      },
    },
  };
});
