import { createHash } from "node:crypto";
import {
  SUMMARY_MAX_LENGTH,
  isDreamRecord,
  SUMMARY_SYSTEM_PROMPT,
  clampSummaryText,
  createInstant,
  isNoteOnlyDay,
  ruleSummaryText,
  summaryFingerprint,
  summaryRetryDelayMs,
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
  return records.filter(record => record.kind !== "task" && !isDreamRecord(record)).map((record) => ({
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
 * How many days one model call may cover.
 *
 * The request has a 30s ceiling, so an unbounded batch means the first time a
 * long history is opened (or a profile is finally given a key) every day is sent
 * at once, the call times out, and the whole history is pushed back together —
 * day after day, never landing. Splitting the work means one slow or failed
 * chunk costs only that chunk.
 */
const SUMMARY_BATCH_SIZE = 20;

/**
 * One request covers every stale day, which is what keeps opening a month cheap:
 * the alternative — a call per day — costs a round trip for each square on the grid.
 */
export class DeepSeekDaySummaryProvider implements DaySummaryProvider {
  public readonly providerId = "deepseek";
  public readonly kind = "ai" as const;
  public readonly model: string;
  /** Provider, model, and prompt identify an explicit regeneration or failed attempt. */
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

export function buildOfflineDaySummary(date: string, records: readonly RecordView[]): DaySummary {
  return { ...buildManualDaySummary(date, ruleSummaryText(summarySources(records)), records), provider: "rule", status: "fallback", contextRevision: "rule:v1" };
}

export interface DaySummaryRequest {
  /** Dates to answer for, oldest first. A day with no records is skipped. */
  readonly dates: readonly string[];
  readonly recordsForDate: (date: string) => readonly RecordView[];
  readonly cache: DaySummaryCache;
  readonly provider: DaySummaryProvider;
  /** Recompute even when the cached summary still matches the records. */
  readonly force?: boolean;
  /** Automatic month reads wait until the following day; manual regenerate bypasses this. */
  readonly today?: string;
  /** Re-read after slow AI work so edits/deletes/privacy changes cannot publish obsolete text. */
  readonly latestRecordsForDate?: (date: string) => readonly RecordView[];
  readonly isActive?: () => boolean;
  /** Receives a content-free diagnostic when an AI day falls back to the rule summary. */
  readonly onProviderFallback?: (failure: DaySummaryProviderFallback) => void;
  /**
   * How many stale days one pass may send to the model. Used by the background
   * refresh, which is handed the whole history: without a cap the first run on a
   * long archive fires every chunk back to back and a month read queues behind it.
   * Omitted (the default) means "everything asked for", which is what a visible
   * month wants. A day leaves the stale set as soon as it is written, so a capped
   * pass still makes progress — the leftovers are simply next pass's work.
   */
  readonly maxStale?: number;
}

export interface DaySummaryProviderFallback {
  readonly provider: string;
  readonly model?: string;
  readonly dates: readonly string[];
  readonly reason: "http_error" | "timeout" | "invalid_json" | "invalid_response" | "network_error" | "provider_error" | "missing_date";
  readonly httpStatus?: number;
  readonly networkCode?: string;
}

function describeDaySummaryFailure(error: unknown): Pick<DaySummaryProviderFallback, "reason" | "httpStatus" | "networkCode"> {
  if (error instanceof Error) {
    const status = /^DeepSeek responded (\d{3})$/.exec(error.message)?.[1];
    if (status !== undefined) return { reason: "http_error", httpStatus: Number(status) };
    if (error.name === "TimeoutError" || error.name === "AbortError") return { reason: "timeout" };
    if (error instanceof SyntaxError || error.message === "DeepSeek reply contained no JSON object") return { reason: "invalid_json" };
    if (error.message === "DeepSeek reply had no message content") return { reason: "invalid_response" };
    const cause = error.cause;
    if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" && /^(?:E[A-Z0-9_]{2,}|UND_ERR_[A-Z0-9_]+)$/.test(cause.code)) {
      return { reason: "network_error", networkCode: cause.code };
    }
  }
  return { reason: "provider_error" };
}

function reportDaySummaryFallback(request: DaySummaryRequest, dates: readonly string[], failed: boolean, error?: unknown): void {
  if (request.provider.kind !== "ai" || dates.length === 0) return;
  const failure: DaySummaryProviderFallback = {
    provider: request.provider.providerId,
    ...(request.provider.model === undefined ? {} : { model: request.provider.model }),
    dates,
    ...(failed ? describeDaySummaryFailure(error) : { reason: "missing_date" as const }),
  };
  try { request.onProviderFallback?.(failure); } catch { /* Diagnostics must not change summary behavior. */ }
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
const summaryQueues = new WeakMap<DaySummaryCache, Promise<unknown>>();
const summaryFlights = new WeakMap<DaySummaryCache, Map<string, Promise<readonly DaySummary[]>>>();
export async function resolveDaySummaries(request: DaySummaryRequest): Promise<readonly DaySummary[]> {
  const key = JSON.stringify([request.force === true, request.today, request.provider.contextKey ?? request.provider.providerId, request.dates.map(date => [date, effectiveFingerprint(summarySources(request.recordsForDate(date)))])]);
  const flights = summaryFlights.get(request.cache) ?? new Map<string, Promise<readonly DaySummary[]>>();
  summaryFlights.set(request.cache, flights);
  const active = flights.get(key);
  if (active !== undefined) return active;
  const previous = summaryQueues.get(request.cache) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => resolveDaySummariesOnce(request));
  summaryQueues.set(request.cache, next);
  flights.set(key, next);
  try { return await next; } finally {
    if (summaryQueues.get(request.cache) === next) summaryQueues.delete(request.cache);
    if (flights.get(key) === next) flights.delete(key);
  }
}
function effectiveFingerprint(sources: readonly SummarySourceRecord[]): string {
  return "content:v1:" + createHash("sha256").update(JSON.stringify(summaryUsableSources(sources).map(s => [s.id, s.kind, s.text.replace(/\s+/gu, " ").trim(), s.labels]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}
async function resolveDaySummariesOnce(request: DaySummaryRequest): Promise<readonly DaySummary[]> {
  if (request.isActive?.() === false) return [];
  const settled: DaySummary[] = [];
  const stale: DaySummaryInput[] = [];
  const cacheBefore = new Map<string, string>();
  const context = request.provider.contextKey ?? request.provider.providerId;

  for (const date of request.dates) {
    if (request.today !== undefined && date > request.today) continue;
    const records = request.recordsForDate(date).filter(record => !isDreamRecord(record));
    cacheBefore.set(date, JSON.stringify(request.cache.readDaySummary(date)));
    let cached = request.force === true ? null : request.cache.readDaySummary(date);
    // Owner-written text outranks everything and outlives the records beside it:
    // it is the only summary nobody derived, so nothing recomputes over it. Only
    // an explicit regenerate (which forces) or an explicit clear removes it.
    if (cached !== null && cached.status === "manual") {
      settled.push(cached);
      continue;
    }
    if (records.length === 0) continue;
    const sources = summarySources(records);
    const fingerprint = effectiveFingerprint(sources);
    // Upgrade an unchanged legacy cache without paying to regenerate its text.
    if (cached?.status === "generated" && cached.sourceRevision === summaryFingerprint(sources)) {
      cached = { ...cached, sourceRevision: fingerprint };
      request.cache.writeDaySummary(cached);
    }
    if (request.force !== true && request.today !== undefined && date > request.today) continue;
    if (request.force !== true && request.today !== undefined && date === request.today) {
      const first = [...records].filter(r => r.kind === "journal").sort((a, b) => a.createdAt.value.localeCompare(b.createdAt.value) || a.id.localeCompare(b.id))[0];
      const firstSources = summarySources(first === undefined ? records : [first]);
      const firstFingerprint = effectiveFingerprint(firstSources);
      const marker = "provisional:v1:" + firstFingerprint;
      if (cached !== null && cached.contextRevision === marker) { settled.push(cached); continue; }
      const initial: DaySummary = { date, text: ruleSummaryText(firstSources), provider: "rule", status: "fallback", sourceRevision: firstFingerprint, contextRevision: marker, generatedAt: createInstant(new Date().toISOString()) };
      request.cache.writeDaySummary(initial);
      settled.push(initial);
      continue;
    }
    // Changing providers/prompts does not silently rewrite already generated history.
    const reusable = cached !== null && !cached.contextRevision?.startsWith("provisional:") && cached.sourceRevision === fingerprint && (cached.status === "generated" || (cached.contextRevision === context && (cached.retryAfter === undefined || Date.parse(cached.retryAfter) > Date.now())));
    if (reusable && cached !== null) {
      settled.push(cached);
      continue;
    }
    stale.push({ date, records: sources });
  }

  if (stale.length === 0) return settled;

  // Newest first when capping: `dates` arrive oldest first, and recent days are
  // the ones the owner actually looks at.
  const work = request.maxStale === undefined || stale.length <= request.maxStale ? stale : stale.slice(stale.length - request.maxStale);

  // One call per chunk instead of one call for the whole history: a single slow
  // or failing chunk can then only hold back its own days. Before this, the very
  // first read of a long history sent every day at once, hit the 30s ceiling, and
  // pushed the entire history back by 24h — every day, forever.
  const batches: (readonly DaySummaryInput[])[] = [];
  for (let index = 0; index < work.length; index += SUMMARY_BATCH_SIZE) batches.push(work.slice(index, index + SUMMARY_BATCH_SIZE));

  const drafts = new Map<string, DaySummaryDraft>();
  const failedDates = new Set<string>();
  const aiProvider = request.provider.kind === "ai";
  let stopped = false;
  for (const batch of batches) {
    if (request.isActive?.() === false) { stopped = true; break; }
    try {
      for (const draft of await request.provider.summarizeDays(batch)) drafts.set(draft.date, draft);
    } catch (error) {
      // A provider failure downgrades the reply; it never fails the request, and
      // it only implicates the days that were in this chunk.
      for (const day of batch) failedDates.add(day.date);
      if (aiProvider) reportDaySummaryFallback(request, batch.map(day => day.date), true, error);
    }
  }
  if (aiProvider && !stopped) {
    // A chunk that answered but skipped some days is its own, quieter failure —
    // and it is reported apart from the chunk that never answered at all.
    const skipped = batches.flatMap(batch => batch.filter(day => !drafts.has(day.date) && !failedDates.has(day.date)).map(day => day.date));
    if (skipped.length > 0) reportDaySummaryFallback(request, skipped, false);
  }

  for (const day of work) {
    if (request.isActive?.() === false) break;
    if (request.latestRecordsForDate !== undefined && effectiveFingerprint(summarySources(request.latestRecordsForDate(day.date))) !== effectiveFingerprint(day.records)) continue;
    // Manual writes do not wait behind AI generation. A late reply must respect
    // edits made while this provider request was in flight, even during regenerate.
    const current = request.cache.readDaySummary(day.date);
    if (current?.status === "manual" && JSON.stringify(current) !== cacheBefore.get(day.date)) {
      settled.push(current);
      continue;
    }
    const draft = drafts.get(day.date);
    const fromProvider = draft !== undefined;
    const provider: DaySummaryProvider = fromProvider ? request.provider : new RuleDaySummaryProvider();
    // Consecutive losses are counted per day, so one broken chunk cannot make an
    // unrelated day look more broken than it is — and a success clears the count.
    // A day whose records changed is a different question, so its count restarts.
    const failedAttempt = !fromProvider && aiProvider;
    const fingerprint = effectiveFingerprint(day.records);
    const previousAttempts = current !== null && current.sourceRevision === fingerprint ? current.retryCount ?? 0 : 0;
    const attempt = failedAttempt ? previousAttempts + 1 : 0;
    const retryDelay = failedAttempt ? summaryRetryDelayMs(attempt) : null;
    const summary: DaySummary = {
      date: day.date,
      text: fromProvider ? draft.text : ruleSummaryText(day.records),
      provider: provider.providerId,
      ...(provider.model === undefined ? {} : { model: provider.model }),
      generatedAt: createInstant(new Date().toISOString()),
      status: provider.kind === "ai" ? "generated" : "fallback",
      sourceRevision: fingerprint,
      // Remember the attempted provider and a durable backoff after failures.
      contextRevision: request.force === true && day.date === request.today
        ? "provisional:v1:" + effectiveFingerprint(summarySources([...request.recordsForDate(day.date)].filter(r => r.kind === "journal").sort((a,b) => a.createdAt.value.localeCompare(b.createdAt.value) || a.id.localeCompare(b.id)).slice(0, 1)))
        : request.provider.kind === "ai" ? context : provider.contextKey ?? provider.providerId,
      // 24h → 48h → 7d, then no `retryAfter` at all: the day has used up its
      // automatic attempts and waits for the owner (or for its records to change).
      ...(attempt === 0 ? {} : { retryCount: attempt, ...(retryDelay === null ? {} : { retryAfter: new Date(Date.now() + retryDelay).toISOString() }) }),
    };
    request.cache.writeDaySummary(summary);
    settled.push(summary);
  }

  return settled.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
}
