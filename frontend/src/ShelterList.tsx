import { useState } from "react";
import type { Feature, Point } from "geojson";
import { sheltersByDistance, type ShelterProperties } from "./redCrossShelters";

export function ShelterOptions({
  records,
  pets,
  onLocate,
  onChoose,
  compact = false,
}: {
  records: ReturnType<typeof sheltersByDistance>;
  pets: boolean;
  onLocate: (feature: Feature<Point, ShelterProperties>) => void;
  onChoose?: (feature: Feature<Point, ShelterProperties>) => void;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <ul className={`live-shelter-list${compact ? " personal-place-list" : ""}`}>
        {(expanded ? records : records.slice(0, 3)).map(({ feature, miles }) => (
          <li key={feature.properties.name + feature.geometry.coordinates.join(",")}>
            {compact ? (
              <div className="personal-place-card">
                <button
                  type="button"
                  className="personal-place-map-button"
                  onClick={() => onLocate(feature)}
                  aria-label={`Show ${feature.properties.name} on map`}
                >
                  <strong className="personal-place-name">{feature.properties.name}</strong>
                  <small>{feature.properties.address}</small>
                  <small>
                    <b>{miles.toFixed(1)} mi</b>
                  </small>
                  {pets && feature.properties.pets !== "Not supplied" && (
                    <small>
                      <b>Pets:</b> {feature.properties.pets}
                    </small>
                  )}
                </button>
                {onChoose && (
                  <button
                    type="button"
                    className="personal-place-choose"
                    onClick={() => onChoose(feature)}
                    aria-label={`Choose ${feature.properties.name}`}
                  >
                    Choose
                  </button>
                )}
              </div>
            ) : (
              <>
                <strong>{feature.properties.name}</strong>
                <small>{feature.properties.address}</small>
                <small>{miles.toFixed(1)} mi</small>
                {pets && <small>Pets: {feature.properties.pets}</small>}
              </>
            )}
            {!compact && (
              <div className={onChoose ? "personal-actions" : undefined}>
                <button
                  type="button"
                  onClick={() => onLocate(feature)}
                  aria-label={`Show ${feature.properties.name} on map`}
                >
                  Show on map
                </button>
                {onChoose && (
                  <button
                    type="button"
                    onClick={() => onChoose(feature)}
                    aria-label={`Choose ${feature.properties.name}`}
                  >
                    Choose
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {records.length > 3 && (
        <button type="button" className="personal-show-all" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${records.length}`}
        </button>
      )}
    </>
  );
}
