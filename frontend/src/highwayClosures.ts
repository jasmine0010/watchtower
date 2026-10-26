import type { Feature, Point } from "geojson";
import { perimeterDistanceKm, pointDistanceKm } from "./wavesLive";
import { formatLaTimestamp } from "./formatLaTimestamp";

export const quickMapUrl = "https://quickmap.dot.ca.gov/";

type Flag = string | boolean;
export type CaltransRecord = {
  index: string;
  location: {
    travelFlowDirection?: string;
    begin: Record<string, string>;
    end: Record<string, string>;
  };
  closure: {
    facility?: string;
    typeOfClosure?: string;
    typeOfWork?: string;
    lanesClosed?: string;
    closureTimestamp: {
      closureStartEpoch?: string;
      closureEndEpoch?: string;
      isClosureEndIndefinite?: Flag;
    };
    code1097?: { isCode1097: Flag };
    code1098?: { isCode1098: Flag };
    code1022?: { isCode1022: Flag };
  };
};

export type HighwayClosure = Feature<
  Point,
  {
    highwayClosure: true;
    route: string;
    direction: string;
    county: string;
    facility: string;
    restriction: string;
    work: string;
    lanes: string;
    begin: string;
    end: string;
    endPoint: number[] | null;
    markerEndpoint: string;
    starts: number | null;
    ends: number | null;
    indefinite: boolean;
    sourceUpdated: number | null;
    statusUncertain: boolean;
    archiveDate?: string;
  }
>;

export type HighwaySnapshot = {
  closures: HighwayClosure[];
  unavailableDistricts: number[];
  unmapped: number;
  retrievedAt: string;
};

function isTrue(value?: Flag) {
  return value === true || value === "true";
}
function isFalse(value?: Flag) {
  return value === false || value === "false";
}
function text(value?: string) {
  return value && value !== "Not Reported" && value !== "N/A" ? value : "Not supplied";
}
function epoch(value?: string) {
  const seconds = Number(value);
  const milliseconds = seconds * 1000;
  return seconds > 0 && Number.isFinite(new Date(milliseconds).valueOf()) ? milliseconds : null;
}
function coordinate(longitude?: string, latitude?: string): number[] | null {
  if (!longitude || !latitude) return null;
  const point = [Number(longitude), Number(latitude)];
  return point[0] >= -125 && point[0] <= -113 && point[1] >= 32 && point[1] <= 43 ? point : null;
}

export function readHighwayClosures(
  rows: CaltransRecord[],
  district: number,
  sourceUpdated: number | null,
) {
  const closures: HighwayClosure[] = [];
  let unmapped = 0;
  for (const row of rows) {
    const closure = row.closure;

    if (
      !isTrue(closure?.code1097?.isCode1097) ||
      isTrue(closure.code1098?.isCode1098) ||
      isTrue(closure.code1022?.isCode1022)
    )
      continue;
    const begin = row.location?.begin || {};
    const end = row.location?.end || {};
    const beginPoint = coordinate(begin.beginLongitude, begin.beginLatitude);
    const endPoint = coordinate(end.endLongitude, end.endLatitude);
    const point = beginPoint || endPoint;
    if (!point) {
      unmapped++;
      continue;
    }
    const times = closure.closureTimestamp || {};
    closures.push({
      type: "Feature",
      id: `${district}-${row.index}`,
      geometry: { type: "Point", coordinates: point },
      properties: {
        highwayClosure: true,
        route: text(begin.beginRoute),
        direction: text(row.location.travelFlowDirection),
        county: text(begin.beginCounty),
        facility: text(closure.facility),
        restriction: text(closure.typeOfClosure),
        work: text(closure.typeOfWork),
        lanes: text(closure.lanesClosed),
        begin: text(begin.beginLocationName),
        end: text(end.endLocationName),
        endPoint,
        markerEndpoint: beginPoint ? "Start point" : "End point",
        starts: epoch(times.closureStartEpoch),
        ends: epoch(times.closureEndEpoch),
        indefinite: isTrue(times.isClosureEndIndefinite),
        sourceUpdated,
        statusUncertain:
          !isFalse(closure.code1098?.isCode1098) || !isFalse(closure.code1022?.isCode1022),
      },
    });
  }
  return { closures, unmapped };
}

export function closureUncertainty(closure: HighwayClosure, now: number) {
  const p = closure.properties;
  if (p.archiveDate) return "Closure time not supplied";
  if (!p.sourceUpdated || now - p.sourceUpdated > 30 * 60000 || p.sourceUpdated > now + 5 * 60000)
    return "Feed timestamp missing or out of date";
  if (p.statusUncertain) return "End or cancellation status not supplied";
  if (p.starts === null || p.starts > now)
    return "Start time missing or conflicts with reported status";
  if (!p.indefinite && (p.ends === null || p.ends <= now))
    return "Scheduled end missing or passed; reopening not confirmed";
  return "";
}

export function nearbyHighwayClosures(closures: HighwayClosure[], context: Feature | null) {
  const matches = closures
    .map((closure) => {
      let distanceKm: number | null = null;
      if (context) {
        const points = [closure.geometry.coordinates];
        if (closure.properties.endPoint) points.push(closure.properties.endPoint);
        const distances = points.map((point) => {
          if (context.geometry?.type === "Point") {
            return pointDistanceKm(context.geometry.coordinates, point);
          } else if (context.geometry) {
            return perimeterDistanceKm(context.geometry, point);
          } else {
            return null;
          }
        });
        const known = distances.filter((distance): distance is number => distance !== null);
        distanceKm = known.length ? Math.min(...known) : null;
      }
      return { closure, distanceKm };
    })
    .filter(
      (match) => !context || (match.distanceKm !== null && match.distanceKm <= 25 * 1.609344),
    );

  function priority(closure: HighwayClosure) {
    const p = closure.properties;
    if (p.restriction === "Full" && ["Mainline", "Conventional Hwy"].includes(p.facility)) return 0;
    return /fire|emergency|flood|slide|weather/i.test(p.work) ? 1 : 2;
  }
  return matches.sort(
    (a, b) =>
      priority(a.closure) - priority(b.closure) || (a.distanceKm ?? 0) - (b.distanceKm ?? 0),
  );
}

export function closureTime(time: number | null) {
  return time === null ? "Not supplied" : formatLaTimestamp(time, "Not supplied", "Invalid Date");
}

export function closureLanes(lanes: string) {
  const names: Record<string, string> = {
    RtTurnLn: "Right-turn lane",
    LtTurnLn: "Left-turn lane",
    LShoulder: "Left shoulder",
    RShoulder: "Right shoulder",
    All: "All lanes",
  };
  return lanes
    .split(",")
    .map((lane) => names[lane.trim()] || lane.trim())
    .join(", ");
}

export function closureText(closure: HighwayClosure, now: number) {
  const p = closure.properties;
  if (p.archiveDate)
    return `${p.route} / ${p.restriction} closure reported. Closure time and reopening not supplied. Reported point, not the full closed road. Not evacuation guidance.`;
  const uncertainty = closureUncertainty(closure, now);
  return `${p.route} / ${p.direction} / ${p.restriction} closure / ${p.facility}. ${p.work}. ${p.begin} to ${p.end}. Lanes: ${p.lanes}. Started: ${closureTime(p.starts)}. Scheduled end: ${p.indefinite ? "Indefinite" : closureTime(p.ends)}. ${uncertainty ? `Status unverified: ${uncertainty}.` : "Reported active by Caltrans."} ${p.markerEndpoint}; not the full closed road. Caltrans highway coverage only; not evacuation guidance.`;
}
