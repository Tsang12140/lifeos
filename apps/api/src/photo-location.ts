import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiConfig } from "./config.js";
import { readAmapConfig } from "./amap-location.js";
import { providerSearchPoint } from "./place-proximity.js";

/**
 * Turning an EXIF coordinate into a human-readable place.
 *
 * The coordinate itself is the fact we store; the address is a convenience we
 * fetch once and remember. Three rules keep it cheap and honest:
 *
 *  1. **One lookup per distinct point, not per photo.** A day out produces
 *     dozens of photos with the same coordinate; rounding to five decimals
 *     (~1 m) collapses them into one request.
 *  2. **Serial, spaced calls.** Amap answers `CUQPS_HAS_EXCEEDED_THE_LIMIT`
 *     to a burst, so requests go through one queue with a fixed gap.
 *  3. **A miss is never fatal.** No key, no signal, a throttled minute — the
 *     panel still shows the raw coordinate and simply omits the address.
 */

export interface PhotoLocation { readonly place?: string; readonly area?: string }
export type PhotoLocationOutcome =
  | { readonly status: "resolved"; readonly location: PhotoLocation }
  | { readonly status: "unavailable"; readonly reason: "no_key" | "rate_limited" | "failed" | "disabled" };

const CACHE_VERSION = 1;
/** Five decimals is ~1 m: far tighter than the coordinate's real accuracy. */
const cacheKeyFor = (latitude: number, longitude: number) => `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
const MIN_GAP_MS = 400;
const NEGATIVE_TTL_MS = 60_000;

interface CacheEntry extends PhotoLocation { readonly at: string }
interface CacheFile { version: number; entries: Record<string, CacheEntry> }

/** Parsed results per data directory; a hit never touches the network. */
const resolved = new Map<string, Map<string, PhotoLocation>>();
/** Recently failed keys, so a dead endpoint is not retried on every open. */
const recentMisses = new Map<string, number>();
/** One in-flight lookup per coordinate: rapid photo switching must not fan out. */
const inflight = new Map<string, Promise<PhotoLocationOutcome>>();
const persisting = new Set<string>();

let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();
function throttle<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    return task();
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function cachePath(config: ApiConfig): string { return join(config.dataDirectory, "derived", "photo-addresses.json"); }

function loadCache(config: ApiConfig): Map<string, PhotoLocation> {
  const existing = resolved.get(config.dataDirectory);
  if (existing) return existing;
  const store = new Map<string, PhotoLocation>();
  try {
    const parsed = JSON.parse(readFileSync(cachePath(config), "utf8")) as CacheFile;
    if (parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry !== "object") continue;
        const place = typeof entry.place === "string" && entry.place.trim() ? entry.place.trim() : undefined;
        const area = typeof entry.area === "string" && entry.area.trim() ? entry.area.trim() : undefined;
        if (place || area) store.set(key, { ...(place ? { place } : {}), ...(area ? { area } : {}) });
      }
    }
  } catch { /* A missing or unreadable cache is not an error: refetch. */ }
  resolved.set(config.dataDirectory, store);
  return store;
}

/** Debounced, atomic rewrite — the cache is regenerable, never authoritative. */
function persist(config: ApiConfig, store: Map<string, PhotoLocation>): void {
  if (persisting.has(config.dataDirectory)) return;
  persisting.add(config.dataDirectory);
  setTimeout(() => {
    persisting.delete(config.dataDirectory);
    try {
      const entries: Record<string, CacheEntry> = {};
      for (const [key, value] of store) entries[key] = { ...value, at: new Date().toISOString() };
      mkdirSync(join(config.dataDirectory, "derived"), { recursive: true });
      const file = cachePath(config);
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: CACHE_VERSION, entries } satisfies CacheFile)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    } catch { /* Regenerable data: a failed write must never surface as a request error. */ }
  }, 500).unref?.();
}

const text = (value: unknown): string => typeof value === "string" && value.trim() && value.trim() !== "[]" ? value.trim() : "";

/** "广东省佛山市南海区大沥镇" is the answer to "where"; the province is noise. */
function areaOf(component: Record<string, unknown>): string | undefined {
  const province = text(component.province);
  const city = text(component.city) || (/市$|自治州$|地区$/.test(province) ? province : "");
  const district = text(component.district);
  const township = text(component.township);
  const parts = [city || province, district, township].filter(Boolean);
  const joined = [...new Set(parts)].join("");
  return joined && joined.length <= 60 ? joined : undefined;
}

interface RegeoBody {
  status?: string;
  info?: string;
  infocode?: string;
  regeocode?: { addressComponent?: Record<string, unknown>; aois?: Array<{ name?: unknown }>; pois?: Array<{ name?: unknown }> };
}

async function fetchLocation(config: ApiConfig, key: string, longitude: number, latitude: number, signal: AbortSignal): Promise<PhotoLocationOutcome> {
  // EXIF is WGS84; Amap speaks GCJ-02. Skipping this lands the address hundreds of metres away.
  const converted = await providerSearchPoint(config.dataDirectory, key, { longitude, latitude, accuracy: 0 }, signal);
  const url = new URL("https://restapi.amap.com/v3/geocode/regeo");
  url.search = new URLSearchParams({ key, location: `${converted.longitude.toFixed(6)},${converted.latitude.toFixed(6)}`, extensions: "all", output: "json" }).toString();
  const response = await fetch(url, { signal, redirect: "error", cache: "no-store" });
  const body = await response.json() as RegeoBody;
  if (body.infocode === "10021" || /CUQPS|EXCEEDED/i.test(body.info ?? "")) return { status: "unavailable", reason: "rate_limited" };
  if (!response.ok || body.status !== "1") return { status: "unavailable", reason: "failed" };
  const regeocode = body.regeocode ?? {};
  // The AOI is the name a person would use ("随寓青年社区"); the formatted address
  // sometimes glues a shop name into the street, so it is only a fallback.
  const place = text(regeocode.aois?.[0]?.name) || text(regeocode.pois?.[0]?.name);
  const area = areaOf(regeocode.addressComponent ?? {});
  if (!place && !area) return { status: "unavailable", reason: "failed" };
  return { status: "resolved", location: { ...(place ? { place } : {}), ...(area ? { area } : {}) } };
}

export async function photoLocation(config: ApiConfig, longitude: number, latitude: number, signal: AbortSignal): Promise<PhotoLocationOutcome> {
  // Consent is checked before the cache: switching the feature off must also
  // stop showing what was already resolved, not just stop new calls.
  const runtime = readAmapConfig(config);
  if (!runtime.photoAddress) return { status: "unavailable", reason: "disabled" };
  const store = loadCache(config);
  const key = cacheKeyFor(latitude, longitude);
  const cached = store.get(key);
  if (cached) return { status: "resolved", location: cached };
  const missedAt = recentMisses.get(`${config.dataDirectory}|${key}`);
  if (missedAt !== undefined && Date.now() - missedAt < NEGATIVE_TTL_MS) return { status: "unavailable", reason: "rate_limited" };

  const sharedKey = `${config.dataDirectory}|${key}`;
  const pending = inflight.get(sharedKey);
  if (pending) return pending;

  if (!runtime.apiKey) return { status: "unavailable", reason: "no_key" };

  const task = throttle(() => fetchLocation(config, runtime.apiKey!, longitude, latitude, signal))
    .then(outcome => {
      if (outcome.status === "resolved") {
        store.set(key, outcome.location);
        persist(config, store);
        recentMisses.delete(sharedKey);
      } else if (outcome.reason !== "no_key") recentMisses.set(sharedKey, Date.now());
      return outcome;
    })
    .catch((): PhotoLocationOutcome => {
      recentMisses.set(sharedKey, Date.now());
      return { status: "unavailable", reason: "failed" };
    })
    .finally(() => { inflight.delete(sharedKey); });
  inflight.set(sharedKey, task);
  return task;
}

/** Test seam: forget every in-memory cache (disk caches stay). */
export function resetPhotoLocationCache(): void {
  resolved.clear(); recentMisses.clear(); inflight.clear();
  lastCallAt = 0; queue = Promise.resolve();
}
