export function formatLaTimestamp(
  input: unknown,
  missingText = "Not supplied",
  invalidText = missingText,
) {
  if (typeof input !== "string" && typeof input !== "number") return missingText;
  const date = new Date(input);
  if (!Number.isFinite(date.valueOf())) return invalidText;
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
