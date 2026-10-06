export interface WeatherDay {
  readonly fxDate: string;
  readonly textDay: string;
  readonly tempMax: string;
  readonly tempMin: string;
  readonly iconDay: string;
  readonly windDirDay: string;
  readonly windScaleDay: string;
  /** Passed through from the daily forecast so the sky can put dawn and dusk in
   *  the right place for this city on this date. */
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

export interface WeatherConfigStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly hasKey: boolean;
  readonly source: "env" | "file" | "shared" | "none";
  readonly locationId: string;
  readonly city: string;
  readonly apiHost: string;
  readonly locationScope: "device" | "default";
}

export interface WeatherProfile {
  readonly id: string;
  readonly label: string;
  readonly locationId: string;
  readonly city: string;
  readonly apiHost: string;
  readonly hasKey: boolean;
}

export type WeatherCategory = "sunny" | "partly-cloudy" | "overcast" | "rainy" | "moderate-rainy" | "heavy-rainy" | "rainstorm" | "thunderstorm" | "snowy" | "cloudy" | "foggy";

export const SOLAR_POSITION_INTERVAL_MS = 5 * 60 * 1000;

export interface SolarPosition {
  /** Horizontal centre as a percentage of the sky, kept in its right side. */
  readonly x: number;
  /** Vertical centre as a percentage of the sky. */
  readonly y: number;
  /** Visibility through the short sunrise/sunset handoff. */
  readonly opacity: number;
}

const NEUTRAL_SOLAR_POSITION: SolarPosition = { x: 84, y: 32, opacity: 1 };
const HIDDEN_MOON_POSITION: SolarPosition = { x: 84, y: 32, opacity: 0 };
const CELESTIAL_FADE_MINUTES = 15;

/** A perceptual size cue for the existing sky arc, not a distance model.
 * Keep the highest point at its base size and enlarge the horizon by 12%.
 * Smoothstep eases both ends without discrete dawn/day/dusk size changes. */
export function getCelestialScale(y: number): number {
  if (!Number.isFinite(y)) return 1;
  const low = Math.max(0, Math.min(1, (y - 22) / 48));
  return 1 + 0.12 * low * low * (3 - 2 * low);
}

const CHINA_WEATHER_REGIONS = new Set([
  "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾",
  "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门",
]);

/** The current API only returns trustworthy sunrise/sunset values for the configured China location. */
export function hasKnownChinaWeatherTimeZone(location: Pick<WeatherLocation, "adm1"> | null): boolean {
  if (location === null) return false;
  const normalized = location.adm1.trim()
    .replace(/(壮族|回族|维吾尔)自治区$/, "")
    .replace(/(特别行政区|自治区|省|市)$/, "");
  return CHINA_WEATHER_REGIONS.has(normalized);
}

export interface WeatherClock {
  readonly date: string;
  readonly time: string;
}

