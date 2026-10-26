import type { ShelterFeatures } from "./redCrossShelters";

export const demoShelterSources = [
  "https://www.news.caloes.ca.gov/shelters-available-for-communities-impacted-by-wildfires-in-los-angeles-county-2/",
  "https://www.news.caloes.ca.gov/shelters-available-for-communities-impacted-by-wildfires-in-southern-california/",
  "https://www.news.caloes.ca.gov/shelters-available-for-communities-impacted-by-wildfires-in-southern-california-2/",
];

const locations = [
  {
    name: "Pasadena Civic Auditorium",
    address: "300 E. Green St, Pasadena, CA 91101",
    coordinates: [-118.14427, 34.14388],
    archivedDays: "Jan 8-10, 2025",
  },
  {
    name: "Westwood Recreation Center",
    address: "1350 S. Sepulveda Blvd, Los Angeles, CA 90025",
    coordinates: [-118.4482, 34.0525],
    archivedDays: "Jan 8-10, 2025",
  },
  {
    name: "El Camino Real Charter High School",
    address: "5440 Valley Circle Blvd, Woodland Hills, CA 91367",
    coordinates: [-118.64301, 34.17069],
    archivedDays: "Jan 8-9, 2025",
  },
  {
    name: "Ritchie Valens Recreation Center",
    address: "10736 Laurel Canyon Blvd, Pacoima, CA 91331",
    coordinates: [-118.43615, 34.26735],
    archivedDays: "Jan 8-10, 2025",
  },
  {
    name: "Pomona Fairplex",
    address: "1101 W McKinley Ave, Pomona, CA 91768",
    coordinates: [-117.76524, 34.08095],
    archivedDays: "Jan 9-10, 2025",
  },
  {
    name: "Pan Pacific Recreation Center",
    address: "7600 Beverly Blvd, Los Angeles, CA 90036",
    coordinates: [-118.35485, 34.07325],
    archivedDays: "Jan 9-10, 2025",
  },
  {
    name: "Glendale Civic Center",
    address: "613 E Broadway, Glendale, CA 91206",
    coordinates: [-118.24824, 34.14666],
    archivedDays: "Jan 9, 2025",
  },
  {
    name: "Hamilton High School",
    address: "57430 Mitchell Rd, Anza, CA 92539",
    coordinates: [-116.66012, 33.5705],
    archivedDays: "Jan 9-10, 2025",
  },
  {
    name: "Stoner Recreation Center",
    address: "1835 Stoner Ave, Los Angeles, CA 90025",
    coordinates: [-118.45397, 34.03807],
    archivedDays: "Jan 10, 2025",
  },
  {
    name: "Calvary Community Church",
    address: "5495 Via Rocas, Westlake Village, CA 91362",
    coordinates: [-118.8082, 34.15208],
    archivedDays: "Jan 10, 2025",
  },
];

export const demoShelters: { data: ShelterFeatures; withheld: number } = {
  data: {
    type: "FeatureCollection",
    features: locations.map(({ name, address, coordinates, archivedDays }) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates },
      properties: { name, address, archivedDays, pets: "Not supplied", updated: null },
    })),
  },
  withheld: 0,
};
