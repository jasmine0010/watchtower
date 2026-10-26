import { useEffect, useState } from "react";
import type { FeatureCollection, MultiPolygon } from "geojson";
import type { UsgsAssessment } from "./usgsAssessments";
import { requestCache } from "./requestCache";

export const runoutLevels = [
  { value: 0, color: "#9e9ac8", label: "Reached in one or more simulations" },
  { value: 0.3, color: "#6f4da3", label: "Simulation index > 0.3" },
  { value: 0.6, color: "#3f007d", label: "Simulation index > 0.6" },
];
type FireMatch = {
  mapId: number;
  eventId: string;
  name: string;
  ignition: string;
};
export type RunoutEntry = {
  assessmentId: string;
  name: string;
  ignition: string;
  assessmentDate: string;
  publicationDate: string;
  assessmentVersion: string;
  sourceUrl: string;
  match: FireMatch | null;
  agencyMatch: UsgsAssessment | null;
  relatedAgency: UsgsAssessment | null;
  intensities: number[];
  url: string;
  sha256: string;
};
export type CompanionPin = { releaseId: string; url: string; sha256: string };
export type RunoutManifest = {
  version: number;
  assessmentId: string;
  name: string;
  ignition: string;
  assessmentDate: string;
  publicationDate: string;
  assessmentVersion: string;
  sourceUrl: string;
  provisional: boolean;
  model: string;
  terrain: string;
  depthCutoffMetres: number;
  assessmentAgeDays: number;
  bounds: [number, number, number, number];
  match: FireMatch | null;
  scenarios: {
    intensity: number;
    url: string;
    sha256: string;
    bytes: number;
  }[];
  audit: {
    runoutFeatures: number;
    basinFeatures: number;
    invalidBasinFeatures: number;
  };
};
export type RunoutContours = FeatureCollection<MultiPolygon, { I15: number; dfsi_thr: number }>;
export type RunoutState = {
  key: string;
  status: "loading" | "available" | "failed" | "unavailable";
  manifest: RunoutManifest | null;
  contours: RunoutContours | null;
};
const cache = requestCache<unknown>(16);

export function readRunoutCatalog(value: unknown): RunoutEntry[] {
  const data = value as { version: number; releases: RunoutEntry[] };
  if (data?.version !== 1 || !Array.isArray(data.releases))
    throw new Error("Runout catalog unavailable.");
  const ids = new Set<string>();
  for (const entry of data.releases) {
    if (
      !/^[a-f0-9]{24}$/.test(entry.assessmentId) ||
      ids.has(entry.assessmentId) ||
      entry.url !== `/data/runout/${entry.assessmentId}.json` ||
      entry.sourceUrl !== `https://www.sciencebase.gov/catalog/item/${entry.assessmentId}` ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !entry.intensities?.length ||
      new Set(entry.intensities).size !== entry.intensities.length ||
      entry.intensities.some((value) => !Number.isFinite(value) || value <= 0)
    )
      throw new Error("Runout release is not verified.");
    ids.add(entry.assessmentId);
  }
  return data.releases;
}

export function readRunoutManifest(value: unknown, entry: RunoutEntry): RunoutManifest {
  const data = value as RunoutManifest;
  if (
    data?.version !== 1 ||
    data.assessmentId !== entry.assessmentId ||
    data.name !== entry.name ||
    data.ignition !== entry.ignition ||
    data.sourceUrl !== entry.sourceUrl ||
    data.assessmentDate !== entry.assessmentDate ||
    data.publicationDate !== entry.publicationDate ||
    data.assessmentVersion !== entry.assessmentVersion ||
    data.provisional !== true ||
    !Array.isArray(data.scenarios) ||
    data.scenarios.length !== entry.intensities.length ||
    !Array.isArray(data.bounds) ||
    data.bounds.length !== 4 ||
    !data.bounds.every(Number.isFinite)
  )
    throw new Error("Runout metadata does not match this assessment.");
  for (const intensity of entry.intensities) {
    const matches = data.scenarios.filter((scenario) => scenario.intensity === intensity);
    if (
      matches.length !== 1 ||
      !/^\/data\/runout\/[a-z0-9-]+\.geojson$/.test(matches[0].url) ||
      !/^[a-f0-9]{64}$/.test(matches[0].sha256)
    )
      throw new Error("Runout scenario is not verified.");
  }
  return data;
}

