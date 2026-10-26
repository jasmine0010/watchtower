import { useEffect, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import { iconPaths } from "./Icons";
import { emptyFeatures } from "./wavesLive";

export const cameraViewer = "https://cameras.alertcalifornia.org/";
export const cameraQuery =
  "https://services8.arcgis.com/X84q166Srnyl4JMV/arcgis/rest/services/ALERTCalifornia_Camera_Feed/FeatureServer/0/query?" +
  new URLSearchParams({
    where: "isActive='active' AND isOnline='online'",
    outFields: "OBJECTID,cameraName,isActive,isOnline,imageURL,cameraURL",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",

    resultType: "standard",
    resultRecordCount: "16000",
  });
type CameraProperties = { cameraName: string; imageURL: string; cameraURL: string };
type Cameras = FeatureCollection<Point, CameraProperties>;

export function readCameras(value: unknown): Cameras {
  const source = value as FeatureCollection & {
    properties?: { exceededTransferLimit?: boolean };
    exceededTransferLimit?: boolean;
  };
  if (
    source?.type !== "FeatureCollection" ||
    !Array.isArray(source.features) ||
    source.exceededTransferLimit ||
    source.properties?.exceededTransferLimit
  )
    throw new Error("Live feed locations unavailable or incomplete");
  const features = source.features.filter((feature) => {
    const p = feature.properties;
    return (
      feature.geometry?.type === "Point" &&
      feature.geometry.coordinates.length >= 2 &&
      feature.geometry.coordinates.every(Number.isFinite) &&
      Math.abs(feature.geometry.coordinates[0]) <= 180 &&
      Math.abs(feature.geometry.coordinates[1]) <= 90 &&
      p?.isActive === "active" &&
      p.isOnline === "online" &&
      typeof p.cameraName === "string" &&
      p.cameraName.trim() &&
      typeof p.imageURL === "string" &&
      p.imageURL.startsWith(cameraViewer + "public-camera-data/") &&
      typeof p.cameraURL === "string" &&
      p.cameraURL.startsWith(cameraViewer + "?id=")
    );
  });
  return { type: "FeatureCollection", features } as Cameras;
}

export function cameraPreviewZooms(cameras: Cameras) {
  const locations = cameras.features
    .map((camera) => ({
      url: camera.properties.cameraURL,
      point: maplibregl.MercatorCoordinate.fromLngLat(
        camera.geometry.coordinates as [number, number],
      ),
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
  const selected: typeof locations = [];
  const minimumZooms = new Map<string, number>();

  for (let zoom = 6; zoom <= 22; zoom++) {
    const spacing = 80 / (512 * 2 ** zoom);
    for (const location of locations) {
      if (minimumZooms.has(location.url)) continue;
      if (
        selected.some(
          (other) =>
            Math.hypot(other.point.x - location.point.x, other.point.y - location.point.y) <
            spacing,
        )
      )
        continue;
      selected.push(location);
      minimumZooms.set(location.url, zoom);
    }
  }
  return minimumZooms;
}

export function CameraLayer({
  map,
  visible,
  refresh,
  onCount,
}: {
  map: maplibregl.Map | null;
  visible: boolean;
  refresh: number;
  onCount: (count: number | null) => void;
}) {
  const [cameras, setCameras] = useState<Cameras | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    async function load() {
      try {
        const response = await fetch(cameraQuery, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          cache: "no-store",
          credentials: "omit",
        });
        if (!response.ok) throw new Error("Fire cameras unavailable");
        const data = readCameras(await response.json());
        if (!controller.signal.aborted) {
          setCameras(data);
          onCount(data.features.length);
        }
      } catch {
        if (!controller.signal.aborted) {
          setCameras(null);
          onCount(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [refresh, onCount]);

  useEffect(() => {
    if (!map) return;
    if (!map.getSource("camera-points")) {
      map.addSource("camera-points", { type: "geojson", data: emptyFeatures });
      map.addLayer({
        id: "camera-points",
        type: "circle",
        source: "camera-points",
        paint: {
          "circle-radius": 3,
          "circle-color": getComputedStyle(map.getContainer())
            .getPropertyValue("--live-feed")
            .trim(),
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1,
        },
      });
    }
    (map.getSource("camera-points") as maplibregl.GeoJSONSource).setData(cameras || emptyFeatures);
    map.setLayoutProperty("camera-points", "visibility", visible ? "visible" : "none");
    if (!visible || !cameras) return;
    const previewZooms = cameraPreviewZooms(cameras);
    const markers = new Map<string, maplibregl.Marker>();
    const popup = new maplibregl.Popup({
      maxWidth: "320px",
      closeButton: false,
      closeOnClick: false,
      focusAfterOpen: false,
    });
    let expandedImage: HTMLImageElement | null = null;
    let fullImageDialog: HTMLDialogElement | null = null;
    function image(p: CameraProperties) {
      const img = document.createElement("img");
      img.hidden = true;
      img.alt = `${p.cameraName} live feed preview`;
      img.referrerPolicy = "no-referrer";
      img.dataset.imageUrl = p.imageURL;
      img.src = p.imageURL + "?t=" + Math.floor(Date.now() / 30000);
      img.onerror = () => {
        img.hidden = true;
      };
      img.onload = () => {
        img.hidden = false;
      };
      return img;
    }
    function showFullImage(p: CameraProperties, preview: HTMLImageElement) {
      fullImageDialog?.close();
      const dialog = document.createElement("dialog");
      dialog.className = "live-camera-fullscreen";
      dialog.setAttribute("aria-label", `${p.cameraName} image`);
      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", "Close image");
      const closeIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      closeIcon.setAttribute("viewBox", "0 0 24 24");
      closeIcon.setAttribute("aria-hidden", "true");
      const closePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      closePath.setAttribute("d", iconPaths.close);
      closeIcon.append(closePath);
      close.append(closeIcon);
      close.addEventListener("click", () => dialog.close());
      const fullImage = document.createElement("img");
      fullImage.src = preview.src;
      fullImage.alt = `${p.cameraName} live feed image`;
      fullImage.referrerPolicy = "no-referrer";
      dialog.append(close, fullImage);
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (fullImageDialog === dialog) fullImageDialog = null;
      });
      document.body.append(dialog);
      dialog.showModal();
      fullImageDialog = dialog;
      close.focus();
    }
    function open(camera: Cameras["features"][number]) {
      const p = camera.properties;
      const content = document.createElement("section");
      content.className = "map-popup map-popup-camera";
      const title = document.createElement("h3");
      title.textContent = p.cameraName;
      expandedImage = image(p);
      const enlarge = document.createElement("button");
      enlarge.type = "button";
      enlarge.className = "live-camera-enlarge";
      enlarge.setAttribute("aria-label", `View ${p.cameraName} image full screen`);
      enlarge.disabled = true;
      expandedImage.addEventListener("load", () => {
        enlarge.disabled = false;
      });
      expandedImage.addEventListener("error", () => {
        enlarge.disabled = true;
      });
      if (expandedImage.complete && expandedImage.naturalWidth) enlarge.disabled = false;
      enlarge.append(expandedImage);
      enlarge.addEventListener("click", (event) => {
        event.stopPropagation();
        showFullImage(p, expandedImage!);
      });
      const note = document.createElement("p");
      note.textContent = "Latest available image.";
      const link = document.createElement("a");
      link.href = p.cameraURL;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "ALERTCalifornia / UC San Diego";
      const source = document.createElement("p");
      source.className = "map-popup-source";
      source.append("Source: ", link);
      const unavailable = document.createElement("p");
      unavailable.className = "live-camera-image-error";
      unavailable.textContent = "Loading preview…";
      expandedImage.addEventListener("error", () => {
        unavailable.textContent = "Preview unavailable. Open the live feed viewer below.";
      });
      content.append(title, enlarge, unavailable, note, source);
      popup
        .setLngLat(camera.geometry.coordinates as [number, number])
        .setDOMContent(content)
        .addTo(map!);
    }
    function previews() {
      const zoom = map!.getZoom();
      const width = map!.getContainer().clientWidth;
      const height = map!.getContainer().clientHeight;
      const inView = new Set<string>();
      for (const camera of cameras!.features) {
        const url = camera.properties.cameraURL;
        const minimumZoom = previewZooms.get(url);
        if (minimumZoom === undefined || zoom < minimumZoom) continue;
        const point = map!.project(camera.geometry.coordinates as [number, number]);

        if (point.x + 22 < 0 || point.x - 22 > width || point.y + 22 < 0 || point.y - 22 > height)
          continue;
        inView.add(url);
        if (markers.has(url)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "live-camera-preview";
        button.setAttribute("aria-label", `Open live feed: ${camera.properties.cameraName}`);
        button.title = camera.properties.cameraName;
        button.textContent = "◉";
        button.append(image(camera.properties));
        button.addEventListener("click", () => open(camera));
        markers.set(
          camera.properties.cameraURL,
          new maplibregl.Marker({ element: button, subpixelPositioning: true })
            .setLngLat(camera.geometry.coordinates as [number, number])
            .addTo(map!),
        );
      }
      for (const [url, marker] of markers) {
        if (inView.has(url)) continue;
        marker.remove();
        markers.delete(url);
      }
    }
    function inspect(event: maplibregl.MapLayerMouseEvent) {
      if ((event.originalEvent.target as Element).closest(".live-camera-preview")) return;
      const id = event.features?.[0]?.id;
      const camera = cameras!.features.find((feature) => feature.id === id);
      if (camera) open(camera);
    }
    function refreshImages() {
      if (document.hidden) return;
      const images = Array.from(markers.values()).flatMap((marker) =>
        Array.from(marker.getElement().querySelectorAll("img")),
      );
      if (expandedImage && popup.isOpen()) images.push(expandedImage);
      for (const img of images)
        img.src = img.dataset.imageUrl + "?t=" + Math.floor(Date.now() / 30000);
    }
    function pointer() {
      map!.getCanvas().style.cursor = "pointer";
    }
    function leave() {
      map!.getCanvas().style.cursor = "";
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") popup.remove();
    }
    function dismiss(event: maplibregl.MapMouseEvent) {
      if (!(event.originalEvent.target as Element).closest(".maplibregl-marker")) popup.remove();
    }
    previews();
    const timer = window.setInterval(refreshImages, 30000);
    map.on("moveend", previews);
    map.on("click", dismiss);
    map.on("click", "camera-points", inspect);
    map.on("mouseenter", "camera-points", pointer);
    map.on("mouseleave", "camera-points", leave);
    map.getContainer().addEventListener("keydown", escape);
    return () => {
      clearInterval(timer);
      markers.forEach((marker) => marker.remove());
      popup.remove();
      fullImageDialog?.close();
      leave();
      map.off("moveend", previews);
      map.off("click", dismiss);
      map.off("click", "camera-points", inspect);
      map.off("mouseenter", "camera-points", pointer);
      map.off("mouseleave", "camera-points", leave);
      map.getContainer().removeEventListener("keydown", escape);
    };
  }, [map, visible, cameras]);

  if (visible) {
    let cameraLabel;
    if (loading) {
      cameraLabel = "Loading fire cameras…";
    } else if (cameras) {
      cameraLabel = "Fire cameras";
    } else {
      cameraLabel = "Fire cameras unavailable";
    }
    return (
      <div className="live-camera-credit" role="status">
        <div className="live-legend-row">
          <span className="live-camera-legend-swatch" aria-hidden="true" />
          <span>{cameraLabel}</span>
        </div>
      </div>
    );
  } else {
    return null;
  }
}
