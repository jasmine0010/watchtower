import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";

export type PersonalLocation = {
  longitude: number;
  latitude: number;
  accuracy: number;
  timestamp: number;
  kind: "gps" | "pin";
};
export type LocationReading = {
  coords: Pick<GeolocationCoordinates, "longitude" | "latitude" | "accuracy">;
  timestamp: number;
};

export function usePersonalLocation() {
  const [location, setLocation] = useState<PersonalLocation | null>(null);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const requestVersion = useRef(0);
  const accept = useCallback((position: LocationReading) => {
    const { longitude, latitude, accuracy } = position.coords;
    const next: PersonalLocation = {
      longitude,
      latitude,
      accuracy,
      timestamp: position.timestamp,
      kind: "gps",
    };
    setLocation(next);
    setNow(Date.now());
    setLoading(false);
    setError("");
    return next;
  }, []);
  const fail = useCallback((error?: Pick<GeolocationPositionError, "code">) => {
    setLoading(false);
    setFollowing(false);
    let message;
    if (error?.code === 1) {
      message =
        "Location access blocked. Allow location for this site in your browser and device settings, then try again.";
    } else if (error?.code === 3) {
      message = "Location request timed out. Try again or place a pin.";
    } else {
      message = "Location unavailable. Use a ZIP or place a pin instead.";
    }
    setError(message);
  }, []);
  function request(): Promise<PersonalLocation | null> {
    if (!window.isSecureContext) {
      setError("Location requires HTTPS or localhost. Use a ZIP or place a pin instead.");
      return Promise.resolve(null);
    }
    if (!navigator.geolocation) {
      fail();
      return Promise.resolve(null);
    }
    setFollowing(false);
    setLoading(true);
    setError("");
    const version = ++requestVersion.current;
    return new Promise((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(version === requestVersion.current ? accept(position) : null),
        (error) => {
          if (version === requestVersion.current) fail(error);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
      ),
    );
  }
  function clear() {
    requestVersion.current++;
    setLoading(false);
    setFollowing(false);
    setLocation(null);
    setError("");
  }
  const pin = useCallback((longitude: number, latitude: number) => {
    requestVersion.current++;
    setLoading(false);
    setFollowing(false);
    setLocation({ longitude, latitude, accuracy: 0, timestamp: Date.now(), kind: "pin" });
    setError("");
  }, []);
  useEffect(() => {
    if (!following || !navigator.geolocation) return;
    let active = true;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        if (active) accept(position);
      },
      (error) => {
        if (active) fail(error);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
    return () => {
      active = false;
      navigator.geolocation.clearWatch(watch);
    };
  }, [following, accept, fail]);
  useEffect(() => {
    if (!location) return;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [location]);
  useEffect(
    () => () => {
      requestVersion.current++;
    },
    [],
  );
  return { location, following, setFollowing, loading, error, now, accept, request, clear, pin };
}

export function locationAccuracy(location: PersonalLocation | null): FeatureCollection {
  if (!location || !location.accuracy) return { type: "FeatureCollection", features: [] };
  const ring = [];
  for (let index = 0; index <= 64; index++) {
    const angle = (index * Math.PI) / 32;
    ring.push([
      location.longitude +
        (Math.cos(angle) * location.accuracy) /
          (111320 * Math.cos((location.latitude * Math.PI) / 180)),
      location.latitude + (Math.sin(angle) * location.accuracy) / 111320,
    ]);
  }
  ring[64] = ring[0];
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } },
    ],
  };
}
