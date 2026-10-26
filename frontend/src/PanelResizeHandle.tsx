import { useRef, type KeyboardEvent, type PointerEvent } from "react";

function setMapHeight(dashboard: HTMLElement, height: number) {
  const available = dashboard.getBoundingClientRect().height;
  const minMap = Math.min(180, available / 2);
  const minPanel = Math.min(160, available / 2);
  const next = Math.min(Math.max(height, minMap), available - minPanel);
  dashboard.style.setProperty("--mobile-map-height", `${Math.round(next)}px`);
}

export function PanelResizeHandle() {
  const drag = useRef<{
    dashboard: HTMLElement;
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !matchMedia("(max-width: 600px)").matches) return;
    const dashboard = event.currentTarget.closest<HTMLElement>(".guided-dashboard");
    const map = dashboard?.querySelector<HTMLElement>(".map-section");
    if (!dashboard || !map) return;
    drag.current = {
      dashboard,
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: map.getBoundingClientRect().height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setMapHeight(current.dashboard, current.startHeight + event.clientY - current.startY);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const dashboard = event.currentTarget.closest<HTMLElement>(".guided-dashboard");
    const map = dashboard?.querySelector<HTMLElement>(".map-section");
    if (!dashboard || !map) return;
    event.preventDefault();
    setMapHeight(
      dashboard,
      map.getBoundingClientRect().height + (event.key === "ArrowDown" ? 24 : -24),
    );
  }

  function stopDrag() {
    drag.current = null;
  }

  return (
    <button
      type="button"
      className="panel-resize-handle"
      aria-label="Resize panel. Drag or use up and down arrow keys"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onLostPointerCapture={stopDrag}
      onKeyDown={onKeyDown}
    >
      <span aria-hidden="true" />
    </button>
  );
}
