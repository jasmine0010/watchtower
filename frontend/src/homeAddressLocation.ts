export type HomeAddressPoint = [number, number];

export async function loadHomeAddressLocation(
  address: string,
  signal: AbortSignal,
): Promise<HomeAddressPoint> {
  const response = await fetch("/home-address-location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
    signal,
  });
  if (!response.ok) throw new Error("Home address location unavailable");
  const result = (await response.json()) as { point?: unknown };
  const point = result.point;
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new Error("Home address location unavailable");
  }
  return point as HomeAddressPoint;
}
