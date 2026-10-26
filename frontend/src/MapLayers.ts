import type { Map as LibreMap, LineLayerSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";

export function cancelledMapRequest(error: { name?: string; message: string }): boolean {
  return (
    error.name === "AbortError" || /(?:\b|_)(aborted|cancelled|canceled)\b/i.test(error.message)
  );
}

export const boundaryLayout: LineLayerSpecification["layout"] = {
  "line-cap": "round",
  "line-join": "round",
};

export const perimeterPaint: LineLayerSpecification["paint"] = {
  "line-color": "#293d34",
  "line-width": 2,
  "line-opacity": 1,
};

export function mapLabelAnchor(source: Feature | FeatureCollection): [number, number] | null {
  const features = source.type === "FeatureCollection" ? source.features : [source];
  let anchor: [number, number] | null = null;
  for (const feature of features) {
    const geometry = feature.geometry;
    let lines: number[][][] = [];
    if (geometry?.type === "Polygon") lines = [geometry.coordinates[0]];
    else if (geometry?.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates) lines.push(polygon[0]);
    } else if (geometry?.type === "LineString") lines = [geometry.coordinates];
    else if (geometry?.type === "MultiLineString") lines = geometry.coordinates;
    for (const line of lines) {
      for (const [longitude, latitude] of line) {
        if (
          Number.isFinite(longitude) &&
          Number.isFinite(latitude) &&
          (!anchor || latitude > anchor[1] || (latitude === anchor[1] && longitude < anchor[0]))
        )
          anchor = [longitude, latitude];
      }
    }
  }
  return anchor;
}

export function addBasemap(map: LibreMap) {
  map.addSource("usgs-topo", {
    type: "raster",
    tiles: [
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    ],
    tileSize: 128,
    maxzoom: 16,
    attribution:
      '<a href="https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer">USGS The National Map</a>',
  });
  map.addLayer(
    {
      id: "usgs-topo",
      type: "raster",
      source: "usgs-topo",
    },
    map.getStyle().layers.find((layer) => layer.id !== "background")?.id,
  );
}

export function muteBasemap(map: LibreMap) {
  if (!map.getLayer("usgs-topo")) return;

  map.setPaintProperty("usgs-topo", "raster-saturation", -0.25);
  map.setPaintProperty("usgs-topo", "raster-contrast", 0);
  map.setPaintProperty("usgs-topo", "raster-opacity", 1);
}

export function mapPadding(container: HTMLElement) {
  const dashboard = container.closest(".dashboard");

  if (!dashboard) return { left: 0, right: 0, top: 0, bottom: 0 };
  const style = getComputedStyle(dashboard);
  return {
    left: parseFloat(style.getPropertyValue("--open-left")),
    right: parseFloat(style.getPropertyValue("--open-right")),
    top: parseFloat(style.getPropertyValue("--fit-top")),
    bottom: parseFloat(style.getPropertyValue("--fit-bottom")),
  };
}
