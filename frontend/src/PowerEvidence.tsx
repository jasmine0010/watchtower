import { useEffect, useState } from "react";
import type { RecoveryData } from "./recovery";
import { EvidenceCard } from "./EvidenceCard";

type County = {
  id: string;
  name: string;
  series: { timestamp: string; customersOut: number }[];
  daily: { dateUtc: string; maximumReported: number; reportedSlots: number }[];
};
type PowerData = {
  schemaVersion: number;
  fireId: string;
  dataClass: string;
  relationship: string;
  unit: string;
  timezone: string;
  sourceUrl: string;
  methodsUrl: string;
  retrievedAt: string;
  publicationDate: string | null;
  sourceUpdatedAt: string;
  license: string;
  limitation: string;
  counties: County[];
  window: { start: string; endExclusive: string };
  fileTimestampRange: { start: string; end: string };
};

export function readPower(value: unknown, recovery: RecoveryData): PowerData {
  const data = value as PowerData;
  if (
    data?.schemaVersion !== 1 ||
    data.fireId !== recovery.fireId ||
    data.dataClass !== "Historical" ||
    data.relationship !== "nearby_time_matched" ||
    data.unit !== "reported customers without power" ||
    data.timezone !== "UTC" ||
    data.sourceUrl !== recovery.power.sourceUrl ||
    !data.license ||
    !data.limitation ||
    !Array.isArray(data.counties) ||
    !data.counties.length
  )
    throw new Error("County outage identity differs");
  const counties = new Set<string>();
  let count = 0;
  for (const county of data.counties) {
    if (
      !/^06\d{3}$/.test(county.id) ||
      counties.has(county.id) ||
      !county.name ||
      !county.series.length
    )
      throw new Error("County outage scope differs");
    counties.add(county.id);
    let previous = "";
    const days = new Map<string, { maximum: number; count: number }>();
    for (const row of county.series) {
      if (
        !Number.isFinite(Date.parse(row.timestamp)) ||
        row.timestamp <= previous ||
        !Number.isInteger(row.customersOut) ||
        row.customersOut < 0 ||
        row.timestamp < data.window.start ||
        row.timestamp >= data.window.endExclusive
      )
        throw new Error("Invalid or duplicate county/time report");
      previous = row.timestamp;
      count++;
      const key = row.timestamp.slice(0, 10);
      const day = days.get(key) || { maximum: 0, count: 0 };
      day.maximum = Math.max(day.maximum, row.customersOut);
      day.count++;
      days.set(key, day);
    }
    if (county.daily.length !== days.size) throw new Error("Outage daily summary differs");
    for (const day of county.daily) {
      const source = days.get(day.dateUtc);
      if (!source || source.maximum !== day.maximumReported || source.count !== day.reportedSlots)
        throw new Error("Outage daily summary differs");
      days.delete(day.dateUtc);
    }
  }
  if (count !== recovery.power.recordCount || counties.size !== recovery.power.countyCount)
    throw new Error("County report count differs");
  return data;
}

export function PowerEvidence({ recovery }: { recovery: RecoveryData }) {
  const [loaded, setLoaded] = useState<{
    id: string;
    data?: PowerData;
    failed?: boolean;
  } | null>(null);
  const data = loaded?.id === recovery.fireId ? loaded.data : undefined;
  useEffect(() => {
    if (recovery.power.status !== "available" || !recovery.power.seriesUrl) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(recovery.power.seriesUrl!, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unavailable");
        const value = readPower(await response.json(), recovery);
        if (!controller.signal.aborted) setLoaded({ id: recovery.fireId, data: value });
      } catch {
        if (!controller.signal.aborted) setLoaded({ id: recovery.fireId, failed: true });
      }
    }
    void load();
    return () => controller.abort();
  }, [recovery]);
  if (recovery.power.status !== "available") return null;
  if (!data)
    return (
      <EvidenceCard
        title="County outage reports"
        kind="Historical"
        source={<a href={recovery.power.sourceUrl}>ORNL EAGLE-I</a>}
        caption="County report"
        loading={loaded?.id !== recovery.fireId || !loaded.failed}
        data={false}
      >
        {loaded?.id === recovery.fireId && loaded.failed && (
          <p className="quiet-failure" role="status">
            Prepared file could not load.
          </p>
        )}
      </EvidenceCard>
    );
  const rows = [];
  for (const county of data.counties) {
    for (const day of county.daily)
      rows.push({ ...day, county: county.name, key: county.id + day.dateUtc });
  }
  return (
    <EvidenceCard
      title="County outage reports"
      kind="Historical"
      source={<a href={data.sourceUrl}>ORNL EAGLE-I</a>}
      caption="County report"
    >
      <div
        className="waves-table-scroll"
        role="region"
        aria-label="Daily maximum reported customer outages"
        tabIndex={0}
      >
        <table>
          <caption>Daily reported outages</caption>
          <thead>
            <tr>
              <th>County / UTC day</th>
              <th>Maximum reported customers out</th>
              <th>Report slots</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  {row.county} / {row.dateUtc}
                </td>
                <td>{row.maximumReported}</td>
                <td>{row.reportedSlots}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </EvidenceCard>
  );
}
