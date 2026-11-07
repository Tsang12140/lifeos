import { createHash } from "node:crypto";
import { clampSummaryText, createInstant, isDreamRecord, trimSummaryText, type RecordSummary } from "@lifeos/core";
import { assertAiCredentialTarget, readRuntimeAiConfig } from "./ai-config.js";
import type { ApiConfig } from "./config.js";
import type { RecordView, SqliteRecordRepository } from "./repository.js";
import { dateForTime } from "./timeline-query.js";

const RECORD_SUMMARY_MAX_LENGTH = 18;
const RECORD_SUMMARY_LOCAL_COMPLETE_LENGTH = 12;
const LEGACY_SUMMARY_REVISION_LOOKBACK = 64;
const RECORD_SUMMARY_SOURCE_LIMIT = 3_000;
const RECORD_SUMMARY_AUTO_ATTEMPTS = 4;
const RECORD_SUMMARY_PROMPT_VERSION = "calendar-record-summary:v1";
const RECORD_SUMMARY_RETRY_DAYS = [1, 2, 7] as const;
const RECORD_SUMMARY_LOCAL_CONTEXT = "local:calendar-record-summary:short:v1";
const RECORD_SUMMARY_BATCH_SIZE = 6;
const RECORD_SUMMARY_BATCH_SOURCE_BUDGET = 10_000;
const RECORD_SUMMARY_DAILY_RECORD_LIMIT = 24;
const RECORD_SUMMARY_DAILY_SOURCE_BUDGET = 40_000;
const RECORD_SUMMARY_SYSTEM_PROMPT = [
  "你只为输入中的每一篇独立日记写一条简短摘要，不能把多篇合并成当天小结。",
  "每条约12到18个汉字，只依据该条原文，保留具体事情或感受，不补充原文没有的细节。",
  "忽略标签、时间戳和格式标记。只输出一个JSON对象：键为输入的id，值为摘要字符串；不要输出解释、Markdown或其他键。",
].join("\n");

function safeFallbackText(text: string): string {
  return trimSummaryText(text, RECORD_SUMMARY_MAX_LENGTH) || clampSummaryText(text, RECORD_SUMMARY_MAX_LENGTH);
}

interface RecordSummarySource {
  readonly record: RecordView;
  readonly date: string;
  readonly text: string;
  readonly sourceRevision: string;
}

interface RecordSummaryProvider {
  readonly providerId: "deepseek" | "rule";
  readonly kind: "ai" | "rule";
  readonly model?: string;
  readonly contextKey: string;
  summarize(records: readonly RecordSummarySource[]): Promise<ReadonlyMap<string, string>>;
}

function sourceRevisionForDate(record: RecordView, date: string): string {
  return createHash("sha256")
    .update(JSON.stringify([record.id, date, record.body.edited ?? record.body.original]))
    .digest("hex");
}

export function recordSummarySourceRevision(record: RecordView, timeZone = "Asia/Shanghai"): string {
  return sourceRevisionForDate(record, dateForTime(record.occurredAt ?? record.createdAt, timeZone));
}

function sourceFor(record: RecordView, timeZone: string): RecordSummarySource {
  const fullText = record.body.edited ?? record.body.original;
  // Bound model input by Unicode code points, not UTF-16 units. The semantic
  // fingerprint keeps the complete source so a clipped prompt cannot hide edits.
  const text = Array.from(fullText).slice(0, RECORD_SUMMARY_SOURCE_LIMIT).join("");
  const date = dateForTime(record.occurredAt ?? record.createdAt, timeZone);
  return { record, date, text, sourceRevision: sourceRevisionForDate(record, date) };
}

function legacyRevisionMatches(source: RecordSummarySource, cachedSourceRevision: string): boolean {
  const body = source.record.body.edited ?? source.record.body.original;
  const firstRevision = Math.max(1, source.record.revision - LEGACY_SUMMARY_REVISION_LOOKBACK + 1);
  for (let revision = source.record.revision; revision >= firstRevision; revision -= 1) {
    const candidate = createHash("sha256").update(JSON.stringify([source.record.id, revision, body])).digest("hex");
    if (candidate === cachedSourceRevision) return true;
  }
  return false;
}

