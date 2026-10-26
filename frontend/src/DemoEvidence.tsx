import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { FeatureCollection } from "geojson";
import type { WavePlace, WavesData } from "./waves";
import { EvidenceCard } from "./EvidenceCard";
import { Icon } from "./Icons";
import { parseNoaaKml, plumeCovers, pointDistanceKm, perimeterDistanceKm } from "./wavesLive";
import { readZones, type EvacuationZones } from "./evacuationZones";
import { demoAirUrl, readDemoAir, type DemoAirArchive } from "./demoAir";
import { WeatherWarningList } from "./ForecastPanel";

export const demoTime = Date.parse("2025-01-08T23:51:00Z");
const evacuationTime = Date.parse("2025-01-11T03:35:00Z");
export const demoPerimeterUrl =
  "https://services.arcgis.com/xsiPoFK0f7RrxF0D/arcgis/rest/services/Palisades_Fire_Progression/FeatureServer/0";
const weatherUrl =
  "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=SMO&data=tmpf&data=relh&data=drct&data=sknt&data=gust&data=metar&sts=2025-01-08T23%3A51%3A00Z&ets=2025-01-08T23%3A52%3A00Z&tz=UTC&format=onlycomma";
const warningArchiveUrl =
  "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py?accept=kml&at=2025-01-08T23:51Z&timeopt=2&location_group=states&states=CA";
type DemoStation = {
  id: string;
  name: string;
  timestamp: string;
  latitude: number;
  longitude: number;
  tmpf: number;
  relh: number | null;
  drct: number | null;
  sknt: number | null;
  gust: number | null;
  metar: string;
};
type DemoWeatherArchive = {
  stations: DemoStation[];
  alerts: FeatureCollection;
  sources: { sourceUrl: string; retrievedAt: string; sha256: string }[];
};

export type DemoEvidence = {
  fire: FeatureCollection;
  air: FeatureCollection;
  regionalAir: FeatureCollection;
  smoke: FeatureCollection;
  evacuationZones: EvacuationZones;
  airSource: string;
  smokeSource: string;
  weather: DemoWeatherArchive;
};

