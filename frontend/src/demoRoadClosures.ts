import type { HighwayClosure, HighwaySnapshot } from "./highwayClosures";

const records = [
  [1, -118.526918494105, 34.0480002314522, "Via De La Paz & Sunset Blvd", "Soft", "Jan 8, 2025"],
  [
    2,
    -118.579168576535,
    34.0401261480739,
    "Topanga Canyon Blvd & Pacific Coast Highway (CA -1)",
    "Hard",
    "Jan 8, 2025",
  ],
  [3, -118.50966024443, 34.0463227080702, "Sunset Blvd & Amafli Dr", "Soft", "Jan 8, 2025"],
  [
    4,
    -118.535745563616,
    34.0358237033192,
    "Temescal Canyon Rd & Sunset Blvd",
    "Soft",
    "Jan 11, 2025",
  ],
  [
    5,
    -118.519401656405,
    34.0283402286953,
    "Chautauqua Blvd & Pacific Coast Highway (CA 1)",
    "Soft",
    "Jan 8, 2025",
  ],
  [
    6,
    -118.518820024414,
    34.0278576707837,
    "Entrada Dr & Pacific Coast Highway (CA 1)",
    "Soft",
    "Jan 7, 2025",
  ],
  [
    15,
    -118.529275283184,
    34.049721526077,
    "Temescal canyon RD & Sunset Blvd",
    "Hard",
    "Jan 11, 2025",
  ],
] as const;

export const demoRoadClosures: HighwaySnapshot = {
  closures: records.map(
    ([id, longitude, latitude, location, restriction, archiveDate]): HighwayClosure => ({
      type: "Feature",
      id: `demo-${id}`,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: {
        highwayClosure: true,
        route: location,
        direction: "Not supplied",
        county: "Los Angeles",
        facility: "Intersection",
        restriction,
        work: "Not supplied",
        lanes: "Not supplied",
        begin: location,
        end: "Not supplied",
        endPoint: null,
        markerEndpoint: "Reported point",
        starts: null,
        ends: null,
        indefinite: false,
        sourceUpdated: null,
        statusUncertain: true,
        archiveDate,
      },
    }),
  ),
  unavailableDistricts: [],
  unmapped: 0,
  retrievedAt: new Date(1739993485152).toISOString(),
};
