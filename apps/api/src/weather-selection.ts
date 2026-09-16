import type { WeatherObservation } from "./repository.js";

/** The most observations a single day's collection may keep. */
export const OBSERVATION_KEEP_LIMIT = 48;

/**
 * Weight decides what survives when a day overflows the limit. The point is to
 * keep the day's *story* — the moment the owner was actually outside, and the
 * moments the sky changed — while shedding the flat, evenly-spaced filler that
 * a plain hourly tick would otherwise flood the day with.
 */
export const OBSERVATION_WEIGHTS = {
  /** Hand-recorded: the owner stood there and pressed the button. */
  manual: 1000,
  /** The sky differs from the previous kept reading — the day changed. */
  changed: 500,
  /** Measured precipitation. The one honest sign it is raining. */
  precipitation: 300,
  /** A plain hourly tick, identical to its neighbour. */
  routine: 10,
} as const;

function precipMillimetres(observation: WeatherObservation): number {
  const value = Number.parseFloat(observation.precip ?? "");
  return Number.isFinite(value) ? value : 0;
}

/**
 * Scores every observation, then keeps the highest until the limit is met.
 * Sorting is stable by (weight desc, capturedAt asc), so ties are broken by
 * keeping the earlier reading — the day reads forward, and a later duplicate
 * of the same reading adds nothing.
 */
export function selectDayObservations(observations: readonly WeatherObservation[], limit = OBSERVATION_KEEP_LIMIT): readonly WeatherObservation[] {
  if (observations.length <= limit) return [...observations];
  const ordered = [...observations].sort((left, right) => left.hour - right.hour || left.source.localeCompare(right.source));
  const scored = ordered.map((observation, index) => {
    const previous = ordered[index - 1];
    const changed = previous !== undefined && previous.icon !== observation.icon;
    const weight = observation.source === "manual"
      ? OBSERVATION_WEIGHTS.manual
      : changed
        ? OBSERVATION_WEIGHTS.changed
        : precipMillimetres(observation) > 0
          ? OBSERVATION_WEIGHTS.precipitation
          : OBSERVATION_WEIGHTS.routine;
    return { observation, weight, index };
  });
  scored.sort((left, right) => right.weight - left.weight || left.index - right.index);
  const kept = scored.slice(0, limit);
  kept.sort((left, right) => left.index - right.index);
  return kept.map((entry) => entry.observation);
}
