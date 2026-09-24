import { createHash } from "node:crypto";
import {
  SUMMARY_MAX_LENGTH,
  SUMMARY_SYSTEM_PROMPT,
  clampSummaryText,
  createInstant,
  isNoteOnlyDay,
  ruleSummaryText,
  summaryFingerprint,
  summaryUsableSources,
  trimSummaryText,
  type DaySummary,
  type DaySummaryDraft,
  type DaySummaryInput,
  type DaySummaryProvider,
  type SummarySourceRecord,
} from "@lifeos/core";
import { assertAiCredentialTarget, readRuntimeAiConfig } from "./ai-config.js";
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
    kind: record.kind === "note" ? "note" : "record",
  }));
}

/**
 * Identifies the machinery behind a draft. Summaries written by different models,
 * or by one model under a different instruction, are not interchangeable — but the
 * record fingerprint cannot see either change, so this travels with the row.
 */
function summaryContextKey(baseUrl: string, model: string, prompt: string): string {
  const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 10);
  return `ai:${baseUrl}|${model}|${promptHash}`;
}

/** Used when no provider is configured, and for any day an AI call did not cover. */
export class RuleDaySummaryProvider implements DaySummaryProvider {
  public readonly providerId = "rule";
  public readonly kind = "rule" as const;
  /** Bump when the offline rule's wording changes, so stale fallbacks recompute. */
  public readonly contextKey = "rule:v1";

  public summarizeDays(days: readonly DaySummaryInput[]): Promise<readonly DaySummaryDraft[]> {
    return Promise.resolve(days.map((day) => ({ date: day.date, text: ruleSummaryText(day.records) })));
  }
}

function buildUserPrompt(days: readonly DaySummaryInput[]): string {
  return days
    .map((day) => {
      // Only what the day should actually be read from: its own records when it has
      // any, its notes as a stand-in when it does not. A clipping never travels
      // next to a record, so the model cannot mistake it for something that happened.
      const usable = summaryUsableSources(day.records);
      const noteOnly = isNoteOnlyDay(usable);
      const lines = usable.map((record) => `- ${noteOnly ? "[笔记] " : ""}${record.text.replace(/\s+/g, " ").slice(0, 200)}`);
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
  /** Provider, model, and prompt, so a change to any of them rewrites the text. */
  public readonly contextKey: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  /** Overridable so the prompt can be edited from settings instead of only in code. */
  readonly #systemPrompt: string;
  readonly #config: ApiConfig;
  readonly #source: ReturnType<typeof readRuntimeAiConfig>["source"];

  public constructor(config: ApiConfig, apiKey: string, baseUrl: string, model: string, source: ReturnType<typeof readRuntimeAiConfig>["source"], systemPrompt: string = SUMMARY_SYSTEM_PROMPT) {
    this.#config = config;
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.model = model;
    this.#source = source;
    this.#systemPrompt = systemPrompt;
    this.contextKey = summaryContextKey(baseUrl, model, systemPrompt);
  }

  public async summarizeDays(days: readonly DaySummaryInput[]): Promise<readonly DaySummaryDraft[]> {
    if (days.length === 0) return [];
    assertAiCredentialTarget(this.#config, { source: this.#source, apiKey: this.#apiKey, baseUrl: this.#baseUrl });
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: "system", content: this.#systemPrompt },
          { role: "user", content: buildUserPrompt(days) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`DeepSeek responded ${response.status}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("DeepSeek reply had no message content");
    return parseDrafts(content, new Set(days.map((day) => day.date)));
  }
}

/**
 * The provider the server asks for, resolved **per request** rather than once at
 * boot: the AI key lives in the settings file, and a provider frozen at startup
 * would keep using whatever key (or lack of one) the process happened to see.
 * The prompt it will use comes from the same settings file (SUMMARY_SYSTEM_PROMPT
 * when none is stored), and is part of the provider's contextKey.
 *
 * Before this, summaries read LIFEOS_DEEPSEEK_API_KEY only, while the assistant
 * read the settings file. Two answers to the same question — so a key typed into
 * the settings screen worked everywhere except the calendar, which silently kept
 * falling back to the offline rule.
 */
export function createDaySummaryProvider(config: ApiConfig): DaySummaryProvider {
  const runtime = readRuntimeAiConfig(config);
  if (!runtime.enabled || runtime.apiKey === undefined) return new RuleDaySummaryProvider();
  return new DeepSeekDaySummaryProvider(config, runtime.apiKey, runtime.baseUrl, runtime.model, runtime.source, runtime.summaryPrompt ?? SUMMARY_SYSTEM_PROMPT);
}

/**
 * A summary the owner typed. It is the only kind that is not derived, so it names
 * no provider and is never recomputed on its own — only the record versions it was
 * written next to are recorded, so the row can be shown as belonging to that day.
 */
export function buildManualDaySummary(date: string, text: string, records: readonly RecordView[]): DaySummary {
  return {
    date,
    text: clampSummaryText(text),
    provider: "manual",
    generatedAt: createInstant(new Date().toISOString()),
    status: "manual",
    sourceRevision: summaryFingerprint(summarySources(records)),
  };
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
  const context = request.provider.contextKey ?? request.provider.providerId;

  for (const date of request.dates) {
    const records = request.recordsForDate(date);
    const cached = request.force === true ? null : request.cache.readDaySummary(date);
    // Owner-written text outranks everything and outlives the records beside it:
    // it is the only summary nobody derived, so nothing recomputes over it. Only
    // an explicit regenerate (which forces) or an explicit clear removes it.
    if (cached !== null && cached.status === "manual") {
      settled.push(cached);
      continue;
    }
    if (records.length === 0) continue;
    const sources = summarySources(records);
    const fingerprint = summaryFingerprint(sources);
    if (cached !== null && cached.sourceRevision === fingerprint && cached.contextRevision === context) {
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
      // Stamped from the provider that actually produced the text, not the one that
      // was asked: a fallback recorded as "ai" would be reused forever after one
      // network blip, and a fallback recorded as "rule" is retried until it works.
      contextRevision: provider.contextKey ?? provider.providerId,
    };
    request.cache.writeDaySummary(summary);
    settled.push(summary);
  }

  return settled.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
}