function readBoundRecordSummary(repository: SqliteRecordRepository, source: RecordSummarySource, timeZone: string): RecordSummary | null {
  const latest = repository.findById(source.record.id);
  if (latest === null || !eligibleSourceRecord(latest)
    || dateForTime(latest.occurredAt ?? latest.createdAt, timeZone) !== source.date
    || sourceRevisionForDate(latest, source.date) !== source.sourceRevision) return null;
  const currentSource = { ...source, record: latest };
  const cached = repository.readRecordSummary(source.record.id);
  if (cached === null || cached.date !== source.date) return cached;
  if (cached.sourceRevision !== source.sourceRevision && cached.recordRevision === undefined
    && legacyRevisionMatches(currentSource, cached.sourceRevision)) {
    const migrated = { ...cached, sourceRevision: source.sourceRevision, recordRevision: latest.revision };
    repository.writeRecordSummary(migrated);
    return migrated;
  }
  if (cached.sourceRevision === source.sourceRevision) return bindRecordSummaryToCurrentRevision(repository, currentSource, cached);
  return cached;
}

class RuleRecordSummaryProvider implements RecordSummaryProvider {
  public readonly providerId = "rule" as const;
  public readonly kind = "rule" as const;
  public readonly contextKey = "rule:calendar-record-summary:v1";

  public summarize(records: readonly RecordSummarySource[]): Promise<ReadonlyMap<string, string>> {
    return Promise.resolve(new Map(records.map((source) => [source.record.id, safeFallbackText(source.text)])));
  }
}

class DeepSeekRecordSummaryProvider implements RecordSummaryProvider {
  public readonly providerId = "deepseek" as const;
  public readonly kind = "ai" as const;
  public readonly model: string;
  public readonly contextKey: string;
  readonly #config: ApiConfig;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #source: ReturnType<typeof readRuntimeAiConfig>["source"];

  public constructor(config: ApiConfig, runtime: ReturnType<typeof readRuntimeAiConfig>) {
    this.#config = config;
    this.#apiKey = runtime.apiKey!;
    this.#baseUrl = runtime.baseUrl;
    this.#source = runtime.source;
    this.model = runtime.model;
    const promptHash = createHash("sha256").update(RECORD_SUMMARY_SYSTEM_PROMPT).digest("hex").slice(0, 10);
    this.contextKey = `ai:${runtime.baseUrl}|${runtime.model}|${RECORD_SUMMARY_PROMPT_VERSION}:${promptHash}`;
  }