export function useDemoEvidence(enabled: boolean) {
  const [evidence, setEvidence] = useState<DemoEvidence | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    async function load() {
      try {
        const files = [
          "/data/waves/palisades.json",
          "/data/demo/palisades-2025-01-08-perimeter.geojson",
          "/data/demo/smoke-2025-01-08.kml",
          "/data/demo/palisades-2025-01-10-evacuation-zones.geojson",
          demoAirUrl,
          "/data/demo/california-2025-01-08-weather.json",
        ];
        const responses = await Promise.all(
          files.map((url) => fetch(url, { signal: controller.signal })),
        );
        if (responses.some((response) => !response.ok))
          throw new Error("Demo evidence unavailable");
        const [caseData, perimeter, smokeKml, zones, airArchive, weather] = (await Promise.all(
          responses.map((response, index) => (index === 2 ? response.text() : response.json())),
        )) as [WavesData, FeatureCollection, string, unknown, DemoAirArchive, DemoWeatherArchive];
        const smoke = parseNoaaKml(smokeKml);
        const evacuationZones = readZones(zones, evacuationTime).data;
        if (
          !perimeter.features[0] ||
          !caseData.smoke?.stations ||
          !smoke.features ||
          evacuationZones.features.length !== 63
        )
          throw new Error("Demo evidence incomplete");
        const { monitors: air, regionalAir } = readDemoAir(airArchive);
        if (!controller.signal.aborted)
          setEvidence({
            fire: perimeter,
            air,
            regionalAir,
            smoke,
            evacuationZones,
            weather,
            airSource: airArchive.sources[0].sourceUrl,
            smokeSource:
              caseData.smoke.plumes.days.find((day) => day.dateUtc === "2025-01-08")?.sourceUrl ||
              "",
          });
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [enabled]);
  return { evidence, failed };
}

export function DemoAir({
  evidence,
  failed,
  children,
}: {
  evidence: DemoEvidence | null;
  failed: boolean;
  children: ReactNode;
}) {
  return (
    <EvidenceCard
      title="Air quality"
      id="live-air"
      icon="air"
      className="live-card live-air"
      kind="Observed"
      source={
        <a href={evidence?.airSource || "https://files.airnowtech.org/"}>U.S. EPA / AirNow</a>
      }
      data={!!evidence}
      loading={!evidence && !failed}
    >
      {evidence ? (
        children
      ) : (
        <p className="quiet-failure" role="status">
          Couldn't load air quality.
        </p>
      )}
    </EvidenceCard>
  );
}

export function DemoSmoke({
  evidence,
  failed,
  place,
}: {
  evidence: DemoEvidence | null;
  failed: boolean;
  place: WavePlace | null;
}) {
  const overhead =
    evidence && place ? plumeCovers(evidence.smoke, place.longitude, place.latitude) : null;
  let summary = "";
  if (evidence && overhead === null)
    summary = `${evidence.smoke.features.length} mapped plume polygons`;
  else if (overhead) summary = "Smoke plume mapped over this ZIP reference point";
  else if (evidence) summary = "No smoke plume mapped over this ZIP reference point";
  return (
    <EvidenceCard
      title="Smoke plumes"
      id="live-smoke"
      icon="smoke"
      className="live-card live-smoke"
      kind="Observed"
      source={
        <a href={evidence?.smokeSource || "https://www.ospo.noaa.gov/products/land/hms.html"}>
          NOAA / HMS
        </a>
      }
      data={!!evidence}
      loading={!evidence && !failed}
    >
      {evidence ? (
        <p className="live-smoke-readout" role="status">
          <Icon name="smoke" />
          {summary}
        </p>
      ) : (
        <p className="quiet-failure" role="status">
          Couldn't load smoke.
        </p>
      )}
    </EvidenceCard>
  );
}

export function DemoFire({
  evidence,
  failed,
  children,
}: {
  evidence: DemoEvidence | null;
  failed: boolean;
  children: ReactNode;
}) {
  const fire = evidence?.fire.features[0];
  return (
    <EvidenceCard
      title="Mapped fires"
      id="live-fires"
      icon="fire"
      className="live-card live-fires"
      kind="Observed"
      source={<a href={demoPerimeterUrl}>Palisades fire progression</a>}
      data={!!fire}
      loading={!fire && !failed}
    >
      {fire ? (
        children
      ) : (
        <p className="quiet-failure" role="status">
          Couldn't load fire boundaries.
        </p>
      )}
    </EvidenceCard>
  );
}

export function nearestDemoStation(stations: DemoStation[], point: [number, number]) {
  let nearest: DemoStation | null = null;
  let distance = Infinity;
  for (const station of stations) {
    const candidate = pointDistanceKm(point, [station.longitude, station.latitude]);
    if (candidate < distance) {
      nearest = station;
      distance = candidate;
    }
  }
  return nearest ? { station: nearest, distance } : null;
}

export function DemoWeather({
  evidence,
  failed,
  place,
  point,
}: {
  evidence: DemoEvidence | null;
  failed: boolean;
  place: WavePlace | null;
  point?: [number, number] | null;
}) {
  const reference: [number, number] =
    point || (place ? [place.longitude, place.latitude] : [-118.53, 34.05]);
  const nearest = evidence ? nearestDemoStation(evidence.weather.stations, reference) : null;
  const station = nearest?.station;
  const loading = !evidence && !failed;
  return (
    <EvidenceCard
      title="Weather"
      id="live-weather"
      icon="weather"
      className="live-card live-weather"
      source={<a href={evidence?.weather.sources[1].sourceUrl || weatherUrl}>IEM / METAR</a>}
      loading={loading}
      data={!!evidence}
    >
      {station ? (
        <>
          <div className="live-weather-reading">
            <p className="live-headline">{Math.round(station.tmpf)} °F</p>
            <p className="live-support">{station.name}</p>
          </div>
          <div className="live-weather-metrics">
            <div>
              <span>
                <small>Wind</small>
                {station.sknt === null
                  ? "Not supplied"
                  : `${Math.round(station.sknt * 1.15078)} mph`}
              </span>
            </div>
            <div>
              <span>
                <small>Humidity</small>
                {station.relh === null ? "Not supplied" : `${Math.round(station.relh)}%`}
              </span>
            </div>
          </div>
        </>
      ) : (
        <p className="quiet-failure" role="status">
          Couldn't load weather.
        </p>
      )}
    </EvidenceCard>
  );
}

export function DemoAlerts({
  evidence,
  failed,
  place,
  point,
}: {
  evidence: DemoEvidence | null;
  failed: boolean;
  place: WavePlace | null;
  point?: [number, number] | null;
}) {
  const reference: [number, number] =
    point || (place ? [place.longitude, place.latitude] : [-118.53, 34.05]);
  const alerts =
    evidence?.weather.alerts.features.filter(
      (alert) => perimeterDistanceKm(alert.geometry, reference) === 0,
    ) || [];
  return (
    <EvidenceCard
      title="Weather warnings"
      id="live-alerts"
      icon="alert"
      className="live-card live-alerts"
      kind="Forecast"
      source={<a href={evidence?.weather.sources[2].sourceUrl || warningArchiveUrl}>IEM / NWS</a>}
      data={!!evidence}
      loading={!evidence && !failed}
    >
      <WeatherWarningList
        alerts={
          evidence
            ? alerts.map((alert) => ({
                id: String(alert.id),
                event: String(alert.properties?.event || "Weather alert"),
              }))
            : null
        }
      />
    </EvidenceCard>
  );
}
