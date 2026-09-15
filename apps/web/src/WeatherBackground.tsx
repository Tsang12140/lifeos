import type { CSSProperties } from "react";
import type { WeatherCategory } from "./weather";

const RAIN_CONFIG: Record<"rainy" | "moderate-rainy" | "heavy-rainy" | "rainstorm" | "thunderstorm", { readonly count: number; readonly speed: number; readonly stagger: number }> = {
  rainy: { count: 14, speed: 0.72, stagger: 0.19 },
  "moderate-rainy": { count: 19, speed: 0.62, stagger: 0.15 },
  "heavy-rainy": { count: 22, speed: 0.56, stagger: 0.13 },
  rainstorm: { count: 32, speed: 0.42, stagger: 0.08 },
  thunderstorm: { count: 28, speed: 0.46, stagger: 0.09 },
};

function renderRain(category: "rainy" | "moderate-rainy" | "heavy-rainy" | "rainstorm" | "thunderstorm") {
  const config = RAIN_CONFIG[category];
  const darkDrops = category !== "rainy";
  const lightning = category === "thunderstorm";
  return <div className={`weather-bg weather-bg--${category}`} aria-hidden="true">
    {lightning ? <><div className="lightning-bolt lightning-bolt--main" /><div className="lightning-bolt lightning-bolt--side" /><div className="lightning-bolt lightning-bolt--small" /></> : null}
    {Array.from({ length: config.count }, (_, index) => <div key={index} className={`rain-drop ${darkDrops && index % 3 === 0 ? "rain-drop--dark" : ""}`} style={{ left: `${((index * 97) % 100) + 0.5}%`, animationDelay: `${((index * config.stagger) % 1.3).toFixed(2)}s`, animationDuration: `${(config.speed + (index % 5) * 0.055).toFixed(2)}s` } satisfies CSSProperties} />)}
  </div>;
}

export function WeatherBackground({ category }: { readonly category: WeatherCategory }) {
  if (category === "sunny") return <div className="weather-bg weather-bg--sunny" aria-hidden="true"><div className="sun-core" />{[0, 1, 2, 3].map((index) => <div key={index} className={`sun-orb sun-orb--${index}`} />)}</div>;
  if (category === "rainy" || category === "moderate-rainy" || category === "heavy-rainy" || category === "rainstorm" || category === "thunderstorm") return renderRain(category);
  if (category === "snowy") return <div className="weather-bg weather-bg--snowy" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <div key={index} className="snow-flake" style={{ left: `${((index * 113) % 96) + 2}%`, animationDelay: `${((index * 0.31) % 2).toFixed(2)}s`, animationDuration: `${(1.8 + (index % 4) * 0.3).toFixed(2)}s`, fontSize: `${10 + (index % 3) * 4}px` }}>❄</div>)}</div>;
  if (category === "cloudy") return <div className="weather-bg weather-bg--cloudy" aria-hidden="true"><div className="cloud cloud--1" /><div className="cloud cloud--2" /></div>;
  return <div className="weather-bg weather-bg--foggy" aria-hidden="true"><div className="fog-line fog-line--1" /><div className="fog-line fog-line--2" /><div className="fog-line fog-line--3" /></div>;
}
