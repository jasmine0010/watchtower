import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { WaveCatalog } from "./waves";
import { displayFireName } from "./units";
import {
  loadHistoricalIndex,
  loadHistoricalScope,
  loadHistoricalCountyLookup,
  type HistoricalIndex,
  type HistoricalCountyRecord,
  type HistoricalScope,
} from "./historicalFires";
import { Icon, type IconName } from "./Icons";
import { useFirePicker } from "./useFirePicker";
import type { WaveStep } from "./navigation";

export type FireOption = {
  id: string;
  selectId: string;
  name: string;
  year: number;
  county: string;
  steps: WaveStep[];
};

const stepIcons: { step: WaveStep; name: string; icon: IconName }[] = [
  { step: "context", name: "Fire context", icon: "map" },
  { step: "smoke", name: "Smoke", icon: "smoke" },
  { step: "recovery", name: "Recovery", icon: "home" },
  { step: "rain", name: "Rain", icon: "droplet" },
];

export function readFireAvailability(value: unknown, scope: HistoricalScope) {
  const data = value as {
    schemaVersion: number;
    eligibleFireCount: number;
    records: { fireId: string; steps: WaveStep[] }[];
  };
  if (
    data?.schemaVersion !== 1 ||
    data.eligibleFireCount !== scope.eligibleFireCount ||
    !Array.isArray(data.records) ||
    data.records.length !== scope.eligibleFireCount
  )
    throw new Error("Fire availability list differs from the selector scope.");
  const allowed = new Set(stepIcons.map((item) => item.step));
  const eligible = new Set(scope.eligibleFireIds);
  const fireSteps = new Map<string, WaveStep[]>();
  for (const row of data.records) {
    if (
      !eligible.has(row.fireId) ||
      fireSteps.has(row.fireId) ||
      !Array.isArray(row.steps) ||
      new Set(row.steps).size !== row.steps.length ||
      row.steps.some((step) => !allowed.has(step))
    )
      throw new Error("Fire availability identity differs.");
    fireSteps.set(row.fireId, row.steps);
  }
  return fireSteps;
}

export function fireOptions(
  scope: HistoricalScope,
  index: HistoricalIndex,
  catalog: WaveCatalog,
  fireSteps: Map<string, WaveStep[]>,
  fireCounties: Map<string, HistoricalCountyRecord>,
): FireOption[] {
  const fireReplays = new Map<string, WaveCatalog["cases"][number]>();
  for (const replay of catalog.cases) {
    const fireId = index.aliases[replay.id]?.id;
    if (fireId) fireReplays.set(fireId, replay);
  }
  const options: FireOption[] = [];
  for (const decision of scope.decisions) {
    if (!decision.eligible || !decision.mtbs) continue;
    const replay = fireReplays.get(decision.fireId);
    const steps = fireSteps.get(decision.fireId) || [];
    options.push({
      id: decision.fireId,
      selectId: replay?.id || decision.fireId,
      name: displayFireName(replay?.name || decision.mtbs.incid_name),
      year: decision.ignitionYear || 0,
      county: fireCounties.get(decision.fireId)?.primaryCounty || "",
      steps,
    });
  }
  return options;
}

export function featuredFires(options: FireOption[]): FireOption[] {
  return options
    .filter((option) => option.steps.length > 1)
    .sort(
      (a, b) => b.steps.length - a.steps.length || b.year - a.year || a.name.localeCompare(b.name),
    )
    .slice(0, 6);
}

export function filterFires(
  options: FireOption[],
  search: string,
  year: number | null,
): FireOption[] {
  const query = search.trim().toLocaleLowerCase();
  return options.filter(
    (option) =>
      (year === null || option.year === year) &&
      (!query || option.name.toLocaleLowerCase().includes(query)),
  );
}
function recentFires(options: FireOption[], featured: FireOption[]) {
  const featuredIds = new Set(featured.map((option) => option.id));
  return options
    .filter((option) => !featuredIds.has(option.id))
    .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
}

function placeAndYear(county: string, year: number | null) {
  const yearLabel = year || "Year not supplied";
  return county ? `${county}, ${yearLabel}` : String(yearLabel);
}