  public async summarize(records: readonly RecordSummarySource[]): Promise<ReadonlyMap<string, string>> {
    if (records.length === 0) return new Map();
    assertAiCredentialTarget(this.#config, { source: this.#source, apiKey: this.#apiKey, baseUrl: this.#baseUrl });
    const requested = new Set(records.map((source) => source.record.id));
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: "system", content: RECORD_SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(records.map(({ record, text }) => ({ id: record.id, text }))) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`DeepSeek responded ${response.status}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("DeepSeek reply had no message content");
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("DeepSeek reply contained no JSON object");
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("DeepSeek reply was not an object");
    const summaries = new Map<string, string>();
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!requested.has(id) || typeof value !== "string") continue;
      const text = trimSummaryText(value, RECORD_SUMMARY_MAX_LENGTH);
      if (text !== "") summaries.set(id, text);
    }
    return summaries;
  }
}

export function createRecordSummaryProvider(config: ApiConfig): RecordSummaryProvider {
  const runtime = readRuntimeAiConfig(config);
  if (!runtime.enabled || runtime.apiKey === undefined) return new RuleRecordSummaryProvider();
  // Deliberately do not use runtime.summaryPrompt: that prompt describes an
  // entire day and may request a combined result. Record summaries have their
  // own stable instruction and cache context.
  return new DeepSeekRecordSummaryProvider(config, runtime);
}

interface RecordSummaryFlight {
  readonly promise: Promise<RecordSummary | null>;
  readonly resolve: (summary: RecordSummary | null) => void;
}

interface OwnedRecordSummarySource {
  readonly source: RecordSummarySource;
  readonly flightKey: string;
  readonly flight: RecordSummaryFlight;
}

const recordSummaryFlights = new WeakMap<SqliteRecordRepository, Map<string, RecordSummaryFlight>>();

function eligibleSourceRecord(record: RecordView): boolean {
  return record.isPrivate !== true && record.kind !== "task" && record.kind !== "note" && !isDreamRecord(record)
    && (record.body.edited ?? record.body.original).trim() !== "";
}

function eligibleJournalSweepRecord(record: RecordView): boolean {
  return record.kind === "journal" && eligibleSourceRecord(record);
}

function canUseLocalSummary(source: RecordSummarySource): boolean {
  const text = source.text.trim();
  return text !== "" && Array.from(text).length <= RECORD_SUMMARY_LOCAL_COMPLETE_LENGTH;
}

function sameCurrentSource(repository: SqliteRecordRepository, source: RecordSummarySource, timeZone: string): boolean {
  const latest = repository.findById(source.record.id);
  return latest !== null && eligibleSourceRecord(latest)
    && dateForTime(latest.occurredAt ?? latest.createdAt, timeZone) === source.date
    && recordSummarySourceRevision(latest, timeZone) === source.sourceRevision;
}

function reusableCachedSummary(
  cached: RecordSummary | null,
  source: RecordSummarySource,
  provider: RecordSummaryProvider,
  now: number,
): cached is RecordSummary {
  if (cached === null || cached.sourceRevision !== source.sourceRevision || cached.date !== source.date) return false;
  if (cached.status === "local" && cached.contextRevision === RECORD_SUMMARY_LOCAL_CONTEXT) return true;
  if (cached.status === "generated" && provider.kind === "rule") return true;
  if (cached.status === "fallback" && canUseLocalSummary(source)) return false;
  if (cached.contextRevision !== provider.contextKey) return false;
  if (cached.status === "generated") return true;
  return (cached.retryCount ?? 0) >= RECORD_SUMMARY_AUTO_ATTEMPTS
    || cached.retryAfter === undefined
    || Date.parse(cached.retryAfter) > now;
}

function claimRecordSummary(repository: SqliteRecordRepository, key: string): { readonly flight: RecordSummaryFlight; readonly owned: boolean } {
  const flights = recordSummaryFlights.get(repository) ?? new Map<string, RecordSummaryFlight>();
  recordSummaryFlights.set(repository, flights);
  const existing = flights.get(key);
  if (existing !== undefined) return { flight: existing, owned: false };
  let resolve!: (summary: RecordSummary | null) => void;
  const promise = new Promise<RecordSummary | null>((accept) => { resolve = accept; });
  const flight = { promise, resolve };
  flights.set(key, flight);
  return { flight, owned: true };
}

function recordSummaryBatches<T>(items: readonly T[], sourceOf: (item: T) => RecordSummarySource): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let current: T[] = [];
  let sourcePoints = 0;
  for (const item of items) {
    const source = sourceOf(item);
    const points = Array.from(source.text).length;
    if (current.length > 0 && (current.length >= RECORD_SUMMARY_BATCH_SIZE || sourcePoints + points > RECORD_SUMMARY_BATCH_SOURCE_BUDGET)) {
      batches.push(current);
      current = [];
      sourcePoints = 0;
    }
    current.push(item);
    sourcePoints += points;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildRecordSummary(
  source: RecordSummarySource,
  provider: RecordSummaryProvider,
  generatedText: string | undefined,
  repository: SqliteRecordRepository,
  now: Date,
): RecordSummary {
  const previous = repository.readRecordSummary(source.record.id);
  const previousAttempts = previous?.sourceRevision === source.sourceRevision && previous.contextRevision === provider.contextKey
    ? previous.retryCount ?? 0
    : 0;
  const isGenerated = provider.kind === "ai" && generatedText !== undefined;
  const isLocal = !isGenerated && canUseLocalSummary(source);
  const attempt = isGenerated || isLocal || provider.kind !== "ai" ? 0 : previousAttempts + 1;
  const contextRevision = isLocal ? RECORD_SUMMARY_LOCAL_CONTEXT : provider.contextKey;
  return {
    recordId: source.record.id,
    date: source.date,
    text: isGenerated ? generatedText : safeFallbackText(source.text),
    provider: isGenerated ? provider.providerId : "rule",
    ...(isGenerated && provider.model !== undefined ? { model: provider.model } : {}),
    generatedAt: createInstant(now.toISOString()),
    status: isGenerated ? "generated" : isLocal ? "local" : "fallback",
    sourceRevision: source.sourceRevision,
    recordRevision: source.record.revision,
    contextRevision,
    ...(!isGenerated && !isLocal && provider.kind === "ai" && attempt < RECORD_SUMMARY_AUTO_ATTEMPTS
      ? { retryCount: attempt, retryAfter: new Date(now.getTime() + (RECORD_SUMMARY_RETRY_DAYS[attempt - 1] ?? 7) * 24 * 60 * 60 * 1000).toISOString() }
      : !isGenerated && !isLocal && provider.kind === "ai" ? { retryCount: RECORD_SUMMARY_AUTO_ATTEMPTS } : {}),
  };
}

function bindRecordSummaryToCurrentRevision(
  repository: SqliteRecordRepository,
  source: RecordSummarySource,
  summary: RecordSummary,
): RecordSummary {
  if (summary.recordRevision === source.record.revision) return summary;
  const rebound = { ...summary, recordRevision: source.record.revision };
  repository.writeRecordSummary(rebound);
  return rebound;
}

async function resolveOwnedRecordSources(
  repository: SqliteRecordRepository,
  provider: RecordSummaryProvider,
  owned: readonly OwnedRecordSummarySource[],
  timeZone: string,
): Promise<void> {
  const modelSources: OwnedRecordSummarySource[] = [];
  const settle = (item: OwnedRecordSummarySource, summary: RecordSummary | null): void => item.flight.resolve(summary);
  for (const item of owned) {
    const { source } = item;
    if (!sameCurrentSource(repository, source, timeZone)) { settle(item, null); continue; }
    const cached = readBoundRecordSummary(repository, source, timeZone);
    if (reusableCachedSummary(cached, source, provider, Date.now())) {
      const rebound = cached;
      if (rebound.status === "generated" || rebound.status === "local") repository.removePendingRecordSummary(rebound.recordId, rebound.sourceRevision);
      settle(item, rebound);
      continue;
    }
    if (canUseLocalSummary(source)) {
      const local = buildRecordSummary(source, provider, undefined, repository, new Date());
      repository.writeRecordSummary(local);
      repository.removePendingRecordSummary(local.recordId, local.sourceRevision);
      settle(item, local);
      continue;
    }
    modelSources.push(item);
  }

  for (const batch of recordSummaryBatches(modelSources, item => item.source)) {
    const currentBatch = batch.filter(item => sameCurrentSource(repository, item.source, timeZone));
    if (currentBatch.length === 0) {
      for (const item of batch) settle(item, null);
      continue;
    }
    let generated = new Map<string, string>();
    if (provider.kind === "ai") {
      try {
        generated = new Map(await provider.summarize(currentBatch.map(item => item.source)));
      } catch {
        // The fallback stays local and the persisted retry window bounds future attempts.
      }
    } else {
      generated = new Map(await provider.summarize(currentBatch.map(item => item.source)));
    }
    for (const item of currentBatch) {
      const { source } = item;
      if (!sameCurrentSource(repository, source, timeZone)) { settle(item, null); continue; }
      const latestCache = readBoundRecordSummary(repository, source, timeZone);
      if (reusableCachedSummary(latestCache, source, provider, Date.now())) {
        const rebound = latestCache;
        if (rebound.status === "generated" || rebound.status === "local") repository.removePendingRecordSummary(rebound.recordId, rebound.sourceRevision);
        settle(item, rebound);
        continue;
      }
      const summary = buildRecordSummary(source, provider, generated.get(source.record.id), repository, new Date());
      repository.writeRecordSummary(summary);
      if (summary.status === "generated" || summary.status === "local") repository.removePendingRecordSummary(summary.recordId, summary.sourceRevision);
      settle(item, summary);
    }
    const settled = new Set(currentBatch.map(item => item.flightKey));
    for (const item of batch) if (!settled.has(item.flightKey)) settle(item, null);
  }
}

export async function resolveCalendarRecordSummaries(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  requestedRecords: readonly RecordView[],
  timeZone: string,
): Promise<readonly RecordSummary[]> {
  const provider = createRecordSummaryProvider(config);
  const sources = requestedRecords
    .filter(eligibleSourceRecord)
    .map((record) => sourceFor(record, timeZone));
  const flights = recordSummaryFlights.get(repository) ?? new Map<string, RecordSummaryFlight>();
  recordSummaryFlights.set(repository, flights);
  const active = new Map<string, Promise<RecordSummary | null>>();
  const owned: OwnedRecordSummarySource[] = [];
  for (const source of sources) {
    const cached = readBoundRecordSummary(repository, source, timeZone);
    if (reusableCachedSummary(cached, source, provider, Date.now())) {
      const rebound = cached;
      if (rebound.status === "generated" || rebound.status === "local") repository.removePendingRecordSummary(rebound.recordId, rebound.sourceRevision);
      active.set(source.record.id, Promise.resolve(rebound));
      continue;
    }
    const flightKey = JSON.stringify([source.record.id, source.sourceRevision, source.date, provider.contextKey]);
    const claim = claimRecordSummary(repository, flightKey);
    active.set(source.record.id, claim.flight.promise);
    if (claim.owned) owned.push({ source, flightKey, flight: claim.flight });
  }

  try {
    if (owned.length > 0) await resolveOwnedRecordSources(repository, provider, owned, timeZone);
  } catch (error) {
    for (const item of owned) item.flight.resolve(null);
    throw error;
  } finally {
    for (const item of owned) if (flights.get(item.flightKey) === item.flight) flights.delete(item.flightKey);
  }

  const resolved = await Promise.all(sources.map(source => active.get(source.record.id) ?? Promise.resolve(null)));
  return sources.flatMap((source, index) => {
    const summary = resolved[index];
    // Re-check cache hits and slow results at the response boundary. Edits,
    // deletes, privacy changes, and date moves must not return obsolete text.
    if (!sameCurrentSource(repository, source, timeZone) || summary === null || summary === undefined
      || summary.sourceRevision !== source.sourceRevision || summary.date !== source.date) return [];
    return [summary];
  });
}

export function collectRecordSummarySweepCandidates(
  repository: SqliteRecordRepository,
  config: ApiConfig,
  today: string,
  timeZone = "Asia/Shanghai",
  now = Date.now(),
  limit = RECORD_SUMMARY_DAILY_RECORD_LIMIT,
): readonly RecordView[] {
  const provider = createRecordSummaryProvider(config);
  const pending = repository.listPendingRecordSummaries().flatMap(item => {
    const record = repository.findById(item.recordId);
    if (record === null || !eligibleJournalSweepRecord(record)) {
      repository.removePendingRecordSummary(item.recordId);
      return [];
    }
    const source = sourceFor(record, timeZone);
    const queuedAt = source.sourceRevision === item.sourceRevision ? item.queuedAt : new Date(now).toISOString();
    if (source.sourceRevision !== item.sourceRevision) repository.queueRecordSummary(record.id, source.sourceRevision, queuedAt);
    if (source.date >= today || source.text.trim() === "") return [];
    const cached = readBoundRecordSummary(repository, source, timeZone);
    if (reusableCachedSummary(cached, source, provider, now)) {
      if (cached.status === "generated" || cached.status === "local") repository.removePendingRecordSummary(record.id, source.sourceRevision);
      return [];
    }
    return [{ record, source, queuedAt }];
  }).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.record.id.localeCompare(b.record.id));
  const selected: RecordView[] = [];
  let sourcePoints = 0;
  for (const item of pending) {
    const points = Array.from(item.source.text).length;
    if (selected.length >= Math.max(0, limit) || sourcePoints + points > RECORD_SUMMARY_DAILY_SOURCE_BUDGET) break;
    selected.push(item.record);
    sourcePoints += points;
  }
  return selected;
}

export async function runDailyRecordSummarySweep(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  today: string,
): Promise<number> {
  const candidates = collectRecordSummarySweepCandidates(repository, config, today);
  if (candidates.length === 0) return 0;
  await resolveCalendarRecordSummaries(config, repository, candidates, "Asia/Shanghai");
  return candidates.length;
}
