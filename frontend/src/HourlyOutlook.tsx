import { useEffect, useState } from "react";
import { EvidenceCard, LoadingBars } from "./EvidenceCard";
import { windCompass, windMph } from "./wavesLive";

type GridValue = { validTime: string; value: number | null };
type GridField = { uom: string; values: GridValue[] };
type GridForecast = {
  properties: {
    updateTime: string;
    temperature: GridField;
    relativeHumidity: GridField;
    windDirection: GridField;
    windSpeed: GridField;
    windGust: GridField;
  };
};
type Hour = {
  time: number;
  temperature: number | null;
  humidity: number | null;
  wind: string | null;
  gust: number | null;
};
type Outlook = { hours: Hour[]; source: string; updated: string; retrieved: string };

function interval(value: string) {
  const match = value.match(/^([^/]+)\/(?:PT(\d+)H|P(\d+)D)$/);
  if (!match) return null;
  const start = Date.parse(match[1]);
  const duration = Number(match[2] || 0) * 3600000 + Number(match[3] || 0) * 86400000;
  return Number.isFinite(start) && duration > 0 ? { start, end: start + duration } : null;
}

function at(field: GridField | undefined, time: number, unit: string | undefined) {
  if (!field || field.uom !== unit || !Array.isArray(field.values)) return null;
  for (const entry of field.values) {
    const span = interval(entry.validTime);
    if (span && span.start <= time && time < span.end)
      return typeof entry.value === "number" && Number.isFinite(entry.value) ? entry.value : null;
  }
  return null;
}

function timeLabel(time: number) {
  const date = new Date(time);
  const options = { timeZone: "America/Los_Angeles" } as const;
  const hour = date.toLocaleTimeString("en-US", { ...options, hour: "numeric" });
  const day = date.toLocaleDateString("en-US", { ...options, month: "numeric", day: "numeric" });
  return `${day}, ${hour}`;
}

export function readGridHours(data: GridForecast, now: number): Hour[] {
  const fields = data.properties;
  const halfDay = 12 * 3600000;
  const first = Math.ceil(now / halfDay) * halfDay;
  return [first, first + halfDay, first + 2 * halfDay].map((time) => {
    const celsius = at(fields.temperature, time, "wmoUnit:degC");
    const humidity = at(fields.relativeHumidity, time, "wmoUnit:percent");
    const bearing = at(fields.windDirection, time, "wmoUnit:degree_(angle)");
    const speed = windMph(at(fields.windSpeed, time, fields.windSpeed?.uom), fields.windSpeed?.uom);
    const gust = windMph(at(fields.windGust, time, fields.windGust?.uom), fields.windGust?.uom);
    const direction = bearing === null ? null : windCompass(bearing);
    return {
      time,
      temperature: celsius === null ? null : Math.round((celsius * 9) / 5 + 32),
      humidity: humidity === null || humidity < 0 || humidity > 100 ? null : Math.round(humidity),
      wind: speed === null ? null : `${direction ? `${direction} ` : ""}${Math.round(speed)} mph`,
      gust: gust === null ? null : Math.round(gust),
    };
  });
}

export function HourlyOutlook({
  latitude,
  longitude,
  label,
  refresh,
  embedded = false,
}: {
  latitude: number;
  longitude: number;
  label: string;
  refresh: number;
  embedded?: boolean;
}) {
  const [outlook, setOutlook] = useState<Outlook | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setOutlook(null);
    setLoading(true);
    async function load() {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
        const pointResponse = await fetch(
          `https://api.weather.gov/points/${latitude},${longitude}`,
          { signal },
        );
        if (!pointResponse.ok) throw new Error("NWS point unavailable");
        const point = await pointResponse.json();
        const url = point.properties?.forecastGridData;
        if (typeof url !== "string" || !url.startsWith("https://api.weather.gov/gridpoints/"))
          throw new Error("NWS grid unavailable");
        const gridResponse = await fetch(url, { signal });
        if (!gridResponse.ok) throw new Error("NWS forecast unavailable");
        const grid: GridForecast = await gridResponse.json();
        const updated = grid.properties?.updateTime;
        if (
          !updated ||
          !Number.isFinite(Date.parse(updated)) ||
          Date.now() - Date.parse(updated) > 12 * 3600000
        )
          throw new Error("NWS forecast is stale");
        const hours = readGridHours(grid, Date.now());
        if (
          !hours.some(
            (hour) => hour.temperature !== null || hour.humidity !== null || hour.wind !== null,
          )
        )
          throw new Error("NWS forecast has no current values");
        if (!controller.signal.aborted)
          setOutlook({ hours, source: url, updated, retrieved: new Date().toISOString() });
      } catch {
        if (!controller.signal.aborted) setOutlook(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [latitude, longitude, refresh]);

  let forecast;
  if (outlook) {
    forecast = (
      <div className="live-hourly-strip">
        {outlook.hours.map((hour) => (
          <div key={hour.time}>
            <strong>{timeLabel(hour.time)}</strong>
            <span>{hour.temperature === null ? "-" : `${hour.temperature}°F`}</span>
            <small>{hour.wind ? `Wind ${hour.wind}` : "Wind -"}</small>
            {hour.gust !== null && <small>Gust {hour.gust} mph</small>}
            <small>Humidity {hour.humidity === null ? "-" : `${hour.humidity}%`}</small>
          </div>
        ))}
      </div>
    );
  } else {
    forecast = (
      <p className="quiet-failure" role="status">
        Hourly forecast unavailable.
      </p>
    );
  }

  if (embedded) {
    return (
      <section className="live-hourly-embedded" aria-label={`Weather forecast ${label}`}>
        <h4>Weather ahead</h4>
        {loading ? (
          <LoadingBars className="compact-loading" label="Loading weather forecast" />
        ) : (
          forecast
        )}
      </section>
    );
  }

  return (
    <EvidenceCard
      title="Weather ahead"
      accessibleName={`Weather forecast ${label}`}
      icon="weather"
      kind="Forecast"
      className="live-card live-hourly"
      source={
        <a href={outlook?.source || "https://www.weather.gov/documentation/services-web-api"}>
          NWS
        </a>
      }
      data={!!outlook}
      loading={loading}
    >
      {forecast}
    </EvidenceCard>
  );
}
