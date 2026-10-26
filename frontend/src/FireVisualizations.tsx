import { imageDates, mappedFireArea, type FireAssessment } from "./mtbs";
import { designStormText, utcDate, type UsgsAssessment } from "./usgsAssessments";
import type { FireProducts } from "./useFireProducts";
import type { StepId } from "./navigation";
import { displayDate, displayUnits } from "./units";
import { BurnSeverityPanel } from "./burnArea";
import { EvidenceCard } from "./EvidenceCard";

type Props = {
  fire: FireAssessment | null;
  agency: UsgsAssessment | null;
  products: FireProducts;
  step: StepId;
};

export function fireEvidenceDates(fire: FireAssessment | null, agency: UsgsAssessment | null) {
  const events: { label: string; date: string | null }[] = [];
  const pre = imageDates(fire?.pre_id ?? null);
  const post = imageDates(fire?.post_id ?? null);
  for (const date of pre) events.push({ label: "Before scene", date });
  const ignition = fire?.ig_date.slice(0, 10) || utcDate(agency?.start_date);
  if (ignition !== "Unavailable") events.push({ label: "Fire start", date: ignition });
  for (const date of post) events.push({ label: "After scene", date });
  const assessed = utcDate(agency?.assessment_date);
  if (assessed !== "Unavailable") events.push({ label: "USGS assessment", date: assessed });
  events.sort((a, b) => a.date!.localeCompare(b.date!));
  if (!pre.length) events.push({ label: "Before scene", date: null });
  if (!post.length) events.push({ label: "After scene", date: null });
  if (ignition === "Unavailable") events.push({ label: "Fire start", date: null });
  if (assessed === "Unavailable") events.push({ label: "USGS assessment", date: null });
  events.push({ label: "Recorded storm", date: null }, { label: "Outcome recorded", date: null });
  return events;
}

function CatalogBurn({ fire, agency, products }: Omit<Props, "step">) {
  const area = fire ? mappedFireArea(fire.burnbndac) : (agency?.size ?? NaN);
  if (products.burnArea.status === "available" || products.burnArea.status === "map")
    return <BurnSeverityPanel data={products.burnArea} />;
  if (!Number.isFinite(area)) return null;
  return (
    <EvidenceCard
      title="Mapped burned area"
      kind="Historical"
      source={
        <a
          href={
            fire
              ? "https://www.mtbs.gov/"
              : "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer"
          }
        >
          {fire ? "USGS / USFS MTBS" : "USGS assessment"}
        </a>
      }
      caption="Mapped fire area"
    >
      <p className="catalog-area">{displayUnits(area, "area").us.toFixed(2)} square miles</p>
    </EvidenceCard>
  );
}
function CatalogTimeline({ fire, agency }: Pick<Props, "fire" | "agency">) {
  const events = fireEvidenceDates(fire, agency);
  return (
    <EvidenceCard
      title="Historical timeline"
      kind="Historical"
      source={<a href="https://www.mtbs.gov/">MTBS catalog and USGS assessment</a>}
      caption="Scenario"
    >
      <figure className="guide-chart catalog-outcome-chart">
        <ol className="catalog-timeline" aria-label="Historical evidence dates">
          {events
            .filter((event) => event.date)
            .map((event) => (
              <li key={event.label + event.date}>
                <span className="timeline-dot" aria-hidden="true" />
                <span>{event.label}</span>
                <time dateTime={event.date!}>{displayDate(event.date!)}</time>
              </li>
            ))}
        </ol>
      </figure>
    </EvidenceCard>
  );
}

export function FireVisualizations({ fire, agency, products, step }: Props) {
  const assessment = agency || Object.values(products.hazards)[0]?.record || null;
  if (step === "burn") return <CatalogBurn fire={fire} agency={agency} products={products} />;
  if (step === "steep") return null;
  if (step === "rain") {
    if (!assessment) return null;
    return (
      <EvidenceCard
        title="Published rainfall scenario"
        kind="Historical"
        source={
          <a href="https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer">
            USGS assessment
          </a>
        }
        caption="Scenario"
      >
        <p className="chart-readout">{designStormText(assessment.Rainfall)}</p>
      </EvidenceCard>
    );
  }
  return <CatalogTimeline fire={fire} agency={assessment} />;
}
