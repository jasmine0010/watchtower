import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icons";
import { useAccount } from "./accountContext";
import { EvidenceCard, LoadingBars } from "./EvidenceCard";
import type { usePersonalLocation } from "./personalLocation";
import type { ZipOutline } from "./zipOutline";
import { demoStatusSource, zoneSource, type EvacuationZones } from "./evacuationZones";
import {
  matchingEvacuationZones,
  highestEvacuationZone,
  polygonsOverlap,
  reportedInstructions,
  destinationKind,
  travelRestrictions,
  type PersonalDestination,
} from "./personalGuidance";
import { type useHighwayClosures } from "./HighwayClosurePanel";
import { quickMapUrl } from "./highwayClosures";
import { ShelterOptions } from "./ShelterList";
import { redCrossFinder, sheltersByDistance, type useRedCrossShelters } from "./redCrossShelters";
import { type useReliefCenters } from "./reliefCenters";
import { pointDistanceKm } from "./wavesLive";
import type { DrivingRoute } from "./drivingRoute";

const evacuationGuide =
  "https://www.readyforwildfire.org/prepare-for-wildfire/go-evacuation-guide/";

export function ForYouSteps({
  demo,
  zip,
  zipOutline,
  location,
  onRequestLocation,
  evacuation,
  onRetry,
  onOpenCard,
  referencePoint,
  shelters,
  relief,
  onLocateDestination,
  onChooseDestination,
  drivingRoute,
  routeStatus,
  highways,
}: {
  demo: boolean;
  zip?: string;
  zipOutline: ZipOutline | null | undefined;
  location: ReturnType<typeof usePersonalLocation>;
  onRequestLocation: () => void;
  evacuation: {
    zones: EvacuationZones;
    loading: boolean;
    failed: boolean;
    checkedAt: number | null;
    outdated: number;
  };
  onRetry: () => void;
  onOpenCard: (target: string) => void;
  referencePoint: [number, number] | null;
  onChooseDestination: (destination: PersonalDestination) => void;
  drivingRoute: DrivingRoute | null;
  routeStatus: "idle" | "loading" | "ready" | "failed";
  shelters: ReturnType<typeof useRedCrossShelters>;
  relief: ReturnType<typeof useReliefCenters>;
  onLocateDestination: (destination: PersonalDestination) => void;
  highways: ReturnType<typeof useHighwayClosures>;
}) {
  const [step, setStep] = useState(0);
  const [destination, setDestination] = useState<PersonalDestination | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const heading = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  const { preferences, openPreferences } = useAccount();
  const needs = preferences.needs;
  const point = location.location;
  const age = point ? Math.max(0, Math.floor((location.now - point.timestamp) / 60000)) : 0;
  const staleZones =
    !demo &&
    (!online ||
      !evacuation.checkedAt ||
      Date.now() - evacuation.checkedAt > 10 * 60000 ||
      evacuation.failed);
  const zipZones = useMemo(
    () =>
      evacuation.zones.features.filter((feature) =>
        zipOutline?.geometry.features.some((area) =>
          polygonsOverlap(area.geometry, feature.geometry),
        ),
      ),
    [evacuation.zones, zipOutline],
  );
  const zipPrimary = highestEvacuationZone(zipZones);
  const matches = staleZones ? [] : matchingEvacuationZones(evacuation.zones, point, location.now);
  const primary = matches[0];
  const officialLink = demo ? demoStatusSource : zoneSource;
  const oldLocation = !!point && point.kind === "gps" && age > 5;
  const shelterRecords =
    shelters.snapshot && referencePoint
      ? sheltersByDistance(shelters.snapshot.data, ...referencePoint)
      : [];
  const centers = (relief.snapshot?.data.features || [])
    .map((feature) => ({
      feature,
      miles: referencePoint
        ? pointDistanceKm(referencePoint, feature.geometry.coordinates) / 1.609344
        : Infinity,
    }))
    .sort((a, b) => a.miles - b.miles);
  const listings: PersonalDestination[] = [
    ...(shelters.snapshot?.data.features || []),
    ...(relief.snapshot?.data.features || []),
  ];
  const currentDestination =
    destination &&
    listings.find(
      (item) =>
        item.properties.name === destination.properties.name &&
        item.properties.address === destination.properties.address &&
        item.geometry.coordinates.join(",") === destination.geometry.coordinates.join(","),
    );
  const selected = currentDestination || destination;
  const restrictions = travelRestrictions(
    highways.snapshot?.closures || [],
    referencePoint,
    selected,
  );
  const destinationZones =
    selected && !staleZones
      ? matchingEvacuationZones(
          evacuation.zones,
          {
            longitude: selected.geometry.coordinates[0],
            latitude: selected.geometry.coordinates[1],
            accuracy: 0,
            timestamp: Date.now(),
            kind: "pin",
          },
          Date.now(),
        )
      : [];
  const navigation =
    selected &&
    referencePoint &&
    !oldLocation &&
    online &&
    currentDestination &&
    !destinationZones.length
      ? "https://www.google.com/maps/dir/?" +
        new URLSearchParams({
          api: "1",
          origin: `${referencePoint[1]},${referencePoint[0]}`,
          destination: `${selected.geometry.coordinates[1]},${selected.geometry.coordinates[0]}`,
          travelmode: "driving",
        })
      : null;
  function chooseDestination(value: PersonalDestination) {
    setDestination(value);
    onChooseDestination(value);
    setStep(3);
  }
  const steps: { title: string; icon: IconName; label: string }[] = [
    { title: "Official evacuation information", icon: "alert", label: "Evacuation" },
    { title: "What to do now", icon: "info", label: "What to do" },
    { title: "Places to go", icon: "home", label: "Places to go" },
    { title: "Travel conditions", icon: "map", label: "Travel" },
  ];
  const zipLevel = !point && !!zip;
  let bannerZone;
  if (point) {
    bannerZone = primary?.zone;
  } else if (!staleZones && zipOutline) {
    bannerZone = zipPrimary;
  } else {
    bannerZone = undefined;
  }
  const loading =
    location.loading ||
    evacuation.loading ||
    (zipLevel && zipOutline === undefined) ||
    (step === 2 && shelters.loading) ||
    (step === 3 && highways.loading);
  const failed =
    evacuation.failed ||
    !!location.error ||
    (zipLevel && zipOutline === null) ||
    (step === 2 && !shelters.loading && !shelters.snapshot) ||
    (step === 3 && !highways.loading && !highways.snapshot);
  const unconfirmed =
    staleZones || oldLocation || (!point && !zip) || (!bannerZone && evacuation.outdated > 0);
  const noEvacuationWarning = !failed && !bannerZone && (!!point || !!zip);
  let status = bannerZone?.properties?.STATUS || "None reported";
  if (unconfirmed) status = "Current status unconfirmed";
  if (noEvacuationWarning) status = "No evacuation warning";
  if (failed) status = "Couldn't load";
  let tone = "neutral";
  if (!failed && !unconfirmed && bannerZone) {
    tone = "other";
    if (status === "Evacuation Order") tone = "order";
    if (status === "Evacuation Warning") tone = "warning";
  }
  let bannerIcon: IconName;
  if (tone === "order") {
    bannerIcon = "alert";
  } else if (tone === "warning") {
    bannerIcon = "info";
  } else if (tone === "other") {
    bannerIcon = "home";
  } else {
    bannerIcon = "map";
  }
  let placeLabel;
  if (point) {
    if (point.kind === "gps") {
      placeLabel = "GPS location";
    } else {
      placeLabel = "Map pin";
    }
  } else if (zip) {
    placeLabel = `ZIP ${zip}`;
  } else {
    placeLabel = "Choose ZIP";
  }
  const evacuationStatus = !failed && !unconfirmed ? bannerZone?.properties?.STATUS : undefined;
  const noReportedZone = !failed && !unconfirmed && !evacuationStatus;
  const showStepNavigation = !failed && !unconfirmed && !!bannerZone;
  let shelterContent: ReactNode;
  if (shelters.loading) {
    shelterContent = <LoadingBars className="compact-loading" label="Loading shelter listings" />;
  } else if (!shelters.snapshot) {
    shelterContent = <p role="status">Shelter feed unavailable; other options may exist.</p>;
  } else if (!shelters.snapshot.data.features.length) {
    shelterContent = (
      <p role="status">
        No open shelters returned by this feed. This does not mean there are no shelter options.
      </p>
    );
  } else if (referencePoint) {
    shelterContent = (
      <ShelterOptions
        records={shelterRecords}
        pets={needs.includes("pets")}
        onLocate={onLocateDestination}
        onChoose={chooseDestination}
        compact
      />
    );
  } else {
    shelterContent = <p>Choose a location to see nearby shelters.</p>;
  }
  let centerContent: ReactNode = null;
  if (!demo) {
    if (relief.loading) {
      centerContent = <LoadingBars className="compact-loading" label="Loading center listings" />;
    } else if (!relief.snapshot) {
      centerContent = <p role="status">Center listings unavailable.</p>;
    } else if (!centers.length) {
      centerContent = <p>No matching center listings returned.</p>;
    } else if (referencePoint) {
      centerContent = (
        <ul className="live-shelter-list personal-place-list">
          {centers.slice(0, 3).map(({ feature, miles }) => (
            <li key={feature.properties.name + feature.properties.address}>
              <div className="personal-place-card">
                <button
                  type="button"
                  className="personal-place-map-button"
                  onClick={() => onLocateDestination(feature)}
                  aria-label={`Show ${feature.properties.name} on map`}
                >
                  <strong className="personal-place-name">{feature.properties.name}</strong>
                  <small>{destinationKind(feature)} / opening unconfirmed</small>
                  <small>{feature.properties.address}</small>
                  <small>
                    <b>{miles.toFixed(1)} mi</b>
                  </small>
                  {feature.properties.hours && (
                    <small>
                      <b>Hours:</b> {feature.properties.hours}
                    </small>
                  )}
                  {feature.properties.contact && (
                    <small>
                      <b>Contact:</b> {feature.properties.contact}
                    </small>
                  )}
                  {needs.includes("pets") &&
                    feature.properties.pets &&
                    feature.properties.pets !== "Not supplied" && (
                      <small>
                        <b>Pets:</b> {feature.properties.pets}
                      </small>
                    )}
                </button>
                <button
                  type="button"
                  className="personal-place-choose"
                  onClick={() => chooseDestination(feature)}
                  aria-label={`Choose ${feature.properties.name}`}
                >
                  Choose
                </button>
              </div>
            </li>
          ))}
        </ul>
      );
    } else {
      centerContent = <p>Choose a location to see nearby centers.</p>;
    }
  }

  const placesContent = (
    <div className="personal-step">
      {!referencePoint && (
        <p>Choose a ZIP, use GPS or confirm a pin to order places by distance.</p>
      )}
      <h4 className="personal-shelter-heading">Open shelters</h4>
      {shelterContent}
      {!demo && (
        <>
          <h4>Clean air & cooling centers</h4>
          {centerContent}
        </>
      )}
    </div>
  );
  const bullets: ReactNode[] = [];
  if (step === 0) {
    if (evacuationStatus === "Evacuation Order")
      bullets.push(
        <>
          <strong>Evacuation order:</strong>{" "}
          <strong className="personal-guidance-order">
            Leave now. Don’t delay to finish packing;
          </strong>{" "}
          take people, pets, essential medicines or medical equipment, and follow official
          directions.
        </>,
      );
    else if (evacuationStatus === "Evacuation Warning")
      bullets.push(
        <>
          <strong>Evacuation warning:</strong> Get ready to leave: gather people and pets, essential
          items, and transportation. Leave early if you need extra time.
        </>,
      );
    else if (evacuationStatus === "Shelter In Place")
      bullets.push(
        <>
          <strong>Shelter in place:</strong> Follow the issuing authority’s instructions.
        </>,
      );
    else if (unconfirmed && demo)
      bullets.push(
        <>
          <strong>Evacuation status unconfirmed.</strong> Check official alerts.
        </>,
      );
    const instructionZone = point ? primary?.zone : zipPrimary;
    const instruction = instructionZone && reportedInstructions(instructionZone)[0];
    if (instruction)
      bullets.push(
        <>
          <strong>{instructionZone.properties?.ZONE_NAME || "Official instructions"}:</strong>{" "}
          {instruction}
        </>,
      );
    if (primary?.possible)
      bullets.push(
        <>
          <strong>Location accuracy</strong> reaches the boundary; your exact zone is uncertain.
        </>,
      );
    if (oldLocation)
      bullets.push(
        <>
          <strong>Location is old.</strong> Refresh before using location-specific information.
        </>,
      );
  }
  if (step === 1) {
    if (evacuationStatus === "Evacuation Order") {
      bullets.push(
        <>
          <strong>Evacuation order:</strong>{" "}
          <strong className="personal-guidance-order">
            Leave now. Don’t delay to finish packing;
          </strong>{" "}
          follow local officials’ directions and don’t return until they give the all-clear.
        </>,
      );
    } else if (evacuationStatus === "Evacuation Warning") {
      bullets.push(
        <>
          <strong>Evacuation warning:</strong>{" "}
          <strong className="personal-guidance-warning">Get ready to leave.</strong> Gather people
          and essentials, monitor official alerts, and{" "}
          <strong className="personal-guidance-warning">leave early</strong> if you need more time
          or have pets.
        </>,
      );
    } else if (evacuationStatus === "Shelter In Place") {
      bullets.push(
        <>
          <strong>Shelter in place:</strong>{" "}
          <strong className="personal-guidance-warning">
            Go inside the nearest safe building.
          </strong>{" "}
          Lock doors and windows, and stay until local officials give the all-clear.
        </>,
      );
    } else if (unconfirmed) {
      bullets.push(
        demo ? (
          <>
            <strong className="personal-guidance-warning">
              Couldn’t confirm current instructions.
            </strong>{" "}
            Check official alerts.
          </>
        ) : (
          <>
            <strong className="personal-guidance-warning">
              Couldn’t confirm evacuation status.
            </strong>{" "}
            Check local alerts; if you feel in danger, leave.
          </>
        ),
      );
    } else {
      bullets.push(
        <>
          <strong className="personal-guidance-info">No reported warning or evacuation zone</strong>{" "}
          matched this {zipLevel ? `ZIP ${zip} area` : "location"}.
        </>,
      );
    }

    if (needs.includes("extra-time") && !noReportedZone) {
      let preparation;
      if (evacuationStatus === "Evacuation Warning") {
        preparation = "Arrange help or transportation now; leave early.";
      } else if (evacuationStatus === "Evacuation Order") {
        preparation = "Use planned help or transportation now.";
      } else {
        preparation = "Keep your help or transportation plan ready.";
      }
      bullets.push(
        <>
          <strong>For your plan:</strong> <span>{preparation} </span>
        </>,
      );
    }

    if (needs.includes("pets") && !noReportedZone) {
      let petGuidance;
      if (evacuationStatus === "Evacuation Order") {
        petGuidance = (
          <>
            <strong className="personal-guidance-order">Take pets</strong>; bring carriers and
            medication only if at hand.
          </>
        );
      } else if (evacuationStatus === "Evacuation Warning") {
        petGuidance = (
          <>
            Get pets, carriers, and medication ready;{" "}
            <strong className="personal-guidance-warning">take pets</strong> if officials order
            evacuation, and confirm pet arrangements with your destination.
          </>
        );
      } else {
        petGuidance =
          "Get pets, carriers, and medication ready; confirm pet arrangements with your destination.";
      }
      bullets.push(
        <>
          <strong>Pets:</strong> {petGuidance}
        </>,
      );
    }
    if (needs.includes("medical-power") && !noReportedZone) {
      let medicalTone;
      if (evacuationStatus === "Evacuation Order") {
        medicalTone = "personal-guidance-order";
      } else if (evacuationStatus === "Evacuation Warning") {
        medicalTone = "personal-guidance-warning";
      } else {
        medicalTone = "personal-guidance-info";
      }
      let medicalGuidance;
      if (evacuationStatus === "Evacuation Order") {
        medicalGuidance = (
          <>
            Take{" "}
            <strong className={medicalTone}>essential medication, supplies, and equipment</strong>{" "}
            if at hand.
          </>
        );
      } else if (evacuationStatus === "Evacuation Warning") {
        medicalGuidance = (
          <>
            Get{" "}
            <strong className={medicalTone}>essential medication, supplies, and equipment</strong>{" "}
            ready.
          </>
        );
      } else {
        medicalGuidance = (
          <>
            Keep{" "}
            <strong className={medicalTone}>essential medication, supplies, and equipment</strong>{" "}
            ready.
          </>
        );
      }
      bullets.push(
        <>
          <strong>Medical needs:</strong> {medicalGuidance}
        </>,
      );
    }
  }
  if (step === 3) {
    if (selected) {
      bullets.push(
        <>
          <strong>Selected destination:</strong> {selected.properties.name} /{" "}
          {destinationKind(selected)}
        </>,
      );
      if (!currentDestination)
        bullets.push(
          <>
            <strong>This listing cannot be revalidated</strong> against the latest feed. Opening and
            availability are unconfirmed.
          </>,
        );
      if (destinationZones.length)
        bullets.push(
          <>
            <strong>A reported evacuation zone overlaps this destination.</strong> Confirm official
            instructions before traveling.
          </>,
        );
      bullets.push(
        <>
          <strong>Address:</strong> {selected.properties.address}
        </>,
      );
      if (routeStatus === "loading")
        bullets.push(
          <>
            <strong>Suggested driving path:</strong> Calculating…
          </>,
        );
      if (drivingRoute)
        bullets.push(
          <>
            <strong>Suggested driving path:</strong>{" "}
            {(drivingRoute.distanceMeters / 1609.344).toFixed(1)} mi / TomTom / calculated{" "}
            {new Date(drivingRoute.checkedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            . This is not a verified evacuation route.
          </>,
        );
      if (routeStatus === "failed")
        bullets.push(
          <>
            <strong>Suggested driving path:</strong> Unavailable.
          </>,
        );
    } else
      bullets.push(<>Choose a destination to see its context alongside reported restrictions.</>);
    if (highways.snapshot && !restrictions.length)
      bullets.push(
        <>
          <strong>No matching restrictions returned.</strong> This does not establish that roads are
          open.
        </>,
      );
  }
  let action: ReactNode = null;
  if (step === 1) {
    if (needs.includes("smoke-sensitive"))
      action = (
        <button type="button" className="personal-secondary" onClick={() => onOpenCard("live-air")}>
          {point ? "ZIP air details" : "View air quality"}
        </button>
      );
    else if (needs.includes("medical-power"))
      action = (
        <a
          className="personal-main"
          href={evacuationGuide}
          target="_blank"
          rel="noopener noreferrer"
        >
          Review evacuation preparation
        </a>
      );
    else if (needs.includes("pets"))
      action = (
        <button type="button" className="personal-secondary" onClick={() => setStep(2)}>
          Find places to go
        </button>
      );
    else if (needs.includes("extra-time"))
      action = (
        <a
          className="personal-main"
          href={evacuationGuide}
          target="_blank"
          rel="noopener noreferrer"
        >
          Review evacuation preparation
        </a>
      );
    else
      action = (
        <button type="button" className="personal-main" onClick={openPreferences}>
          Choose your needs
        </button>
      );
  }
  if (step === 3) {
    let travelAction;
    if (navigation) {
      travelAction = (
        <a
          className="personal-secondary personal-navigation"
          href={navigation}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open navigation / shares selected locations
        </a>
      );
    } else if (selected) {
      travelAction = null;
    } else {
      travelAction = (
        <button type="button" className="personal-secondary" onClick={() => setStep(2)}>
          Find places to go
        </button>
      );
    }
    action = travelAction;
  }
  let sourceLink;
  if (step === 2) {
    sourceLink = redCrossFinder;
  } else if (step === 3) {
    sourceLink = quickMapUrl;
  } else {
    sourceLink = officialLink;
  }
  return (
    <EvidenceCard
      title="For you"
      className={`live-card live-personal personal-guide${demo ? " demo-guide" : ""}`}
      data={false}
      source={unconfirmed && !demo ? null : <a href={officialLink}>Official notice</a>}
    >
      <div
        className={`personal-banner ${tone}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={loading}
      >
        {loading ? (
          <LoadingBars className="personal-skeleton" label="Checking reported evacuation zones" />
        ) : (
          <>
            <span className="personal-banner-icon" aria-hidden="true">
              <Icon name={bannerIcon} />
            </span>
            <div>
              <strong className="personal-status-name">{status}</strong>
              <strong className={`personal-place${!point && !zip ? " is-empty" : ""}`}>
                {placeLabel}
              </strong>
            </div>
          </>
        )}
      </div>
      {!failed && !(unconfirmed && !demo) && (
        <a
          className="personal-main personal-official-notice"
          href={officialLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          Official notice
        </a>
      )}
      {failed && (
        <div className="personal-failure-actions">
          <button
            type="button"
            className="personal-main"
            onClick={location.error ? onRequestLocation : onRetry}
          >
            Retry
          </button>
          <a
            className={`personal-main${sourceLink === officialLink ? " personal-official-notice" : ""}`}
            href={sourceLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            {sourceLink === officialLink ? "Official notice" : "Open official source"}
          </a>
          {sourceLink !== officialLink && (
            <a
              className="personal-main personal-official-notice"
              href={officialLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              Official notice
            </a>
          )}
        </div>
      )}
      {showStepNavigation && (
        <div className="guide-progress">
          <div className="step-dots" role="group" aria-label="For you steps">
            {steps.map(({ title, icon, label }, index) => (
              <button
                key={title}
                type="button"
                aria-label={`${index + 1} ${title}`}
                aria-current={step === index ? "step" : undefined}
                data-complete={demo ? index < step : undefined}
                onClick={() => setStep(index)}
              >
                <span className="step-number" aria-hidden="true">
                  <Icon name={icon} />
                </span>
                <span className="step-name">{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        ref={heading}
        tabIndex={-1}
        className="personal-brief-body"
        aria-label={steps[step].title}
      >
        {!loading &&
          !failed &&
          (step === 2 ? (
            placesContent
          ) : (
            <ul className="personal-bullets">
              {bullets.slice(0, 5).map((bullet, index) => (
                <li key={index}>{bullet}</li>
              ))}
            </ul>
          ))}
        {!failed && step !== 2 && action}
      </div>
    </EvidenceCard>
  );
}