export function HistoricalFirePicker({
  catalog,
  selectedId,
  name,
  onSelect,
}: {
  catalog: WaveCatalog;
  selectedId: string;
  name: string;
  onSelect: (id: string) => void;
}) {
  const [options, setOptions] = useState<FireOption[]>([]);
  const [failure, setFailure] = useState("");
  const [search, setSearch] = useState("");
  const [year, setYear] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadHistoricalIndex(), loadHistoricalScope()])
      .then(async ([loadedIndex, scope]) => {
        let fireSteps = new Map<string, WaveStep[]>();
        try {
          const response = await fetch("/data/historical-fires/fire-availability.json");
          if (!response.ok) throw new Error("Fire availability could not load.");
          fireSteps = readFireAvailability(await response.json(), scope);
        } catch {
          if (!cancelled) setFailure("Data availability could not load.");
        }
        let fireCounties = new Map<string, HistoricalCountyRecord>();
        try {
          fireCounties = await loadHistoricalCountyLookup(scope);
        } catch {}
        if (cancelled) return;
        setOptions(fireOptions(scope, loadedIndex, catalog, fireSteps, fireCounties));
      })
      .catch(() => {
        if (!cancelled) setFailure("Fire list could not load.");
      });
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  const selected = options.find(
    (option) => option.selectId === selectedId || option.id === selectedId,
  );
  const replay = catalog.cases.find((item) => item.id === selectedId);
  const selectedYear = selected?.year || Number(replay?.ignition.slice(0, 4)) || null;
  const selectedCounty = selected?.county || "";
  const featured = featuredFires(options);
  const matching = filterFires(options, search, year);
  const hasSearch = search.trim().length > 0;
  const filteredFeatured = hasSearch ? [] : featured.filter((option) => matching.includes(option));
  const ordered = hasSearch
    ? matching.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name))
    : [...filteredFeatured, ...recentFires(matching, filteredFeatured)];
  const visible = ordered;
  const years = [...new Set(options.map((option) => option.year))].sort((a, b) => b - a);
  const {
    open,
    active,
    setActive,
    position,
    trigger,
    searchField,
    popover,
    chosenIndex,
    openPicker,
    closePicker: closeSelector,
    choose,
    onSearchKey,
    onDialogKey,
  } = useFirePicker(visible, (option) => onSelect(option.selectId), "parent");

  function openSelector() {
    setSearch("");
    setYear(null);
    openPicker();
  }
  useEffect(() => {
    if (!open) return;
    popover.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open, search, year]);
  return (
    <div className="fire-selector">
      <div className="fire-selector-heading">
        <div className="fire-selector-label">
          <strong>{displayFireName(name)}</strong>
          <span className="waves-place">{placeAndYear(selectedCounty, selectedYear)}</span>
        </div>
        <button
          ref={trigger}
          type="button"
          className="fire-selector-trigger"
          aria-label={`Change fire, currently ${displayFireName(name)}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => (open ? closeSelector() : openSelector())}
        >
          Change fire <span className="fire-selector-chevron" aria-hidden="true" />
        </button>
      </div>
      {failure && (
        <p className="quiet-failure" role="status">
          {failure}
        </p>
      )}
      {open &&
        createPortal(
          <>
            <div className="fire-selector-backdrop" onClick={closeSelector} aria-hidden="true" />
            <div
              ref={popover}
              className="fire-selector-popover"
              role="dialog"
              aria-label="Choose a historical fire"
              aria-modal="true"
              style={{ left: position.left, top: position.top, width: position.width }}
              onKeyDown={onDialogKey}
            >
              <div className="fire-selector-search-row">
                <input
                  ref={searchField}
                  role="combobox"
                  aria-label="Search fires by name"
                  aria-controls="fire-selector-results"
                  aria-expanded="true"
                  aria-activedescendant={
                    visible[chosenIndex] ? `fire-option-${chosenIndex}` : undefined
                  }
                  placeholder="Search fires by name"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onSearchKey}
                />
                <select
                  className="fire-selector-year"
                  aria-label="Filter by ignition year"
                  value={year ?? ""}
                  onChange={(event) => {
                    setYear(event.target.value ? Number(event.target.value) : null);
                    setActive(0);
                    searchField.current?.focus();
                  }}
                >
                  <option value="">All years</option>
                  {years.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="fire-selector-close"
                  aria-label="Close fire selector"
                  onClick={closeSelector}
                >
                  <Icon name="close" />
                </button>
              </div>
              <p className="fire-selector-count" role="status" aria-live="polite">
                {matching.length} fires found
              </p>
              <div
                id="fire-selector-results"
                className="fire-selector-results"
                role="listbox"
                aria-label="Historical fire results"
              >
                {!hasSearch && filteredFeatured.length > 0 && (
                  <div className="fire-selector-group" role="presentation">
                    Featured
                  </div>
                )}
                {visible.map((option, position) => (
                  <div
                    key={option.id}
                    id={`fire-option-${position}`}
                    className="fire-selector-option"
                    role="option"
                    data-fire-id={option.id}
                    aria-selected={option.selectId === selectedId || option.id === selectedId}
                    data-active={chosenIndex === position}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                  >
                    <span>
                      <strong>{option.name}</strong>
                      <small>{placeAndYear(option.county, option.year)}</small>
                    </span>
                    {option.steps.length > 0 && (
                      <span
                        className="fire-selector-step-icons"
                        role="img"
                        aria-label={`Linked data: ${stepIcons
                          .filter((item) => option.steps.includes(item.step))
                          .map((item) => item.name)
                          .join(", ")}`}
                      >
                        {stepIcons
                          .filter((item) => option.steps.includes(item.step))
                          .map((item) => (
                            <span key={item.step} title={item.name}>
                              <Icon name={item.icon} />
                            </span>
                          ))}
                      </span>
                    )}
                  </div>
                ))}
                {visible.length === 0 && <p className="fire-selector-empty">No matching fires</p>}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