/** Use the API's Shanghai day boundary for China locations; otherwise use the device's local zone. */
export function weatherClockAt(value: Date, timeZone?: string): WeatherClock {
  const resolvedTimeZone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolvedTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year ?? "1970"}-${byType.month ?? "01"}-${byType.day ?? "01"}`,
    time: `${byType.hour ?? "00"}:${byType.minute ?? "00"}`,
  };
}

export function shouldRefreshSolarPosition(visibilityState: string, isCurrentDay: boolean, hasKnownTimeZone: boolean, category: WeatherCategory): boolean {
  return visibilityState === "visible" && isCurrentDay && hasKnownTimeZone && categoryFollowsPhase(category);
}

function strictClockMinutes(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function smoothVisibility(value: number, start: number, end: number): number {
  const progress = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return progress * progress * (3 - 2 * progress);
}

function usableDaylight(day: WeatherDay | null): { sunrise: number; sunset: number } | null {
  if (day === null) return null;
  const sunrise = strictClockMinutes(day.sunrise);
  const sunset = strictClockMinutes(day.sunset);
  if (sunrise === null || sunset === null || sunset - sunrise < 4 * 60 || sunset - sunrise > 20 * 60) return null;
  return { sunrise, sunset };
}

function daylightVisibility(now: number, sunrise: number, sunset: number): number {
  return smoothVisibility(now, sunrise - CELESTIAL_FADE_MINUTES, sunrise + CELESTIAL_FADE_MINUTES)
    * (1 - smoothVisibility(now, sunset - CELESTIAL_FADE_MINUTES, sunset + CELESTIAL_FADE_MINUTES));
}

/**
 * Continuous daily solar arc for today's China-local forecast. Other dates,
 * unknown location zones, invalid times, and extreme daylight lengths use a
 * stable noon position instead of suggesting false precision.
 */
export function getSolarPosition(day: WeatherDay | null, nowClock: string, isCurrentDay: boolean): SolarPosition {
  if (!isCurrentDay || day === null) return NEUTRAL_SOLAR_POSITION;
  const daylight = usableDaylight(day);
  const now = strictClockMinutes(nowClock);
  if (daylight === null || now === null) return NEUTRAL_SOLAR_POSITION;

  const { sunrise, sunset } = daylight;
  const progress = (now - sunrise) / (sunset - sunrise);
  const visibleProgress = Math.min(1, Math.max(0, progress));
  const arc = Math.sin(Math.PI * progress);
  return {
    x: 78 + visibleProgress * 12,
    y: Math.max(18, Math.min(82, 70 - arc * 48)),
    opacity: daylightVisibility(now, sunrise, sunset),
  };
}

/** A scenic night arc, not an astronomical moonrise prediction. It hands the
 * light to the sun at dawn and receives it back at dusk. */
export function getMoonPosition(day: WeatherDay | null, nowClock: string, isCurrentDay: boolean): SolarPosition {
  if (!isCurrentDay) return HIDDEN_MOON_POSITION;
  const now = strictClockMinutes(nowClock);
  if (now === null) return HIDDEN_MOON_POSITION;
  const { sunrise, sunset } = usableDaylight(day) ?? { sunrise: 6 * 60, sunset: 18 * 60 };
  const nightLength = 24 * 60 - (sunset - sunrise);
  const progress = now < sunrise + CELESTIAL_FADE_MINUTES
    ? (now + 24 * 60 - sunset) / nightLength
    : (now - sunset) / nightLength;
  return {
    x: 78 + Math.max(0, Math.min(1, progress)) * 12,
    y: Math.max(18, Math.min(82, 70 - Math.sin(Math.PI * progress) * 48)),
    opacity: 1 - daylightVisibility(now, sunrise, sunset),
  };
}

export function getWeatherCategory(iconCode: string): WeatherCategory {
  const code = Number.parseInt(iconCode, 10);
  if (code === 100 || code === 150) return "sunny";
  // QWeather separates these codes, and so should the UI: 101 is "partly
  // cloudy" and 104 is "overcast". Collapsing them made the header claim 多云
  // while the sky was grey.
  if (code === 101 || code === 151 || code === 102 || code === 152 || code === 103 || code === 153) return "partly-cloudy";
  if (code === 104 || code === 154) return "overcast";
  if (code >= 302 && code <= 304) return "thunderstorm";
  if ([308, 310, 311, 312, 317, 318].includes(code)) return "rainstorm";
  if ([307, 315, 316].includes(code)) return "heavy-rainy";
  if (code === 306) return "moderate-rainy";
  if (code >= 300 && code <= 318) return "rainy";
  if (code >= 400 && code <= 410) return "snowy";
  if (code >= 500 && code <= 515) return "foggy";
  return "cloudy";
}

/**
 * The second axis of the sky: what time of day it is. Kept separate from
 * `WeatherCategory` on purpose. A category decides *what is drawn*; a phase only
 * decides *what colour it is and where the light sits*. Rain looks the same at
 * 10:00 and 15:00, so rain must not change shape with the phase — but a sunny
 * morning and a sunny night have nothing in common, so sunshine must.
 *
 * `day` is the neutral daytime phase used for dates that are not today: a daily
 * forecast has no hour attached, so claiming "夜晚" for tomorrow's card at 22:00
 * would be a lie.
 */
export type WeatherPhase = "dawn" | "morning" | "day" | "afternoon" | "dusk" | "night";

const DEFAULT_SUNRISE = "06:00";
const DEFAULT_SUNSET = "18:00";
/** How far either side of sunrise/sunset counts as dawn/dusk. */
const TWILIGHT_MINUTES = 45;

function clockMinutes(clock: string | undefined, fallback: string): number {
  const value = typeof clock === "string" && /^\d{2}:\d{2}$/.test(clock) ? clock : fallback;
  const [hour, minute] = value.split(":");
  return Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10);
}

export function getWeatherPhase(day: WeatherDay | null, selectedDate: string, today: string, nowClock: string): WeatherPhase {
  // Only today has a time of day. Other dates get the neutral daylight phase.
  if (selectedDate !== today) return "day";
  const sunrise = clockMinutes(day?.sunrise, DEFAULT_SUNRISE);
  const sunset = clockMinutes(day?.sunset, DEFAULT_SUNSET);
  const now = clockMinutes(nowClock, "12:00");
  // Solar noon is the midpoint of the real sunrise and sunset, so the
  // morning/afternoon split tracks the season instead of the wall clock.
  const noon = (sunrise + sunset) / 2;
  if (now < sunrise - TWILIGHT_MINUTES) return "night";
  if (now < sunrise + TWILIGHT_MINUTES) return "dawn";
  if (now < noon) return "morning";
  if (now < sunset - TWILIGHT_MINUTES) return "afternoon";
  if (now < sunset + TWILIGHT_MINUTES) return "dusk";
  return "night";
}

export interface SunEventMoment {
  readonly kind: "sunrise" | "sunset";
  readonly time: string;
}

const SUN_EVENT_HINT_MINUTES = 3 * 60;

/** The small weather-card hint is visible only during the current day's
 * three-hour window on either side of an actual forecast event. */
export function getSunEventMoment(day: WeatherDay | null, nowClock: string, isCurrentDay: boolean): SunEventMoment | null {
  if (!isCurrentDay || day === null) return null;
  const now = strictClockMinutes(nowClock);
  if (now === null) return null;
  const candidates = ([
    { kind: "sunrise", time: day.sunrise },
    { kind: "sunset", time: day.sunset },
  ] as const).flatMap((event) => {
    const at = strictClockMinutes(event.time);
    return at !== null && now - at >= -SUN_EVENT_HINT_MINUTES && now - at < SUN_EVENT_HINT_MINUTES ? [{ kind: event.kind, time: event.time!, distance: Math.abs(now - at) }] : [];
  });
  const nearest = candidates.sort((left, right) => left.distance - right.distance)[0];
  return nearest ? { kind: nearest.kind, time: nearest.time } : null;
}

/** China forecast clocks use UTC+08:00. A single timeout at the next edge is
 * enough to update the hint even when the weather is rainy and the sky clock
 * has no five-minute timer. */
export function nextSunEventBoundaryDelay(day: WeatherDay | null, date: string, nowMs: number): number | null {
  if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dayStart = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(dayStart)) return null;
  const boundaries = [day.sunrise, day.sunset].flatMap((clock) => {
    const minute = strictClockMinutes(clock);
    return minute === null ? [] : [dayStart + (minute - SUN_EVENT_HINT_MINUTES) * 60_000, dayStart + (minute + SUN_EVENT_HINT_MINUTES) * 60_000];
  });
  const next = boundaries.filter((boundary) => boundary > nowMs).sort((left, right) => left - right)[0];
  return next === undefined ? null : Math.max(1, next - nowMs);
}

/** Categories that draw a light source, and therefore have to answer to the phase. */
const LIT_CATEGORIES: readonly WeatherCategory[] = ["sunny", "partly-cloudy"];

export function categoryFollowsPhase(category: WeatherCategory): boolean {
  return LIT_CATEGORIES.includes(category);
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

export function weatherMessage(day: WeatherDay, tempHint?: string | null): string {
  return `${day.textDay}，${day.tempMin}~${day.tempMax}°C${tempHint ? `  ${tempHint}` : ""}`;
}

export function getWeatherDecision(snapshot: WeatherSnapshot | null, targetDay: WeatherDay | null): { readonly category: WeatherCategory; readonly tempHint: string | null; readonly showAnimation: boolean } | null {
  if (!snapshot || !targetDay) return null;
  const todayCategory = getWeatherCategory(snapshot.today.iconDay);
  const targetCategory = getWeatherCategory(targetDay.iconDay);
  const todayAverage = (Number.parseFloat(snapshot.today.tempMax) + Number.parseFloat(snapshot.today.tempMin)) / 2;
  const targetAverage = (Number.parseFloat(targetDay.tempMax) + Number.parseFloat(targetDay.tempMin)) / 2;
  const tempDelta = Math.round(targetAverage - todayAverage);
  const precipitation: readonly WeatherCategory[] = ["rainy", "moderate-rainy", "heavy-rainy", "rainstorm", "thunderstorm", "snowy"];
  const tempHint = Math.abs(tempDelta) >= 5 ? tempDelta > 0 ? `升温${tempDelta}°C，注意防晒补水` : `降温${Math.abs(tempDelta)}°C，注意添衣` : null;
  return { category: targetCategory, tempHint, showAnimation: precipitation.includes(targetCategory) || (precipitation.includes(todayCategory) && !precipitation.includes(targetCategory)) || Math.abs(tempDelta) >= 5 };
}
