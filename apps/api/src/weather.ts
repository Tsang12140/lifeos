import { createInstant, type WeatherAttachment } from "@lifeos/core";
import type { ApiConfig } from "./config.js";
import { readRuntimeWeatherConfig, runtimeWeatherConfigForLocation, type RuntimeWeatherConfig, type WeatherLocationOverride } from "./weather-config.js";
import type { WeatherDayCache, WeatherObservation } from "./repository.js";

export interface WeatherDay {
  readonly fxDate: string;
  readonly textDay: string;
  readonly tempMax: string;
  readonly tempMin: string;
  readonly iconDay: string;
  readonly windDirDay: string;
  readonly windScaleDay: string;
  /** QWeather already returns these on the daily endpoint; they used to be
   *  discarded. The sky renderer needs them to place dawn/dusk per city and
   *  per date instead of hardcoding 06:00/18:00. */
  readonly sunrise?: string;
  readonly sunset?: string;
}

export interface WeatherSnapshot {
  readonly today: WeatherDay;
  readonly tomorrow: WeatherDay;
  readonly days: readonly WeatherDay[];
}

export interface WeatherLocation {
  readonly id: string;
  readonly name: string;
  readonly adm2: string;
  readonly adm1: string;
}

export interface WeatherArchiveStore {
  readonly getWeatherDayCache: (date: string, locationKey: string) => WeatherDayCache | null;
  readonly listWeatherDayCache?: (from: string, to: string, locationKey?: string) => readonly WeatherDayCache[];
  readonly saveWeatherDayCache: (date: string, locationKey: string, locationId: string, city: string, value: unknown, capturedAt: string, archived?: boolean) => void;
  readonly saveWeatherObservation?: (observation: WeatherObservation) => void;
  readonly listWeatherObservations?: (date: string, locationKey?: string) => readonly WeatherObservation[];
}

export interface RealtimeWeatherResult {
  readonly weather: WeatherAttachment;
  readonly location: WeatherLocation;
}

export type WeatherCategory = "sunny" | "rainy" | "moderate-rainy" | "heavy-rainy" | "rainstorm" | "thunderstorm" | "snowy" | "cloudy" | "foggy";

export function getWeatherCategory(iconCode: string): WeatherCategory {
  const code = Number.parseInt(iconCode, 10);
  if (code === 100 || code === 150) return "sunny";
  if (code >= 302 && code <= 304) return "thunderstorm";
  if ([308, 310, 311, 312, 317, 318].includes(code)) return "rainstorm";
  if ([307, 315, 316].includes(code)) return "heavy-rainy";
  if (code === 306) return "moderate-rainy";
  if (code >= 300 && code <= 318) return "rainy";
  if (code >= 400 && code <= 410) return "snowy";
  if (code >= 500 && code <= 515) return "foggy";
  return "cloudy";
}

export function getWeatherEmoji(iconCode: string): string {
  const code = Number.parseInt(iconCode, 10);
  if (code === 100 || code === 150) return "☀️";
  if (code === 101 || code === 151) return "⛅";
  if (code === 102 || code === 152) return "🌤️";
  if (code === 103 || code === 153) return "⛅";
  if (code === 104 || code === 154) return "☁️";
  if (code === 302 || code === 303) return "⛈️";
  if (code >= 300 && code <= 318) return "🌧️";
  if (code >= 400 && code <= 410) return "❄️";
  if (code >= 500 && code <= 515) return "🌫️";
  return "🌡️";
}

export function findWeatherDay(snapshot: WeatherSnapshot | null, date: string): WeatherDay | null {
  if (!snapshot) return null;
  return snapshot.days.find((day) => day.fxDate === date) ?? (snapshot.today.fxDate === date ? snapshot.today : snapshot.tomorrow.fxDate === date ? snapshot.tomorrow : null);
}

