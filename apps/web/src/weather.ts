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
  const precipitation: readonly WeatherCategory[] = ["rainy", "heavy-rainy", "rainstorm", "thunderstorm", "snowy"];
  const tempHint = Math.abs(tempDelta) >= 5 ? tempDelta > 0 ? `升温${tempDelta}°C，注意防晒补水` : `降温${Math.abs(tempDelta)}°C，注意添衣` : null;
  return { category: targetCategory, tempHint, showAnimation: precipitation.includes(targetCategory) || (precipitation.includes(todayCategory) && !precipitation.includes(targetCategory)) || Math.abs(tempDelta) >= 5 };
}
