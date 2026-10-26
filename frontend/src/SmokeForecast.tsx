import { useEffect, useRef, useState } from "react";
import type { Map as LibreMap, RasterTileSource } from "maplibre-gl";
import { cancelledMapRequest, mapPadding } from "./MapLayers";
import { ReplayBar } from "./WavesSmoke";
import { Icon } from "./Icons";
import { isStackedLayout } from "./layout";
import { useReplayPlayback } from "./useReplayPlayback";

type Forecast = { issuedTime: number; frames: { validTime: number }[] };
const sourceIds = ["smoke-forecast-a", "smoke-forecast-b"] as const;
const regions = [
  { name: "US", bounds: [-190, 17, -65, 72] },
  { name: "Alaska", bounds: [-190, 49, -129, 72] },
  { name: "Hawaii", bounds: [-161, 18, -154, 23] },
];

export function SmokeForecast({
  map,
  active,
  refresh,
  onFrame,
}: {
  map: LibreMap | null;
  active: boolean;
  refresh: number;
  onFrame: (time: number | null) => void;
}) {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [regionIndex, setRegionIndex] = useState(0);
  const [status, setStatus] = useState("Loading…");
  const activeSource = useRef<string | null>(null);
  const { index, setIndex, playing, setPlaying } = useReplayPlayback(
    forecast?.frames,
    status === "Ready",
    1500,
  );
  const frame = forecast?.frames[index];

  function showRegion(bounds: number[]) {
    if (!map) return;
    const padding = mapPadding(map.getContainer());
    const bottom = isStackedLayout(map.getContainer())
      ? padding.bottom
      : Math.max(padding.bottom, 145);
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      {
        padding: { ...padding, bottom },
        duration: 0,
      },
    );
  }

  useEffect(() => {
    if (!active) {
      setPlaying(false);
      onFrame(null);
      return;
    }
    const controller = new AbortController();
    setPlaying(false);
    setStatus("Loading…");
    fetch("/surface-smoke-forecast", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Forecast unavailable");
        const data = (await response.json()) as Forecast;
        if (!data.frames?.length) throw new Error("Forecast unavailable");
        if (!controller.signal.aborted) {
          setForecast(data);
          setIndex(0);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("Current NWS forecast unavailable.");
      });
    return () => controller.abort();
  }, [active, refresh, onFrame]);

  useEffect(() => {
    if (!map) return;
    if (!active || !forecast || !frame) {
      onFrame(null);
      for (const id of sourceIds) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      }
      return;
    }
    setStatus("Loading…");
    const tiles = `/surface-smoke-forecast/tile?time=${frame.validTime}&issued=${forecast.issuedTime}&bbox={bbox-epsg-3857}`;
    let failed = false;
    let cancelled = false;
    const sourceId = sourceIds.find((id) => id !== activeSource.current)!;
    function unavailable() {
      if (cancelled) return;
      failed = true;
      setStatus("Forecast frame unavailable.");
      setPlaying(false);
      if (map!.getLayer(sourceId)) map!.setLayoutProperty(sourceId, "visibility", "none");
    }
    function loaded(event: { sourceId?: string }) {
      if (cancelled || failed || event.sourceId !== sourceId || !map!.isSourceLoaded(sourceId))
        return;
      window.clearTimeout(timeout);
      map!.setLayoutProperty(sourceId, "visibility", "visible");
      map!.setPaintProperty(sourceId, "raster-opacity", 0.85);
      if (activeSource.current && map!.getLayer(activeSource.current))
        map!.setLayoutProperty(activeSource.current, "visibility", "none");
      activeSource.current = sourceId;
      setStatus("Ready");
      onFrame(frame!.validTime);
    }
    const timeout = window.setTimeout(unavailable, 45000);
    const onError = (event: { sourceId?: string; error: { message: string; name?: string } }) => {
      if (event.sourceId === sourceId && !cancelledMapRequest(event.error)) unavailable();
    };
    map.on("sourcedata", loaded);
    map.on("error", onError);
    const source = map.getSource(sourceId) as RasterTileSource | undefined;
    if (source) {
      map.setLayoutProperty(sourceId, "visibility", "visible");
      map.setPaintProperty(sourceId, "raster-opacity", 0);
      source.setTiles([tiles]);
    } else {
      map.addSource(sourceId, {
        type: "raster",
        tiles: [tiles],
        tileSize: 512,
        maxzoom: 9,
      });
      map.addLayer(
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": 0,
            "raster-hue-rotate": 180,
            "raster-saturation": 0.4,
            "raster-fade-duration": 0,
          },
        },
        "fire-fill",
      );
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      map.off("sourcedata", loaded);
      map.off("error", onError);
    };
  }, [map, active, forecast, frame, onFrame]);

  useEffect(
    () => () => {
      for (const id of sourceIds) {
        if (map?.getLayer(id)) map.removeLayer(id);
        if (map?.getSource(id)) map.removeSource(id);
      }
      activeSource.current = null;
    },
    [map],
  );

  if (!active) return null;
  function frameLabel(time: number) {
    return new Date(time).toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "numeric",
    });
  }
  const date = frame ? frameLabel(frame.validTime) : "Unavailable";
  const rangeStart = forecast?.frames[0] ? frameLabel(forecast.frames[0].validTime) : undefined;
  const rangeEnd = forecast?.frames.at(-1)
    ? frameLabel(forecast.frames.at(-1)!.validTime)
    : undefined;
  return (
    <div className="waves-smoke-controls live-forecast-controls">
      <ReplayBar
        label="Smoke forecast replay"
        playLabel="smoke forecast"
        sliderLabel="Smoke forecast hour / UTC"
        date={date}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        suffix={frame ? "UTC" : undefined}
        sublabel="Surface smoke forecast / not AQI"
        index={index}
        count={forecast?.frames.length || 0}
        ticks={[]}
        status={status === "Ready" ? "" : status}
        playing={playing}
        playDisabled={status.includes("unavailable")}
        onPlaying={(play) => {
          if (play && status.includes("unavailable")) return;
          if (play && index === (forecast?.frames.length || 0) - 1) setIndex(0);
          setPlaying(play);
        }}
        onSelect={(selected) => {
          setPlaying(false);
          setIndex(selected);
        }}
        modeSwitch={
          <div className="replay-layer-switch">
            <span className="replay-mode-label" aria-hidden="true">
              {regions[regionIndex].name}
            </span>
            <Icon name="chevron-down" />
            <select
              aria-label="Forecast map region"
              value={regionIndex}
              onChange={(event) => {
                const next = Number(event.target.value);
                setRegionIndex(next);
                showRegion(regions[next].bounds);
              }}
            >
              {regions.map((region, position) => (
                <option key={region.name} value={position}>
                  {region.name}
                </option>
              ))}
            </select>
          </div>
        }
      />
    </div>
  );
}
