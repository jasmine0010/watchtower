import { defineConfig, loadEnv } from "vite";
import { mtbsProxy } from "./mtbsProxy";
import { historicalEvidenceProxy } from "./historicalEvidenceProxy";
import { firmsViirsProxy } from "./firmsViirsProxy";
import { smokeForecastProxy } from "./smokeForecastProxy";
import { caltransProxy } from "./caltransProxy";
import { tomtomRouteProxy } from "./tomtomRouteProxy";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "WILDFIRE_");
  return {
    optimizeDeps: { exclude: ["maplibre-gl"] },
    plugins: [
      tomtomRouteProxy(
        process.env.WILDFIRE_TOMTOM_API_KEY || environment.WILDFIRE_TOMTOM_API_KEY || "",
      ),
      caltransProxy(),
      firmsViirsProxy(),
      smokeForecastProxy(),
      mtbsProxy(),
      historicalEvidenceProxy(process.env.WILDFIRE_PYTHON || environment.WILDFIRE_PYTHON),
    ],

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
