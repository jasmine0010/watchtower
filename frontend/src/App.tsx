import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { CaseData } from "./types";
import type { WeatherState } from "./ForecastPanel";
import { readCatalog } from "./fireProducts";
import { readNavigation, navigationHash, type Page, type Navigation } from "./navigation";
import { waveCaseFor, type WaveCatalog } from "./waves";
import { useHistoricalSelection, loadHistoricalScope } from "./historicalFires";
import { HistoricalFirePicker } from "./HistoricalFirePicker";
import { displayFireName } from "./units";
import { useAccount } from "./accountContext";

const WavesPanel = lazy(() => import("./WavesPanel"));
const LivePanel = lazy(() => import("./LivePanel"));
const HistoricalWaves = lazy(() => import("./HistoricalWaves"));
async function readData<T>(name: string, extension = "json"): Promise<T> {
  const response = await fetch(`/data/${name}.${extension}`);
  if (!response.ok) throw new Error(`${name} unavailable`);
  return response.json();
}

export function App() {
  const [catalog, setCatalog] = useState<WaveCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    readData<WaveCatalog>("waves-cases")
      .then((data) => {
        if (!data.cases?.length || !Array.isArray(data.rightNowPlaces))
          throw new Error("Catalog unavailable");
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!catalog)
    return (
      <main className="page-content">
        <h1 className="app-page-title">Watchtower</h1>
        <div role="status">
          {failed
            ? "The app catalog could not load. Reload to try again."
            : "Loading historical fire data…"}
        </div>
      </main>
    );
  return <LoadedApp waveCatalog={catalog} />;
}

function LoadedApp({ waveCatalog }: { waveCatalog: WaveCatalog }) {
  const { owner } = useAccount();
  const [navigation, setNavigation] = useState(() =>
    readNavigation(location.hash, location.search),
  );
  const navigationRef = useRef(navigation);
  const historical = useHistoricalSelection(navigation.waveCase || waveCatalog.cases[0].id);
  const replayId = historical.record?.replayId || navigation.waveCase;
  const selectedWave = waveCaseFor(waveCatalog, replayId);
  const catalogSelection =
    navigation.waveCase !== null && !waveCatalog.cases.some((row) => row.id === replayId);
  let waveName;
  if (!historical.record) {
    waveName = "Historical fire";
  } else if (catalogSelection) {
    waveName = displayFireName(historical.record.name);
  } else {
    waveName = selectedWave.name;
  }
  navigationRef.current = navigation;
  function changeNavigation(changes: Partial<Navigation>) {
    const next = { ...navigationRef.current, ...changes };
    if (JSON.stringify(next) === JSON.stringify(navigationRef.current)) return;
    navigationRef.current = next;
    const hash = navigationHash(next);
    if (hash !== location.hash) {
      history.pushState(null, "", hash);
    }
    setNavigation(next);
  }
  useEffect(() => {
    function restoreNavigation() {
      if (location.hash === "#main") return;
      const next = readNavigation(location.hash, location.search);
      navigationRef.current = next;
      setNavigation(next);
    }
    window.addEventListener("popstate", restoreNavigation);
    window.addEventListener("hashchange", restoreNavigation);
    return () => {
      window.removeEventListener("popstate", restoreNavigation);
      window.removeEventListener("hashchange", restoreNavigation);
    };
  }, []);
  const { page } = navigation;
  const [weatherState, setWeatherState] = useState<WeatherState>({
    weather: null,
    now: Date.now(),
  });
  const [chosenPlace, setChosenPlace] = useState("");
  const [livePlaceSelected, setLivePlaceSelected] = useState(false);
  const [demoPlaceSelected, setDemoPlaceSelected] = useState(false);
  const markLivePlace = useCallback(() => setLivePlaceSelected(true), []);
  const markDemoPlace = useCallback(() => setDemoPlaceSelected(true), []);
  const [demoPlace, setDemoPlace] = useState(
    () =>
      waveCatalog.rightNowPlaces.find((place) => place.zipcode === "90272")?.name || "ZIP 90272",
  );
  const previousOwner = useRef(owner);
  useEffect(() => {
    if (previousOwner.current !== owner) {
      setChosenPlace("");
      setLivePlaceSelected(false);
    }
    previousOwner.current = owner;
  }, [owner]);
  const updateWeather = useCallback((changes: Partial<WeatherState>) => {
    setWeatherState((previous) => ({ ...previous, ...changes }));
  }, []);
  const [cases, setCases] = useState<CaseData[]>([]);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector(".page-content")?.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    let active = true;
    readData<unknown>("catalog")
      .then(readCatalog)
      .then(async (catalog) => {
        const scope = await loadHistoricalScope();
        if (!active) return;
        const ids = new Set(scope.eligibleObservationIds);
        const eligibleCases = catalog.cases.filter((record) => ids.has(record.observationId));
        setCases(eligibleCases);
      })
      .catch(() => setCases([]));
    return () => {
      active = false;
    };
  }, []);
  function navigate(next: Page) {
    changeNavigation({ page: next });
  }
  const resources = (
    <div className="official-links" role="navigation" aria-label="Official resources">
      <a href="https://www.burbankca.gov/web/fire-department/el-ni%C3%B1o">Burbank resources</a>
      <a href="https://www.weather.gov/alerts">NWS alerts</a>
    </div>
  );
  let historicalView;
  if (navigation.page === "After the fire") {
    if (!historical.record && !historical.failed) {
      historicalView = <p role="status">Verifying fire identity…</p>;
    } else if (catalogSelection || !historical.record) {
      historicalView = (
        <HistoricalWaves
          key={navigation.waveCase}
          record={historical.record}
          failed={historical.failed}
          picker={
            <HistoricalFirePicker
              catalog={waveCatalog}
              selectedId={navigation.waveCase || waveCatalog.cases[0].id}
              name={waveName}
              onSelect={(waveCase) => changeNavigation({ waveCase })}
            />
          }
          step={navigation.waveStep}
          onStep={(waveStep) => changeNavigation({ waveStep })}
          mode={navigation.waveView}
          onMode={(waveView) => changeNavigation({ waveView })}
        />
      );
    } else {
      historicalView = (
        <WavesPanel
          catalog={waveCatalog}
          record={historical.record}
          caseId={replayId}
          step={navigation.waveStep}
          mode={navigation.waveView}
          onStep={(waveStep) => changeNavigation({ waveStep })}
          onMode={(waveView) => changeNavigation({ waveView })}
          observations={cases}
          resources={resources}
          picker={
            <HistoricalFirePicker
              catalog={waveCatalog}
              selectedId={selectedWave.id}
              name={selectedWave.name}
              onSelect={(waveCase) => changeNavigation({ waveCase })}
            />
          }
        />
      );
    }
  }
  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <ViewSwitch page={page} navigate={navigate} />
      {page === "Live" || page === "Demo" ? (
        <main id="main" tabIndex={-1} className="dashboard guided-dashboard live-dashboard">
          <h1 className="app-page-title">
            {page === "Demo" ? "Demo wildfire conditions" : "Live wildfire conditions"}
          </h1>
          <Suspense fallback={<p>Loading {page}…</p>}>
            <LivePanel
              demo={page === "Demo"}
              onPlace={page === "Demo" ? setDemoPlace : setChosenPlace}
              hasUserSelectedPlace={page === "Demo" ? demoPlaceSelected : livePlaceSelected}
              onUserSelectPlace={page === "Demo" ? markDemoPlace : markLivePlace}
              places={waveCatalog.rightNowPlaces}
              placeName={page === "Demo" ? demoPlace : chosenPlace}
              weatherState={weatherState}
              onWeatherState={updateWeather}
            />
          </Suspense>
        </main>
      ) : (
        <main id="main" tabIndex={-1} className="dashboard guided-dashboard waves-dashboard">
          <h1 className="app-page-title">Past fires</h1>
          <Suspense fallback={<p>Loading historical fire evidence…</p>}>{historicalView}</Suspense>
        </main>
      )}
    </div>
  );
}
function ViewSwitch({ page, navigate }: { page: Page; navigate: (page: Page) => void }) {
  const { identity, openProfile } = useAccount();
  const initials = identity.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <header className="app-mode-bar">
      <button
        type="button"
        className="account-profile-button"
        aria-label={`Open account profile for ${identity.name}`}
        onClick={openProfile}
      >
        {identity.avatarUrl ? (
          <img src={identity.avatarUrl} alt="" />
        ) : (
          <span>{initials || "G"}</span>
        )}
      </button>
      <nav className="app-mode-switch" aria-label="Map view">
        <button
          type="button"
          aria-current={page === "After the fire" ? "page" : undefined}
          onClick={() => navigate("After the fire")}
        >
          Past fires
        </button>
        <button
          type="button"
          aria-current={page === "Live" ? "page" : undefined}
          onClick={() => navigate("Live")}
        >
          Live
        </button>
        <button
          type="button"
          aria-current={page === "Demo" ? "page" : undefined}
          onClick={() => navigate("Demo")}
        >
          Demo
        </button>
      </nav>
    </header>
  );
}
