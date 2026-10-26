import type { FeatureCollection } from "geojson";
import { californiaAirMonitors, californiaAirReports } from "./wavesLive";

export const demoAirUrl = "/data/demo/california-2025-01-08-air.json";
export type DemoAirArchive = {
  monitors: FeatureCollection;
  concentrations: FeatureCollection;
  regionalText: string;
  monitorTime: string;
  regionalTime: string;
  sources: { sourceUrl: string; retrievedAt: string; sha256: string }[];
};

export function readDemoAir(archive: DemoAirArchive) {
  const monitors = californiaAirMonitors(archive.monitors, new Date("2025-01-08T23:51:00Z"));
  for (const feature of monitors.features) {
    const original = archive.monitors.features.find(
      (sourceMonitor) => sourceMonitor.id === feature.id,
    );
    feature.properties!.pollutant = original!.properties!.pollutant;
  }
  for (const station of archive.concentrations.features) {
    const existing = monitors.features.find(
      (feature) => String(feature.id).slice(-9) === station.id,
    );
    if (existing) {
      existing.properties!.aqsMeasurements = station.properties!.measurements;
      existing.properties!.aqsPm25 = station.properties!.measurements[0].value;
      existing.properties!.aqsQualifier = station.properties!.measurements[0].qualifier;
      continue;
    }
    const reading = station.properties!.measurements[0];
    monitors.features.push({
      ...station,
      properties: {
        ...station.properties,
        siteName: `EPA monitor ${station.id}`,
        pm25: reading.value,
        qualifier: reading.qualifier,
        sourceUrl: reading.sourceUrl,
        demoPM25: true,
        color: "#315f55",
      },
    });
  }

  const regionalAir = californiaAirReports(archive.regionalText, new Date(archive.regionalTime));
  return { monitors, regionalAir };
}
