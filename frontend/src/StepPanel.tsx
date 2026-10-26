import { useEffect, useRef, type ReactNode } from "react";
import type { WaveStep } from "./navigation";
import { Icon } from "./Icons";
import { isStackedLayout } from "./layout";
import { PanelResizeHandle } from "./PanelResizeHandle";

const waveIcons = {
  smoke: "smoke",
  recovery: "home",
  rain: "droplet",
  context: "map",
} as const;

export function StepPanel({
  steps,
  active,
  onStep,
  context,
  children,
  selectionKey = "",
}: {
  steps: readonly { id: WaveStep; question: string }[];
  active: WaveStep;
  onStep: (id: WaveStep) => void;
  context?: ReactNode;
  children: ReactNode;
  selectionKey?: string;
}) {
  const index = Math.max(
    0,
    steps.findIndex((step) => step.id === active),
  );
  const step = steps[index];
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const previous = useRef({ active, selectionKey });
  useEffect(() => {
    const selectionChanged = previous.current.selectionKey !== selectionKey;
    const changed = previous.current.active !== active || selectionChanged;
    previous.current = { active, selectionKey };
    if (!changed) return;

    if (selectionChanged)
      panel.current
        ?.querySelector<HTMLButtonElement>(".fire-selector-trigger")
        ?.focus({ preventScroll: true });
    else heading.current?.focus({ preventScroll: true });

    if (isStackedLayout(panel.current)) panel.current?.scrollIntoView({ block: "start" });
    else if (panel.current) panel.current.scrollTop = 0;
  }, [active, selectionKey]);
  return (
    <aside ref={panel} className="guide-panel" aria-label="After the fire" data-wave={active}>
      <PanelResizeHandle />
      {context}
      <div className="guide-progress">
        <div className="step-dots" role="group" aria-label="Information steps">
          {steps.map((item, position) => (
            <button
              key={item.id}
              data-step={item.id}
              data-wave={item.id}
              data-complete={position < index}
              aria-label={`${position + 1} ${item.question}`}
              aria-current={position === index ? "step" : undefined}
              onClick={() => {
                onStep(item.id);
                if (item.id === step.id) heading.current?.focus({ preventScroll: true });
              }}
            >
              <span className="step-number" aria-hidden="true">
                <Icon name={waveIcons[item.id]} />
              </span>{" "}
              <span className="step-name" aria-hidden="true">
                {item.question}
              </span>
            </button>
          ))}
        </div>
      </div>
      <section
        key={`${selectionKey}:${step.id}`}
        className="guide-card"
        aria-labelledby="step-heading"
        data-step={step.id}
      >
        <div className="step-title">
          <h2 id="step-heading" ref={heading} tabIndex={-1}>
            <Icon name={waveIcons[active]} />
            {step.question}
          </h2>
        </div>
        {children}
      </section>
    </aside>
  );
}
