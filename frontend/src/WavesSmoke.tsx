import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "./Icons";
import {
  dateTicks,
  hourlyPath,
  shortWaveDate,
  type WavesData,
  type PlumeDay,
  type WaveStation,
} from "./waves";

export type ReplayTick = {
  label: string;
  status: "mapped" | "unknown";
};

export function SmokeLayerSwitch({
  active,
  dailyAvailable,
  goesAvailable,
  hrrrAvailable = false,
  dailyLabel = "Daily",
  onSelect,
}: {
  active: string;
  dailyAvailable: boolean;
  goesAvailable: boolean;
  hrrrAvailable?: boolean;
  dailyLabel?: string;
  onSelect: (layer: string) => void;
}) {
  const selected = active === "hms" && !dailyAvailable ? "" : active;
  let label;
  if (selected === "goes") {
    label = "10-minute";
  } else if (selected === "hrrr") {
    label = "Modeled smoke";
  } else if (selected) {
    label = dailyLabel;
  } else {
    label = "Choose replay";
  }
  return (
    <div className="replay-layer-switch">
      <span className="replay-mode-label" aria-hidden="true">
        {label}
      </span>
      <Icon name="chevron-down" />
      <select
        aria-label="Smoke replay mode"
        value={selected}
        onChange={(event) => onSelect(event.target.value)}
      >
        {!selected && (
          <option value="" disabled>
            Choose replay
          </option>
        )}
        {dailyAvailable && <option value="hms">{dailyLabel}</option>}
        {goesAvailable && <option value="goes">10-minute</option>}
        {hrrrAvailable && <option value="hrrr">Modeled smoke</option>}
      </select>
    </div>
  );
}

