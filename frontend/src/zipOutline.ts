import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";

export type ZipOutline = {
  zip: string;
  geometry: FeatureCollection<Polygon | MultiPolygon>;
  point: [number, number];
};

export const censusZipSource =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1";

export function censusZipUrl(zip: string) {
  const query = new URLSearchParams({
    where: `ZCTA5='${zip}'`,
    outFields: "ZCTA5,INTPTLAT,INTPTLON",
    outSR: "4326",
    f: "geojson",
  });
  return `${censusZipSource}/query?${query}`;
}

export function readZipOutline(value: unknown, zip: string): ZipOutline | null {
  const data = value as FeatureCollection;
  if (data?.type !== "FeatureCollection" || data.features?.length !== 1) return null;
  const feature = data.features[0];
  const geometry = feature.geometry;
  if (
    feature.properties?.ZCTA5 !== zip ||
    (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon")
  )
    return null;
  const latitude = Number(feature.properties.INTPTLAT);
  const longitude = Number(feature.properties.INTPTLON);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    zip,
    geometry: {
      type: "FeatureCollection",
      features: [feature as Feature<Polygon | MultiPolygon>],
    },
    point: [longitude, latitude],
  };
}
