import type { CSSProperties } from "react";
import type { WeatherCategory, WeatherPhase } from "./weather";

/**
 * The sky is drawn on two axes.
 *
 * `category` decides the structure: how many drops, how many clouds, whether
 * there is a light source at all.
 * `phase` decides only the colour tokens and where the light sits. It never
 * changes the structure, so adding a phase costs zero extra DOM and zero extra
 * animation.
 *
 * Every category is held to a hard budget of 20 elements so a richer sky can
 * never turn into a heavier page. Current worst case is moderate rain at 20.
 */

type RainCategory = "rainy" | "moderate-rainy" | "heavy-rainy" | "rainstorm" | "thunderstorm";

interface RainPlan {
  readonly drops: number;
  readonly speed: number;
  readonly stagger: number;
}

const RAIN_PLANS: Record<RainCategory, RainPlan> = {
  rainy: { drops: 14, speed: 0.72, stagger: 0.19 },
  "moderate-rainy": { drops: 19, speed: 0.62, stagger: 0.15 },
  // Heavy rain and up used to add two fast-moving stripe sheets for density.
  // A fine periodic pattern (10px stripes) travelling at 226px/s is 22.6 cycles
  // a second, and two sheets at different periods also interfere with each other
  // — the owner reported a moire-like shimmer. Measured on the rendered pixels,
  // the sheets multiplied the card's high-frequency energy by 2.9 and left a
  // 19px periodic signal at 0.89 correlation. Drops are aperiodic and measure at
  // the clear-sky noise floor, so the density comes from more, thicker drops.
  "heavy-rainy": { drops: 19, speed: 0.46, stagger: 0.11 },
  rainstorm: { drops: 19, speed: 0.38, stagger: 0.09 },
  thunderstorm: { drops: 15, speed: 0.42, stagger: 0.12 },
};

interface CloudSpec {
  readonly tier: "far" | "mid" | "near";
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly drift: number;
}

/** Overcast is the whole point of the layering: far clouds are wide, pale and
 *  slow, near clouds are small, dark and quick. Depth, not decoration. */
const OVERCAST_CLOUDS: readonly CloudSpec[] = [
  { tier: "far", left: 2, top: 0, width: 210, drift: 38 },
  { tier: "far", left: 30, top: 2, width: 230, drift: 44 },
  { tier: "far", left: 58, top: 0, width: 200, drift: 34 },
  { tier: "far", left: 82, top: 3, width: 180, drift: 40 },
  { tier: "mid", left: 14, top: 26, width: 136, drift: 25 },
  { tier: "mid", left: 44, top: 23, width: 152, drift: 29 },
  { tier: "mid", left: 74, top: 27, width: 130, drift: 22 },
  { tier: "near", left: 6, top: 55, width: 104, drift: 17 },
  { tier: "near", left: 38, top: 52, width: 116, drift: 19 },
  { tier: "near", left: 70, top: 57, width: 96, drift: 15 },
];

const CLOUDY_CLOUDS: readonly CloudSpec[] = [
  { tier: "far", left: 10, top: 4, width: 196, drift: 36 },
  { tier: "far", left: 56, top: 1, width: 214, drift: 32 },
  { tier: "mid", left: 30, top: 28, width: 144, drift: 24 },
  { tier: "near", left: 64, top: 55, width: 108, drift: 16 },
];

/** Kept clear of the right-hand side so the sun still shows through. */
const PARTLY_CLOUDS: readonly CloudSpec[] = [
  { tier: "mid", left: 32, top: 21, width: 158, drift: 25 },
  { tier: "near", left: 56, top: 53, width: 114, drift: 17 },
];

function Clouds({ specs }: { readonly specs: readonly CloudSpec[] }) {
  return <>{specs.map((spec, index) => (
    <div
      key={`${spec.tier}-${index}`}
      className={`cloud cloud--${spec.tier}`}
      style={{
        left: `${spec.left}%`,
        top: `${spec.top}px`,
        width: `${spec.width}px`,
        animationDuration: `${spec.drift}s`,
        animationDelay: `${((index * 1.7) % 6).toFixed(2)}s`,
      } satisfies CSSProperties}
    />
  ))}</>;
}

function Luminary({ night }: { readonly night: boolean }) {
  return <>
    {/* At night the stars replace the sun's rays, so the element count is the
        same in both cases. */}
    {night ? <div className="sky-stars" /> : <div className="sky-rays" />}
    <div className="sky-halo" />
    <div className="sky-disc" />
  </>;
}

function Rain({ category }: { readonly category: RainCategory }) {
  const plan = RAIN_PLANS[category];
  return <>
    {Array.from({ length: plan.drops }, (_, index) => (
      <div
        key={`drop-${index}`}
        className={`rain-drop ${index % 3 === 0 ? "rain-drop--dark" : ""}`}
        style={{
          left: `${((index * 97) % 100) + 0.5}%`,
          animationDelay: `${((index * plan.stagger) % 1.3).toFixed(2)}s`,
          animationDuration: `${(plan.speed + (index % 5) * 0.055).toFixed(2)}s`,
        } satisfies CSSProperties}
      />
    ))}
    {category === "thunderstorm" ? <>
      <div className="sky-flash" />
      <div className="lightning-bolt lightning-bolt--main" />
      <div className="lightning-bolt lightning-bolt--side" />
    </> : null}
  </>;
}

export function WeatherBackground({ category, phase }: { readonly category: WeatherCategory; readonly phase: WeatherPhase }) {
  const night = phase === "night";
  const lit = category === "sunny" || category === "partly-cloudy";
  const rootClass = `weather-bg weather-bg--${category} weather-bg--${phase}`;

  if (lit) {
    return <div className={rootClass} aria-hidden="true">
      <div className="sky-horizon" />
      <Luminary night={night} />
      {category === "partly-cloudy" ? <Clouds specs={PARTLY_CLOUDS} /> : null}
    </div>;
  }

  if (category === "rainy" || category === "moderate-rainy" || category === "heavy-rainy" || category === "rainstorm" || category === "thunderstorm") {
    return <div className={rootClass} aria-hidden="true">
      <div className="sky-horizon" />
      <Rain category={category} />
    </div>;
  }

  if (category === "snowy") {
    return <div className={rootClass} aria-hidden="true">
      <div className="sky-horizon" />
      <div className="snow-field" />
      {Array.from({ length: 10 }, (_, index) => (
        <div
          key={index}
          className="snow-flake"
          style={{
            left: `${((index * 113) % 96) + 2}%`,
            animationDelay: `${((index * 0.31) % 2).toFixed(2)}s`,
            animationDuration: `${(1.8 + (index % 4) * 0.3).toFixed(2)}s`,
            fontSize: `${10 + (index % 3) * 4}px`,
            opacity: `${(0.5 + (index % 4) * 0.14).toFixed(2)}`,
          } satisfies CSSProperties}
        >❄</div>
      ))}
    </div>;
  }

  if (category === "cloudy" || category === "overcast") {
    return <div className={rootClass} aria-hidden="true">
      <div className="sky-horizon" />
      <Clouds specs={category === "overcast" ? OVERCAST_CLOUDS : CLOUDY_CLOUDS} />
    </div>;
  }

  return <div className={rootClass} aria-hidden="true">
    <div className="sky-horizon" />
    <div className="fog-band fog-band--1" />
    <div className="fog-band fog-band--2" />
    <div className="fog-band fog-band--3" />
  </div>;
}
