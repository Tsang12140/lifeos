import { createInstant, type WeatherAttachment } from "@lifeos/core";
import type { ApiConfig } from "./config.js";
import { readRuntimeWeatherConfig, runtimeWeatherConfigForLocation, type RuntimeWeatherConfig, type WeatherLocationOverride } from "./weather-config.js";
import type { WeatherDayCache } from "./repository.js";

export interface WeatherDay {
  readonly fxDate: string;
  readonly textDay: string;
  readonly tempMax: string;
  readonly tempMin: string;
  readonly iconDay: string;
  readonly windDirDay: string;
  readonly windScaleDay: string;
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
  readonly saveWeatherDayCache: (date: string, locationKey: string, locationId: string, city: string, value: unknown, capturedAt: string) => void;
}

export interface RealtimeWeatherResult {
  readonly weather: WeatherAttachment;
  readonly location: WeatherLocation;
}

export type WeatherCategory = "sunny" | "rainy" | "heavy-rainy" | "rainstorm" | "thunderstorm" | "snowy" | "cloudy" | "foggy";

export function getWeatherCategory(iconCode: string): WeatherCategory {
  const code = Number.parseInt(iconCode, 10);
  if (code === 100 || code === 150) return "sunny";
  if (code >= 302 && code <= 304) return "thunderstorm";
  if ([308, 310, 311, 312, 317, 318].includes(code)) return "rainstorm";
  if ([307, 315, 316].includes(code)) return "heavy-rainy";
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
  const precipCategories: readonly WeatherCategory[] = ["rainy", "heavy-rainy", "rainstorm", "thunderstorm", "snowy"];
  const showAnimation = precipCategories.includes(targetCategory) || (precipCategories.includes(todayCategory) && !precipCategories.includes(targetCategory)) || Math.abs(tempDelta) >= 5;
  const tempHint = Math.abs(tempDelta) >= 5 ? tempDelta > 0 ? `升温${tempDelta}°C，注意防晒补水` : `降温${Math.abs(tempDelta)}°C，注意添衣` : null;
  return { showAnimation, category: targetCategory, tempHint, tempDelta };
}

interface QWeatherDailyResponse { readonly code?: string; readonly daily?: readonly Record<string, unknown>[]; }
interface QWeatherLocationResponse { readonly code?: string; readonly location?: readonly { readonly id?: string; readonly name?: string; readonly adm2?: string; readonly adm1?: string }[]; }
interface QWeatherHistoricalResponse { readonly code?: string; readonly weatherDaily?: { readonly date?: string; readonly tempMax?: string; readonly tempMin?: string }; readonly weatherHourly?: readonly { readonly time?: string; readonly icon?: string; readonly text?: string; readonly windDir?: string; readonly windScale?: string }[]; }
interface QWeatherNowResponse { readonly code?: string; readonly now?: { readonly obsTime?: string; readonly temp?: string; readonly text?: string; readonly icon?: string; readonly windDir?: string; readonly windScale?: string }; }

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

function currentDateShanghai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function cleanHost(value: string): string {
  return value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function weatherDayFromDaily(raw: Record<string, unknown>): WeatherDay | null {
  const fxDate = typeof raw.fxDate === "string" ? raw.fxDate : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fxDate)) return null;
  const textDay = typeof raw.textDay === "string" ? raw.textDay : "未知天气";
  const tempMax = typeof raw.tempMax === "string" ? raw.tempMax : String(raw.tempMax ?? "—");
  const tempMin = typeof raw.tempMin === "string" ? raw.tempMin : String(raw.tempMin ?? "—");
  const iconDay = typeof raw.iconDay === "string" ? raw.iconDay : "999";
  return { fxDate, textDay, tempMax, tempMin, iconDay, windDirDay: typeof raw.windDirDay === "string" ? raw.windDirDay : "", windScaleDay: typeof raw.windScaleDay === "string" ? raw.windScaleDay : "" };
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

export function clearWeatherCache(): void {
  historyCache.clear();
  snapshotCache.clear();
  locationCache = null;
}

export async function fetchWeatherSnapshot(config: ApiConfig, requestedDate?: string | null, locationOverride?: WeatherLocationOverride, archiveStore?: WeatherArchiveStore): Promise<{ readonly snapshot: WeatherSnapshot | null; readonly location: WeatherLocation | null }> {
  const runtime = runtimeWeatherConfigForLocation(config, locationOverride);
  if (!runtime.enabled || !runtime.apiKey) return { snapshot: null, location: null };
  const location = await resolveLocation(runtime);
  if (!location) return { snapshot: null, location: null };
  const targetDate = requestedDate ?? currentDateShanghai();
  const locationKey = location.id || location.name;
  const archived = archiveStore?.getWeatherDayCache(targetDate, locationKey);
  if (archived !== undefined && archived !== null) {
    const restored = archivedPayload(archived.value);
    if (restored !== null) {
      // Older archives may have captured the raw location ID before the
      // friendly-name resolver was added. Keep the cached forecast, but use
      // the current resolved label for the header and timeline.
      return { snapshot: restored.snapshot, location: restored.location.id === location.id ? location : restored.location };
    }
  }
  const cached = snapshotCache.get(`${location.id}:${runtime.apiHost}`);
  let snapshot = cached && cached.expiresAt > Date.now() ? cached.snapshot : undefined;
  if (snapshot === undefined) {
    const daily = await fetchDailyWeather(location.id, runtime);
    if (daily === null || daily.length < 2) return { snapshot: null, location };
    snapshot = { today: daily[0]!, tomorrow: daily[1]!, days: daily };
    snapshotCache.set(`${location.id}:${runtime.apiHost}`, { snapshot, location, expiresAt: Date.now() + CACHE_MS });
    if (archiveStore !== undefined) {
      const capturedAt = new Date().toISOString();
      for (const day of daily) {
        archiveStore.saveWeatherDayCache(day.fxDate, locationKey, location.id, location.name, weatherArchiveValue(oneDaySnapshot(day), location), capturedAt);
      }
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(targetDate) && findWeatherDay(snapshot, targetDate) === null && targetDate < currentDateShanghai()) {
    const historical = await fetchHistoricalWeather(targetDate, location.id, runtime);
    if (historical) {
      snapshot = { ...snapshot, days: [...snapshot.days.filter((day) => day.fxDate !== historical.fxDate), historical].sort((left, right) => left.fxDate.localeCompare(right.fxDate)) };
      archiveStore?.saveWeatherDayCache(historical.fxDate, locationKey, location.id, location.name, weatherArchiveValue(oneDaySnapshot(historical), location), new Date().toISOString());
    }
  }
  const selected = findWeatherDay(snapshot, targetDate);
  return selected === null ? { snapshot, location } : { snapshot: oneDaySnapshot(selected), location };
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
      capturedAt: createInstant(new Date().toISOString()),
    };
    return { weather, location };
  } catch {
    return null;
  }
}

export async function verifyWeatherLocation(config: ApiConfig, input: { readonly apiKey?: string; readonly locationId: string; readonly apiHost?: string }): Promise<{ readonly location: WeatherLocation }> {
  const runtime = readRuntimeWeatherConfig(config);
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
