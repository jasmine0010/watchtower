import { useEffect } from "react";
import { displayUnits } from "./units";
import { EvidenceCard, UpdateAge } from "./EvidenceCard";
import type { WavePlace } from "./waves";
import { HourlyOutlook } from "./HourlyOutlook";
import { windMph } from "./wavesLive";
import { weatherWarningMeanings } from "./weatherWarningMeanings";

type FetchResult<T> = { data: T | null; retrieved: number; error: string };
type Observation = {
  properties: {
    timestamp: string;
    station: string;
    temperature: { value: number | null };
    textDescription: string;
    windSpeed?: { value: number | null; unitCode: string };
    windDirection?: { value: number | null; unitCode: string };
    relativeHumidity?: { value: number | null; unitCode: string };
  };
};
type Alerts = {
  features: {
    properties: {
      id: string;
      headline: string;
      description: string;
      expires: string;
      sent?: string;
      onset?: string | null;
      ends?: string | null;
      web?: string | null;
      event?: string;
      severity?: string;
    };
  }[];
};
export type Weather = {
  coordinates: string;
  observation: FetchResult<Observation>;
  alerts: FetchResult<Alerts>;
};
type Point = { properties: { observationStations: string } };
type Stations = {
  features: { id: string }[];
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const nwsUrl = (value: unknown): value is string =>
  text(value) && value.startsWith("https://api.weather.gov/");

export function validPoint(value: unknown): value is Point {
  const p = object(object(value).properties);
  return nwsUrl(p.observationStations);
}

export function validStations(value: unknown): value is Stations {
  const features = object(value).features;

  return Array.isArray(features) && (features.length === 0 || nwsUrl(object(features[0]).id));
}

export function validObservation(value: unknown): value is Observation {
  const p = object(object(value).properties);
  const temperature = object(p.temperature).value;
  return (
    timestamp(p.timestamp) &&
    text(p.station) &&
    text(p.textDescription) &&
    (temperature === null || finite(temperature))
  );
}

export function validAlerts(value: unknown): value is Alerts {
  const features = object(value).features;
  return (
    Array.isArray(features) &&
    features.every((value) => {
      const p = object(object(value).properties);
      return text(p.id) && text(p.headline) && text(p.description) && timestamp(p.expires);
    })
  );
}
const cache = new Map<string, { data: unknown; retrieved: number }>();
const CACHE_MS = 5 * 60_000;
const STALE_MS = 15 * 60_000;

export function clearWeatherCache() {
  cache.clear();
}

async function get<T>(
  url: string,
  valid: (value: unknown) => value is T,
): Promise<{ data: T; retrieved: number }> {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.retrieved < CACHE_MS && valid(entry.data))
    return { data: entry.data, retrieved: entry.retrieved };
  const response = await fetch(url, {
    headers: { Accept: "application/geo+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`NWS returned HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!valid(data)) throw new Error("NWS response is incomplete or invalid");
  const result = { data, retrieved: Date.now() };
  cache.set(url, result);
  return result;
}

async function attempt<T>(
  operation: () => Promise<{ data: T; retrieved: number }>,
): Promise<FetchResult<T>> {
  try {
    return { ...(await operation()), error: "" };
  } catch (error) {
    return {
      data: null,
      retrieved: 0,
      error: error instanceof Error ? error.message : "Request failed",
    };
  }
}

async function loadWeather(coordinates: string): Promise<Weather> {
  const point = get(`https://api.weather.gov/points/${coordinates}`, validPoint);
  const observation = attempt(async () => {
    const stations = await get((await point).data.properties.observationStations, validStations);
    for (const station of stations.data.features.slice(0, 3)) {
      try {
        return await get(`${station.id}/observations/latest`, validObservation);
      } catch {}
    }
    throw new Error("No usable observation from nearby NWS stations");
  });
  const alerts = attempt(() =>
    get(`https://api.weather.gov/alerts/active?point=${coordinates}`, validAlerts),
  );
  const [stationResult, alertResult] = await Promise.all([observation, alerts]);
  return {
    coordinates,
    observation: stationResult,
    alerts: alertResult,
  };
}

export type WeatherState = {
  weather: Weather | null;
  now: number;
};

export function ForecastPanel({
  place,
  state,
  refresh,
  onState,
}: {
  place: WavePlace;
  state: WeatherState;
  refresh: number;
  onState: (changes: Partial<WeatherState>) => void;
}) {
  const { now } = state;
  const coordinates = `${place.latitude},${place.longitude}`;
  const nwsForecast = `https://forecast.weather.gov/MapClick.php?lat=${place.latitude}&lon=${place.longitude}`;

  const weather = state.weather?.coordinates === coordinates ? state.weather : null;
  useEffect(() => {
    const timer = setInterval(() => onState({ now: Date.now() }), 30_000);
    return () => clearInterval(timer);
  }, [onState]);
  useEffect(() => {
    let active = true;
    onState({ weather: null });
    loadWeather(coordinates).then((value) => {
      if (active) {
        onState({ weather: value, now: Date.now() });
      }
    });
    return () => {
      active = false;
    };
  }, [refresh, coordinates, onState]);
  return (
    <>
      {!weather ? (
        <>
          <EvidenceCard
            title="Weather"
            id="live-weather"
            icon="weather"
            className="live-card live-weather"
            kind="Observed"
            loading
            data={false}
            source={<a href={nwsForecast}>NWS</a>}
          />
          <EvidenceCard
            title="Weather warnings"
            id="live-alerts"
            icon="alert"
            className="live-card live-alerts"
            kind="Forecast"
            loading
            data={false}
            source={<a href="https://www.weather.gov/alerts">NWS</a>}
          />
        </>
      ) : (
        <>
          <StationObservation
            observation={weather.observation}
            place={place}
            now={now}
            refresh={refresh}
          />
          <WeatherAlerts alerts={weather.alerts} />
        </>
      )}
    </>
  );
}

function StationObservation({
  observation,
  place,
  now,
  refresh,
}: {
  observation: Weather["observation"];
  place: WavePlace;
  now: number;
  refresh: number;
}) {
  const nwsForecast = `https://forecast.weather.gov/MapClick.php?lat=${place.latitude}&lon=${place.longitude}`;
  if (!observation.data)
    return (
      <EvidenceCard
        title="Weather"
        id="live-weather"
        icon="weather"
        className="live-card live-weather"
        kind="Observed"
        data={false}
        source={<a href={nwsForecast}>NWS</a>}
      >
        <p className="quiet-failure" role="status">
          Couldn't load weather.
        </p>
        <HourlyOutlook
          embedded
          latitude={place.latitude}
          longitude={place.longitude}
          label={`ZIP ${place.zipcode}`}
          refresh={refresh}
        />
      </EvidenceCard>
    );
  const report = observation.data.properties;
  const temperature = report.temperature.value;
  const speed = windMph(report.windSpeed?.value, report.windSpeed?.unitCode);
  const humidityValue = report.relativeHumidity?.value;
  const humidity =
    report.relativeHumidity?.unitCode === "wmoUnit:percent" &&
    typeof humidityValue === "number" &&
    Number.isFinite(humidityValue) &&
    humidityValue >= 0 &&
    humidityValue <= 100
      ? humidityValue
      : null;
  const stale =
    now - observation.retrieved > STALE_MS ||
    !Number.isFinite(Date.parse(report.timestamp)) ||
    now - Date.parse(report.timestamp) > 90 * 60_000;
  return (
    <EvidenceCard
      title="Weather"
      id="live-weather"
      icon="weather"
      className="live-card live-weather"
      updated={<UpdateAge time={report.timestamp} now={now} stale={stale} />}
      kind="Observed"
      source={
        <>
          <a href={`${report.station.replace(/\/$/, "")}/observations/latest`}>NWS observations</a>{" "}
          /{" "}
          <a
            href={`https://forecast.weather.gov/MapClick.php?lat=${place.latitude}&lon=${place.longitude}`}
          >
            NWS forecast
          </a>
        </>
      }
    >
      <div className="live-weather-reading">
        <p className={temperature === null ? "live-headline live-condition" : "live-headline"}>
          {temperature === null
            ? report.textDescription
            : displayUnits(temperature, "temperature").us.toFixed(1) + " °F"}
        </p>
        {temperature !== null && <p className="live-support">{report.textDescription}</p>}
      </div>
      {(speed !== null || humidity !== null) && (
        <div className="live-weather-metrics">
          {speed !== null && (
            <div>
              <span>
                <small>Wind</small>
                {speed.toFixed(0)} mph
              </span>
            </div>
          )}
          {humidity !== null && (
            <div>
              <span>
                <small>Humidity</small>
                {humidity.toFixed(0)}%
              </span>
            </div>
          )}
        </div>
      )}
      <HourlyOutlook
        embedded
        latitude={place.latitude}
        longitude={place.longitude}
        label={`ZIP ${place.zipcode}`}
        refresh={refresh}
      />
    </EvidenceCard>
  );
}

function WeatherAlerts({ alerts }: { alerts: Weather["alerts"] }) {
  return (
    <EvidenceCard
      title="Weather warnings"
      id="live-alerts"
      icon="alert"
      className="live-card live-alerts"
      kind="Forecast"
      data={!!alerts.data}
      source={<a href="https://www.weather.gov/alerts">NWS</a>}
    >
      <WeatherWarningList
        alerts={
          alerts.data
            ? alerts.data.features.map((alert) => ({
                id: alert.properties.id,
                event: alert.properties.event || "Weather alert",
              }))
            : null
        }
      />
    </EvidenceCard>
  );
}

export function WeatherWarningList({ alerts }: { alerts: { id: string; event: string }[] | null }) {
  let content;
  if (!alerts) {
    content = <p role="status">Weather warnings unavailable.</p>;
  } else if (!alerts.length) {
    content = <p>No weather warnings match this location.</p>;
  } else {
    content = (
      <ul>
        {alerts.map(({ id, event }) => (
          <li key={id}>
            <strong>{event}:</strong> {weatherWarningMeanings[event] || "Meaning not available."}
          </li>
        ))}
      </ul>
    );
  }
  return <div className="live-weather-alerts">{content}</div>;
}