export function replayDayLabel(dateUtc: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${dateUtc}T00:00:00Z`));
}

export function replayTickStatus(mapped: boolean | null | undefined): "mapped" | "unknown" {
  return mapped === true ? "mapped" : "unknown";
}

export function ReplayBar({
  children,
  modeSwitch,
  label,
  playLabel,
  sliderLabel,
  sliderValue,
  date,
  rangeStart,
  rangeEnd,
  suffix,
  sublabel,
  index,
  count,
  ticks,
  status,
  playing,
  onPlaying,
  onSelect,
  playDisabled = false,
}: {
  children?: ReactNode;
  modeSwitch?: ReactNode;
  label: string;
  playLabel?: string;
  sliderLabel?: string;
  sliderValue?: string;
  date: string;
  rangeStart?: string;
  rangeEnd?: string;
  suffix?: string;
  sublabel?: string;
  index: number;
  count: number;
  ticks: ReplayTick[];
  status: string;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  onSelect: (index: number) => void;
  playDisabled?: boolean;
}) {
  const [sliderActive, setSliderActive] = useState(false);
  const maximum = Math.max(0, count - 1);
  const progress = maximum ? (index / maximum) * 100 : 0;
  const style = { "--replay-progress": `${progress}%` } as CSSProperties;

  function toggleWithSpace(event: KeyboardEvent<HTMLInputElement>) {
    if (event.code !== "Space") return;
    event.preventDefault();
    onPlaying(!playing);
  }

  return (
    <div className="waves-playback" role="group" aria-label={label}>
      <div className="waves-playback-controls">
        <button
          className="replay-play"
          type="button"
          onClick={() => onPlaying(!playing)}
          aria-label={playing ? `Pause ${playLabel || label}` : `Play ${playLabel || label}`}
          title={playing ? "Pause" : "Play"}
          disabled={count < 2 || playDisabled}
        >
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <div className="waves-playback-date" aria-live="off">
          <span className="replay-date-main">{date}</span>
          {suffix && <span className="replay-date-suffix">{suffix}</span>}
          {sublabel && <small>{sublabel}</small>}
        </div>
        <div className="waves-playback-track" style={style}>
          {rangeStart && (
            <span
              className={`replay-range-label${rangeStart === date ? " is-current-start" : ""}`}
              aria-hidden={rangeStart === date}
            >
              {rangeStart}
            </span>
          )}
          <div className="replay-slider">
            {ticks.length > 0 && (
              <div className="replay-day-ticks" aria-hidden="true">
                {ticks.map((tick, tickIndex) => (
                  <span
                    key={`${tick.label}-${tickIndex}`}
                    data-passed={tickIndex <= index}
                    title={`${tick.label}: ${tick.status === "mapped" ? "mapped over fire" : "none or unknown"}`}
                    style={{ left: `${maximum ? (tickIndex / maximum) * 100 : 0}%` }}
                  />
                ))}
              </div>
            )}
            <div
              className={`replay-tooltip${sliderActive ? " visible" : ""}`}
              style={{ left: `calc(${progress}% + ${8 - progress * 0.16}px)` }}
              aria-hidden="true"
            >
              <span>
                {date}
                {suffix ? ` ${suffix}` : ""}
              </span>
              {ticks[index] && (
                <small>
                  {ticks[index].status === "mapped"
                    ? "Smoke mapped over fire"
                    : "No mapped smoke or unknown"}
                </small>
              )}
            </div>
            <input
              type="range"
              aria-label={sliderLabel || label}
              aria-valuetext={sliderValue || `${date}${suffix ? ` ${suffix}` : ""}`}
              title={
                ticks[index]
                  ? `${date}: ${ticks[index].status === "mapped" ? "Smoke mapped over fire" : "No mapped smoke or unknown"}`
                  : status || date
              }
              min="0"
              max={maximum}
              step="1"
              value={index}
              disabled={count < 2}
              onChange={(event) => onSelect(Number(event.target.value))}
              onKeyDown={toggleWithSpace}
              onFocus={() => setSliderActive(true)}
              onBlur={() => setSliderActive(false)}
              onPointerDown={() => setSliderActive(true)}
              onPointerUp={() => setSliderActive(false)}
            />
          </div>
          {rangeEnd && <span className="replay-range-label">{rangeEnd}</span>}
        </div>
        {status && (
          <small
            className="waves-playback-status"
            role="status"
            aria-live={playing ? "off" : "polite"}
          >
            {status}
          </small>
        )}
        {modeSwitch}
      </div>
      {children}
    </div>
  );
}

export function SmokePlayback({
  days,
  selectedDate,
  onDate,
  coverage,
  status,
  playing,
  onPlaying,
  modeSwitch,
}: {
  days: PlumeDay[];
  selectedDate: string;
  onDate: (date: string) => void;
  coverage: Record<string, boolean | null>;
  status: string;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  modeSwitch?: ReactNode;
}) {
  const index = days.findIndex((day) => day.dateUtc === selectedDate);
  const failed = status.includes("unavailable");
  useEffect(() => {
    if (!playing) return;
    if (index === days.length - 1 || failed) {
      onPlaying(false);
      return;
    }
    if (status === "Loading…") return;
    const timer = window.setTimeout(() => onDate(days[index + 1].dateUtc), 750);
    return () => window.clearTimeout(timer);
  }, [playing, index, days, onDate, status, failed, onPlaying]);
  useEffect(() => {
    function pauseWhenHidden() {
      if (document.hidden) onPlaying(false);
    }
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, [onPlaying]);
  function select(index: number) {
    onPlaying(false);
    onDate(days[index].dateUtc);
  }
  function togglePlayback() {
    if (!playing && index === days.length - 1) onDate(days[0].dateUtc);
    onPlaying(!playing);
  }
  let briefStatus = "Overlap unverified";
  if (status === "Loading…") briefStatus = "Loading…";
  else if (failed) briefStatus = "Unavailable";
  else if (typeof coverage[selectedDate] === "boolean") briefStatus = "";
  const ticks = days.map((day) => ({
    label: day.dateUtc,
    status:
      day.status === "available" ? replayTickStatus(coverage[day.dateUtc]) : ("unknown" as const),
  }));
  return (
    <div className="waves-replay-stack">
      <ReplayBar
        modeSwitch={modeSwitch}
        label="Daily smoke replay"
        playLabel="smoke replay"
        sliderLabel="NOAA smoke day / UTC"
        sliderValue={`${selectedDate} UTC`}
        date={`${replayDayLabel(selectedDate)} UTC`}
        rangeStart={shortWaveDate(days[0].dateUtc)}
        rangeEnd={shortWaveDate(days[days.length - 1].dateUtc)}
        index={index}
        count={days.length}
        ticks={ticks}
        status={briefStatus}
        playing={playing}
        onPlaying={togglePlayback}
        onSelect={select}
      />
    </div>
  );
}

export function UnavailableSmokePlayback({
  modeSwitch,
  status,
  label = "Daily smoke replay",
}: {
  modeSwitch: ReactNode;
  status: string;
  label?: string;
}) {
  return (
    <ReplayBar
      modeSwitch={modeSwitch}
      label={label}
      date="Unavailable"
      index={0}
      count={0}
      ticks={[]}
      status={status}
      playing={false}
      onPlaying={() => {}}
      onSelect={() => {}}
    />
  );
}

export function SmokeMeasurements({
  data,
  selectedDate,
  selectedTime,
}: {
  data: Pick<WavesData, "smoke">;
  selectedDate?: string;
  selectedTime?: string | null;
}) {
  const { aqiReference } = data.smoke;
  const stations = data.smoke.stations.slice(0, 1);
  const chart = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    if (!chart.current) return;

    const initialWidth = Math.round(chart.current.getBoundingClientRect().width);
    if (initialWidth > 0) setWidth(initialWidth);
    const observer = new ResizeObserver(([entry]) => {
      const displayWidth = Math.round(entry.contentRect.width);
      if (displayWidth > 0) setWidth(displayWidth);
    });
    observer.observe(chart.current);
    return () => observer.disconnect();
  }, []);
  const height = 194,
    left = 38,
    right = 12,
    top = 18,
    bottom = 44;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  let maximum = aqiReference.bands[aqiReference.bands.length - 1].high;
  let minimum = 0;
  for (const station of stations) {
    for (const row of station.series) {
      if (row.value !== null) {
        maximum = Math.max(maximum, row.value);
        minimum = Math.min(minimum, row.value);
      }
    }
  }
  if (minimum < 0) minimum = Math.floor(minimum / 10) * 10;
  let maximumPhase = 0;
  for (const station of stations)
    maximumPhase = Math.max(maximumPhase, (station.sampleOffsetSeconds ?? 0) / 3600);
  const x = (index: number) =>
    left + (plotWidth * index) / (stations[0].series.length - 1 + maximumPhase);
  const sourceX = (station: WaveStation, index: number) =>
    x(index + (station.sampleOffsetSeconds ?? 0) / 3600);
  const y = (value: number) => top + (plotHeight * (maximum - value)) / (maximum - minimum);
  let peak: { value: number; index: number } | null = null;
  for (let index = 0; index < stations[0].series.length; index++) {
    const value = stations[0].series[index].value;
    if (value !== null && (!peak || value > peak.value)) peak = { value, index };
  }
  const threshold = stations[0].thresholdUgM3;
  let markerTime = selectedTime || null;
  if (!markerTime && selectedDate) markerTime = `${selectedDate}T12:00:00Z`;
  let markerX: number | null = null;
  if (markerTime && stations[0].series.length > 0) {
    const start = Date.parse(stations[0].series[0].timestamp);
    const marker = Date.parse(markerTime);
    const markerHour = (marker - start) / 3600000;
    const finalHour = stations[0].series.length - 1 + maximumPhase;
    if (Number.isFinite(markerHour) && markerHour >= 0 && markerHour <= finalHour)
      markerX = x(markerHour);
  }
  return (
    <>
      <div className="pm-series-key">
        {stations.map((station, index) => {
          let lineStyle: CSSProperties["borderTopStyle"];
          if (index === 0) {
            lineStyle = "solid";
          } else if (index === 1) {
            lineStyle = "dashed";
          } else {
            lineStyle = "dotted";
          }
          return (
            <span key={station.id}>
              <i
                style={{
                  borderColor: station.color,
                  borderTopStyle: lineStyle,
                }}
              />
              {station.name}
            </span>
          );
        })}
      </div>
      <svg
        ref={chart}
        className="waves-pm-chart"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Hourly PM2.5, ${data.smoke.window.start} to ${data.smoke.window.end}, ${data.smoke.timezone}. Missing hours break the lines.`}
      >
        <text x={left} y="12">
          µg/m³
        </text>
        {aqiReference.bands.map((band) => (
          <rect
            key={band.name}
            x={left}
            y={y(band.high)}
            width={plotWidth}
            height={y(band.low) - y(band.high)}
            fill={band.color}
            opacity="0.05"
          />
        ))}
        {[0, 100, 200, 300].map((value) => (
          <g key={value}>
            <line
              x1={left}
              x2={width - right}
              y1={y(value)}
              y2={y(value)}
              stroke="#7b8980"
              opacity="0.3"
            />
            <text x={left - 5} y={y(value) + 4} textAnchor="end">
              {value}
            </text>
          </g>
        ))}
        {[...stations].reverse().map((station) => {
          let dashPattern;
          if (station.id === stations[1]?.id) {
            dashPattern = "6 3";
          } else if (station.id === stations[2]?.id) {
            dashPattern = "2 3";
          } else {
            dashPattern = undefined;
          }
          return (
            <path
              key={station.id}
              data-station={station.id}
              d={hourlyPath(station.series, (index) => sourceX(station, index), y)}
              fill="none"
              stroke={station.color}
              strokeWidth={station.id === stations[0].id ? 2 : 1.2}
              strokeDasharray={dashPattern}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {threshold !== null && (
          <g className="pm-annotation">
            <line
              x1={left}
              x2={width - right}
              y1={y(threshold)}
              y2={y(threshold)}
              stroke="var(--smoke-accent)"
              strokeDasharray="4 3"
            />
            <text x={width - right - 4} y={y(threshold) - 5} textAnchor="end">
              Typical reference {threshold.toFixed(2)} µg/m³
            </text>
          </g>
        )}
        {markerX !== null && (
          <line
            className="replay-chart-marker"
            x1={markerX}
            x2={markerX}
            y1={top}
            y2={top + plotHeight}
            stroke="var(--accent)"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            aria-hidden="true"
          />
        )}
        {peak && (
          <g className="pm-annotation">
            <circle
              cx={sourceX(stations[0], peak.index)}
              cy={y(peak.value)}
              r="3"
              fill={stations[0].color}
            />
            <text
              x={
                sourceX(stations[0], peak.index) +
                (peak.index < stations[0].series.length / 2 ? 7 : -7)
              }
              y={Math.max(top + 12, y(peak.value) - 7)}
              textAnchor={peak.index < stations[0].series.length / 2 ? "start" : "end"}
            >
              Peak {peak.value} µg/m³
            </text>
          </g>
        )}
        {dateTicks(stations[0].dailyMeans.length).map((index) => (
          <text
            key={index}
            x={x(index * 24)}
            y={height - bottom + 17}
            textAnchor={index === 0 ? "start" : "middle"}
          >
            {shortWaveDate(stations[0].dailyMeans[index].date)}
          </text>
        ))}
      </svg>
    </>
  );
}
