import { createClient } from "@supabase/supabase-js";

const projectUrl = import.meta.env?.VITE_SUPABASE_URL?.trim();
const publishableKey = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const supabase =
  projectUrl && publishableKey
    ? createClient(projectUrl, publishableKey, { auth: { flowType: "pkce" } })
    : null;

export const welcomeKey = "wildfire-welcome-dismissed";
export const guestPreferencesKey = "wildfire-guest-preferences";
export const preferenceOptions = [
  { id: "extra-time", label: "I need extra time or assistance to leave" },
  {
    id: "smoke-sensitive",
    label: "I am sensitive to smoke",
  },
  { id: "pets", label: "I have pets" },
  { id: "medical-power", label: "I have medical needs during an evacuation" },
] as const;

export type Need = (typeof preferenceOptions)[number]["id"];
export type Preferences = {
  homeLocationType: "address" | "zip" | "none";
  homeAddress: string;
  homeZip: string;
  needs: Need[];
};
type StoredPreferences = {
  home_location_type: Preferences["homeLocationType"];
  home_address: string;
  home_zip: string;
  needs: Need[];
};
export const emptyPreferences: Preferences = {
  homeLocationType: "none",
  homeAddress: "",
  homeZip: "",
  needs: [],
};

export function storedPreferences(preferences: Preferences): StoredPreferences {
  return {
    home_location_type: preferences.homeLocationType,
    home_address: preferences.homeAddress,
    home_zip: preferences.homeZip,
    needs: preferences.needs,
  };
}

export function readPreferences(value: unknown): Preferences {
  const record = value as Partial<StoredPreferences> | null;
  const homeAddress =
    typeof record?.home_address === "string" ? record.home_address.trim().slice(0, 300) : "";
  const homeZip =
    typeof record?.home_zip === "string" && /^\d{5}$/.test(record.home_zip) ? record.home_zip : "";
  const savedType = record?.home_location_type;
  const homeLocationType =
    savedType === "address" || savedType === "zip" || savedType === "none"
      ? savedType
      : homeAddress
        ? "address"
        : homeZip
          ? "zip"
          : "none";
  const needs = preferenceOptions
    .filter((option) => Array.isArray(record?.needs) && record.needs.includes(option.id))
    .map((option) => option.id);
  return { homeLocationType, homeAddress, homeZip, needs };
}

export function readGuestPreferences(): Preferences {
  try {
    return readPreferences(JSON.parse(localStorage.getItem(guestPreferencesKey) || "null"));
  } catch {
    return emptyPreferences;
  }
}

export function welcomeDismissed() {
  try {
    return sessionStorage.getItem(welcomeKey) === "true";
  } catch {
    return false;
  }
}