export function getWeatherDecisionForDay(snapshot: WeatherSnapshot | null, targetDay: WeatherDay | null) {
  if (!snapshot || !targetDay) return null;
  const todayCategory = getWeatherCategory(snapshot.today.iconDay);
  const targetCategory = getWeatherCategory(targetDay.iconDay);
  const todayAverage = (Number.parseFloat(snapshot.today.tempMax) + Number.parseFloat(snapshot.today.tempMin)) / 2;
  const targetAverage = (Number.parseFloat(targetDay.tempMax) + Number.parseFloat(targetDay.tempMin)) / 2;
  const tempDelta = Math.round(targetAverage - todayAverage);
  const precipCategories: readonly WeatherCategory[] = ["rainy", "moderate-rainy", "heavy-rainy", "rainstorm", "thunderstorm", "snowy"];
  const showAnimation = precipCategories.includes(targetCategory) || (precipCategories.includes(todayCategory) && !precipCategories.includes(targetCategory)) || Math.abs(tempDelta) >= 5;
  const tempHint = Math.abs(tempDelta) >= 5 ? tempDelta > 0 ? `升温${tempDelta}°C，注意防晒补水` : `降温${Math.abs(tempDelta)}°C，注意添衣` : null;
  return { showAnimation, category: targetCategory, tempHint, tempDelta };
}

interface QWeatherDailyResponse { readonly code?: string; readonly daily?: readonly Record<string, unknown>[]; }
interface QWeatherLocationResponse { readonly code?: string; readonly location?: readonly { readonly id?: string; readonly name?: string; readonly adm2?: string; readonly adm1?: string }[]; }
interface QWeatherHistoricalResponse { readonly code?: string; readonly weatherDaily?: { readonly date?: string; readonly tempMax?: string; readonly tempMin?: string }; readonly weatherHourly?: readonly { readonly time?: string; readonly icon?: string; readonly text?: string; readonly windDir?: string; readonly windScale?: string }[]; }
interface QWeatherNowResponse { readonly code?: string; readonly now?: { readonly obsTime?: string; readonly temp?: string; readonly text?: string; readonly icon?: string; readonly windDir?: string; readonly windScale?: string; readonly precip?: string; readonly cloud?: string }; }

const GEO_HOST = "geoapi.qweather.com";
const CACHE_MS = 30 * 60 * 1000;
const historyCache = new Map<string, WeatherDay>();
const snapshotCache = new Map<string, { readonly snapshot: WeatherSnapshot; readonly location: WeatherLocation; readonly expiresAt: number }>();
let locationCache: { readonly signature: string; readonly location: WeatherLocation } | null = null;

// Project-specific QWeather hosts can serve the forecast successfully while
// rejecting the universal GeoAPI. Keep the labels for the locations we use in
// the device preview as a safe display fallback; the API lookup still wins
// whenever it is available.
const KNOWN_LOCATION_LABELS: Readonly<Record<string, Pick<WeatherLocation, "name" | "adm2" | "adm1">>> = {
  "101280803": { name: "佛山南海区", adm2: "佛山市", adm1: "广东省" },
};

export function currentDateShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

/**
 * The zone every weather date/hour is filed under. One name so the scheduler
 * and the recorder cannot drift apart.
 */
export const WEATHER_OBSERVATION_TIME_ZONE = "Asia/Shanghai";

/**
 * The hour of the day in Shanghai, 0–23. Always pair it with
 * `currentDateShanghai()`: deriving the date from a UTC slice would file a
 * post-midnight reading under the previous day.
 */
export function currentHourShanghai(value: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(value));
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Finds a cached archive without needing to resolve a location through GeoAPI. */
function cachedArchiveForDate(
  archiveStore: WeatherArchiveStore,
  runtime: RuntimeWeatherConfig,
  targetDate: string,
  today: string,
): WeatherDayCache | null {
  if (!isDateOnly(targetDate)) return null;
  const keys = [...new Set([runtime.locationId.trim(), runtime.city.trim()].filter(Boolean))];
  const candidates: WeatherDayCache[] = [];
  for (const key of keys) {
    const cached = archiveStore.getWeatherDayCache(targetDate, key);
    if (cached !== null) candidates.push(cached);
  }
  // Do not guess from a same-day row belonging to another city/profile. A
  // city-only configuration can resolve once (and then persist its location
  // ID in subsequent device requests); until that key is known, correctness
  // wins over a speculative cache hit.
  return candidates.find((candidate) => targetDate < today || candidate.archived === true) ?? null;
}

