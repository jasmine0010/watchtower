import { useEffect, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import { EvidenceCard, LoadingBars } from "./EvidenceCard";
import { readDamageGeometry, type RecoveryData } from "./recovery";
import { PowerEvidence } from "./PowerEvidence";
import type { EvidenceCheck } from "./historicalEvidence";

export function RecoveryCards({ data, check }: { data?: RecoveryData; check?: EvidenceCheck }) {
  if (!data)
    return check?.reason ? (
      <p className="quiet-failure" role="status">
        {check.reason}
      </p>
    ) : (
      <LoadingBars className="compact-loading" label="Loading recovery evidence" />
    );
  const damage = data.damage;
  return (
    <div className="recovery-cards">
      {damage.status === "available" ? (
        <EvidenceCard
          title="Building damage"
          kind="Historical"
          source={<a href={damage.sourceUrl}>CAL FIRE / DINS</a>}
        >
          <div
            className="recovery-damage-bar"
            role="img"
            aria-label={damage.categories?.map((row) => `${row.label}: ${row.count}`).join("; ")}
          >
            {damage.categories
              ?.filter((row) => row.count > 0)
              .map((row) => (
                <span key={row.label} style={{ flexGrow: row.count, background: row.color }} />
              ))}
          </div>
          <ul className="recovery-category-list">
            {damage.categories
              ?.filter((row) => row.count > 0)
              .map((row) => (
                <li key={row.label}>
                  <i aria-hidden="true" style={{ background: row.color }} />
                  <span>{row.label}</span>
                  <strong>{row.count.toLocaleString()}</strong>
                </li>
              ))}
          </ul>
        </EvidenceCard>
      ) : (
        <p className="quiet-failure">Building damage / {damage.reason}</p>
      )}
      <PowerEvidence recovery={data} />
    </div>
  );
}

export function RecoveryLayers({ map, data }: { map: maplibregl.Map | null; data?: RecoveryData }) {
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!map || data?.damage.status !== "available") return;
    const controller = new AbortController();
    let popup: maplibregl.Popup | undefined;
    const current = data;
    setFailure("");
    async function load() {
      const response = await fetch(current.damage.geometryUrl!, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Inspection map could not load.");
      const geometry: FeatureCollection<Point> = readDamageGeometry(await response.json(), current);
      if (controller.signal.aborted) return;
      map!.addSource("recovery-damage", { type: "geojson", data: geometry });
      const colors: (string | string[])[] = ["match", ["get", "damage"]];
      for (const row of current.damage.categories!) colors.push(row.label, row.color);
      colors.push("#a6aeae");
      map!.addLayer({
        id: "recovery-damage",
        type: "circle",
        source: "recovery-damage",
        paint: {
          "circle-color": colors as maplibregl.ExpressionSpecification,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 14, 4],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.5,
        },
      });
      map!.on("click", "recovery-damage", showInspection);
    }
    function showInspection(event: maplibregl.MapLayerMouseEvent) {
      const feature = event.features?.[0];
      if (feature?.geometry.type !== "Point") return;
      popup?.remove();
      popup = new maplibregl.Popup()
        .setLngLat(feature.geometry.coordinates as [number, number])
        .setText(
          `${feature.properties?.damage} / ${feature.properties?.structureType || "Structure type not supplied"}. Historical exterior inspection.`,
        )
        .addTo(map!);
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setFailure(current.fireId);
    });
    return () => {
      controller.abort();
      popup?.remove();
      map.off("click", "recovery-damage", showInspection);
      if (map.getLayer("recovery-damage")) map.removeLayer("recovery-damage");
      if (map.getSource("recovery-damage")) map.removeSource("recovery-damage");
    };
  }, [map, data]);
  return failure === data?.fireId ? (
    <p className="waves-map-message fine" role="status">
      Inspection map could not load. Damage counts remain available.
    </p>
  ) : null;
}
