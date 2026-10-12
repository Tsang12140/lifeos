import { createHash } from "node:crypto";

export interface SearchPoint { longitude: number; latitude: number; accuracy: number }
const conversions = new Map<string, { expires: number; point: SearchPoint }>();

/** Browser GPS is WGS84; provider POIs use GCJ-02. Never compare mixed systems. */
export async function providerSearchPoint(scope: string, key: string, point: SearchPoint, signal: AbortSignal): Promise<SearchPoint> {
  const locations = `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`;
  const cacheKey = createHash("sha256").update(`${scope}|${key}|${locations}`).digest("hex");
  const prior = conversions.get(cacheKey);
  if (prior && prior.expires > Date.now()) return { ...prior.point, accuracy: point.accuracy };
  const url = new URL("https://restapi.amap.com/v3/assistant/coordinate/convert");
  url.search = new URLSearchParams({ key, locations, coordsys: "gps", output: "json" }).toString();
  const response = await fetch(url, { signal, redirect: "error", cache: "no-store" });
  const data = await response.json() as { status?: string; locations?: string };
  const parts = typeof data.locations === "string" ? data.locations.split(",") : [];
  const longitude = Number(parts[0]), latitude = Number(parts[1]);
  if (!response.ok || data.status !== "1" || parts.length !== 2 || parts.some(part => !part.trim()) || !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error("coordinate_conversion_failed");
  const converted = { longitude, latitude, accuracy: point.accuracy };
  if (conversions.size >= 128) conversions.delete(conversions.keys().next().value!);
  conversions.set(cacheKey, { expires: Date.now() + 5 * 60_000, point: converted });
  return converted;
}

export function placeDistance(point: SearchPoint, destination: { longitude?: number; latitude?: number }): number | undefined {
  if (destination.longitude === undefined || destination.latitude === undefined) return undefined;
  const rad = Math.PI / 180;
  const a = Math.sin((destination.latitude - point.latitude) * rad / 2) ** 2 + Math.cos(point.latitude * rad) * Math.cos(destination.latitude * rad) * Math.sin((destination.longitude - point.longitude) * rad / 2) ** 2;
  return Math.round(6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, a))));
}
