import { useEffect, useState, type ReactNode } from "react";
import type { Map, ImageSource } from "maplibre-gl";
import { mapPadding } from "./MapLayers";
import type { GoesProduct, HrrrProduct } from "./waves";
import { ReplayBar, replayTickStatus } from "./WavesSmoke";
import { useReplayPlayback } from "./useReplayPlayback";

type Counts = { pixels: number; usable: number; smoke: number };
type Frame = {
  slot: string;
  status: "available" | "unavailable";
  reason?: string | null;
  image?: string;
  start?: string;
  end?: string;
  publishedAt?: string;
  retrievedAt?: string;
  sourceUrl?: string;
  coverage?: Record<string, Counts>;
  initializationTime?: string;
  forecastLeadHours?: number;
};
type Replay = {
  caseId: string;
  bounds: [number, number, number, number];
  resolution: string;
  window: string;
  guideUrl: string;
  processing: string;
  interpretation?: string;
  frames: Frame[];
  scale?: { unit: string; stops: number[]; colors: string[] };
  limitations?: string;
  initialValidTime?: string;
};
export type HrrrScale = NonNullable<Replay["scale"]>;

export function HrrrScaleLegend({ scale }: { scale: HrrrScale }) {
  const maximum = scale.stops.at(-1) || 1;
  const colors = scale.colors.map(
    (color, index) => `${color} ${(scale.stops[index] / maximum) * 100}%`,
  );
  const ticks = [0, maximum / 4, maximum / 2, maximum];
  return (
    <div
      className="hrrr-ramp"
      role="img"
      aria-label={`Modeled smoke concentration, ${scale.stops.join(", ")} or more ${scale.unit}`}
    >
      <small>Smoke concentration ({scale.unit})</small>
      <div style={{ background: `linear-gradient(to right, ${colors.join(", ")})` }} />
      <div>
        {ticks.map((tick, index) => (
          <span key={tick} style={{ left: `${(tick / maximum) * 100}%` }}>
            {Math.round(tick)}
            {index === ticks.length - 1 ? "+" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export function readHrrr(value: unknown, product: HrrrProduct & { caseId: string }): Replay {
  const data = value as {
    caseId: string;
    dataClass: string;
    bounds: number[];
    cadenceMinutes: number;
    forecastLeadHours: number;
    scale: Replay["scale"];
    guideUrl: string;
    processing: string;
    limitations: string;
    initialValidTime?: string;
    frames: (Frame & { validTime: string })[];
  };
  const folder = product.manifest.slice(0, product.manifest.lastIndexOf("/") + 1);
  if (
    data?.caseId !== (product.sourceCaseId || product.caseId) ||
    data.dataClass !== "Historical" ||
    !folder.startsWith("/data/") ||
    data.forecastLeadHours !== product.forecastLeadHours ||
    data.cadenceMinutes !== 60 ||
    !Number.isInteger(product.forecastLeadHours) ||
    product.forecastLeadHours <= 0 ||
    data.bounds?.length !== 4 ||
    !data.bounds.every(Number.isFinite) ||
    data.bounds[0] >= data.bounds[2] ||
    data.bounds[1] >= data.bounds[3] ||
    data.scale?.unit !== "µg/m³" ||
    data.scale.stops[0] !== 0 ||
    data.scale.stops.length < 2 ||
    data.scale.stops.length !== data.scale.colors.length ||
    !Array.isArray(data.frames) ||
    !data.frames.length
  )
    throw new Error("Modeled smoke unavailable");
  for (let index = 0; index < data.scale.stops.length; index++) {
    if (
      !Number.isFinite(data.scale.stops[index]) ||
      !/^#[0-9a-f]{6}$/i.test(data.scale.colors[index]) ||
      (index > 0 && data.scale.stops[index] <= data.scale.stops[index - 1])
    )
      throw new Error("Invalid modeled smoke scale");
  }
  const frames: Frame[] = [];
  for (const original of data.frames) {
    const valid = Date.parse(original.validTime);
    if (
      !Number.isFinite(valid) ||
      valid % 3600000 !== 0 ||
      !["available", "unavailable"].includes(original.status) ||
      (frames.length > 0 && valid - Date.parse(frames[frames.length - 1].slot) !== 3600000)
    )
      throw new Error("Invalid modeled smoke hour");
    if (
      original.status === "available" &&
      (!original.image?.startsWith(folder) ||
        original.image.includes("..") ||
        original.forecastLeadHours !== product.forecastLeadHours ||
        Date.parse(original.initializationTime || "") + product.forecastLeadHours * 3600000 !==
          valid)
    )
      throw new Error("Unverified modeled smoke frame");
    frames.push({
      ...original,
      slot: original.validTime,
      start: original.validTime,
    });
  }
  return {
    ...data,
    bounds: data.bounds as Replay["bounds"],
    frames,
    resolution: "3 km model grid",
    window: "Hourly valid times / Pacific",
    scale: data.scale,
  };
}

export function readGoes(value: unknown, product: GoesProduct & { caseId: string }): Replay {
  const data = value as Replay;
  const folder = product.manifest.slice(0, product.manifest.lastIndexOf("/") + 1);
  if (
    data?.caseId !== product.caseId ||
    !folder.startsWith("/data/") ||
    !product.coverageKey ||
    !Number.isFinite(product.cadenceMinutes) ||
    product.cadenceMinutes <= 0 ||
    data.bounds?.length !== 4 ||
    !data.bounds.every(Number.isFinite) ||
    !Array.isArray(data.frames) ||
    !data.frames.length
  )
    throw new Error("GOES replay unavailable");
  for (let index = 0; index < data.frames.length; index++) {
    const frame = data.frames[index];
    if (
      !Number.isFinite(Date.parse(frame.slot)) ||
      !["available", "unavailable"].includes(frame.status)
    )
      throw new Error("GOES frame unavailable");
    if (
      index > 0 &&
      Date.parse(frame.slot) - Date.parse(data.frames[index - 1].slot) !==
        product.cadenceMinutes * 60000
    )
      throw new Error("Missing GOES slot");
    if (
      frame.status === "available" &&
      (!frame.image?.startsWith(folder) ||
        frame.image.includes("..") ||
        !frame.start ||
        !frame.end ||
        !frame.coverage)
    )
      throw new Error("Incomplete GOES frame");
  }
  return data;
}

function localTime(value: string, timezone: string) {
  return new Date(value).toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function dateInZone(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")!.value;
  const month = parts.find((part) => part.type === "month")!.value;
  const day = parts.find((part) => part.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

export function WavesGoes({
  map,
  product,
  modeSwitch,
  onFrameTime,
  onDetails,
}: {
  map: Map | null;
  product: GoesProduct & { caseId: string };
  modeSwitch?: ReactNode;
  onFrameTime?: (time: string | null) => void;
  onDetails?: (details: ReactNode | null) => void;
}) {
  return (
    <SmokeRasterReplay
      map={map}
      product={product}
      kind="goes"
      modeSwitch={modeSwitch}
      onFrameTime={onFrameTime}
      onDetails={onDetails}
    />
  );
}

export function WavesHrrr({
  map,
  product,
  modeSwitch,
  startDate,
  onScale,
}: {
  map: Map | null;
  product: HrrrProduct & { caseId: string };
  modeSwitch?: ReactNode;
  startDate: string;
  onScale: (scale: HrrrScale | null) => void;
}) {
  return (
    <SmokeRasterReplay
      map={map}
      product={product}
      kind="hrrr"
      modeSwitch={modeSwitch}
      startDate={startDate}
      onScale={onScale}
    />
  );
}

function SmokeRasterReplay({
  map,
  product,
  kind,
  modeSwitch,
  onFrameTime,
  onDetails,
  startDate,
  onScale,
}: {
  map: Map | null;
  product: (GoesProduct | HrrrProduct) & { caseId: string };
  kind: "goes" | "hrrr";
  modeSwitch?: ReactNode;
  onFrameTime?: (time: string | null) => void;
  onDetails?: (details: ReactNode | null) => void;
  startDate?: string;
  onScale?: (scale: HrrrScale | null) => void;
}) {
  const modeled = kind === "hrrr";
  const name = modeled ? "HRRR" : "GOES";
  const layerId = modeled ? "hrrr-smoke" : "goes-smoke";
  const cadenceMinutes = modeled ? 60 : (product as GoesProduct).cadenceMinutes;
  const [data, setData] = useState<Replay | null>(null);
  const [status, setStatus] = useState("Loading…");
  const { index, setIndex, playing, setPlaying } = useReplayPlayback(
    data?.frames,
    status === "Ready",
    500,
  );
  const frame = data?.frames[index];
  useEffect(() => {
    const controller = new AbortController();
    if (modeled) onScale?.(null);
    async function load() {
      try {
        const response = await fetch(product.manifest, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unavailable");
        const value = await response.json();
        const replay = modeled
          ? readHrrr(value, product as HrrrProduct & { caseId: string })
          : readGoes(value, product as GoesProduct & { caseId: string });
        if (!controller.signal.aborted) {
          if (modeled) onScale?.(replay.scale || null);
          if (modeled && startDate) {
            setData({
              ...replay,
              frames: replay.frames.filter(
                (frame) => dateInZone(frame.slot, product.timezone) >= startDate,
              ),
            });
            setIndex(0);
          } else {
            setData(replay);
          }
          if (modeled && !startDate && replay.initialValidTime) {
            const initial = replay.frames.findIndex(
              (frame) => Date.parse(frame.slot) === Date.parse(replay.initialValidTime!),
            );
            setIndex(Math.max(0, initial));
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          if (modeled) onScale?.(null);
          setStatus(name + " replay unavailable");
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [product.manifest, product.caseId, modeled, name, startDate, onScale]);
  useEffect(() => {
    if (!map || !data || !frame) return;
    setStatus("Loading…");
    if (frame.status !== "available" || !frame.image) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
      onFrameTime?.(null);
      setStatus("Frame unavailable / " + (frame.reason || "missing source"));
      setPlaying(false);
      return;
    }
    const image = new Image();
    image.onload = () => {
      const [west, south, east, north] = data.bounds;
      const coordinates: [[number, number], [number, number], [number, number], [number, number]] =
        [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ];
      const hasLayer = map.getLayer(layerId);
      if (!map.getSource(layerId)) {
        map.addSource(layerId, { type: "image", coordinates });
      }
      if (!hasLayer) {
        map.addLayer(
          {
            id: layerId,
            type: "raster",
            source: layerId,
            paint: {
              "raster-opacity": 0,
              "raster-opacity-transition": {
                duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150,
                delay: 0,
              },
              "raster-fade-duration": 0,
              "raster-resampling": "nearest",
            },
          },
          "perimeter",
        );
      }
      let displayImage: HTMLImageElement | HTMLCanvasElement = image;
      if (modeled) {
        (map.getSource(layerId) as ImageSource).updateImage({
          image: displayImage,
          coordinates,
        });
      } else {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const haze = getComputedStyle(map.getContainer())
          .getPropertyValue("--smoke-haze-heavy")
          .trim();
        const red = parseInt(haze.slice(1, 3), 16);
        const green = parseInt(haze.slice(3, 5), 16);
        const blue = parseInt(haze.slice(5, 7), 16);
        for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
          if (
            pixels.data[pixel] === 112 &&
            pixels.data[pixel + 1] === 67 &&
            pixels.data[pixel + 2] === 165
          ) {
            pixels.data[pixel] = red;
            pixels.data[pixel + 1] = green;
            pixels.data[pixel + 2] = blue;
          }
        }
        context.putImageData(pixels, 0, 0);
        displayImage = canvas;
        (map.getSource(layerId) as ImageSource).updateImage({
          image: displayImage,
          coordinates,
        });
      }
      map.setLayoutProperty(layerId, "visibility", "visible");
      map.setPaintProperty(layerId, "raster-opacity", 1);
      onFrameTime?.(frame!.start || frame!.slot);
      setStatus("Ready");
    };
    image.onerror = () => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
      onFrameTime?.(null);
      setStatus("Frame unavailable / image could not load");
      setPlaying(false);
    };
    image.src = frame.image;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [map, data, frame, modeled, layerId, onFrameTime]);
  useEffect(() => {
    if (!map || !data) return;
    const [west, south, east, north] = data.bounds;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: mapPadding(map.getContainer()), duration: 0, maxZoom: 11 },
    );
  }, [map, data]);
  useEffect(
    () => () => {
      if (map?.getLayer(layerId)) map.removeLayer(layerId);
      if (map?.getSource(layerId)) map.removeSource(layerId);
    },
    [map, layerId],
  );
  function select(next: number) {
    setPlaying(false);
    setIndex(next);
  }
  function toggle() {
    if (!data) return;
    if (index === data.frames.length - 1) setIndex(0);
    setPlaying(!playing);
  }
  let summary = status;
  let counts: Counts | undefined;
  if (!modeled && status === "Ready" && frame?.coverage) {
    counts = frame.coverage[(product as GoesProduct).coverageKey];
    if (!counts) summary = "Fire-footprint coverage unavailable";
    else if (counts.usable === 0) summary = "Unknown";
    else summary = "";
  }
  const date = frame ? localTime(frame.start || frame.slot, product.timezone) : "Unavailable";
  let sublabel;
  if (frame) {
    sublabel = `${new Date(frame.start || frame.slot).toLocaleDateString("en-US", {
      timeZone: product.timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
    })}${modeled ? "" : " / Historical"}`;
  } else {
    sublabel = undefined;
  }
  const firstFrame = data?.frames[0];
  const lastFrame = data?.frames.at(-1);
  const tickFrames = modeled ? [] : data?.frames || [];
  const ticks = tickFrames.map((item) => {
    const itemCounts = item.coverage?.[(product as GoesProduct).coverageKey];
    const hasObservation = item.status === "available" && !!itemCounts && itemCounts.usable > 0;
    return {
      label: localTime(item.start || item.slot, product.timezone),
      status: hasObservation ? replayTickStatus(itemCounts!.smoke > 0) : ("unknown" as const),
    };
  });
  const goesDetails = (
    <details className="goes-details">
      <summary>GOES data</summary>
      {counts && (
        <p>
          {counts.usable}/{counts.pixels} pixels usable; {counts.smoke} smoke detections.
        </p>
      )}
      {data && (
        <>
          <p>
            {data.window} / {data.resolution} / {cadenceMinutes}-minute scans
          </p>
          <a href={data.guideUrl}>NOAA product guide</a>
        </>
      )}
      {frame?.sourceUrl && (
        <>
          <p>
            Measurement: {frame.start} to {frame.end}
            <br />
            Published: {frame.publishedAt}
            <br />
            Retrieved: {frame.retrievedAt}
          </p>
          <a href={frame.sourceUrl}>Original NOAA NetCDF</a>
        </>
      )}
    </details>
  );
  useEffect(() => {
    if (modeled || !onDetails) return;
    onDetails(data ? goesDetails : null);
    return () => onDetails(null);
  }, [modeled, onDetails, data, frame, counts]);
  return (
    <div className="waves-replay-stack">
      <ReplayBar
        modeSwitch={modeSwitch}
        label={`${name} ${cadenceMinutes}-minute replay`}
        playLabel={`${name} replay`}
        sliderLabel={`${name} historical frame`}
        sliderValue={sublabel ? `${sublabel} / ${date}` : date}
        date={date}
        rangeStart={
          firstFrame ? localTime(firstFrame.start || firstFrame.slot, product.timezone) : undefined
        }
        rangeEnd={
          lastFrame ? localTime(lastFrame.start || lastFrame.slot, product.timezone) : undefined
        }
        sublabel={sublabel}
        index={index}
        count={data?.frames.length || 0}
        ticks={ticks}
        status={modeled && status === "Ready" ? "" : summary}
        playing={playing}
        onPlaying={toggle}
        onSelect={select}
        playDisabled={!data || status.includes("unavailable")}
      ></ReplayBar>
      {!modeled && !onDetails && goesDetails}
    </div>
  );
}
