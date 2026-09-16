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
  readonly source: "env" | "file" | "none";
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
