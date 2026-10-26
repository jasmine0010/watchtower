export const pages = ["After the fire", "Live", "Demo"] as const;
export type Page = (typeof pages)[number];
export type WaveStep = "smoke" | "recovery" | "rain" | "context";
export type StepId = "burn" | "steep" | "rain" | "outcome";
export type Navigation = {
  page: Page;
  waveStep: WaveStep;
  waveCase: string | null;
  waveView: "likelihood" | "volume" | "combined";
};

export function readNavigation(hash: string, _search = ""): Navigation {
  const params = new URLSearchParams(hash.slice(1));
  let pageKey = params.get("page") || "live";
  const oldLiveSmoke =
    pageKey === "waves" &&
    params.get("waveSmoke") === "live" &&
    (!params.has("wave") || params.get("wave") === "smoke");
  if (pageKey === "weather" || oldLiveSmoke) pageKey = "live";
  const wave = params.get("wave") === "ash" ? "recovery" : params.get("wave");
  const waveView = params.get("waveView");
  let page: Page;
  if (pageKey === "live") {
    page = "Live";
  } else if (pageKey === "demo") {
    page = "Demo";
  } else {
    page = "After the fire";
  }
  return {
    page: page,
    waveCase: params.get("waveCase"),
    waveStep: wave === "recovery" || wave === "rain" || wave === "context" ? wave : "smoke",
    waveView: waveView === "volume" || waveView === "combined" ? waveView : "likelihood",
  };
}

export function navigationHash(state: Navigation): string {
  let pageKey;
  if (state.page === "Live") {
    pageKey = "live";
  } else if (state.page === "Demo") {
    pageKey = "demo";
  } else {
    pageKey = "waves";
  }
  const params = new URLSearchParams({
    page: pageKey,
  });
  if (state.waveStep !== "smoke") params.set("wave", state.waveStep);
  if (state.waveCase) params.set("waveCase", state.waveCase);
  if (state.waveView !== "likelihood") params.set("waveView", state.waveView);
  return "#" + params;
}
