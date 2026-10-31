import type { Asset, AssetLink } from "@lifeos/core";

/**
 * The default 发生时间 for a journal entry, judged from its photos.
 *
 * The field means "when it happened", but its default was the keyboard's clock —
 * when it was typed. A photo carries a better answer: its EXIF capture time. Two
 * conditions keep that from becoming a wrong guess.
 *
 * 1. **Same day.** The capture must fall on the day the entry belongs to. A photo
 *    from last month attached to today's entry says nothing about today, while a
 *    photo taken on the day being backfilled is exactly the evidence wanted. That
 *    is why this is a day match and not a "within N days" window: a distance-from-
 *    today rule would reject the oldest — and most valuable — case, and a camera
 *    whose clock is wrong is already caught by the day match.
 * 2. **Same stretch.** The group must span an hour or less. Photos scattered over
 *    a whole day are a collage of that day, not one event, and the latest of them
 *    is not when the entry happened.
 *
 * Anything else falls back to the clock. Being conservative is deliberate: a wrong
 * guess costs more than a missing one, because it is discovered days later on the
 * timeline rather than at the moment of saving.
 */

export interface PhotoCapture {
  readonly assetId: string;
  readonly capturedAt: string;
}

export interface PhotoTimeSuggestion {
  /** `YYYY-MM-DDTHH:mm`, the shape `DateField` already speaks. */
  readonly value: string;
  /** The photo whose time was taken. */
  readonly assetId: string;
  /** How many photos backed the guess. */
  readonly count: number;
}

/** Photos further apart than this are a collage of a day, not one event. */
export const PHOTO_TIME_MAX_SPAN_MINUTES = 60;

/**
 * EXIF writes `2026:10:28 19:58:03` with no zone, so the value is read as wall
 * clock text and never converted: the camera stamped local time where it stood.
 */
export function photoTimeInput(capturedAt: string): string | undefined {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(capturedAt.trim());
  if (match === null) return undefined;
  const [, year, month, day, hour, minute] = match;
  const monthNumber = Number(month), dayNumber = Number(day), hourNumber = Number(hour), minuteNumber = Number(minute);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31 || hourNumber > 23 || minuteNumber > 59) return undefined;
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** Minutes since midnight. Safe only within one day, which condition 1 guarantees. */
function minutesOfDay(value: string): number {
  return Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
}

/** The captures among the entry's attachments, in the order the library holds them. */
export function photoCaptures(assets: readonly Asset[], shots: readonly AssetLink[]): readonly PhotoCapture[] {
  if (shots.length === 0) return [];
  const attached = new Set(shots.map((shot) => shot.assetId));
  const captures: PhotoCapture[] = [];
  for (const asset of assets) {
    if (asset.kind !== "photo" || !attached.has(asset.id)) continue;
    const capturedAt = asset.photoMetadata?.details?.capturedAt;
    if (capturedAt === undefined) continue;
    captures.push({ assetId: asset.id, capturedAt });
  }
  return captures;
}

export function suggestPhotoTime(input: {
  readonly captures: readonly PhotoCapture[];
  /** `YYYY-MM-DD` — the day this entry belongs to. */
  readonly day: string;
  /** `YYYY-MM-DDTHH:mm` — the clock now. */
  readonly now: string;
  readonly maxSpanMinutes?: number;
}): PhotoTimeSuggestion | undefined {
  const maxSpan = input.maxSpanMinutes ?? PHOTO_TIME_MAX_SPAN_MINUTES;
  const candidates = input.captures
    .map((capture) => ({ assetId: capture.assetId, value: photoTimeInput(capture.capturedAt) }))
    .filter((item): item is { assetId: string; value: string } => item.value !== undefined)
    .filter((item) => item.value.slice(0, 10) === input.day)
    // A stamp later than the clock is a camera that was set wrong, not evidence.
    .filter((item) => item.value <= input.now)
    .sort((left, right) => left.value.localeCompare(right.value));
  if (candidates.length === 0) return undefined;
  const earliest = candidates[0]!;
  const latest = candidates[candidates.length - 1]!;
  if (minutesOfDay(latest.value) - minutesOfDay(earliest.value) > maxSpan) return undefined;
  return { value: latest.value, assetId: latest.assetId, count: candidates.length };
}
