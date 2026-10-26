import { useEffect, useState } from "react";
import type { FeatureCollection } from "geojson";
import { readSmoke, type WavesData } from "./waves";
import type { HistoricalRecord } from "./historicalFires";
import { readRecovery, type RecoveryData } from "./recovery";
import { readSlopeLayer, type SlopeLayer } from "./fireGround";
import type { GoesProduct, HrrrProduct } from "./waves";

export type EvidenceCheck = {
  status: string;
  reason: string;
  releaseChecks?: {
    status: string;
    preparedUrl: string;
    sourceUrl: string;
  }[];
};
export type HistoricalEvidence = {
  schemaVersion: number;
  fireId: string;
  builtAt: string;
  perimeter?: { status: string; value: FeatureCollection | null };
  smoke: WavesData["smoke"] | EvidenceCheck;
  plumeCoverage?: Record<string, boolean | null>;
  checks: Record<string, EvidenceCheck>;
  rainUrl?: string;
  recovery?: RecoveryData;
  context?: EvidenceCheck & { fireId?: string; slope?: SlopeLayer };
  goes?: EvidenceCheck & GoesProduct & { caseId: string };
  hrrr?: EvidenceCheck & HrrrProduct & { caseId: string };
};

function assessmentBelongsToFire(url: string, id: string): boolean {
  const prefix = `/data/waves/${id.replaceAll(":", "-")}`;
  if (url === `${prefix}-rain-scenarios.json`) return true;
  if (!url.startsWith(prefix + "-")) return false;
  const releaseFile = url.slice(prefix.length + 1);
  return /^[a-f0-9]{24}-rain-scenarios\.json$/.test(releaseFile);
}

export function readHistoricalEvidence(value: unknown, id: string): HistoricalEvidence {
  const data = value as HistoricalEvidence;
  if (data?.schemaVersion !== 1 || data.fireId !== id || !data.smoke?.status || !data.checks)
    throw new Error("Historical evidence identity differs.");
  if (data.rainUrl && !assessmentBelongsToFire(data.rainUrl, id))
    throw new Error("Assessment file is not linked to this fire.");
  if (data.smoke.status === "available") readSmoke(data.smoke);
  if (data.checks.recovery && !data.recovery)
    throw new Error("Recovery check has no evidence record.");
  if (data.recovery) readRecovery(data.recovery, id);
  if (data.context?.status === "available") {
    if (data.context.fireId !== id) throw new Error("Terrain identity differs.");
    readSlopeLayer(data.context.slope, id.replaceAll(":", "-"));
  }
  if (
    data.goes?.status === "available" &&
    (data.goes.caseId !== id ||
      data.goes.manifest !== `/data/waves/goes-${id.replaceAll(":", "-")}/manifest.json`)
  )
    throw new Error("Satellite identity differs.");
  if (
    data.hrrr?.status === "available" &&
    (data.hrrr.caseId !== id ||
      !data.hrrr.manifest.startsWith("/data/waves/hrrr-") ||
      !data.hrrr.manifest.endsWith("/manifest.json"))
  )
    throw new Error("Modeled smoke identity differs.");
  if (
    data.smoke.status === "unavailable" &&
    !("checkedAt" in data.smoke || "retrievedAt" in data.smoke)
  )
    throw new Error("Source absence has no recorded check.");
  return data;
}

export function useHistoricalEvidence(
  record: HistoricalRecord | null,
  product: "smoke" | "rain" | "recovery" | "context" | "goes" | "hrrr" | null,
) {
  const [state, setState] = useState<{
    id: string;
    data?: HistoricalEvidence;
    check?: EvidenceCheck;
  } | null>(null);
  useEffect(() => {
    if (!record?.evidenceUrl || !product) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = record.id;
    async function check(prepared: boolean) {
      try {
        const response = await fetch(
          prepared
            ? record!.evidenceUrl!
            : "/historical-evidence?fire=" + encodeURIComponent(id) + "&product=" + product,
          { signal: controller.signal },
        );
        if (
          prepared &&
          (response.status === 404 ||
            !response.headers.get("Content-Type")?.includes("application/json"))
        ) {
          await check(false);
          return;
        }
        if (!response.headers.get("Content-Type")?.includes("application/json")) {
          setState({
            id,
            check: {
              status: "not_checked",
              reason: "Historical data unavailable.",
            },
          });
          return;
        }
        const payload = await response.json();
        if (!response.ok || response.status === 202) {
          setState({ id, check: payload });
          if (response.status === 202) timer = setTimeout(() => void check(false), 3000);
          return;
        }
        const data = readHistoricalEvidence(payload, id);
        if (!data.checks[product!]) {
          await check(false);
          return;
        }
        if (!controller.signal.aborted) setState({ id, data });
      } catch {
        if (!controller.signal.aborted)
          setState({
            id,
            check: {
              status: "failed",
              reason: "Evidence could not be checked. This does not establish missing source data.",
            },
          });
      }
    }
    void check(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [record, product]);
  return state?.id === record?.id ? state : null;
}