export function readRunoutContours(value: unknown, intensity: number): RunoutContours {
  const data = value as RunoutContours & { crs?: unknown };
  if (data?.type !== "FeatureCollection" || data.crs || data.features?.length !== 3)
    throw new Error("Runout map data is invalid.");
  const levels = new Set<number>();
  for (const feature of data.features) {
    const level = feature.properties?.dfsi_thr;
    if (
      feature.geometry?.type !== "MultiPolygon" ||
      feature.properties?.I15 !== intensity ||
      !runoutLevels.some((entry) => entry.value === level) ||
      levels.has(level)
    )
      throw new Error("Runout contours do not match the scenario.");
    levels.add(level);
    for (const polygon of feature.geometry.coordinates) {
      for (const ring of polygon) {
        if (ring.length < 4) throw new Error("Runout ring is incomplete.");
        for (const point of ring) {
          if (
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]) ||
            point[0] <= -125 ||
            point[0] >= -113 ||
            point[1] <= 32 ||
            point[1] >= 43
          )
            throw new Error("Runout coordinates are invalid.");
        }
      }
    }
  }
  return data;
}

export async function checkedFile(url: string, sha256: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Runout file unavailable.");
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hash = "";
  for (const byte of digest) hash += byte.toString(16).padStart(2, "0");
  if (hash !== sha256) throw new Error("Runout file changed.");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function useRunoutCatalog(retry: number, enabled = true) {
  const [entries, setEntries] = useState<RunoutEntry[]>([]);
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    async function load() {
      setStatus("loading");
      let saved = cache.get("catalog");
      if (!saved) {
        const response = await fetch("/data/runout/catalog.json", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Runout catalog unavailable.");
        saved = await response.json();
      }
      const checked = readRunoutCatalog(saved);
      if (controller.signal.aborted) return;
      cache.set("catalog", saved);
      setEntries(checked);
      setStatus("available");
    }
    load().catch(() => {
      if (!controller.signal.aborted) setStatus("failed");
    });
    return () => controller.abort();
  }, [retry, enabled]);
  return { entries, status };
}

export function useRunout(
  entry: RunoutEntry | null,
  enabled: boolean,
  intensity: number,
  retry: number,
) {
  const key = enabled && entry ? `${entry.assessmentId}:${intensity}:${retry}` : "";
  const empty: RunoutState = {
    key,
    status: key ? "loading" : "unavailable",
    manifest: null,
    contours: null,
  };
  const [state, setState] = useState(empty);
  useEffect(() => {
    if (!key || !entry) return;
    const controller = new AbortController();
    async function load() {
      let saved = cache.get(entry!.url);
      if (!saved) saved = await checkedFile(entry!.url, entry!.sha256, controller.signal);
      const manifest = readRunoutManifest(saved, entry!);
      if (controller.signal.aborted) return;
      cache.set(entry!.url, manifest);
      setState({ ...empty, manifest });
      const scenario = manifest.scenarios.find((value) => value.intensity === intensity);
      if (!scenario) throw new Error("Scenario unavailable.");
      let data = cache.get(scenario.url);
      if (!data) data = await checkedFile(scenario.url, scenario.sha256, controller.signal);
      const contours = readRunoutContours(data, intensity);
      if (controller.signal.aborted) return;
      cache.set(scenario.url, contours);
      setState({ key, status: "available", manifest, contours });
    }
    load().catch(() => {
      if (!controller.signal.aborted) setState({ ...empty, status: "failed" });
    });
    return () => controller.abort();
  }, [key]);
  return state.key === key ? state : empty;
}
