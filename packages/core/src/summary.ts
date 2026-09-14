import type { InstantTime, RecordId } from "./model.js";

/**
 * A day's one-line note on the month grid. Five characters is the budget the
 * grid gives a day, so both the AI and the offline fallback are clamped to it.
 */
export const SUMMARY_MAX_LENGTH = 5;

/**
 * One record as the summariser sees it: identity, version, and the text that is
 * actually shown. `revision` is what makes a stored summary invalidatable —
 * editing a record changes its revision, which changes the day's fingerprint.
 */
export interface SummarySourceRecord {
  readonly id: RecordId;
  readonly revision: number;
  readonly text: string;
  /** Names this record is linked to; the offline fallback uses them as themes. */
  readonly labels?: readonly string[];
}

/** How a day's summary came to be. A fallback is shown as such, never as AI output. */
export type DaySummaryStatus = "generated" | "fallback";

/**
 * Derived data, stored apart from the records it describes: requirements §6.1
 * asks every derived value to carry its provider, its input version, and the
 * moment it was produced.
 */
export interface DaySummary {
  /** YYYY-MM-DD in the zone the caller asked in. */
  readonly date: string;
  readonly text: string;
  readonly provider: string;
  readonly model?: string;
  readonly generatedAt: InstantTime;
  readonly status: DaySummaryStatus;
  /** Fingerprint of the record versions this was made from, for cache reuse. */
  readonly sourceRevision: string;
}

/**
 * `@` is a marker, not content, so it never survives into a summary. A leading
 * bracketed tag is app metadata from older imports, and a day should be
 * summarised by what happened in it, not by that tag.
 */
const TAG_PREFIX = /^(?:\s*【[^】]{0,12}】\s*)+/;
const NOISE = /[\s\u3000，。、；：！？…—～·「」『』（）()[\]【】“”‘’"'`~!?;:,./\\|<>*#_+-]/g;

/** Strips markers and punctuation, then keeps at most `max` characters. */
export function trimSummaryText(text: string, max: number = SUMMARY_MAX_LENGTH): string {
  const cleaned = text.replace(TAG_PREFIX, "").split("@").join("").replace(NOISE, "");
  return [...cleaned].slice(0, max).join("");
}

/**
 * The offline summary, used when no provider is configured or a call fails.
 *
 * It is deliberately plain: a theme the day returns to twice, otherwise the
 * opening characters of the first record. It makes no claim to be a real
 * reading of the day, which is why callers mark it `fallback`.
 */
export function ruleSummaryText(records: readonly SummarySourceRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const label of new Set(record.labels ?? [])) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let theme: string | undefined;
  let themeCount = 0;
  for (const [label, count] of counts) {
    if (count > themeCount) {
      theme = label;
      themeCount = count;
    }
  }
  if (theme !== undefined && themeCount >= 2) return trimSummaryText(theme);
  return trimSummaryText(records[0]?.text ?? "");
}

/**
 * A cheap, stable key over the versions a day was summarised from. It only has
 * to change when the input changes, so a cache entry can be recognised as stale
 * without storing and comparing every record id.
 */
export function summaryFingerprint(records: readonly Pick<SummarySourceRecord, "id" | "revision">[]): string {
  const keys = records.map((record) => `${record.id}@${record.revision}`).sort();
  let hash = 5381;
  for (const key of keys) {
    for (let index = 0; index < key.length; index += 1) hash = ((hash * 33) ^ key.charCodeAt(index)) >>> 0;
  }
  return `${keys.length}:${hash.toString(36)}`;
}
