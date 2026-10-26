import type { WavePlace } from "./waves";

type ZipRow = [string, string, number, number];

export function readZips(raw: unknown): WavePlace[] {
  const zipLookup = raw as {
    sourceUrl?: string;
    retrievedAt?: string;
    places?: ZipRow[];
  };
  if (
    zipLookup?.sourceUrl !== "https://files.airnowtech.org/airnow/today/cityzipcodes.csv" ||
    !zipLookup.retrievedAt ||
    !Array.isArray(zipLookup.places)
  )
    throw new Error("California ZIP lookup unavailable");
  const seen = new Set<string>();
  const places: WavePlace[] = [];
  for (const [zipcode, reportingArea, lat, lon] of zipLookup.places) {
    if (
      !/^\d{5}$/.test(zipcode) ||
      seen.has(zipcode) ||
      !reportingArea ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < 32 ||
      lat > 42.5 ||
      lon < -125 ||
      lon > -114
    )
      throw new Error("Invalid California ZIP lookup");
    seen.add(zipcode);
    places.push({
      name: `ZIP ${zipcode}`,
      zipcode,
      reportingArea,
      latitude: lat,
      longitude: lon,
      sourceUrl: zipLookup.sourceUrl,
      retrievedAt: zipLookup.retrievedAt,
      dataClass: "Historical",
    });
  }
  return places;
}

export function mergeZips(featured: WavePlace[], statewide: WavePlace[]) {
  const featuredZips = new Set(featured.map((place) => place.zipcode));
  return [...featured, ...statewide.filter((place) => !featuredZips.has(place.zipcode))];
}
