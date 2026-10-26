import { useEffect, useState } from "react";
import { loadFireBoundary, loadSeverity, type FireAssessment, type FireBoundary } from "./mtbs";
import {
  assessmentIdentity,
  loadLocations,
  matchHazardAssessment,
  loadHazardRecord,
  loadAssessmentBounds,
  type HazardMode,
  type HazardAssessment,
} from "./usgsHazards";
import type { UsgsAssessment } from "./usgsAssessments";
import { requestCache } from "./requestCache";
import { loadBurnArea, type BurnAreaState } from "./burnArea";

type DataStatus = "loading" | "unavailable" | "failed";

export type FireProducts = {
  key: string;
  boundary: FireBoundary | null;
  bounds: [number, number, number, number] | null;
  severity: Awaited<ReturnType<typeof loadSeverity>> | null;
  burnArea: BurnAreaState;
  hazards: Partial<Record<HazardMode, HazardAssessment>>;
  loading: boolean;
  message: string;
  state: DataStatus;
  association: string;
  associationState: DataStatus;
};
const boundaries = requestCache<FireBoundary>(8);
const severities = requestCache<Awaited<ReturnType<typeof loadSeverity>>>(3);
const hazards = requestCache<HazardAssessment>(12);
function emptyProducts(key: string): FireProducts {
  return {
    key,
    boundary: null,
    bounds: null,
    severity: null,
    burnArea: {
      status: key ? "loading" : "unavailable",
      reason: "No exact MTBS boundary is selected for an area summary.",
    },
    hazards: {},
    loading: !!key,
    message: key ? "Loading agency products…" : "",
    state: "loading",
    association: "",
    associationState: "unavailable",
  };
}

async function boundaryFor(fire: FireAssessment, signal: AbortSignal) {
  const key = `${fire.event_id}:${fire.map_id}:${fire.updated_at || ""}`;
  const cached = boundaries.get(key);
  if (cached) return cached;
  const boundary = await loadFireBoundary(fire, signal);
  if (!signal.aborted) boundaries.set(key, boundary);
  return boundary;
}

async function severityFor(boundary: FireBoundary, signal: AbortSignal) {
  const key = `${boundary.properties.map_id}:${boundary.properties.updated_at || ""}`;
  const cached = severities.get(key);
  if (cached) return cached;
  const product = await loadSeverity(boundary, signal);
  if (!signal.aborted) severities.set(key, product);
  return product;
}

async function hazardsFor(record: UsgsAssessment, mode: HazardMode, signal: AbortSignal) {
  const key = `${assessmentIdentity(record)}:${mode}`;
  const cached = hazards.get(key);
  if (cached) return cached;
  const product = await loadHazardRecord(record, mode, signal);
  if (!signal.aborted) hazards.set(key, product);
  return product;
}

function errorStatus(error: Error): DataStatus {
  if (
    /HTTP|fetch|network|timeout|invalid|incomplete|differs|mismatch|multiple/i.test(error.message)
  )
    return "failed";
  return "unavailable";
}

type Publish = () => void;
function noteFailure(result: FireProducts, error: Error, publish: Publish) {
  result.message = error.message;
  result.state = errorStatus(error);
  publish();
}
async function loadSeverityProduct(result: FireProducts, signal: AbortSignal, publish: Publish) {
  try {
    result.severity = await severityFor(result.boundary!, signal);
    publish();
  } catch (error) {
    noteFailure(result, error as Error, publish);
  }
}
async function loadAreaProduct(result: FireProducts, signal: AbortSignal, publish: Publish) {
  try {
    result.burnArea = await loadBurnArea(result.boundary!, signal);
  } catch (error) {
    result.burnArea = {
      status: "failed",
      reason: `Numeric area summary could not be checked. ${(error as Error).message}`,
    };
  }
  publish();
}
async function loadPerimeter(
  result: FireProducts,
  agency: UsgsAssessment,
  signal: AbortSignal,
  publish: Publish,
) {
  try {
    result.bounds = await loadAssessmentBounds(agency, signal);
    publish();
  } catch (error) {
    noteFailure(result, error as Error, publish);
  }
}
async function loadScenarioProducts(
  result: FireProducts,
  record: UsgsAssessment,
  signal: AbortSignal,
  publish: Publish,
) {
  const pending: Promise<void>[] = [];
  for (const mode of ["likelihood", "volume", "combined"] as const) {
    const request = hazardsFor(record, mode, signal)
      .then((product) => {
        result.hazards[mode] = product;
        publish();
      })
      .catch((error: Error) => noteFailure(result, error, publish));
    pending.push(request);
  }
  await Promise.all(pending);
}
async function loadSelectedProducts(
  result: FireProducts,
  fire: FireAssessment | null,
  agency: UsgsAssessment | null,
  signal: AbortSignal,
  publish: Publish,
) {
  let record = agency;
  const pending: Promise<void>[] = [];
  if (fire) {
    result.boundary = await boundaryFor(fire, signal);
    publish();
    pending.push(loadSeverityProduct(result, signal, publish));
    pending.push(loadAreaProduct(result, signal, publish));
    try {
      record = matchHazardAssessment(await loadLocations(signal), fire, result.boundary).record;
    } catch (error) {
      result.association = (error as Error).message;
      result.associationState = errorStatus(error as Error);
    }
  } else if (agency) {
    result.burnArea = {
      status: "unavailable",
      reason:
        "No exact MTBS boundary and numeric severity summary are linked to this direct USGS selection.",
    };
    pending.push(loadPerimeter(result, agency, signal, publish));
  }
  if (record) pending.push(loadScenarioProducts(result, record, signal, publish));
  await Promise.all(pending);
  result.loading = false;
  if (result.state === "loading") result.message = "";
  publish();
}
export function useFireProducts(fire: FireAssessment | null, agency: UsgsAssessment | null) {
  let key;
  if (agency) {
    key = assessmentIdentity(agency);
  } else if (fire) {
    key = `${fire.event_id}:${fire.map_id}:${fire.updated_at || ""}`;
  } else {
    key = "";
  }
  const [products, setProducts] = useState(() => emptyProducts(key));
  useEffect(() => {
    const controller = new AbortController();
    const result = emptyProducts(key);
    function publish() {
      if (!controller.signal.aborted) setProducts({ ...result, hazards: { ...result.hazards } });
    }
    publish();
    if (key)
      loadSelectedProducts(result, fire, agency, controller.signal, publish).catch(
        (error: Error) => {
          result.loading = false;
          result.burnArea = {
            status: "failed",
            reason:
              "The exact MTBS boundary could not be loaded, so its area summary cannot be verified.",
          };
          noteFailure(result, error, publish);
        },
      );
    return () => controller.abort();
  }, [key]);
  return products.key === key ? products : emptyProducts(key);
}
