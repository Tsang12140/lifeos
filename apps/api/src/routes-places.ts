import { PLACE_CITY_CATALOG, type Place, type PlaceDetails } from "@lifeos/core";
import { readAmapConfig } from "./amap-location.js";
import { HttpError, setJson } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { boundedIntegerField, hasOnlyKeys, jsonObject, stringField } from "./field-validate.js";
import type { RouteHandler } from "./route-context.js";
import { setTimeout as delay } from "node:timers/promises";

export interface PlaceSearchItem extends PlaceDetails { name: string; address?: string; role?: string }
const limits = new Map<string, { time: number; count: number }>();
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const transientCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
function transportCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "TimeoutError") return "TIMEOUT";
  const item = error as Error & { code?: unknown; cause?: { code?: unknown } };
  const code = item.cause?.code ?? item.code;
  return typeof code === "string" && transientCodes.has(code) ? code : "unknown";
}

/** Retry a broken connection once, within one shared deadline. Never log the URL/key. */
export async function requestPlaceSearch(url: URL) {
  const signal = AbortSignal.timeout(10000);
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: "error", signal, cache: "no-store" });
      const data = await response.json() as { status?: string; infocode?: string; pois?: unknown[] } | null;
      return { response, data };
    } catch (error) {
      const code = transportCode(error);
      const retry = attempt === 1 && transientCodes.has(code) && !signal.aborted;
      console.warn(JSON.stringify({ event: "amap_search_transport", attempt, code, retry }));
      if (!retry) throw error;
      await delay(150, undefined, { signal });
    }
  }
}
export function normalisePoi(value: unknown): PlaceSearchItem | null {
  if (!value || typeof value !== "object") return null;
  const poi = value as Record<string, any>;
  const name = text(poi.name).slice(0, 200), amapId = text(poi.id);
  if (!name || !/^[A-Za-z0-9_-]{1,100}$/.test(amapId)) return null;
  const [longitude, latitude] = text(poi.location).split(",").map(Number);
  let photoUrl: string | undefined;
  for (const photo of Array.isArray(poi.photos) ? poi.photos : []) {
    try { const url = new URL(text(photo?.url)); if (url.protocol === "http:") url.protocol = "https:"; if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2000) { photoUrl = url.href; break; } } catch { /* Optional image may be missing or malformed. */ }
  }
  const type = text(poi.typecode);
  const role = type.startsWith("05") ? "dining" : type.startsWith("06") ? "shopping" : type.startsWith("09") ? "medical" : /^(10|11)/.test(type) ? "travel" : type.startsWith("14") ? "school" : undefined;
  const fields = { phone: text(poi.business?.tel || poi.tel).slice(0, 200), city: text(poi.cityname).slice(0, 200), province: text(poi.pname).slice(0, 200), district: text(poi.adname).slice(0, 200), address: text(poi.address).slice(0, 500) };
  return { name, amapId, ...Object.fromEntries(Object.entries(fields).filter(([, val]) => val)), ...(role ? { role } : {}), ...(photoUrl ? { photoUrl } : {}), ...(Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude!) <= 180 && Math.abs(latitude!) <= 90 ? { longitude: longitude!, latitude: latitude! } : {}) };
}

export const handlePlacesRoutes: RouteHandler = async (ctx, req, res, pathname) => {
  if (pathname === "/api/places/cities" && req.method === "GET") {
    const places = new Map(ctx.repository.listEntities({ type: "place" }).filter((p): p is Place => p.type === "place").map(p => [p.id, p]));
    const names = [...new Set(Object.values(PLACE_CITY_CATALOG).flat())];
    const counts = new Map<string, { city: string; count: number; recent: number; last: string }>();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const cutoff = Date.now() - 30 * 86400000;
    for (const record of ctx.repository.list({ kind: "journal" })) {
      if (record.isPrivate || record.isDemo) continue;
      const time = record.occurredAt ?? record.createdAt;
      const date = time.value;
      const recordDay = time.kind === "instant" ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(date)) : date.substring(0, 10);
      if (recordDay > today) continue;
      const body = record.body.edited ?? record.body.original;
      const cities = new Set<string>();
      for (const city of names) if (body.includes(city.replace(/市$/u, ""))) cities.add(city);
      for (const ref of record.entityRefs) { const city = places.get(ref.entityId)?.city; if (city) cities.add(names.find(name => name.replace(/市$/u, "") === city.replace(/市$/u, "")) ?? city); }
      if (record.weather?.city) { const match = names.find(city => record.weather!.city.startsWith(city.replace(/市$/u, ""))); if (match) cities.add(match); }
      for (const city of cities) { const item = counts.get(city) ?? { city, count: 0, recent: 0, last: "" }; item.count++; if (Date.parse(date) >= cutoff) item.recent++; if (date > item.last) item.last = date; counts.set(city, item); }
    }
    const items = [...counts.values()];
    setJson(res, 200, { frequent: items.sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, 6).map(item => item.city), recent: items.filter(item => item.recent).sort((a, b) => b.recent - a.recent || b.last.localeCompare(a.last)).slice(0, 6).map(item => item.city) }); return true;
  }
  if (pathname !== "/api/places/search" || req.method !== "POST") return false;
  requireJsonContentType(req);
  const input = jsonObject(await readBody(req, ctx.config.bodyLimitBytes), "body");
  hasOnlyKeys(input, ["query", "city", "page"]);
  const query = stringField(input.query, "query", { nonEmpty: true }).trim();
  const city = input.city === undefined ? "" : stringField(input.city, "city").trim();
  const page = input.page === undefined ? 1 : boundedIntegerField(input.page, "page", 1, 20);
  if (!query || query.length > 80 || city.length > 80) throw new HttpError(400, "invalid_query", "关键词或城市过长，请缩短后再搜");
  const runtime = readAmapConfig(ctx.config);
  if (!runtime.apiKey) throw new HttpError(409, "amap_key_missing", "请先配置高德 Web 服务 Key，再搜索店铺或地址");
  const key = ctx.config.dataDirectory;
  if (limits.size > 2048) limits.clear();
  const limit = limits.get(key);
  if (limit && limit.time > Date.now() - 60000 && limit.count >= 30) throw new HttpError(429, "search_limit", "搜索太频繁，请稍后再试");
  limits.set(key, limit && limit.time > Date.now() - 60000 ? { ...limit, count: limit.count + 1 } : { time: Date.now(), count: 1 });
  const url = new URL("https://restapi.amap.com/v5/place/text");
  url.search = new URLSearchParams({ key: runtime.apiKey, keywords: query, ...(city ? { region: city, city_limit: "true" } : {}), show_fields: "business,photos", page_size: "10", page_num: String(page) }).toString();
  try {
    const { response, data } = await requestPlaceSearch(url);
    if (!response.ok || data?.status !== "1" || !Array.isArray(data.pois)) {
      const code = /^\d{5}$/.test(data?.infocode ?? "") ? data!.infocode : "unknown";
      throw new HttpError(502, "amap_search_failed", `高德搜索暂不可用（${code}），请检查 Key 的搜索权限或配额`);
    }
    const items = data.pois.map(normalisePoi).filter((item): item is PlaceSearchItem => item !== null);
    setJson(res, 200, { items, page, hasMore: data.pois.length === 10 && page < 20, source: "amap" });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "amap_search_unavailable", "地点搜索连接失败或超时，请重试");
  }
  return true;
};
