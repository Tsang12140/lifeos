import {
  SUMMARY_MAX_LENGTH,
  createInstant,
  ruleSummaryText,
  summaryFingerprint,
  trimSummaryText,
  type DaySummary,
  type DaySummaryDraft,
  type DaySummaryInput,
  type DaySummaryProvider,
  type SummarySourceRecord,
} from "@lifeos/core";
import type { ApiConfig } from "./config.js";
import type { RecordView } from "./repository.js";

/** Where a computed summary is kept between requests. */
export interface DaySummaryCache {
  readDaySummary(date: string): DaySummary | null;
  writeDaySummary(summary: DaySummary): void;
}

/** The visible text of a record, and the names it is linked to. */
export function summarySources(records: readonly RecordView[]): readonly SummarySourceRecord[] {
  return records.map((record) => ({
    id: record.id,
    revision: record.revision,
    text: record.body.edited ?? record.body.original,
    labels: record.entityRefs.map((ref) => ref.label ?? ref.entityId),
  }));
}

/** Used when no provider is configured, and for any day an AI call did not cover. */
export class RuleDaySummaryProvider implements DaySummaryProvider {
  public readonly providerId = "rule";
  public readonly kind = "rule" as const;

  public summarizeDays(days: readonly DaySummaryInput[]): Promise<readonly DaySummaryDraft[]> {
    return Promise.resolve(days.map((day) => ({ date: day.date, text: ruleSummaryText(day.records) })));
  }
}

const SYSTEM_PROMPT = [
  "你是一个生活记录的时间轴摘要器。",
  `用户会给你若干天的记录，请你为每一天写一个不超过 ${SUMMARY_MAX_LENGTH} 个汉字的短标签，说明那天最主要的一件事或状态。`,
  "只用一个短语，不要标点，不要解释，不要复述具体时间。",
  '只输出 JSON，形如 {"2026-09-01":"江边散步"}，键必须是给出的日期。',
].join("\n");

function buildUserPrompt(days: readonly DaySummaryInput[]): string {
  return days
    .map((day) => {
      const lines = day.records.map((record) => `- ${record.text.replace(/\s+/g, " ").slice(0, 200)}`);
      return `${day.date}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** Tolerates a fenced or chatty reply, but never invents a day that was not asked about. */
function parseDrafts(content: string, asked: ReadonlySet<string>): readonly DaySummaryDraft[] {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("DeepSeek reply contained no JSON object");
  const parsed: unknown = JSON.parse(content.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) throw new Error("DeepSeek reply was not an object");
  const drafts: DaySummaryDraft[] = [];
  for (const [date, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!asked.has(date) || typeof value !== "string") continue;
    const text = trimSummaryText(value, SUMMARY_MAX_LENGTH);
    if (text.length > 0) drafts.push({ date, text });
  }
  return drafts;
}

/**
 * One request covers every stale day, which is what keeps opening a month cheap:
 * the alternative — a call per day — costs a round trip for each square on the grid.
 */
export class DeepSeekDaySummaryProvider implements DaySummaryProvider {
  public readonly providerId = "deepseek";
  public readonly kind = "ai" as const;
  public readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;

  public constructor(apiKey: string, baseUrl: string, model: string) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.model = model;
  }

  public async summarizeDays(days: readonly DaySummaryInput[]): Promise<readonly DaySummaryDraft[]> {
    if (days.length === 0) return [];
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(days) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`DeepSeek responded ${response.status}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("DeepSeek reply had no message content");
    return parseDrafts(content, new Set(days.map((day) => day.date)));
  }
}

export function createDaySummaryProvider(config: ApiConfig): DaySummaryProvider {
  if (config.deepseekApiKey === undefined) return new RuleDaySummaryProvider();
  return new DeepSeekDaySummaryProvider(config.deepseekApiKey, config.deepseekBaseUrl, config.deepseekModel);
}

export interface DaySummaryRequest {
  /** Dates to answer for, oldest first. A day with no records is skipped. */
  readonly dates: readonly string[];
  readonly recordsForDate: (date: string) => readonly RecordView[];
  readonly cache: DaySummaryCache;
  readonly provider: DaySummaryProvider;
  /** Recompute even when the cached summary still matches the records. */
  readonly force?: boolean;
}

/**
 * Answers with one summary per day that has records.
 *
 * A cached summary is reused while the fingerprint of its input still matches,
 * so an untouched day never costs a call and an edited one is recomputed. When
 * the provider fails — no network, a bad key, a malformed reply — the day falls
 * back to the offline rule and is labelled `fallback` rather than passed off as
 * a reading of the day.
 */
export async function resolveDaySummaries(request: DaySummaryRequest): Promise<readonly DaySummary[]> {
  const settled: DaySummary[] = [];
  const stale: DaySummaryInput[] = [];

  for (const date of request.dates) {
    const records = request.recordsForDate(date);
    if (records.length === 0) continue;
    const sources = summarySources(records);
    const fingerprint = summaryFingerprint(sources);
    const cached = request.force === true ? null : request.cache.readDaySummary(date);
    if (cached !== null && cached.sourceRevision === fingerprint) {
      settled.push(cached);
      continue;
    }
    stale.push({ date, records: sources });
  }

  if (stale.length === 0) return settled;

  let drafts = new Map<string, DaySummaryDraft>();
  if (request.provider.kind === "ai") {
    try {
      for (const draft of await request.provider.summarizeDays(stale)) drafts.set(draft.date, draft);
    } catch {
      // A provider failure downgrades the reply; it never fails the request.
      drafts = new Map();
    }
  } else {
    for (const draft of await request.provider.summarizeDays(stale)) drafts.set(draft.date, draft);
  }

  for (const day of stale) {
    const draft = drafts.get(day.date);
    const fromProvider = draft !== undefined;
    const provider: DaySummaryProvider = fromProvider ? request.provider : new RuleDaySummaryProvider();
    const summary: DaySummary = {
      date: day.date,
      text: fromProvider ? draft.text : ruleSummaryText(day.records),
      provider: provider.providerId,
      ...(provider.model === undefined ? {} : { model: provider.model }),
      generatedAt: createInstant(new Date().toISOString()),
      status: provider.kind === "ai" ? "generated" : "fallback",
      sourceRevision: summaryFingerprint(day.records),
    };
    request.cache.writeDaySummary(summary);
    settled.push(summary);
  }

  return settled.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
}
