import type { InstantTime, RecordId } from "./model.js";

/**
 * A day's short note on the month grid. The grid has room for about sixteen
 * CJK code points across two lines; the final two slots are reserved for the
 * literal `..` marker when the source is longer.
 */
export const SUMMARY_MAX_LENGTH = 16;

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
  /**
   * A note is a kept quotation or clipping, not something that happened that
   * day, so it is a filler source: it is only read for a day that has no
   * record of its own, and even then a provider must not narrate it as an
   * event. Absent means `record`, so callers predating the distinction keep
   * their meaning.
   */
  readonly kind?: "record" | "note";
}

/**
 * The records a summary should actually be written from: the day's own records
 * when it has any, otherwise its notes as a stand-in. Never an empty list for a
 * non-empty day.
 */
export function summaryUsableSources(records: readonly SummarySourceRecord[]): readonly SummarySourceRecord[] {
  const primary = records.filter((record) => record.kind !== "note");
  return primary.length > 0 ? primary : records;
}

/** True when the only thing a day has to summarise is notes. */
export function isNoteOnlyDay(records: readonly SummarySourceRecord[]): boolean {
  return records.length > 0 && records.every((record) => record.kind === "note");
}

/**
 * How a day's summary came to be. A fallback is shown as such, never as AI
 * output. `manual` is text the owner typed in the calendar's edit mode; it is
 * the only one that is not derived, so it outranks the other two.
 */
export type DaySummaryStatus = "generated" | "fallback" | "manual";

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
  /**
   * Fingerprint of the machinery that produced this text — provider kind, model,
   * and prompt. The input fingerprint alone cannot see a model or prompt change,
   * which is how summaries written by an older rule outlived the rule. Absent on
   * rows written before this existed, and a missing value never matches, so those
   * rows are recomputed exactly once.
   */
  readonly contextRevision?: string;
}

/**
 * `@` is a marker, not content, so it never survives into a summary. A leading
 * bracketed tag is app metadata from older imports, and a day should be
 * summarised by what happened in it, not by that tag.
 */
const TAG_PREFIX = /^(?:\s*【[^】]{0,12}】\s*)+/;
const NOISE = /[\s\u3000，。、；：！？…—～·「」『』（）()[\]【】“”‘’"'`~!?;:,./\\|<>*#_+-]/g;

/**
 * Keeps at most `max` Unicode code points and marks a clipped tail with `..`.
 * It never rewrites what it keeps — that is the difference between this and
 * `trimSummaryText`, and the reason owner-typed text goes through this one:
 * punctuation and `@` are markup noise in derived text, but in a summary the
 * owner wrote they are simply what they wrote.
 */
export function clampSummaryText(text: string, max: number = SUMMARY_MAX_LENGTH): string {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : SUMMARY_MAX_LENGTH;
  const codePoints = Array.from(text.trim());
  if (codePoints.length <= limit) return codePoints.join("");
  if (limit <= 2) return ".".repeat(limit);
  return `${codePoints.slice(0, limit - 2).join("")}..`;
}

/**
 * Strips markers and punctuation, then keeps at most `max` Unicode code
 * points. If text was clipped, `..` replaces the omitted tail. `Array.from`
 * is intentional: a JavaScript UTF-16 code unit must never split an emoji or
 * another astral code point in the middle.
 */
export function trimSummaryText(text: string, max: number = SUMMARY_MAX_LENGTH): string {
  const cleaned = text.replace(TAG_PREFIX, "").split("@").join("").replace(NOISE, "");
  return clampSummaryText(cleaned, max);
}

/**
 * The offline summary, used when no provider is configured or a call fails.
 *
 * It is deliberately plain: a theme the day returns to twice, otherwise the
 * opening characters of the first record. It makes no claim to be a real
 * reading of the day, which is why callers mark it `fallback`.
 */
export function ruleSummaryText(records: readonly SummarySourceRecord[]): string {
  const usable = summaryUsableSources(records);
  const counts = new Map<string, number>();
  for (const record of usable) {
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
  return trimSummaryText(usable[0]?.text ?? "");
}

/**
 * The instruction the calendar hands a model. It lives here, next to the length
 * budget it quotes, so the code and the text can never drift apart; the settings
 * screen may override it, and this is what it falls back to.
 *
 * The note paragraph is deliberate: a note is a clipping, not an event, and a
 * model asked to summarise one will otherwise invent a day that never happened.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  "你是一个生活记录的时间轴摘要器。",
  `用户会给你若干天的记录，请你为每一天写一个不超过 ${SUMMARY_MAX_LENGTH} 个 Unicode 字符的短标签，说明那天最主要的一件事或状态。超长内容由系统截断并追加两个英文句点，不要自行添加省略号。`,
  "只用一个短语，不要标点，不要解释，不要复述具体时间。",
  "如果某天只标注了[笔记]，说明那天没有留下活动记录，那只是一段摘抄或剪藏。不要把它说成那天发生的事，写一个中性提示即可，例如「只留下一段笔记」。",
  '只输出 JSON，形如 {"2026-09-01":"江边散步"}，键必须是给出的日期。',
].join("\n");

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