function cleanHost(value: string): string {
  return value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function clockFromDaily(raw: Record<string, unknown>, key: "sunrise" | "sunset"): string | undefined {
  const value = raw[key];
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : undefined;
}

function weatherDayFromDaily(raw: Record<string, unknown>): WeatherDay | null {
  const fxDate = typeof raw.fxDate === "string" ? raw.fxDate : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fxDate)) return null;
  const textDay = typeof raw.textDay === "string" ? raw.textDay : "未知天气";
  const tempMax = typeof raw.tempMax === "string" ? raw.tempMax : String(raw.tempMax ?? "—");
  const tempMin = typeof raw.tempMin === "string" ? raw.tempMin : String(raw.tempMin ?? "—");
  const iconDay = typeof raw.iconDay === "string" ? raw.iconDay : "999";
  const sunrise = clockFromDaily(raw, "sunrise");
  const sunset = clockFromDaily(raw, "sunset");
  return {
    fxDate,
    textDay,
    tempMax,
    tempMin,
    iconDay,
    windDirDay: typeof raw.windDirDay === "string" ? raw.windDirDay : "",
    windScaleDay: typeof raw.windScaleDay === "string" ? raw.windScaleDay : "",
    ...(sunrise === undefined ? {} : { sunrise }),
    ...(sunset === undefined ? {} : { sunset }),
  };
}

function trimAdministrativeSuffix(value: string): string {
  return value.replace(/[省市]$/, "");
}

function displayLocationName(name: string, adm2: string, adm1: string, fallback: string): string {
  const child = name.trim();
  const parent = adm2.trim() || adm1.trim();
  if (!child) return fallback;
  if (!parent || child.includes(parent)) return child;
  return `${trimAdministrativeSuffix(parent)}${child}`;
}

function oneDaySnapshot(day: WeatherDay): WeatherSnapshot {
  return { today: day, tomorrow: day, days: [day] };
}

function weatherArchiveValue(snapshot: WeatherSnapshot, location: WeatherLocation): { readonly weatherSnapshot: WeatherSnapshot; readonly location: WeatherLocation } {
  return { weatherSnapshot: snapshot, location };
}

function archivedPayload(value: unknown): { readonly snapshot: WeatherSnapshot; readonly location: WeatherLocation } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { readonly weatherSnapshot?: unknown; readonly location?: unknown };
  if (typeof candidate.weatherSnapshot !== "object" || candidate.weatherSnapshot === null || typeof candidate.location !== "object" || candidate.location === null) return null;
  const snapshot = candidate.weatherSnapshot as WeatherSnapshot;
  const location = candidate.location as WeatherLocation;
  if (!snapshot.today || !snapshot.tomorrow || !Array.isArray(snapshot.days) || typeof location.id !== "string") return null;
  return { snapshot, location };
}

