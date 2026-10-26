import { useEffect, useState } from "react";
import type { WavePlace } from "./waves";

export function placeForZip(places: WavePlace[], input: string): WavePlace | null {
  const zip = input.trim();
  if (!/^\d{5}$/.test(zip)) return null;
  const matches = places.filter((place) => place.zipcode === zip);
  return matches.length === 1 ? matches[0] : null;
}

export function zipLookupMessage(status: "loading" | "ready" | "failed") {
  if (status === "loading") return "California ZIP lookup is loading. Try again in a moment.";
  if (status === "failed") return "California ZIP lookup is unavailable. Try again shortly.";
  return "ZIP not in AirNow’s California lookup.";
}

export function PlacePicker({
  places,
  lookupStatus,
  value,
  onChange,
}: {
  places: WavePlace[];
  lookupStatus: "loading" | "ready" | "failed";
  value: string;
  onChange: (name: string) => void;
}) {
  const selected = places.find((place) => place.name === value);
  const inputId = selected ? "app-zip" : "live-zip";
  const [zip, setZip] = useState(selected?.zipcode || "");
  const [message, setMessage] = useState("");
  useEffect(() => {
    setZip(selected?.zipcode || "");
    setMessage("");
  }, [selected]);
  function choose(place: WavePlace | null) {
    onChange(place?.name || "");
    setZip(place?.zipcode || "");
    setMessage("");
  }
  return (
    <section className="app-place-picker" aria-label="Choose a ZIP code">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!zip.trim()) choose(null);
          else {
            const place = placeForZip(places, zip);
            if (place) choose(place);
            else setMessage(zipLookupMessage(lookupStatus));
          }
        }}
      >
        <label htmlFor={inputId}>California ZIP code</label>
        <div className="app-zip-entry">
          <input
            id={inputId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={5}
            placeholder="Enter ZIP"
            value={zip}
            onChange={(event) => {
              setZip(event.target.value);
              setMessage("");
            }}
          />
          <button type="submit">Use ZIP</button>
        </div>
        {message && (
          <p role="alert" className="fine">
            {message}
          </p>
        )}
      </form>
      {lookupStatus === "failed" && (
        <p className="fine" role="status">
          California ZIP lookup unavailable. Try again shortly.
        </p>
      )}
    </section>
  );
}
