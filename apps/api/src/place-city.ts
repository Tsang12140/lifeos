import { createHash } from "node:crypto";
import type { ApiConfig } from "./config.js";
import { readAmapConfig } from "./amap-location.js";
import { HttpError } from "./http-kit.js";
import { providerSearchPoint, type SearchPoint } from "./place-proximity.js";

const cache = new Map<string, { until: number; city: string }>();
const limits = new Map<string, { since: number; count: number }>();
/** Resolve a city for this search only. No weather/profile or location writes. */
export async function locatePlaceCity(config: ApiConfig, point: SearchPoint, signal: AbortSignal): Promise<{ city: string }> {
  const runtime = readAmapConfig(config);
  if (!runtime.apiKey) throw new HttpError(409, "amap_key_missing", "请先配置高德 Web 服务 Key，再定位城市");
  const key = createHash("sha256").update(JSON.stringify([config.dataDirectory, runtime.apiKey, point.longitude, point.latitude])).digest("hex");
  const previous = cache.get(key); if (previous && previous.until > Date.now()) return { city: previous.city };
  if (limits.size > 2048) limits.clear();
  const old = limits.get(config.dataDirectory), limit = old && Date.now() - old.since < 60_000 ? old : { since: Date.now(), count: 0 };
  if (limit.count >= 20) throw new HttpError(429, "location_limit", "定位过于频繁，请稍后重试");
  limit.count++; limits.set(config.dataDirectory, limit);
  try {
    const converted = await providerSearchPoint(config.dataDirectory, runtime.apiKey, point, signal);
    const url = new URL("https://restapi.amap.com/v3/geocode/regeo");
    url.search = new URLSearchParams({ key: runtime.apiKey, location: `${converted.longitude},${converted.latitude}`, extensions: "base", output: "json" }).toString();
    const response = await fetch(url, { signal, redirect: "error", cache: "no-store" });
    const body = await response.json() as { status?: string; regeocode?: { addressComponent?: { city?: unknown; province?: unknown } } };
    const component = body.regeocode?.addressComponent;
    const city = typeof component?.city === "string" && component.city.trim() ? component.city.trim() : typeof component?.province === "string" && ["北京市", "上海市", "天津市", "重庆市"].includes(component.province) ? component.province : "";
    if (!response.ok || body.status !== "1" || !city || city.length > 80) throw new Error("city_not_resolved");
    if (cache.size > 128) cache.clear(); cache.set(key, { until: Date.now() + 60_000, city });
    return { city };
  } catch { throw new HttpError(502, "place_city_unavailable", "暂时无法确定当前城市，请重试或手动选择"); }
}
