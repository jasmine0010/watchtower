export type UsgsAssessment = {
  Fire_ID: string;
  fire: string;
  lat: number | null;
  lon: number | null;
  location: string | null;
  size: number | null;
  status: string | null;
  disclaimer: string | null;
  Rainfall: string | null;
  start_date: number | null;
  assessment_date: number | null;
  ScienceBaseURL: string | null;
  download_url: string | null;
};

export function utcDate(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString().slice(0, 10) : "Unavailable";
}

export function designStormText(value: string | null): string {
  if (!value?.trim()) return "Unavailable";

  const millimetres = value.trim().match(/^(\d+(?:\.\d+)?)\s*mm$/i);
  if (millimetres) return `${millimetres[1]} mm/hour (peak 15-minute intensity)`;
  return `${value.trim()} (source text; rate interpretation not verified)`;
}
