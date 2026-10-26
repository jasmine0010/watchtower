import type { ReactNode } from "react";
import { Icon } from "./Icons";

export function MapLegend({ children, hidden = false }: { children: ReactNode; hidden?: boolean }) {
  return (
    <details
      open={window.matchMedia("(min-width: 601px)").matches}
      className="map-legend waves-map-legend map-legend-disclosure"
      hidden={hidden}
    >
      <summary
        className="waves-map-legend-title"
        onClick={(event) => {
          if (window.matchMedia("(min-width: 601px)").matches) event.preventDefault();
        }}
      >
        <Icon name="chevron-down" /> Legend
      </summary>
      {children}
    </details>
  );
}
