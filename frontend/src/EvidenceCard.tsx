import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "./Icons";
import { reportAge } from "./wavesLive";

type Props = {
  title: string;
  accessibleName?: string;
  kind?: "Observed" | "Historical" | "Forecast";
  children?: ReactNode;
  caption?: ReactNode;
  source: ReactNode;
  className?: string;
  data?: boolean;
  id?: string;
  icon?: IconName;
  updated?: ReactNode;
  loading?: boolean;
  headingAction?: ReactNode;
};

export function EvidenceCard({
  title,
  accessibleName,
  kind,
  children,
  caption,
  source,
  className = "",
  data = true,
  id,
  icon,
  updated,
  loading,
  headingAction,
}: Props) {
  const headingId = useId();
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      aria-busy={loading || undefined}
      className={`plain-card ${className}`}
      aria-labelledby={headingId}
      data-card={data ? "data" : "information"}
      data-class={kind}
    >
      <div className="evidence-heading">
        <h3 id={headingId} aria-label={accessibleName !== title ? accessibleName : undefined}>
          {icon && <Icon name={icon} />}
          {title}
        </h3>
        {headingAction}
      </div>
      {updated}
      {loading ? (
        <div className="evidence-visual">
          <LoadingBars label={`Loading ${title}`} />
        </div>
      ) : (
        children && <div className="evidence-visual">{children}</div>
      )}
      {caption && <p className="evidence-caption">{caption}</p>}
      {source !== null && source !== undefined && (
        <div className="evidence-source-footer" data-evidence="source">
          Source: {source}
        </div>
      )}
    </section>
  );
}

export function LoadingBars({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`live-skeleton ${className}`} role="status" aria-label={label}>
      <span />
      <span />
    </div>
  );
}

export function UpdateAge({
  time,
  now,
  stale = false,
  delayed = false,
}: {
  time: string | number | null;
  now: number;
  stale?: boolean;
  delayed?: boolean;
}) {
  const age = reportAge(time, now, stale, delayed);
  if (!age) return null;
  return (
    <span
      className={`live-age ${age.state}`}
      title={new Date(time!).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
      })}
    >
      {age.label}
    </span>
  );
}
