/**
 * The only thing a video tile says about itself is how long it runs: `01:29`,
 * bottom right. It used to print `0:13` — one digit of minutes, so a column of
 * clips had badges of two different widths, and it read like a timestamp rather
 * than a duration. Minutes are always two digits; an hour or more keeps its own
 * digit so a long clip cannot lie about its length.
 *
 * Null when the asset has no usable duration: a badge saying `00:00` would
 * claim a zero-length clip instead of admitting the metadata is missing.
 */
export function formatMediaDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}