async function fetchDailyWeather(locationId: string, runtime: RuntimeWeatherConfig): Promise<WeatherDay[] | null> {
  try {
    const response = await fetch(`https://${cleanHost(runtime.apiHost)}/v7/weather/7d?location=${encodeURIComponent(locationId)}&key=${encodeURIComponent(runtime.apiKey ?? "")}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as QWeatherDailyResponse;
    if (data.code !== "200" || !Array.isArray(data.daily)) return null;
    return data.daily.map(weatherDayFromDaily).filter((day): day is WeatherDay => day !== null);
  } catch {
    return null;
  }
}

async function fetchHistoricalWeather(date: string, locationId: string, runtime: RuntimeWeatherConfig): Promise<WeatherDay | null> {
  const cacheKey = `${locationId}:${date}`;
  const cached = historyCache.get(cacheKey);
  if (cached) return cached;
  try {
    const response = await fetch(`https://${cleanHost(runtime.apiHost)}/v7/historical/weather?location=${encodeURIComponent(locationId)}&date=${date.replaceAll("-", "")}&key=${encodeURIComponent(runtime.apiKey ?? "")}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as QWeatherHistoricalResponse;
    if (data.code !== "200" || !data.weatherDaily?.date || !data.weatherHourly?.length) return null;
    const representative = data.weatherHourly.find((item) => item.time?.endsWith("12:00")) ?? data.weatherHourly.find((item) => item.time?.endsWith("15:00")) ?? data.weatherHourly[Math.floor(data.weatherHourly.length / 2)];
    if (!representative?.text || !representative.icon) return null;
    const result: WeatherDay = { fxDate: data.weatherDaily.date, textDay: representative.text, tempMax: data.weatherDaily.tempMax ?? "—", tempMin: data.weatherDaily.tempMin ?? "—", iconDay: representative.icon, windDirDay: representative.windDir ?? "", windScaleDay: representative.windScale ?? "" };
    historyCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

async function resolveLocation(runtime: RuntimeWeatherConfig): Promise<WeatherLocation | null> {
  const signature = `${runtime.locationId}|${runtime.city}|${runtime.apiHost}`;
  if (locationCache?.signature === signature) return locationCache.location;
  if (runtime.locationId) {
    const known = KNOWN_LOCATION_LABELS[runtime.locationId];
    const fallback = {
      id: runtime.locationId,
      name: known?.name || runtime.city || runtime.locationId,
      adm2: known?.adm2 || "",
      adm1: known?.adm1 || "",
    };
    try {
      const response = await fetch(`https://${GEO_HOST}/v2/city/lookup?location=${encodeURIComponent(runtime.locationId)}&key=${encodeURIComponent(runtime.apiKey ?? "")}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const data = await response.json() as QWeatherLocationResponse;
      const match = data.code === "200" ? data.location?.find((item) => item.id === runtime.locationId) ?? data.location?.[0] : undefined;
      if (match?.id) {
        const location = { id: match.id, name: displayLocationName(match.name ?? "", match.adm2 ?? "", match.adm1 ?? "", runtime.city || match.id), adm2: match.adm2 ?? "", adm1: match.adm1 ?? "" };
        locationCache = { signature, location };
        return location;
      }
    } catch {
      // The forecast can still work when the optional name lookup is unavailable.
    }
    locationCache = { signature, location: fallback };
    return fallback;
  }
  if (!runtime.city) return null;
  try {
    const response = await fetch(`https://${GEO_HOST}/v2/city/lookup?location=${encodeURIComponent(runtime.city)}&key=${encodeURIComponent(runtime.apiKey ?? "")}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as QWeatherLocationResponse;
    const match = data.code === "200" ? data.location?.[0] : undefined;
    if (!match?.id) return null;
    const location = { id: match.id, name: displayLocationName(match.name ?? "", match.adm2 ?? "", match.adm1 ?? "", runtime.city), adm2: match.adm2 ?? "", adm1: match.adm1 ?? "" };
    locationCache = { signature, location };
    return location;
  } catch {
    return null;
  }
}

/**
 * Turn a device's coordinates into the city the forecast should use. The GeoAPI
 * answers `location=lon,lat` on the same lookup endpoint, so a phone can name
 * its own city instead of asking the person to spell it.
 *
 * Coordinates are rounded to two decimals (roughly a kilometre) before leaving
 * the process: the provider resolves a city, not a doorway, and a shorter
 * string is one less precise trace handed to a third party. Only the resolved
 * city id and name are ever stored.
 */
export async function lookupWeatherLocationByCoordinates(runtime: RuntimeWeatherConfig, longitude: number, latitude: number): Promise<WeatherLocation | null> {
  const apiKey = runtime.apiKey;
  if (!apiKey) return null;
  const location = `${longitude.toFixed(2)},${latitude.toFixed(2)}`;
  try {
    const response = await fetch(`https://${GEO_HOST}/v2/city/lookup?location=${encodeURIComponent(location)}&key=${encodeURIComponent(apiKey)}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as QWeatherLocationResponse;
    const match = data.code === "200" ? data.location?.[0] : undefined;
    if (!match?.id) return null;
    return { id: match.id, name: displayLocationName(match.name ?? "", match.adm2 ?? "", match.adm1 ?? "", match.id), adm2: match.adm2 ?? "", adm1: match.adm1 ?? "" };
  } catch {
    return null;
  }
}

export function clearWeatherCache(): void {
  historyCache.clear();
  snapshotCache.clear();
  locationCache = null;
  forcedRefreshAt.clear();
}

/**
 * The owner asked for a fresh forecast rather than the cached one. We still
 * refuse to hammer the provider: a manual refresh is allowed once every five
 * minutes, and the caller is told how long to wait instead of being handed an
 * error, because "slow down" is not a failure.
 *
 * The escape hatch is deliberate. Pressing again after being told to wait is
 * reported as `escalated`, and the caller is allowed through — someone who
 * deliberately presses twice has just told us they do not care about the quota.
 */
export const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const forcedRefreshAt = new Map<string, number>();

export type ForcedRefreshDecision = { readonly allowed: true; readonly escalated: boolean } | { readonly allowed: false; readonly retryAfterMs: number };

export function decideForcedRefresh(key: string, now: number, escalated = false): ForcedRefreshDecision {
  const previous = forcedRefreshAt.get(key);
  if (previous !== undefined && now - previous < REFRESH_MIN_INTERVAL_MS) {
    if (!escalated) return { allowed: false, retryAfterMs: REFRESH_MIN_INTERVAL_MS - (now - previous) };
    // The second press inside the window is the point, not an accident.
    forcedRefreshAt.set(key, now);
    return { allowed: true, escalated: true };
  }
  forcedRefreshAt.set(key, now);
  return { allowed: true, escalated: false };
}

export async function fetchWeatherSnapshot(config: ApiConfig, requestedDate?: string | null, locationOverride?: WeatherLocationOverride, archiveStore?: WeatherArchiveStore, options: { readonly force?: boolean } = {}): Promise<{ readonly snapshot: WeatherSnapshot | null; readonly location: WeatherLocation | null }> {
  const runtime = runtimeWeatherConfigForLocation(config, locationOverride);
  if (!runtime.enabled || !runtime.apiKey) return { snapshot: null, location: null };
  const targetDate = requestedDate ?? currentDateShanghai();
  const today = currentDateShanghai();
  // This check intentionally precedes resolveLocation: a hit in the SQLite
  // archive must not spend an external request merely to recover a friendly
  // location label. The archived payload already carries its own location.
  const cachedBeforeResolve = archiveStore === undefined ? null : cachedArchiveForDate(archiveStore, runtime, targetDate, today);
  if (cachedBeforeResolve !== null) {
    const restored = archivedPayload(cachedBeforeResolve.value);
    if (restored !== null) return { snapshot: restored.snapshot, location: restored.location };
    // A row for the exact date/location is still authoritative. Do not turn a
    // malformed local payload into an external request while viewing history.
    return { snapshot: null, location: null };
  }
  const location = await resolveLocation(runtime);
  if (!location) return { snapshot: null, location: null };
  const locationKey = location.id || location.name;
  const archived = archiveStore?.getWeatherDayCache(targetDate, locationKey);
  const canReadArchive = targetDate < today || archived?.archived === true;
  if (archived !== undefined && archived !== null && canReadArchive) {
    const restored = archivedPayload(archived.value);
    if (restored !== null) {
      // Older archives may have captured the raw location ID before the
      // friendly-name resolver was added. Keep the cached forecast, but use
      // the current resolved label for the header and timeline.
      return { snapshot: restored.snapshot, location: restored.location.id === location.id ? location : restored.location };
    }
    return { snapshot: null, location };
  }
  // Keyed by location only, on purpose: what goes in here is the *forecast
  // list* (`today` / `tomorrow` / `days`), which is the same answer for every
  // target date. Which day comes back is decided below by `findWeatherDay`, and
  // a past day is served from the archive instead of this cache — so sharing
  // one entry between "yesterday" and "today" cannot return the wrong day.
  const cached = snapshotCache.get(`${location.id}:${runtime.apiHost}`);
  // `force` is the owner asking a second time; skip the TTL but still refresh
  // the entry so the next ordinary read sees the newer snapshot.
  let snapshot = options.force === true ? undefined : cached && cached.expiresAt > Date.now() ? cached.snapshot : undefined;
  if (snapshot === undefined) {
    const daily = await fetchDailyWeather(location.id, runtime);
    if (daily === null || daily.length < 2) return { snapshot: null, location };
    snapshot = { today: daily[0]!, tomorrow: daily[1]!, days: daily };
    snapshotCache.set(`${location.id}:${runtime.apiHost}`, { snapshot, location, expiresAt: Date.now() + CACHE_MS });
    if (archiveStore !== undefined) {
      const capturedAt = new Date().toISOString();
      for (const day of daily) {
        archiveStore.saveWeatherDayCache(day.fxDate, locationKey, location.id, location.name, weatherArchiveValue(oneDaySnapshot(day), location), capturedAt, false);
      }
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(targetDate) && findWeatherDay(snapshot, targetDate) === null && targetDate < currentDateShanghai()) {
    const historical = await fetchHistoricalWeather(targetDate, location.id, runtime);
    if (historical) {
      snapshot = { ...snapshot, days: [...snapshot.days.filter((day) => day.fxDate !== historical.fxDate), historical].sort((left, right) => left.fxDate.localeCompare(right.fxDate)) };
      archiveStore?.saveWeatherDayCache(historical.fxDate, locationKey, location.id, location.name, weatherArchiveValue(oneDaySnapshot(historical), location), new Date().toISOString(), true);
    }
  }
  const selected = findWeatherDay(snapshot, targetDate);
  return selected === null ? { snapshot, location } : { snapshot: oneDaySnapshot(selected), location };
}

/**
 * Captures one day's final weather into SQLite. The write is monotonic: a
 * forecast row can become archived, but an archive is never downgraded by a
 * later forecast refresh.
 */
export async function archiveWeatherDay(
  config: ApiConfig,
  date: string,
  locationOverride: WeatherLocationOverride | undefined,
  archiveStore: WeatherArchiveStore,
): Promise<boolean> {
  if (!isDateOnly(date)) return false;
  const runtime = runtimeWeatherConfigForLocation(config, locationOverride);
  if (!runtime.enabled || !runtime.apiKey) return false;
  const directKeys = [...new Set([runtime.locationId.trim(), runtime.city.trim()].filter(Boolean))];
  if (directKeys.some((key) => archiveStore.getWeatherDayCache(date, key)?.archived === true)) return true;
  const result = await fetchWeatherSnapshot(config, date, locationOverride, archiveStore);
  if (result.snapshot === null || result.location === null) return false;
  const day = findWeatherDay(result.snapshot, date) ?? result.snapshot.today;
  const locationKey = result.location.id || result.location.name;
  archiveStore.saveWeatherDayCache(
    day.fxDate,
    locationKey,
    result.location.id,
    result.location.name,
    weatherArchiveValue(oneDaySnapshot(day), result.location),
    new Date().toISOString(),
    true,
  );
  return true;
}

export async function fetchRealtimeWeather(config: ApiConfig, locationOverride?: WeatherLocationOverride): Promise<RealtimeWeatherResult | null> {
  const runtime = runtimeWeatherConfigForLocation(config, locationOverride);
  if (!runtime.enabled || !runtime.apiKey) return null;
  const location = await resolveLocation(runtime);
  if (!location) return null;
  try {
    const response = await fetch(`https://${cleanHost(runtime.apiHost)}/v7/weather/now?location=${encodeURIComponent(location.id)}&key=${encodeURIComponent(runtime.apiKey)}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as QWeatherNowResponse;
    const now = data.code === "200" ? data.now : undefined;
    if (!now?.text || !now.icon) return null;
    const weather: WeatherAttachment = {
      mode: "realtime",
      locationId: location.id,
      city: location.name || runtime.city || location.id,
      text: now.text,
      icon: now.icon,
      ...(now.temp === undefined ? {} : { temperature: now.temp }),
      ...(now.windDir === undefined ? {} : { windDir: now.windDir }),
      ...(now.windScale === undefined ? {} : { windScale: now.windScale }),
      // Kept because they are the only evidence of actual precipitation; the
      // provider's `text` alone reports "overcast" during a local downpour.
      ...(now.precip === undefined ? {} : { precip: now.precip }),
      ...(now.cloud === undefined ? {} : { cloud: now.cloud }),
      ...(now.obsTime === undefined ? {} : { observedAt: now.obsTime }),
      capturedAt: createInstant(new Date().toISOString()),
    };
    return { weather, location };
  } catch {
    return null;
  }
}

/**
 * Files one reading of the sky. The table's primary key collapses repeats in
 * the same hour, so calling this twice inside one hour is one fact, not two.
 *
 * `source` records who asked: "auto" for the hourly tick, "manual" for the
 * owner pressing the button — the latter is the one that means "I was outside
 * right then", so the day's selection weights it highest.
 */
export function recordWeatherObservation(
  store: WeatherArchiveStore | undefined,
  input: { readonly weather: WeatherAttachment; readonly location: WeatherLocation; readonly source: "auto" | "manual"; readonly at?: Date },
): boolean {
  if (store?.saveWeatherObservation === undefined) return false;
  const at = input.at ?? new Date();
  const locationKey = input.location.id || input.location.name;
  if (locationKey === "") return false;
  store.saveWeatherObservation({
    date: currentDateShanghai(),
    hour: currentHourShanghai(at),
    locationKey,
    locationId: input.location.id,
    city: input.location.name || input.location.id,
    source: input.source,
    text: input.weather.text,
    icon: input.weather.icon,
    ...(input.weather.temperature === undefined ? {} : { temperature: input.weather.temperature }),
    ...(input.weather.precip === undefined ? {} : { precip: input.weather.precip }),
    ...(input.weather.cloud === undefined ? {} : { cloud: input.weather.cloud }),
    ...(input.weather.windDir === undefined ? {} : { windDir: input.weather.windDir }),
    ...(input.weather.windScale === undefined ? {} : { windScale: input.weather.windScale }),
    ...(input.weather.observedAt === undefined ? {} : { observedAt: input.weather.observedAt }),
    capturedAt: new Date().toISOString(),
  });
  return true;
}

export async function verifyWeatherLocation(config: ApiConfig, input: { readonly apiKey?: string; readonly locationId: string; readonly apiHost?: string }): Promise<{ readonly location: WeatherLocation }> {  const runtime = readRuntimeWeatherConfig(config);
  const apiKey = input.apiKey?.trim() || runtime.apiKey;
  const locationId = input.locationId.trim();
  const apiHost = cleanHost(input.apiHost?.trim() || runtime.apiHost);
  if (!apiKey) throw new Error("请先填写和风天气 API Key");
  if (!locationId) throw new Error("位置 ID 不能为空");
  const response = await fetch(`https://${apiHost}/v7/weather/3d?location=${encodeURIComponent(locationId)}&key=${encodeURIComponent(apiKey)}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const data = await response.json() as { readonly code?: string };
  if (data.code !== "200") {
    const hint = data.code === "401" ? "（Key 无效）" : data.code === "402" ? "（超出调用限额）" : data.code === "404" ? "（位置 ID 不存在）" : "";
    throw new Error(`天气 API 返回 ${data.code ?? response.status}${hint}`);
  }
  const known = KNOWN_LOCATION_LABELS[locationId];
  return { location: { id: locationId, name: known?.name || locationId, adm2: known?.adm2 || "", adm1: known?.adm1 || "" } };
}
