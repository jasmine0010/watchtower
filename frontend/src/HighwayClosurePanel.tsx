import { useEffect, useState } from "react";
import {
  closureTime,
  closureLanes,
  closureUncertainty,
  nearbyHighwayClosures,
  type HighwayClosure,
  type HighwaySnapshot,
} from "./highwayClosures";

export function HighwayOptions({
  matches,
  now,
  demo,
  onLocate,
}: {
  matches: ReturnType<typeof nearbyHighwayClosures>;
  now: number;
  demo: boolean;
  onLocate: (feature: HighwayClosure) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <ul className="live-highway-list">
        {(expanded ? matches : matches.slice(0, 3)).map(({ closure, distanceKm }) => {
          const p = closure.properties;
          const reason = closureUncertainty(closure, now);
          let distanceLabel;
          if (distanceKm !== null) {
            distanceLabel = ` / ${(distanceKm / 1.609344).toFixed(1)} mi`;
          } else if (demo) {
            distanceLabel = "";
          } else {
            distanceLabel = ` / ${p.county}`;
          }
          return (
            <li key={closure.id}>
              <button type="button" onClick={() => onLocate(closure)}>
                <span
                  className={`live-highway-dot${reason ? " is-unverified" : ""}`}
                  aria-hidden="true"
                />
                <span>
                  <strong>
                    {p.route}
                    {demo ? "" : ` / ${p.direction}`}
                  </strong>
                  <span>
                    {p.restriction} closure{demo ? "" : ` / ${p.facility}`}
                  </span>
                  <small>
                    {demo ? "Reported closure" : p.work}
                    {distanceLabel}
                  </small>
                  {!demo && (
                    <small>
                      {reason
                        ? `Status unverified: ${reason}`
                        : `Scheduled end: ${p.indefinite ? "Indefinite" : closureTime(p.ends)}`}
                    </small>
                  )}
                </span>
                <span aria-hidden="true">↗</span>
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length > 3 && (
        <button type="button" className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${matches.length}`}
        </button>
      )}
    </>
  );
}

export function highwayPopup(closure: HighwayClosure, now: number) {
  const p = closure.properties;
  const uncertainty = closureUncertainty(closure, now);
  const content = document.createElement("section");
  content.className = "highway-popup";

  content.innerHTML = `
    <h3></h3>
    <div class="highway-popup-body">
    <p class="highway-popup-location"></p>
    <p class="highway-popup-impact"></p>
    <p class="highway-popup-timing"></p>
    <p class="highway-popup-warning"></p>
    </div>`;
  if (p.archiveDate) {
    content.classList.add("is-caution");
    content.querySelector("h3")!.textContent = `${p.route} / ${p.restriction} closure reported`;
    content.querySelector(".highway-popup-location")!.textContent = p.begin;
    content.querySelector(".highway-popup-impact")!.textContent = "Reported closure";
    content.querySelector(".highway-popup-timing")!.textContent =
      "Closure and reopening times not supplied.";
    content.querySelector<HTMLElement>(".highway-popup-warning")!.hidden = true;
    return content;
  }
  const fullRoad =
    p.restriction === "Full" && ["Mainline", "Conventional Hwy"].includes(p.facility);
  content.classList.add(fullRoad && !uncertainty ? "is-full" : "is-caution");
  let restriction =
    p.restriction === "Not supplied" ? "Traffic restriction" : `${p.restriction} closure`;
  if (fullRoad) restriction = uncertainty ? "Road closure reported" : "Road closed";
  else if (p.restriction === "Full" && p.facility === "Off Ramp")
    restriction = uncertainty ? "Exit closure reported" : "Exit ramp closed";
  else if (p.restriction === "Full" && p.facility === "On Ramp")
    restriction = uncertainty ? "Entrance closure reported" : "Entrance ramp closed";
  else {
    if (!["Mainline", "Conventional Hwy", "Not supplied"].includes(p.facility))
      restriction += ` / ${p.facility}`;
    if (uncertainty) restriction += " reported";
  }
  content.querySelector("h3")!.textContent = `${p.route} / ${restriction}`;
  content.querySelector(".highway-popup-location")!.textContent = `${p.begin} to ${p.end}`;
  const direction = p.direction === "Not supplied" ? "Direction unknown" : p.direction;
  content.querySelector(".highway-popup-impact")!.textContent =
    p.restriction === "Full" && p.lanes === "All"
      ? direction
      : `${direction} / ${p.lanes === "Not supplied" ? "Affected lanes unknown" : closureLanes(p.lanes)}`;
  let timingLabel;
  if (p.indefinite || p.ends === null) {
    timingLabel = "Reopening time unknown.";
  } else if (p.ends <= now) {
    timingLabel = "Reopening not confirmed.";
  } else {
    timingLabel = `Expected to end ${closureTime(p.ends)}.`;
  }
  content.querySelector(".highway-popup-timing")!.textContent = timingLabel;
  const warning = content.querySelector<HTMLElement>(".highway-popup-warning")!;
  warning.textContent = "Current status unconfirmed.";
  warning.hidden = !uncertainty;
  return content;
}

export function useHighwayClosures(refresh: number, enabled = true) {
  const [snapshot, setSnapshot] = useState<HighwaySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    async function load() {
      try {
        const response = await fetch("/caltrans-closures", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Highway closures unavailable");
        const data: HighwaySnapshot = await response.json();
        if (!controller.signal.aborted) setSnapshot(data);
      } catch {
        if (!controller.signal.aborted) setSnapshot(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [refresh, enabled]);
  return { snapshot, loading };
}
