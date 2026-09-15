import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, realpathSync, statSync, type WriteStream } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  PLACE_ROLES,
  RELATION_KINDS,
  assertValidAsset,
  assertValidAssetLink,
  assertValidCycleIntimacyEvent,
  assertValidCycleIntimacyModuleConfig,
  assertValidEntity,
  assertValidEntityRef,
  assertValidEntityRelation,
  assertValidLifeTime,
  assertValidStorageReference,
  assertValidWeatherAttachment,
  canonicalPersonName,
  createDateOnly,
  createInstant,
  createExportBundle,
  exportRecordMarkdown,
  findEntityMentions,
  normalizeEntitySearchTerm,
  parseExportJson,
  serializeExportJson,
  type Asset,
  type AssetKind,
  type AssetLink,
  type AssetRole,
  type CycleIntimacyEvent,
  type CycleIntimacyEventKind,
  type CycleIntimacyModuleConfig,
  type Entity,
  type EntityKind,
  type EntityRef,
  type EntityRelation,
  type Movie,
  type MovieExternalIds,
  type LifeTime,
  type PlacePeriod,
  type PlaceRole,
  type RecordKind,
  type RelationKind,
  type StorageReference,
  type TaskStatus,
  type TimelineRecord,
  type WeatherAttachment,
} from "@lifeos/core";
import { isLoopbackHost, type ApiConfig } from "./config.js";
import { ConflictError, SqliteRecordRepository, type BackupRun, type BackupSchedule, type RecordView } from "./repository.js";
import { createDaySummaryProvider, resolveDaySummaries } from "./summary.js";
import { answerLifeosAssistant, type AssistantHistoryItem } from "./assistant.js";
import { createDualBackup, createLocalBackup, pruneBackups, testS3Backup, uploadS3Backup } from "./backup.js";
import { BackupScheduler, BACKUP_TIME_ZONE, publicNextBackupAt, shanghaiDateKey } from "./backup-scheduler.js";
import { publicBackupConfig, saveRuntimeBackupConfig } from "./backup-config.js";
import { BACKUP_RETENTION_LIMITS, buildBackupRetentionView, DEFAULT_BACKUP_RETENTION, describeBackupRetention, type BackupRetention } from "./backup-retention.js";
import { AI_REASONING_EFFORTS, publicAiConfig, saveRuntimeAiConfig, testRuntimeAiConfig } from "./ai-config.js";
import { clearWeatherCache, fetchRealtimeWeather, fetchWeatherSnapshot, verifyWeatherLocation } from "./weather.js";
import { listWeatherProfiles, publicWeatherConfig, readRuntimeWeatherConfig, readWeatherProfile, saveRuntimeWeatherConfig, saveWeatherProfile, type WeatherLocationOverride } from "./weather-config.js";
import { WeatherArchiveScheduler, WEATHER_ARCHIVE_TIME_ZONE } from "./weather-archive-scheduler.js";
import { publicMovieConfig, readRuntimeMovieConfig, saveRuntimeMovieConfig } from "./movie-config.js";
import { MovieModuleError, resolveMovies, testMovieConfig, type MovieCandidate } from "./movie.js";

const SESSION_COOKIE = "lifeos_session";
const WEATHER_DEVICE_COOKIE = "lifeos_weather_device";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECORD_KINDS: readonly RecordKind[] = ["journal", "task", "event", "note"];
const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];
const ENTITY_KINDS: readonly EntityKind[] = ["person", "project", "place", "topic", "movie"];
const ASSET_KINDS: readonly AssetKind[] = ["photo", "audio", "file"];
const ASSET_ROLES: readonly AssetRole[] = ["photo", "recording", "attachment"];
const CYCLE_INTIMACY_EVENT_KINDS: readonly CycleIntimacyEventKind[] = ["intimacy", "period_start", "period_end"];

class HttpError extends Error {
  public constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function backupHttpError(error: unknown): HttpError {
  return new HttpError(502, "backup_failed", error instanceof Error ? error.message : "备份操作失败");
}

function backupRunDate(run: { readonly startedAt: string }): string {
  return shanghaiDateKey(new Date(run.startedAt));
}

function latestDualBackup(runs: readonly BackupRun[]): {
  readonly batchId: string;
  readonly status: "success" | "partial" | "local_only" | "failed";
  readonly local: BackupRun;
  readonly s3: BackupRun;
} | null {
  const local = runs.find((run) => run.batchId !== undefined && run.provider === "local");
  if (local?.batchId === undefined) return null;
  const s3 = runs.find((run) => run.batchId === local.batchId && run.provider === "s3");
  if (s3 === undefined) return null;
  const status = local.status === "failed"
    ? "failed"
    : s3.status === "success"
      ? "success"
      : s3.status === "skipped"
        ? "local_only"
        : "partial";
  return { batchId: local.batchId, status, local, s3 };
}

/**
 * Shapes the retention state for the settings UI: the policy in plain language,
 * one row per backup with its verdict and the reason behind it, and when the
 * cleanup will next run. Cleanup happens after each backup, so "next cleanup" is
 * simply the next scheduled backup.
 */
function backupRetentionPayload(repository: SqliteRecordRepository, config: ApiConfig, schedule: BackupSchedule) {
  const policy = repository.getBackupRetention();
  // The whole history: a truncated list would hide older snapshots from the plan.
  const runs = repository.listAllBackupRuns();
  const view = buildBackupRetentionView(runs, policy, new Date());
  return {
    policy,
    limits: BACKUP_RETENTION_LIMITS,
    defaults: DEFAULT_BACKUP_RETENTION,
    described: describeBackupRetention(policy),
    cleanupTrigger: "每次备份完成后自动清理",
    // Cleaned snapshots are moved into LifeOS's own recycle bin first, because
    // the bucket has versioning off — a plain S3 DELETE would be permanent.
    cleanupScope: { local: true, remote: true, recycleBin: { local: true, remote: true } },
    cleanupScheduled: schedule.enabled,
    nextCleanupAt: publicNextBackupAt(schedule),
    localDirectory: config.backupDirectory ?? null,
    entries: view.entries,
    summary: view.summary,
    trashed: view.trashed,
    connectionTestCount: view.connectionTestCount,
    connectionTestBytes: view.connectionTestBytes,
  };
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value)) throw new HttpError(400, "invalid_json", `${name} must be an object`);
  return value;
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HttpError(400, "unknown_field", `Unsupported field: ${key}`);
  }
}

function stringField(value: unknown, name: string, options: { nonEmpty?: boolean } = {}): string {
  if (typeof value !== "string" || (options.nonEmpty && value.length === 0)) {
    throw new HttpError(400, "invalid_field", `${name} must be ${options.nonEmpty ? "a non-empty string" : "a string"}`);
  }
  return value;
}

function enumField<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new HttpError(400, "invalid_field", `${name} is invalid`);
  return value as T;
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_field", `${name} must be a boolean`);
  return value;
}

function boundedIntegerField(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(400, "invalid_field", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function cycleIntimacyConfig(input: JsonObject): CycleIntimacyModuleConfig {
  hasOnlyKeys(input, ["enabled", "cycleLength", "periodLength", "anchorStart"]);
  const anchorRaw = input.anchorStart;
  const anchorStart = anchorRaw === undefined || anchorRaw === null
    ? undefined
    : parseDateQuery(stringField(anchorRaw, "anchorStart"), "anchorStart");
  const config: CycleIntimacyModuleConfig = {
    enabled: booleanField(input.enabled, "enabled"),
    cycleLength: boundedIntegerField(input.cycleLength, "cycleLength", 15, 90),
    periodLength: boundedIntegerField(input.periodLength, "periodLength", 1, 21),
    ...(anchorStart === undefined ? {} : { anchorStart }),
  };
  return coreValidated("cycle module config", () => {
    assertValidCycleIntimacyModuleConfig(config);
    return config;
  });
}

function cycleIntimacyEvent(input: JsonObject): CycleIntimacyEvent {
  hasOnlyKeys(input, ["date", "kind"]);
  const date = parseDateQuery(stringField(input.date, "date"), "date");
  if (date === undefined) throw new HttpError(400, "invalid_date", "date is required");
  const event: CycleIntimacyEvent = { id: randomUUID(), date, kind: enumField(input.kind, CYCLE_INTIMACY_EVENT_KINDS, "kind") };
  return coreValidated("cycle module event", () => {
    assertValidCycleIntimacyEvent(event);
    return event;
  });
}

function revisionField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "invalid_revision", "revision must be a positive integer");
  }
  return value;
}

function parseLifeTime(value: unknown, name: string): LifeTime {
  try {
    assertValidLifeTime(value, name);
    return value;
  } catch (error) {
    throw new HttpError(400, "invalid_time", error instanceof Error ? error.message : `${name} is invalid`);
  }
}

function nowInstant(): ReturnType<typeof createInstant> {
  return createInstant(new Date().toISOString());
}

function setJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  res.end(body);
}

function setEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "cache-control": "no-store", ...extraHeaders });
  res.end();
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function cookieHeader(value: string, config: ApiConfig, maxAge: number): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function weatherDeviceCookieHeader(value: string, config: ApiConfig): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${WEATHER_DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}${secure}`;
}

function weatherDeviceId(req: IncomingMessage, res: ServerResponse, config: ApiConfig): string {
  const existing = cookieValue(req, WEATHER_DEVICE_COOKIE);
  if (existing !== undefined && /^[0-9a-f-]{20,80}$/i.test(existing)) return existing;
  const created = randomUUID();
  res.setHeader("set-cookie", weatherDeviceCookieHeader(created, config));
  return created;
}

function weatherLocationOverride(config: ApiConfig, deviceLocation: ReturnType<SqliteRecordRepository["getWeatherDeviceLocation"]>): WeatherLocationOverride | undefined {
  if (deviceLocation === null) return undefined;
  if (deviceLocation.profileId !== undefined) {
    const profile = readWeatherProfile(config, deviceLocation.profileId);
    if (profile !== null) return { profileId: deviceLocation.profileId, locationId: profile.locationId, city: profile.city, apiHost: profile.apiHost, apiKey: profile.apiKey ?? null };
  }
  return { locationId: deviceLocation.locationId, city: deviceLocation.city };
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hostName(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? undefined : value.slice(1, end).toLowerCase();
  }
  const colon = value.lastIndexOf(":");
  return colon > -1 && value.indexOf(":") === colon ? value.slice(0, colon).toLowerCase() : value.toLowerCase();
}

function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}

function originAllowed(req: IncomingMessage, config: ApiConfig): boolean {
  const origin = requestOrigin(req);
  if (origin === undefined) return true;
  if (config.allowedOrigins.includes(origin)) return true;
  const host = req.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function localHostAllowed(req: IncomingMessage): boolean {
  const name = hostName(req.headers.host);
  return name !== undefined && isLoopbackHost(name);
}

function rawPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://lifeos.invalid").pathname;
  } catch {
    throw new HttpError(400, "invalid_path", "Invalid URL");
  }
}

function decodeStaticPathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid_path", "Invalid URL");
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, "invalid_content_length", "Invalid Content-Length");
    if (length > limit) throw new HttpError(413, "body_too_large", "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "body_too_large", "Request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function requireJsonContentType(req: IncomingMessage, allowEmpty = false): void {
  const contentType = req.headers["content-type"];
  if (allowEmpty && contentType === undefined) return;
  if (contentType === undefined || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new HttpError(415, "unsupported_media_type", "Write requests require application/json");
  }
}

function parseDateQuery(value: string | null, name: string): string | undefined {
  if (value === null) return undefined;
  try {
    return createDateOnly(value).value;
  } catch {
    throw new HttpError(400, "invalid_date", `${name} must use YYYY-MM-DD`);
  }
}

function dateForTime(time: LifeTime, timeZone: string): string {
  if (time.kind === "date" || time.kind === "local") return time.value.slice(0, 10);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time.value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timelineDisplayKey(record: RecordView, timeZone: string): string {
  const time = record.occurredAt ?? record.createdAt;
  if (time.kind === "date") return `${time.value}T00:00:00`;
  if (time.kind === "local") return time.value;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time.value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function sortTimeline(items: readonly RecordView[], timeZone: string): readonly RecordView[] {
  return [...items].sort((left, right) => {
    const leftKey = timelineDisplayKey(left, timeZone);
    const rightKey = timelineDisplayKey(right, timeZone);
    if (leftKey < rightKey) return 1;
    if (leftKey > rightKey) return -1;
    if (left.createdAt.value < right.createdAt.value) return 1;
    if (left.createdAt.value > right.createdAt.value) return -1;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  });
}

function filterDate(items: readonly RecordView[], date: string | undefined, timeZone: string): readonly RecordView[] {
  assertTimeZone(timeZone);
  if (date === undefined) return items;
  return items.filter((item) => dateForTime(item.occurredAt ?? item.createdAt, timeZone) === date);
}

function assertTimeZone(timeZone: string): void {
  try {
    // Constructing the formatter validates IANA names before rows are examined.
    new Intl.DateTimeFormat("en-CA", { timeZone }).format();
  } catch {
    throw new HttpError(400, "invalid_time_zone", "timeZone must be a valid IANA time zone");
  }
}

/** Inclusive range over the same local-day key `filterDate` matches on. */
function filterDateRange(items: readonly RecordView[], from: string | undefined, to: string | undefined, timeZone: string): readonly RecordView[] {
  if (from === undefined && to === undefined) return items;
  assertTimeZone(timeZone);
  return items.filter((item) => {
    const date = dateForTime(item.occurredAt ?? item.createdAt, timeZone);
    if (from !== undefined && date < from) return false;
    return !(to !== undefined && date > to);
  });
}

/** Every calendar day in an inclusive range, so a month grid can ask for a range once. */
function datesBetween(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = start; at <= end; at += 86_400_000) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}

function buildRecord(input: JsonObject, repository: SqliteRecordRepository): TimelineRecord {
  hasOnlyKeys(input, ["kind", "content", "occurredAt", "dueAt", "isPrivate", "isDemo", "isBackfill", "weather", "entityRefs", "relatedRecordIds", "assetRefs"]);
  const kind = enumField(input.kind, RECORD_KINDS, "kind");
  const content = stringField(input.content, "content");
  if (input.occurredAt !== undefined && input.occurredAt === null) throw new HttpError(400, "invalid_time", "occurredAt cannot be null on create");
  if (input.dueAt !== undefined && kind !== "task") throw new HttpError(400, "invalid_field", "dueAt is only valid for task records");
  const occurredAt = input.occurredAt === undefined ? undefined : parseLifeTime(input.occurredAt, "occurredAt");
  const dueAt = input.dueAt === undefined ? undefined : parseLifeTime(input.dueAt, "dueAt");
  const isPrivate = input.isPrivate === undefined ? undefined : booleanField(input.isPrivate, "isPrivate");
  const isDemo = input.isDemo === undefined ? undefined : booleanField(input.isDemo, "isDemo");
  const isBackfill = input.isBackfill === undefined ? undefined : booleanField(input.isBackfill, "isBackfill");
  const weather = input.weather === undefined ? undefined : coreValidated("weather", () => {
    assertValidWeatherAttachment(input.weather);
    return input.weather as WeatherAttachment;
  });
  const id = randomUUID();
  const explicitRefs = input.entityRefs === undefined ? ([] as const) : entityRefsField(input.entityRefs, repository);
  const common = {
    id,
    createdAt: nowInstant(),
    body: { original: content },
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(isPrivate === undefined ? {} : { isPrivate }),
    ...(isDemo === undefined ? {} : { isDemo }),
    ...(isBackfill === undefined ? {} : { isBackfill }),
    ...(weather === undefined ? {} : { weather }),
    entityRefs: withMentionRefs(content, explicitRefs, repository),
    relatedRecordIds:
      input.relatedRecordIds === undefined ? ([] as const) : relatedRecordIdsField(input.relatedRecordIds, id, repository),
    assetRefs: input.assetRefs === undefined ? ([] as const) : assetRefsField(input.assetRefs, repository),
    aiDerived: [] as const,
  };
  if (kind === "task") return { ...common, kind: "task", task: { status: "todo", ...(dueAt === undefined ? {} : { dueAt }) } };
  if (dueAt !== undefined) throw new HttpError(400, "invalid_field", "dueAt is only valid for task records");
  return { ...common, kind } as TimelineRecord;
}

function patchRecord(
  current: RecordView,
  input: JsonObject,
  repository: SqliteRecordRepository,
): { expectedRevision: number; record: TimelineRecord } {
  hasOnlyKeys(input, ["revision", "content", "occurredAt", "dueAt", "isPrivate", "isBackfill", "weather", "status", "entityRefs", "relatedRecordIds", "assetRefs"]);
  const expectedRevision = revisionField(input.revision);
  const { revision: _revision, ...base } = current;
  let record: TimelineRecord = base;
  if (Object.hasOwn(input, "isPrivate")) {
    record = { ...record, isPrivate: booleanField(input.isPrivate, "isPrivate") };
  }
  if (Object.hasOwn(input, "isBackfill")) {
    record = { ...record, isBackfill: booleanField(input.isBackfill, "isBackfill") };
  }
  if (Object.hasOwn(input, "weather")) {
    if (input.weather === null) {
      const { weather: _weather, ...withoutWeather } = record;
      record = withoutWeather;
    } else {
      const weather = coreValidated("weather", () => {
        assertValidWeatherAttachment(input.weather);
        return input.weather as WeatherAttachment;
      });
      record = { ...record, weather };
    }
  }
  if (input.content !== undefined) {
    const content = stringField(input.content, "content");
    record = { ...record, body: { ...record.body, edited: content } };
  }
  if (Object.hasOwn(input, "occurredAt")) {
    if (input.occurredAt === null) {
      const { occurredAt: _occurredAt, ...withoutOccurredAt } = record;
      record = withoutOccurredAt;
    } else {
      record = { ...record, occurredAt: parseLifeTime(input.occurredAt, "occurredAt") };
    }
  }
  if (Object.hasOwn(input, "dueAt") || Object.hasOwn(input, "status")) {
    if (record.kind !== "task") throw new HttpError(400, "invalid_field", "dueAt and status are only valid for task records");
    const task = record.task;
    const taskWithoutDueAt = Object.hasOwn(input, "dueAt") && input.dueAt === null
      ? (() => {
          const { dueAt: _dueAt, ...withoutDueAt } = task;
          return withoutDueAt;
        })()
      : task;
    const nextTask = {
      ...taskWithoutDueAt,
      ...(Object.hasOwn(input, "dueAt") && input.dueAt !== null ? { dueAt: parseLifeTime(input.dueAt, "dueAt") } : {}),
      ...(Object.hasOwn(input, "status") ? { status: enumField(input.status, TASK_STATUSES, "status") } : {}),
    };
    record = { ...record, task: nextTask };
  }
  if (input.entityRefs !== undefined) {
    record = { ...record, entityRefs: entityRefsField(input.entityRefs, repository) };
  }
  // Only a write that carries text re-reads the mentions in it, so removing a
  // chip by hand is not undone by an unrelated status change.
  if (input.content !== undefined) {
    record = { ...record, entityRefs: withMentionRefs(record.body.edited ?? record.body.original, record.entityRefs, repository) };
  }
  if (input.relatedRecordIds !== undefined) {
    record = { ...record, relatedRecordIds: relatedRecordIdsField(input.relatedRecordIds, record.id, repository) };
  }
  if (input.assetRefs !== undefined) {
    record = { ...record, assetRefs: assetRefsField(input.assetRefs, repository) };
  }
  record = { ...record, updatedAt: nowInstant() };
  return { expectedRevision, record };
}

function safeId(segment: string): string {
  if (segment.length === 0 || segment.length > 512) throw new HttpError(400, "invalid_id", "Invalid record id");
  return segment;
}

function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

function arrayField(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_field", `${name} must be an array`);
  return value;
}

/** Re-runs the core rules so adapter input validation cannot drift from the domain rules. */
function coreValidated<T>(name: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new HttpError(400, "invalid_field", `${name}: ${error instanceof Error ? error.message : "invalid value"}`);
  }
}

function decodeSegment(segment: string): string {
  try {
    return safeId(decodeURIComponent(segment));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_id", "Invalid id");
  }
}

function entityRefsField(value: unknown, repository: SqliteRecordRepository): readonly EntityRef[] {
  const items = arrayField(value, "entityRefs");
  const refs = coreValidated("entityRefs", () => {
    items.forEach((item, index) => assertValidEntityRef(item, `entityRefs[${index}]`));
    return items as readonly EntityRef[];
  });
  const seen = new Set<string>();
  const resolved: EntityRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.entityId)) throw new HttpError(400, "duplicate_reference", `entityRefs repeats ${ref.entityId}`);
    seen.add(ref.entityId);
    const entity = repository.findEntityById(ref.entityId);
    if (entity === null) throw new HttpError(400, "unknown_entity", `Unknown entity: ${ref.entityId}`);
    if (entity.type !== ref.entityType) {
      throw new HttpError(400, "entity_type_mismatch", `Entity ${ref.entityId} is a ${entity.type}, not a ${ref.entityType}`);
    }
    // Storing the label keeps the timeline readable even if the entity is deleted later.
    resolved.push(ref.label === undefined ? { entityType: ref.entityType, entityId: ref.entityId, label: entity.name } : ref);
  }
  return resolved;
}

function relatedRecordIdsField(value: unknown, selfId: string, repository: SqliteRecordRepository): readonly string[] {
  const items = arrayField(value, "relatedRecordIds");
  const ids = coreValidated("relatedRecordIds", () => {
    items.forEach((item, index) => {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`relatedRecordIds[${index}] must be a non-empty string`);
      }
    });
    return items as readonly string[];
  });
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === selfId) throw new HttpError(400, "self_reference", "A record cannot relate to itself");
    if (seen.has(id)) throw new HttpError(400, "duplicate_reference", `relatedRecordIds repeats ${id}`);
    seen.add(id);
    if (repository.findById(id) === null) throw new HttpError(400, "unknown_record", `Unknown record: ${id}`);
  }
  return ids;
}

function assetRefsField(value: unknown, repository: SqliteRecordRepository): readonly AssetLink[] {
  const items = arrayField(value, "assetRefs");
  const refs = coreValidated("assetRefs", () => {
    items.forEach((item, index) => assertValidAssetLink(item, `assetRefs[${index}]`));
    return items as readonly AssetLink[];
  });
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.assetId)) throw new HttpError(400, "duplicate_reference", `assetRefs repeats ${ref.assetId}`);
    seen.add(ref.assetId);
    if (repository.findAssetById(ref.assetId) === null) {
      throw new HttpError(400, "unknown_asset", `Unknown asset: ${ref.assetId}`);
    }
  }
  return refs;
}

function storageRefsField(value: unknown): readonly StorageReference[] {
  const items = arrayField(value, "storageRefs");
  if (items.length === 0) throw new HttpError(400, "invalid_field", "storageRefs must not be empty");
  return coreValidated("storageRefs", () => {
    items.forEach((item, index) => assertValidStorageReference(item, `storageRefs[${index}]`));
    return items as readonly StorageReference[];
  });
}

function sizeBytesField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, "invalid_field", "sizeBytes must be a non-negative number");
  }
  return value;
}

function aliasesField(value: unknown): readonly string[] {
  const items = arrayField(value, "aliases");
  const cleaned = coreValidated("aliases", () => {
    items.forEach((item, index) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new Error(`aliases[${index}] must be a non-empty string`);
      }
    });
    return items as readonly string[];
  });
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const alias of cleaned) {
    const trimmed = alias.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

const MOVIE_FIELD_NAMES = [
  "originalTitle",
  "releaseYear",
  "posterUrl",
  "overview",
  "externalIds",
  "doubanRating",
  "personalRating",
  "personalReview",
  "watchedAt",
] as const;

function movieScoreField(value: unknown, name: string, halfStep: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10 || (halfStep && !Number.isInteger(value * 2))) {
    throw new HttpError(400, "invalid_field", `${name} must be between 0 and 10${halfStep ? " in 0.5 increments" : ""}`);
  }
  return value;
}

function movieExternalIdsField(value: unknown): MovieExternalIds {
  const input = jsonObject(value, "externalIds");
  hasOnlyKeys(input, ["tmdb", "imdb", "douban"]);
  const ids: { tmdb?: string; imdb?: string; douban?: string } = {};
  if (input.tmdb !== undefined) ids.tmdb = String(boundedIntegerField(typeof input.tmdb === "string" && /^\d+$/.test(input.tmdb) ? Number(input.tmdb) : input.tmdb, "externalIds.tmdb", 1, Number.MAX_SAFE_INTEGER));
  if (input.imdb !== undefined) {
    const imdb = stringField(input.imdb, "externalIds.imdb", { nonEmpty: true }).trim().toLowerCase();
    if (!/^tt\d+$/.test(imdb)) throw new HttpError(400, "invalid_field", "externalIds.imdb must look like tt1234567");
    ids.imdb = imdb;
  }
  if (input.douban !== undefined) {
    const raw = typeof input.douban === "number" ? String(input.douban) : stringField(input.douban, "externalIds.douban", { nonEmpty: true }).trim();
    const douban = raw.match(/^https?:\/\/(?:www\.)?(?:movie\.)?douban\.com\/subject\/(\d+)\/?$/i)?.[1] ?? raw;
    if (!/^\d+$/.test(douban) || douban.length === 0 || !Number.isSafeInteger(Number(douban)) || Number(douban) <= 0) {
      throw new HttpError(400, "invalid_field", "externalIds.douban must be a numeric subject id or Douban subject URL");
    }
    ids.douban = douban;
  }
  return ids;
}

function movieReleaseYearField(value: unknown): number {
  return boundedIntegerField(value, "releaseYear", 1, 9999);
}

function movieWatchedAtField(value: unknown): string {
  const parsed = parseDateQuery(stringField(value, "watchedAt"), "watchedAt");
  if (parsed === undefined) throw new HttpError(400, "invalid_date", "watchedAt must use YYYY-MM-DD");
  return parsed;
}

/** Parse movie-only fields, with null accepted only for PATCH-style clearing. */
function movieFieldsField(input: JsonObject, allowNull: boolean): JsonObject {
  const output: JsonObject = {};
  for (const field of MOVIE_FIELD_NAMES) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value === null) {
      if (!allowNull) throw new HttpError(400, "invalid_field", `${field} cannot be null`);
      output[field] = null;
      continue;
    }
    if (field === "originalTitle" || field === "posterUrl" || field === "overview" || field === "personalReview") {
      output[field] = stringField(value, field);
    } else if (field === "releaseYear") {
      output[field] = movieReleaseYearField(value);
    } else if (field === "externalIds") {
      output[field] = movieExternalIdsField(value);
    } else if (field === "doubanRating") {
      output[field] = movieScoreField(value, field, false);
    } else if (field === "personalRating") {
      output[field] = movieScoreField(value, field, true);
    } else if (field === "watchedAt") {
      output[field] = movieWatchedAtField(value);
    }
  }
  return output;
}

function assertMovieOnlyFields(type: EntityKind, input: JsonObject): void {
  if (type !== "movie" && MOVIE_FIELD_NAMES.some((field) => Object.hasOwn(input, field))) {
    throw new HttpError(400, "invalid_field", "Movie fields are only allowed on a movie entity");
  }
}

function addressField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const address = stringField(value, "address").trim();
  if (address.length > 500) throw new HttpError(400, "invalid_field", "address is too long");
  return address.length === 0 ? undefined : address;
}

function placeRoleField(value: unknown): PlaceRole {
  if (typeof value !== "string" || !PLACE_ROLES.includes(value as PlaceRole)) {
    throw new HttpError(400, "invalid_field", `role must be one of: ${PLACE_ROLES.join(", ")}`);
  }
  return value as PlaceRole;
}

function placePeriodField(value: unknown): PlacePeriod {
  const period = jsonObject(value, "period");
  hasOnlyKeys(period, ["from", "until"]);
  const rawFrom = period.from === undefined ? undefined : stringField(period.from, "period.from");
  const rawUntil = period.until === undefined ? undefined : stringField(period.until, "period.until");
  if (rawFrom !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(rawFrom)) {
    throw new HttpError(400, "invalid_field", `period.from must be YYYY-MM: ${rawFrom}`);
  }
  if (rawUntil !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(rawUntil)) {
    throw new HttpError(400, "invalid_field", `period.until must be YYYY-MM: ${rawUntil}`);
  }
  if (rawFrom !== undefined && rawUntil !== undefined && rawFrom > rawUntil) {
    throw new HttpError(400, "invalid_field", "period.from must not be after period.until");
  }
  const candidate: unknown = {
    ...(rawFrom === undefined ? {} : { from: rawFrom }),
    ...(rawUntil === undefined ? {} : { until: rawUntil }),
  };
  // Re-check through core so the API and any future adapter share one rule.
  coreValidated("period", () => {
    assertValidEntity({ type: "place", id: "check", name: "check", period: candidate });
    return true;
  });
  return candidate as PlacePeriod;
}

/** Role and period live on places only; anything else carrying them is a client bug. */
function placeOnlyFields(type: EntityKind, role: PlaceRole | undefined, period: PlacePeriod | undefined, address: string | null | undefined = undefined): void {
  if (type !== "place" && (role !== undefined || period !== undefined || (address !== undefined && address !== null))) {
    throw new HttpError(400, "invalid_field", "role, period and address are only allowed on a place");
  }
}

/**
 * A typed marker in the text is a relation: `@person` and `#place` both turn
 * into entityRefs. Mentions only ever add: an explicit entityRefs edit is the
 * place to remove one, so a stale name in the text can never silently drop a
 * link the user made on purpose.
 */
function withMentionRefs(text: string, refs: readonly EntityRef[], repository: SqliteRecordRepository): readonly EntityRef[] {
  const mentions = findEntityMentions(text, repository.listEntities());
  if (mentions.length === 0) return refs;
  const known = new Set(refs.map((ref) => ref.entityId));
  const merged = [...refs];
  for (const mention of mentions) {
    if (known.has(mention.entityId)) continue;
    const entity = repository.findEntityById(mention.entityId);
    if (entity === null) continue;
    known.add(mention.entityId);
    merged.push({ entityType: entity.type, entityId: entity.id, label: entity.name });
  }
  return merged;
}

/** LifeOS stores a reference to an original that stays wherever it already lives. */
function buildAsset(input: JsonObject, id: string, storageRefs: readonly StorageReference[]): Asset {
  const kind = enumField(input.kind, ASSET_KINDS, "kind");
  const originalName = input.originalName === undefined ? undefined : stringField(input.originalName, "originalName");
  const mediaType = input.mediaType === undefined ? undefined : stringField(input.mediaType, "mediaType");
  const sizeBytes = input.sizeBytes === undefined ? undefined : sizeBytesField(input.sizeBytes);
  const candidate: unknown = {
    id,
    kind,
    storageRefs,
    createdAt: nowInstant(),
    ...(originalName === undefined ? {} : { originalName }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
  assertValidAsset(candidate);
  return candidate;
}

/**
 * Entity is a union discriminated by `type`; spreading it directly widens the
 * discriminant, so the result is validated after the edit instead of cast blindly.
 */
function withEntityEdits(
  entity: Entity,
  edits: { readonly name?: string; readonly aliases?: readonly string[]; readonly description?: string; readonly role?: PlaceRole; readonly period?: PlacePeriod; readonly address?: string | null },
): Entity {
  const candidate: unknown = {
    ...entity,
    ...(edits.name === undefined ? {} : { name: edits.name }),
    ...(edits.aliases === undefined ? {} : { aliases: edits.aliases }),
    ...(edits.description === undefined ? {} : { description: edits.description }),
    ...(edits.role === undefined ? {} : { role: edits.role }),
    ...(edits.period === undefined ? {} : { period: edits.period }),
    ...(edits.address === undefined ? {} : { address: edits.address === null ? undefined : edits.address }),
  };
  assertValidEntity(candidate);
  return candidate;
}

function withMovieEdits(entity: Entity, edits: JsonObject): Entity {
  if (entity.type !== "movie" || Object.keys(edits).length === 0) return entity;
  const candidate: JsonObject = { ...entity };
  for (const field of MOVIE_FIELD_NAMES) {
    if (!Object.hasOwn(edits, field)) continue;
    const value = edits[field];
    if (value === null) delete candidate[field];
    else candidate[field] = value;
  }
  assertValidEntity(candidate);
  return candidate as Movie;
}

const MOVIE_INPUT_KEYS = [
  "id",
  "type",
  "name",
  "title",
  "query",
  "aliases",
  "description",
  "originalTitle",
  "releaseYear",
  "posterUrl",
  "overview",
  "externalIds",
  "tmdbId",
  "imdbId",
  "doubanId",
  "doubanUrl",
  "doubanRating",
  "personalRating",
  "personalReview",
  "watchedAt",
] as const;

function moviePayload(input: JsonObject): JsonObject {
  if (Object.hasOwn(input, "movie")) return jsonObject(input.movie, "movie");
  if (Object.hasOwn(input, "candidate")) return jsonObject(input.candidate, "candidate");
  return input;
}

function movieIdentifierField(value: unknown, name: string): string {
  const id = stringField(value, name, { nonEmpty: true }).trim();
  if (!/^\d+$/.test(id)) throw new HttpError(400, "invalid_field", `${name} must be numeric`);
  return id;
}

function movieInputEntity(input: JsonObject, idOverride?: string): Movie {
  hasOnlyKeys(input, MOVIE_INPUT_KEYS);
  if (input.type !== undefined && input.type !== "movie") throw new HttpError(400, "invalid_field", "movie.type must be movie");
  const nameValue = input.name ?? input.title;
  const name = stringField(nameValue, "name", { nonEmpty: true });
  const aliases = input.aliases === undefined ? undefined : aliasesField(input.aliases);
  const description = input.description === undefined ? undefined : stringField(input.description, "description");
  const fields = movieFieldsField(input, false);
  const parsedExternal = fields.externalIds as MovieExternalIds | undefined;
  const externalIds: { tmdb?: string; imdb?: string; douban?: string } = {
    ...(parsedExternal?.tmdb === undefined ? {} : { tmdb: String(parsedExternal.tmdb) }),
    ...(parsedExternal?.imdb === undefined ? {} : { imdb: parsedExternal.imdb }),
    ...(parsedExternal?.douban === undefined ? {} : { douban: String(parsedExternal.douban) }),
  };
  if (input.tmdbId !== undefined) externalIds.tmdb = String(boundedIntegerField(typeof input.tmdbId === "string" && /^\d+$/.test(input.tmdbId) ? Number(input.tmdbId) : input.tmdbId, "tmdbId", 1, Number.MAX_SAFE_INTEGER));
  if (input.imdbId !== undefined) {
    const imdb = stringField(input.imdbId, "imdbId", { nonEmpty: true }).trim().toLowerCase();
    if (!/^tt\d+$/.test(imdb)) throw new HttpError(400, "invalid_field", "imdbId must look like tt1234567");
    externalIds.imdb = imdb;
  }
  const doubanInput = input.doubanId ?? input.doubanUrl;
  if (doubanInput !== undefined) {
    const raw = input.doubanUrl === undefined && typeof doubanInput === "number"
      ? String(doubanInput)
      : stringField(doubanInput, input.doubanUrl !== undefined ? "doubanUrl" : "doubanId", { nonEmpty: true });
    const match = input.doubanUrl === undefined ? raw : raw.match(/(?:movie\.)?douban\.com\/subject\/(\d+)/i)?.[1];
    if (match === undefined) throw new HttpError(400, "invalid_field", "doubanUrl must contain a subject id");
    externalIds.douban = match;
  }
  const hasExternalIds = Object.keys(externalIds).length > 0;
  const suppliedId = input.id === undefined ? undefined : stringField(input.id, "id", { nonEmpty: true });
  const providerId = externalIds.tmdb ?? (externalIds.imdb === undefined ? externalIds.douban : externalIds.imdb);
  const providerIdLooksLikeInternal = suppliedId !== undefined && providerId !== undefined && suppliedId === providerId;
  const generatedId = providerId === undefined
    ? `movie_${randomUUID()}`
    : externalIds.tmdb !== undefined
      ? `movie_tmdb_${externalIds.tmdb}`
      : externalIds.imdb !== undefined
        ? `movie_imdb_${externalIds.imdb}`
        : `movie_douban_${externalIds.douban}`;
  const candidate: JsonObject = {
    type: "movie",
    id: idOverride ?? (providerIdLooksLikeInternal ? generatedId : suppliedId ?? generatedId),
    name,
    createdAt: nowInstant(),
    ...(aliases === undefined ? {} : { aliases }),
    ...(description === undefined ? {} : { description }),
    ...fields,
    ...(hasExternalIds ? { externalIds } : {}),
  };
  assertValidEntity(candidate);
  return candidate as Movie;
}

function movieExternalId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    return trimmed.match(/^https?:\/\/(?:www\.)?(?:movie\.)?douban\.com\/subject\/(\d+)\/?$/i)?.[1] ?? trimmed;
  }
  return undefined;
}

function movieTitleMatches(left: Movie, right: Movie): boolean {
  const terms = new Set([left.name, ...(left.aliases ?? [])].map((term) => normalizeEntitySearchTerm(term)));
  return [right.name, ...(right.aliases ?? [])].some((term) => terms.has(normalizeEntitySearchTerm(term)));
}

function movieMatch(repository: SqliteRecordRepository, candidate: Movie): Movie | null {
  const incoming = candidate.externalIds ?? {};
  const movies = repository.listEntities({ type: "movie" }) as readonly Movie[];
  const tmdb = movieExternalId(incoming.tmdb);
  if (tmdb !== undefined) {
    const match = movies.find((movie) => movieExternalId(movie.externalIds?.tmdb) === tmdb);
    if (match !== undefined) return match;
  }
  const imdb = movieExternalId(incoming.imdb)?.toLowerCase();
  if (imdb !== undefined) {
    const match = movies.find((movie) => movieExternalIdsMatch(movie, "imdb", imdb));
    if (match !== undefined) return match;
  }
  const douban = movieExternalId(incoming.douban);
  if (douban !== undefined) {
    const match = movies.find((movie) => movieExternalIdsMatch(movie, "douban", douban) && movieTitleMatches(movie, candidate));
    if (match !== undefined) return match;
  }
  // A caller may be editing a manually-created movie that has no provider ID;
  // its explicit LifeOS id is still a safe final upsert key.
  const byId = movies.find((movie) => movie.id === candidate.id);
  return byId ?? null;
}

function movieExternalIdsMatch(movie: Movie, key: "imdb" | "douban", expected: string): boolean {
  const actual = movieExternalId(movie.externalIds?.[key]);
  return actual !== undefined && actual.toLowerCase() === expected.toLowerCase();
}

function movieNameHasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function mergeMovie(existing: Movie, incoming: Movie): Movie {
  const name = movieNameHasCjk(incoming.name) || !movieNameHasCjk(existing.name) ? incoming.name : existing.name;
  const aliases = [...new Set([existing.name, incoming.name, ...(existing.aliases ?? []), ...(incoming.aliases ?? [])])].filter((alias) => alias !== name);
  const externalIds = { ...(existing.externalIds ?? {}), ...(incoming.externalIds ?? {}) };
  const candidate: JsonObject = {
    ...existing,
    ...incoming,
    id: existing.id,
    createdAt: existing.createdAt,
    name,
    ...(aliases.length === 0 ? {} : { aliases }),
    ...(Object.keys(externalIds).length === 0 ? {} : { externalIds }),
  };
  assertValidEntity(candidate);
  return candidate as Movie;
}

function withRelation(entity: Entity, relation: EntityRelation): Entity {
  const relations = (entity.relations ?? []).filter((existing) => existing.entityId !== relation.entityId);
  relations.push(relation);
  const candidate: unknown = { ...entity, relations };
  assertValidEntity(candidate);
  return candidate;
}

function withoutRelation(entity: Entity, targetId: string): Entity {
  const relations = (entity.relations ?? []).filter((existing) => existing.entityId !== targetId);
  const { relations: _dropped, ...rest } = entity;
  // No relations means no field at all, so the stored shape stays lean.
  const candidate: unknown = relations.length === 0 ? rest : { ...rest, relations };
  assertValidEntity(candidate);
  return candidate;
}

const SERVABLE_ASSET_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".heic",
  ".mp3", ".m4a", ".aac", ".ogg", ".wav",
  ".mp4", ".webm",
]);

/**
 * One JSONL line per request, written to logs/api-YYYY-MM-DD.log next to the
 * data directory. Errors carry the reason; everything else is just
 * method/path/status/duration, so the file stays small and greppable.
 */
const requestLog = (() => {
  const logDir = process.env.LIFEOS_LOG_DIR ?? resolve(process.env.LIFEOS_DATA_DIR ?? process.cwd(), "..", "logs");
  let cachedDate = "";
  let stream: WriteStream | undefined;
  return (status: number, method: string, path: string, startedAt: number, error?: string) => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (stream === undefined || cachedDate !== day) {
        mkdirSync(logDir, { recursive: true });
        stream = createWriteStream(resolve(logDir, `api-${day}.log`), { flags: "a" });
        cachedDate = day;
      }
      const line: Record<string, unknown> = {
        at: new Date().toISOString(),
        method,
        path,
        status,
        ms: Date.now() - startedAt,
      };
      if (error !== undefined) line.error = error;
      stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      // Logging must never take the API down with it.
    }
  };
})();

const ASSET_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * Resolves an asset reference inside the configured asset root. Both sides are
 * realpath'd first so a symlink cannot walk out of the root, and only media
 * files are served at all. The original is read in place; LifeOS never copies it.
 */
function resolveLocalAsset(root: string, sourceRef: string): { file: string; mediaType: string } {
  if (sourceRef.includes("\0")) throw new HttpError(400, "invalid_reference", "Invalid asset reference");
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    throw new HttpError(404, "asset_root_missing", "LIFEOS_ASSET_ROOT does not exist");
  }
  let realFile: string;
  try {
    realFile = realpathSync(resolve(realRoot, sourceRef));
  } catch {
    throw new HttpError(404, "asset_file_missing", "The referenced original is not available");
  }
  const relativePath = relative(realRoot, realFile);
  if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new HttpError(403, "asset_outside_root", "Asset reference points outside LIFEOS_ASSET_ROOT");
  }
  const extension = extname(realFile).toLowerCase();
  if (!SERVABLE_ASSET_EXTENSIONS.has(extension)) {
    throw new HttpError(415, "unsupported_asset_type", "Only image, audio and video originals can be served");
  }
  if (!statSync(realFile).isFile()) throw new HttpError(404, "asset_file_missing", "The referenced original is not available");
  return { file: realFile, mediaType: ASSET_MEDIA_TYPES[extension] ?? "application/octet-stream" };
}

export interface LifeosApp {
  readonly repository: SqliteRecordRepository;
  readonly backupScheduler: BackupScheduler;
  readonly weatherArchiveScheduler: WeatherArchiveScheduler;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly close: () => void;
}

export function createApp(config: ApiConfig, repository = new SqliteRecordRepository(config.databasePath)): LifeosApp {
  const loginFailures = new Map<string, { failures: number; blockedUntil: number }>();
  const backupScheduler = new BackupScheduler({
    repository,
    config,
    onError: (error) => console.error("[backup-scheduler] scheduled backup failed:", error),
  });
  backupScheduler.start();
  const weatherArchiveScheduler = new WeatherArchiveScheduler({
    repository,
    config,
    onError: (error) => console.error("[weather-archive] daily archive failed:", error),
  });
  weatherArchiveScheduler.start();
  // One provider for the process: it holds no per-request state, and the summaries
  // it produces are cached per day, so a month view does not re-ask on every open.
  const daySummaryProvider = createDaySummaryProvider(config);

  function authenticated(req: IncomingMessage): boolean {
    if (config.password === undefined) return true;
    repository.purgeExpiredSessions();
    const token = cookieValue(req, SESSION_COOKIE);
    return token !== undefined && repository.hasSession(sessionHash(token));
  }

  function requireAuth(req: IncomingMessage): void {
    if (!authenticated(req)) throw new HttpError(401, "authentication_required", "Authentication required");
  }

  function checkRequestSecurity(req: IncomingMessage): void {
    // Passwordless mode is intentionally safe only on the loopback interface and
    // rejects a hostile Host header to prevent DNS-rebinding reads/writes.
    if (config.password === undefined && !localHostAllowed(req)) {
      throw new HttpError(421, "invalid_host", "Passwordless mode accepts loopback Host headers only");
    }
    if (!originAllowed(req, config)) throw new HttpError(403, "origin_not_allowed", "Origin is not allowed");
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    if (pathname === "/api/health" && req.method === "GET") {
      setJson(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/auth" && req.method === "GET") {
      setJson(res, 200, { required: config.password !== undefined, authenticated: authenticated(req) });
      return;
    }
    if (pathname === "/api/auth/login" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["password"]);
      const password = stringField(input.password, "password");
      if (config.password === undefined) {
        setJson(res, 200, { required: false, authenticated: true });
        return;
      }
      const loginKey = req.socket.remoteAddress ?? "unknown";
      const attempt = loginFailures.get(loginKey);
      if (attempt !== undefined && attempt.blockedUntil > Date.now()) {
        res.setHeader("retry-after", String(Math.ceil((attempt.blockedUntil - Date.now()) / 1000)));
        throw new HttpError(429, "login_rate_limited", "登录尝试过多，请稍后再试");
      }
      const expected = Buffer.from(config.password);
      const actual = Buffer.from(password);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        const failures = (attempt?.failures ?? 0) + 1;
        loginFailures.set(loginKey, { failures, blockedUntil: failures >= 5 ? Date.now() + 60_000 : 0 });
        throw new HttpError(401, "invalid_credentials", "Invalid credentials");
      }
      loginFailures.delete(loginKey);
      const token = randomBytes(32).toString("base64url");
      repository.createSession(sessionHash(token), Date.now() + SESSION_TTL_MS);
      setJson(res, 200, { required: true, authenticated: true }, { "set-cookie": cookieHeader(token, config, SESSION_TTL_MS / 1000) });
      return;
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      requireJsonContentType(req, true);
      const token = cookieValue(req, SESSION_COOKIE);
      if (token !== undefined) repository.deleteSession(sessionHash(token));
      setEmpty(res, 204, { "set-cookie": cookieHeader("", config, 0) });
      return;
    }

    requireAuth(req);
    if (pathname === "/api/backup/status" && req.method === "GET") {
      const s3 = publicBackupConfig(config);
      const schedule = backupScheduler.schedule;
      const runs = repository.listBackupRuns(100);
      const scheduledRuns = runs.filter((run) => run.kind === "scheduled");
      const latestScheduled = scheduledRuns[0];
      setJson(res, 200, {
        localDirectory: config.backupDirectory ?? null,
        s3,
        schedule: {
          ...schedule,
          timeZone: BACKUP_TIME_ZONE,
          nextRunAt: publicNextBackupAt(schedule),
          ...(latestScheduled?.finishedAt === undefined ? {} : { lastRunAt: latestScheduled.finishedAt }),
        },
        lastDualBackup: latestDualBackup(runs),
        retention: { policy: repository.getBackupRetention(), described: describeBackupRetention(repository.getBackupRetention()) },
        runs,
      });
      return;
    }
    if (pathname === "/api/backup/retention" && req.method === "GET") {
      setJson(res, 200, backupRetentionPayload(repository, config, backupScheduler.schedule));
      return;
    }
    if (pathname === "/api/backup/retention" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["dailyDays", "weeklyWeeks", "monthlyMonths", "trashDays"]);
      try {
        const policy: BackupRetention = {
          dailyDays: boundedIntegerField(input.dailyDays, "dailyDays", BACKUP_RETENTION_LIMITS.dailyDays.min, BACKUP_RETENTION_LIMITS.dailyDays.max),
          weeklyWeeks: boundedIntegerField(input.weeklyWeeks, "weeklyWeeks", BACKUP_RETENTION_LIMITS.weeklyWeeks.min, BACKUP_RETENTION_LIMITS.weeklyWeeks.max),
          monthlyMonths: boundedIntegerField(input.monthlyMonths, "monthlyMonths", BACKUP_RETENTION_LIMITS.monthlyMonths.min, BACKUP_RETENTION_LIMITS.monthlyMonths.max),
          trashDays: boundedIntegerField(input.trashDays, "trashDays", BACKUP_RETENTION_LIMITS.trashDays.min, BACKUP_RETENTION_LIMITS.trashDays.max),
        };
        repository.saveBackupRetention(policy);
        setJson(res, 200, backupRetentionPayload(repository, config, backupScheduler.schedule));
      } catch (error) {
        throw new HttpError(400, "invalid_backup_retention", error instanceof Error ? error.message : "保留策略无效");
      }
      return;
    }
    if (pathname === "/api/backup/runs" && req.method === "GET") {
      const from = parseDateQuery(url.searchParams.get("from"), "from");
      const to = parseDateQuery(url.searchParams.get("to"), "to");
      if ((from === undefined) !== (to === undefined)) throw new HttpError(400, "invalid_range", "from and to must be provided together");
      if (from !== undefined && to !== undefined) {
        if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
        const start = Date.parse(`${from}T00:00:00Z`);
        const end = Date.parse(`${to}T00:00:00Z`);
        if (!Number.isFinite(start) || !Number.isFinite(end) || (end - start) / 86_400_000 > 400) {
          throw new HttpError(400, "invalid_range", "备份日历最多查询 400 天");
        }
      }
      const allRuns = repository.listBackupRuns(1000);
      const items = from === undefined || to === undefined
        ? allRuns
        : allRuns.filter((run) => {
            const day = backupRunDate(run);
            return day >= from && day <= to;
          });
      setJson(res, 200, { items });
      return;
    }
    if (pathname === "/api/backup/config" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["enabled", "endpoint", "region", "bucket", "prefix", "forcePathStyle", "accessKeyId", "secretAccessKey"]);
      try {
        const status = saveRuntimeBackupConfig(config, {
          enabled: booleanField(input.enabled, "enabled"),
          endpoint: stringField(input.endpoint, "endpoint", { nonEmpty: true }),
          region: stringField(input.region, "region", { nonEmpty: true }),
          bucket: stringField(input.bucket, "bucket", { nonEmpty: true }),
          prefix: stringField(input.prefix ?? "product-backup/lifeos", "prefix"),
          forcePathStyle: booleanField(input.forcePathStyle, "forcePathStyle"),
          ...(input.accessKeyId === undefined ? {} : { accessKeyId: stringField(input.accessKeyId, "accessKeyId") }),
          ...(input.secretAccessKey === undefined ? {} : { secretAccessKey: stringField(input.secretAccessKey, "secretAccessKey") }),
        });
        setJson(res, 200, { ok: true, s3: status });
      } catch (error) {
        throw new HttpError(400, "invalid_backup_config", error instanceof Error ? error.message : "对象存储配置无效");
      }
      return;
    }
    if (pathname === "/api/backup/schedule" && req.method === "GET") {
      const schedule = backupScheduler.schedule;
      setJson(res, 200, { ...schedule, timeZone: BACKUP_TIME_ZONE, nextRunAt: publicNextBackupAt(schedule) });
      return;
    }
    if (pathname === "/api/backup/schedule" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["enabled", "hour", "minute"]);
      const schedule = {
        enabled: booleanField(input.enabled, "enabled"),
        hour: boundedIntegerField(input.hour, "hour", 0, 23),
        minute: boundedIntegerField(input.minute, "minute", 0, 59),
      } as const;
      try {
        repository.saveBackupSchedule(schedule);
        backupScheduler.update(schedule);
      } catch (error) {
        throw new HttpError(400, "invalid_backup_schedule", error instanceof Error ? error.message : "备份排程无效");
      }
      setJson(res, 200, { ...schedule, timeZone: BACKUP_TIME_ZONE, nextRunAt: publicNextBackupAt(schedule) });
      return;
    }
    if (pathname === "/api/backup/dual" && req.method === "POST") {
      requireJsonContentType(req, true);
      try {
        const result = await createDualBackup(config, repository, "manual");
        const status = result.status === "failed" ? 502 : 201;
        setJson(res, status, { ok: result.status !== "failed", provider: "dual", ...result });
      } catch (error) {
        throw backupHttpError(error);
      }
      return;
    }
    if (pathname === "/api/backup/local" && req.method === "POST") {
      requireJsonContentType(req, true);
      try {
        const artifact = await createLocalBackup(config, repository);
        const pruned = await pruneBackups(config, repository);
        setJson(res, 201, { ok: true, provider: "local", fileName: artifact.filename, location: artifact.path, sizeBytes: artifact.sizeBytes, pruned: pruned.trashedLocal + pruned.purgedLocal, prune: pruned });
      } catch (error) {
        throw backupHttpError(error);
      }
      return;
    }
    if (pathname === "/api/backup/s3" && req.method === "POST") {
      requireJsonContentType(req, true);
      try {
        const result = await uploadS3Backup(config, repository);
        setJson(res, 201, { ok: true, provider: "s3", fileName: result.filename, location: result.location, sizeBytes: result.sizeBytes });
      } catch (error) {
        throw backupHttpError(error);
      }
      return;
    }
    if (pathname === "/api/backup/s3/test" && req.method === "POST") {
      requireJsonContentType(req, true);
      try {
        const result = await testS3Backup(config, repository);
        setJson(res, 200, { ok: true, location: result.location, transport: result.transport, ...(result.transport === "file" ? { warning: "当前对象存储 Endpoint 是本机目录（file://），连接测试只写入了本机文件，不能证明可以联网上传。" } : {}) });
      } catch (error) {
        throw backupHttpError(error);
      }
      return;
    }
    if (pathname === "/api/ai/status" && req.method === "GET") {
      setJson(res, 200, publicAiConfig(config));
      return;
    }
    if (pathname === "/api/ai/config" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["enabled", "baseUrl", "model", "thinking", "reasoningEffort", "apiKey", "clearApiKey"]);
      try {
        const status = saveRuntimeAiConfig(config, {
          enabled: input.enabled === undefined ? true : booleanField(input.enabled, "enabled"),
          baseUrl: stringField(input.baseUrl, "baseUrl", { nonEmpty: true }),
          model: stringField(input.model, "model", { nonEmpty: true }),
          ...(input.thinking === undefined ? {} : { thinking: booleanField(input.thinking, "thinking") }),
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort === null ? null : enumField(input.reasoningEffort, AI_REASONING_EFFORTS, "reasoningEffort") }),
          ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
          ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
        });
        setJson(res, 200, status);
      } catch (error) {
        throw new HttpError(400, "invalid_ai_config", error instanceof Error ? error.message : "AI 配置无效");
      }
      return;
    }
    if (pathname === "/api/ai/config/test" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["baseUrl", "apiKey"]);
      try {
        const message = await testRuntimeAiConfig(config, {
          baseUrl: stringField(input.baseUrl, "baseUrl", { nonEmpty: true }),
          ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
        });
        setJson(res, 200, { ok: true, message });
      } catch (error) {
        throw new HttpError(502, "ai_config_test_failed", error instanceof Error ? error.message : "AI 服务连接失败");
      }
      return;
    }
    const movieStatusPath = pathname === "/api/movie/status" || pathname === "/api/movies/status";
    const movieConfigPath = pathname === "/api/movie/config" || pathname === "/api/movies/config";
    const movieConfigTestPath = pathname === "/api/movie/config/test" || pathname === "/api/movies/config/test";
    const movieResolvePath = pathname === "/api/movie/resolve" || pathname === "/api/movies/resolve";
    const movieImportPath = pathname === "/api/movie/import" || pathname === "/api/movies/import";
    const movieUpsertPath = pathname === "/api/movie/upsert" || pathname === "/api/movies/upsert";
    if (movieStatusPath && req.method === "GET") {
      setJson(res, 200, publicMovieConfig(config));
      return;
    }
    if (movieConfigPath && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["enabled", "apiKey", "clearApiKey"]);
      const current = readRuntimeMovieConfig(config);
      try {
        const status = saveRuntimeMovieConfig(config, {
          enabled: input.enabled === undefined ? current.enabled : booleanField(input.enabled, "enabled"),
          ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
          ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
        });
        setJson(res, 200, status);
      } catch (error) {
        throw new HttpError(400, "invalid_movie_config", error instanceof Error ? error.message : "观影配置无效");
      }
      return;
    }
    if (movieConfigTestPath && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["apiKey"]);
      const message = await testMovieConfig(config, input.apiKey === undefined ? undefined : stringField(input.apiKey, "apiKey"));
      setJson(res, 200, { ok: true, message });
      return;
    }
    if (movieResolvePath && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["query", "title", "imdbId", "tmdbId", "doubanId", "doubanUrl"]);
      const queryParts = [
        input.query === undefined ? undefined : stringField(input.query, "query"),
        input.doubanUrl === undefined ? undefined : stringField(input.doubanUrl, "doubanUrl"),
      ].filter((value): value is string => value !== undefined && value.trim().length > 0);
      const query = queryParts.length === 0 ? undefined : queryParts.join(" ");
      const result = await resolveMovies(config, {
        ...(query === undefined ? {} : { query }),
        ...(input.title === undefined ? {} : { title: stringField(input.title, "title") }),
        ...(input.imdbId === undefined ? {} : { imdbId: stringField(input.imdbId, "imdbId") }),
        ...(input.tmdbId === undefined ? {} : { tmdbId: typeof input.tmdbId === "number" ? input.tmdbId : stringField(input.tmdbId, "tmdbId") }),
        ...(input.doubanId === undefined ? {} : { doubanId: typeof input.doubanId === "number" ? input.doubanId : stringField(input.doubanId, "doubanId") }),
      });
      setJson(res, 200, result);
      return;
    }
    if ((movieImportPath || movieUpsertPath) && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      if (!readRuntimeMovieConfig(config).enabled) throw new MovieModuleError(409, "movie_module_disabled", "观影模块未启用；请先在设置中启用");
      if (Object.hasOwn(input, "movie") || Object.hasOwn(input, "candidate")) hasOnlyKeys(input, ["movie", "candidate"]);
      let source = moviePayload(input);
      if (source.name === undefined && source.title === undefined) {
        const lookup: JsonObject = {};
        for (const key of ["query", "title", "imdbId", "tmdbId", "doubanId", "doubanUrl"] as const) {
          if (source[key] !== undefined) lookup[key] = source[key];
        }
        if (source.doubanUrl !== undefined) {
          const doubanUrl = stringField(source.doubanUrl, "doubanUrl");
          lookup.query = lookup.query === undefined ? doubanUrl : `${String(lookup.query)} ${doubanUrl}`;
        }
        const resolved = await resolveMovies(config, lookup);
        if (resolved.candidates.length === 0) throw new HttpError(404, "movie_not_found", "TMDb 没有找到影片");
        if (resolved.candidates.length > 1) throw new HttpError(409, "movie_candidate_required", "匹配到多部影片，请先选择候选项");
        source = { ...resolved.candidates[0], ...source };
      }
      const movie = movieInputEntity(source);
      const existing = movieMatch(repository, movie);
      if (existing === null) {
        repository.insertEntity(movie);
        setJson(res, 201, { created: true, entity: movie });
      } else {
        const updated = mergeMovie(existing, movie);
        repository.updateEntity(updated);
        setJson(res, 200, { created: false, entity: updated });
      }
      return;
    }
    if (pathname === "/api/ai/assistant" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["message", "history", "pageUrl"]);
      const message = stringField(input.message, "message", { nonEmpty: true });
      if (message.length > 2000) throw new HttpError(400, "invalid_field", "message is too long");
      const historyRaw = input.history === undefined ? [] : input.history;
      if (!Array.isArray(historyRaw)) throw new HttpError(400, "invalid_field", "history must be an array");
      const history: AssistantHistoryItem[] = historyRaw.slice(-8).map((item, index) => {
        const entry = jsonObject(item, `history[${index}]`);
        hasOnlyKeys(entry, ["role", "text"]);
        const role = enumField(entry.role, ["user", "assistant"] as const, `history[${index}].role`);
        const text = stringField(entry.text, `history[${index}].text`, { nonEmpty: true });
        return { role, text: text.slice(0, 1200) };
      });
      const pageUrl = input.pageUrl === undefined ? undefined : stringField(input.pageUrl, "pageUrl").slice(0, 500);
      setJson(res, 200, await answerLifeosAssistant(config, repository, { message, history, ...(pageUrl === undefined ? {} : { pageUrl }) }));
      return;
    }
    if (pathname === "/api/weather/status" && req.method === "GET") {
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      setJson(res, 200, publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)));
      return;
    }
    if (pathname === "/api/weather/profiles" && req.method === "GET") {
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      setJson(res, 200, { items: listWeatherProfiles(config), activeProfileId: deviceLocation?.profileId ?? null, status: publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)) });
      return;
    }
    if (pathname === "/api/weather/profiles" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["id", "label", "locationId", "city", "apiHost", "apiKey", "clearApiKey", "activate"]);
      try {
        const deviceId = weatherDeviceId(req, res, config);
        const profile = saveWeatherProfile(config, {
          ...(input.id === undefined ? {} : { id: stringField(input.id, "id", { nonEmpty: true }) }),
          label: stringField(input.label, "label", { nonEmpty: true }),
          locationId: stringField(input.locationId ?? "", "locationId"),
          city: stringField(input.city ?? "", "city"),
          apiHost: stringField(input.apiHost ?? "devapi.qweather.com", "apiHost", { nonEmpty: true }),
          ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
          ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
        });
        const activate = input.activate === undefined ? true : booleanField(input.activate, "activate");
        if (activate) repository.saveWeatherDeviceLocation(deviceId, profile.locationId, profile.city, JSON.stringify(nowInstant()), profile.id);
        clearWeatherCache();
        const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
        setJson(res, 200, { items: listWeatherProfiles(config), activeProfileId: deviceLocation?.profileId ?? null, status: publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)) });
      } catch (error) {
        throw new HttpError(400, "invalid_weather_profile", error instanceof Error ? error.message : "天气方案无效");
      }
      return;
    }
    if (pathname === "/api/weather/profiles/activate" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["id"]);
      const profileId = stringField(input.id, "id", { nonEmpty: true });
      const profile = readWeatherProfile(config, profileId);
      if (profile === null) throw new HttpError(404, "weather_profile_not_found", "天气方案不存在");
      const deviceId = weatherDeviceId(req, res, config);
      repository.saveWeatherDeviceLocation(deviceId, profile.locationId, profile.city, JSON.stringify(nowInstant()), profileId);
      clearWeatherCache();
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      setJson(res, 200, { items: listWeatherProfiles(config), activeProfileId: profileId, status: publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)) });
      return;
    }
    if (pathname === "/api/weather" && req.method === "GET") {
      const requestedDate = url.searchParams.get("date");
      if (requestedDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) throw new HttpError(400, "invalid_date", "date must use YYYY-MM-DD");
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      const result = await fetchWeatherSnapshot(config, requestedDate, weatherLocationOverride(config, deviceLocation), repository);
      setJson(res, 200, { weatherSnapshot: result.snapshot, location: result.location });
      return;
    }
    if (pathname === "/api/weather/current" && req.method === "POST") {
      requireJsonContentType(req, true);
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      const result = await fetchRealtimeWeather(config, weatherLocationOverride(config, deviceLocation));
      if (result === null) throw new HttpError(502, "weather_current_failed", "实时天气暂时不可用，请检查天气配置");
      setJson(res, 200, result);
      return;
    }
    if (pathname === "/api/weather/config" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["enabled", "locationId", "city", "apiHost", "apiKey", "clearApiKey"]);
      try {
        const deviceId = weatherDeviceId(req, res, config);
        const locationId = stringField(input.locationId ?? "", "locationId").trim();
        const city = stringField(input.city ?? "", "city").trim();
        const status = saveRuntimeWeatherConfig(config, {
          enabled: input.enabled === undefined ? true : booleanField(input.enabled, "enabled"),
          locationId,
          city,
          apiHost: stringField(input.apiHost ?? "devapi.qweather.com", "apiHost", { nonEmpty: true }),
          ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
          ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
        });
        const deviceLocation = repository.saveWeatherDeviceLocation(deviceId, locationId, city, JSON.stringify(nowInstant()));
        clearWeatherCache();
        setJson(res, 200, { ...status, locationId: deviceLocation.locationId, city: deviceLocation.city, locationScope: "device" });
      } catch (error) {
        throw new HttpError(400, "invalid_weather_config", error instanceof Error ? error.message : "天气配置无效");
      }
      return;
    }
    if (pathname === "/api/weather/config/test" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["locationId", "apiHost", "apiKey"]);
      try {
        weatherDeviceId(req, res, config);
        const result = await verifyWeatherLocation(config, {
          locationId: stringField(input.locationId, "locationId", { nonEmpty: true }),
          ...(input.apiHost === undefined ? {} : { apiHost: stringField(input.apiHost, "apiHost") }),
          ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
        });
        setJson(res, 200, { ok: true, message: "天气 API 连接成功", location: result.location });
      } catch (error) {
        throw new HttpError(502, "weather_config_test_failed", error instanceof Error ? error.message : "天气 API 连接失败");
      }
      return;
    }
    if (pathname === "/api/weather/archive" && req.method === "GET") {
      const from = parseDateQuery(url.searchParams.get("from"), "from");
      const to = parseDateQuery(url.searchParams.get("to"), "to");
      if (from === undefined || to === undefined) throw new HttpError(400, "invalid_range", "from and to are required");
      if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
      const start = Date.parse(`${from}T00:00:00Z`);
      const end = Date.parse(`${to}T00:00:00Z`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || (end - start) / 86_400_000 > 62) {
        throw new HttpError(400, "invalid_range", "天气归档最多查询 63 天");
      }
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      // Read only the currently active device/profile location. Do not union
      // stale device keys with the profile key: a same-day row from another
      // city must never leak into this device's month view.
      const activeOverride = deviceLocation === null ? undefined : weatherLocationOverride(config, deviceLocation);
      const runtime = activeOverride === undefined ? readRuntimeWeatherConfig(config) : activeOverride;
      const locationKeys = new Set<string>();
      if (runtime.locationId) locationKeys.add(runtime.locationId);
      if (runtime.city) locationKeys.add(runtime.city);
      const rows = [...locationKeys].flatMap((locationKey) => repository.listWeatherDayCache(from, to, locationKey));
      const unique = new Map(rows.map((row) => [`${row.date}|${row.locationKey}`, row]));
      setJson(res, 200, { from, to, timeZone: WEATHER_ARCHIVE_TIME_ZONE, items: [...unique.values()].sort((left, right) => left.date.localeCompare(right.date) || left.locationKey.localeCompare(right.locationKey)) });
      return;
    }
    if (pathname === "/api/modules/cycle-intimacy" && req.method === "GET") {
      setJson(res, 200, repository.cycleIntimacyModule());
      return;
    }
    if (pathname === "/api/modules/cycle-intimacy/config" && req.method === "PUT") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      setJson(res, 200, repository.writeCycleIntimacyConfig(cycleIntimacyConfig(input)));
      return;
    }
    if (pathname === "/api/modules/cycle-intimacy/events" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      const event = cycleIntimacyEvent(input);
      if (repository.cycleIntimacyModule().events.some((existing) => existing.date === event.date && existing.kind === event.kind)) {
        throw new HttpError(409, "event_exists", "This calendar marker already exists");
      }
      setJson(res, 201, repository.addCycleIntimacyEvent(event));
      return;
    }
    const cycleEventMatch = /^\/api\/modules\/cycle-intimacy\/events\/([^/]+)$/.exec(pathname);
    if (cycleEventMatch !== null && req.method === "DELETE") {
      const id = decodeSegment(cycleEventMatch[1]!);
      if (!repository.deleteCycleIntimacyEvent(id)) throw new HttpError(404, "not_found", "Cycle module event not found");
      setJson(res, 200, repository.cycleIntimacyModule());
      return;
    }
    if (pathname === "/api/records" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? undefined;
      if (q !== undefined && q.length > 2000) throw new HttpError(400, "invalid_query", "q is too long");
      const kindRaw = url.searchParams.get("kind");
      const statusRaw = url.searchParams.get("status");
      const kind = kindRaw === null || kindRaw === "" ? undefined : enumField(kindRaw, RECORD_KINDS, "kind");
      const status = statusRaw === null || statusRaw === "" ? undefined : enumField(statusRaw, TASK_STATUSES, "status");
      const date = parseDateQuery(url.searchParams.get("date"), "date");
      const from = parseDateQuery(url.searchParams.get("from"), "from");
      const to = parseDateQuery(url.searchParams.get("to"), "to");
      if (date !== undefined && (from !== undefined || to !== undefined)) {
        throw new HttpError(400, "invalid_range", "date cannot be combined with from/to");
      }
      if (from !== undefined && to !== undefined && from > to) {
        throw new HttpError(400, "invalid_range", "from must not be after to");
      }
      const timeZone = url.searchParams.get("timeZone") || "UTC";
      // The range is applied in memory, so it is kept to a size a calendar can ask for.
      if (from !== undefined && to !== undefined && datesBetween(from, to).length > 400) {
        throw new HttpError(400, "invalid_range", "range must not exceed 400 days");
      }
      const entityId = url.searchParams.get("entityId") || undefined;
      const assetId = url.searchParams.get("assetId") || undefined;
      const query: { q?: string; kind?: RecordKind; status?: TaskStatus; entityId?: string; assetId?: string } = {};
      if (q !== undefined) query.q = q;
      if (kind !== undefined) query.kind = kind;
      if (status !== undefined) query.status = status;
      if (entityId !== undefined) query.entityId = entityId;
      if (assetId !== undefined) query.assetId = assetId;
      const scoped = filterDate(repository.list(query), date, timeZone);
      const items = sortTimeline(filterDateRange(scoped, from, to, timeZone), timeZone);
      setJson(res, 200, { items });
      return;
    }
    if (pathname === "/api/summaries" && req.method === "GET") {
      const from = parseDateQuery(url.searchParams.get("from"), "from");
      const to = parseDateQuery(url.searchParams.get("to"), "to");
      if (from === undefined || to === undefined) throw new HttpError(400, "invalid_range", "from and to are required");
      if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
      const timeZone = url.searchParams.get("timeZone") || "UTC";
      assertTimeZone(timeZone);
      const dates = datesBetween(from, to);
      if (dates.length > 400) throw new HttpError(400, "invalid_range", "range must not exceed 400 days");
      const byDate = new Map<string, RecordView[]>();
      for (const record of repository.list({})) {
        if (record.isPrivate === true) continue;
        const date = dateForTime(record.occurredAt ?? record.createdAt, timeZone);
        const bucket = byDate.get(date);
        if (bucket === undefined) byDate.set(date, [record]);
        else bucket.push(record);
      }
      const items = await resolveDaySummaries({
        dates,
        recordsForDate: (date) => byDate.get(date) ?? [],
        cache: repository,
        provider: daySummaryProvider,
        force: url.searchParams.get("force") === "1",
      });
      setJson(res, 200, {
        items,
        provider: daySummaryProvider.providerId,
        ...(daySummaryProvider.model === undefined ? {} : { model: daySummaryProvider.model }),
        ai: daySummaryProvider.kind === "ai",
      });
      return;
    }
    if (pathname === "/api/records" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      const record = buildRecord(input, repository);
      repository.insert(record);
      const view = repository.findById(record.id);
      if (view === null) throw new Error("Inserted record could not be read back");
      setJson(res, 201, view);
      return;
    }
    const recordMatch = /^\/api\/records\/([^/]+)$/.exec(pathname);
    if (recordMatch !== null && (req.method === "PATCH" || req.method === "DELETE")) {
      let decodedId: string;
      try {
        decodedId = decodeURIComponent(recordMatch[1]!);
      } catch {
        throw new HttpError(400, "invalid_id", "Invalid record id");
      }
      const id = safeId(decodedId);
      requireJsonContentType(req);
      const current = repository.findById(id);
      if (current === null) throw new HttpError(404, "not_found", "Record not found");
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      if (req.method === "DELETE") {
        hasOnlyKeys(input, ["revision"]);
        const revision = revisionField(input.revision);
        if (!repository.softDelete(id, revision, JSON.stringify(nowInstant()))) {
          const latest = repository.findById(id);
          if (latest === null) throw new HttpError(404, "not_found", "Record not found");
          throw new HttpError(409, "revision_conflict", "Record was changed; reload before deleting");
        }
        setEmpty(res, 204);
        return;
      }
      const patched = patchRecord(current, input, repository);
      if (!repository.update(patched.record, patched.expectedRevision)) {
        const latest = repository.findById(id);
        if (latest === null) throw new HttpError(404, "not_found", "Record not found");
        setJson(res, 409, { error: "revision_conflict", message: "Record was changed; reload before editing", current: latest });
        return;
      }
      const updated = repository.findById(id);
      if (updated === null) throw new Error("Updated record could not be read back");
      setJson(res, 200, updated);
      return;
    }
    if (pathname === "/api/export" && req.method === "GET") {
      const format = url.searchParams.get("format") ?? "json";
      const data = repository.exportData();
      const bundle = createExportBundle({ exportedAt: nowInstant(), ...data });
      if (format === "json") {
        const payload = serializeExportJson(bundle);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": contentDisposition("lifeos-export.json"),
          "cache-control": "no-store",
        });
        res.end(payload);
        return;
      }
      if (format === "markdown") {
        const payload = data.records.map((record) => exportRecordMarkdown(record, data)).join("\n\n---\n\n");
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": contentDisposition("lifeos-export.md"),
          "cache-control": "no-store",
        });
        res.end(payload);
        return;
      }
      throw new HttpError(400, "invalid_format", "format must be json or markdown");
    }
    if (pathname === "/api/import" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["bundle"]);
      if (input.bundle === undefined) throw new HttpError(400, "invalid_bundle", "bundle is required");
      let bundle;
      try {
        bundle = parseExportJson(JSON.stringify(input.bundle));
      } catch (error) {
        throw new HttpError(400, "invalid_bundle", error instanceof Error ? error.message : "Invalid export bundle");
      }
      try {
        repository.importData(bundle);
      } catch (error) {
        if (error instanceof ConflictError) throw new HttpError(409, "import_conflict", error.message);
        throw error;
      }
      setJson(res, 201, { imported: bundle.records.length, entities: bundle.entities.length, assets: bundle.assets.length });
      return;
    }
    if (pathname === "/api/entities" && req.method === "GET") {
      const typeRaw = url.searchParams.get("type");
      const q = url.searchParams.get("q") ?? undefined;
      if (q !== undefined && q.length > 200) throw new HttpError(400, "invalid_query", "q is too long");
      const type = typeRaw === null || typeRaw === "" ? undefined : enumField(typeRaw, ENTITY_KINDS, "type");
      setJson(res, 200, {
        items: repository.listEntities({ ...(type === undefined ? {} : { type }), ...(q === undefined ? {} : { q }) }),
      });
      return;
    }
    if (pathname === "/api/entities" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["id", "type", "name", "aliases", "description", "role", "period", "address", ...MOVIE_FIELD_NAMES]);
      const type = enumField(input.type, ENTITY_KINDS, "type");
      if (type === "movie" && !readRuntimeMovieConfig(config).enabled) throw new MovieModuleError(409, "movie_module_disabled", "观影模块未启用；请先在设置中启用");
      assertMovieOnlyFields(type, input);
      const rawName = stringField(input.name, "name", { nonEmpty: true });
      const name = type === "person" ? canonicalPersonName(rawName) : rawName;
      const description = input.description === undefined ? undefined : stringField(input.description, "description");
      const aliases = input.aliases === undefined ? undefined : aliasesField(input.aliases);
      const role = input.role === undefined ? undefined : placeRoleField(input.role);
      const period = input.period === undefined ? undefined : placePeriodField(input.period);
      const address = addressField(input.address);
      const movieFields = movieFieldsField(input, false);
      placeOnlyFields(type, role, period, address);
      // An explicit id keeps seeded or imported objects addressable and predictable.
      const id = input.id === undefined ? `${type}_${randomUUID()}` : stringField(input.id, "id", { nonEmpty: true });
      if (repository.findEntityById(id) !== null) throw new HttpError(409, "entity_exists", `Entity already exists: ${id}`);
      const entity: Entity = {
        type,
        id,
        name,
        createdAt: nowInstant(),
        ...(aliases === undefined ? {} : { aliases }),
        ...(description === undefined ? {} : { description }),
        ...(role === undefined ? {} : { role }),
        ...(period === undefined ? {} : { period }),
        ...(address === undefined ? {} : { address }),
        ...movieFields,
      };
      assertValidEntity(entity);
      repository.insertEntity(entity);
      setJson(res, 201, entity);
      return;
    }
    const entityMatch = /^\/api\/entities\/([^/]+)$/.exec(pathname);
    if (entityMatch !== null && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = decodeSegment(entityMatch[1]!);
      const existing = repository.findEntityById(id);
      if (existing === null) throw new HttpError(404, "not_found", "Entity not found");
      if (req.method === "DELETE") {
        requireJsonContentType(req, true);
        const references = repository.entityReferenceRecordIds(id);
        if (references.length > 0) {
          throw new HttpError(409, "entity_in_use", `Entity is still referenced by ${references.length} record(s)`);
        }
        // Relations are ours to keep consistent: drop the far side before deleting.
        const related = repository.entitiesRelatingTo(id).filter((entity) => entity.id !== id);
        if (related.length > 0) repository.writeEntities(related.map((entity) => withoutRelation(entity, id)));
        repository.deleteEntity(id);
        setEmpty(res, 204);
        return;
      }
      if (existing.type === "movie" && !readRuntimeMovieConfig(config).enabled) throw new MovieModuleError(409, "movie_module_disabled", "观影模块未启用；请先在设置中启用");
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["name", "aliases", "description", "role", "period", "address", ...MOVIE_FIELD_NAMES]);
      assertMovieOnlyFields(existing.type, input);
      const role = input.role === undefined ? undefined : placeRoleField(input.role);
      const period = input.period === undefined ? undefined : placePeriodField(input.period);
      const address = input.address === undefined ? undefined : input.address === null ? null : addressField(input.address);
      const movieFields = movieFieldsField(input, true);
      placeOnlyFields(existing.type, role, period, address);
      const updated = withEntityEdits(existing, {
        ...(input.name === undefined ? {} : { name: existing.type === "person" ? canonicalPersonName(stringField(input.name, "name", { nonEmpty: true })) : stringField(input.name, "name", { nonEmpty: true }) }),
        ...(input.aliases === undefined ? {} : { aliases: aliasesField(input.aliases) }),
        ...(input.description === undefined ? {} : { description: stringField(input.description, "description") }),
        ...(role === undefined ? {} : { role }),
        ...(period === undefined ? {} : { period }),
        ...(address === undefined ? {} : { address }),
      });
      const movieUpdated = withMovieEdits(updated, movieFields);
      repository.updateEntity(movieUpdated);
      setJson(res, 200, movieUpdated);
      return;
    }
    if (pathname === "/api/assets" && req.method === "GET") {
      const kindRaw = url.searchParams.get("kind");
      const kind = kindRaw === null || kindRaw === "" ? undefined : enumField(kindRaw, ASSET_KINDS, "kind");
      setJson(res, 200, { items: repository.listAssets(kind === undefined ? {} : { kind }) });
      return;
    }
    if (pathname === "/api/assets" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["id", "kind", "storageRefs", "originalName", "mediaType", "sizeBytes"]);
      const id = input.id === undefined ? `asset_${randomUUID()}` : stringField(input.id, "id", { nonEmpty: true });
      if (repository.findAssetById(id) !== null) throw new HttpError(409, "asset_exists", `Asset already exists: ${id}`);
      const asset = buildAsset(input, id, storageRefsField(input.storageRefs));
      repository.insertAsset(asset);
      setJson(res, 201, asset);
      return;
    }
    const assetMatch = /^\/api\/assets\/([^/]+)$/.exec(pathname);
    if (assetMatch !== null && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = decodeSegment(assetMatch[1]!);
      const existing = repository.findAssetById(id);
      if (existing === null) throw new HttpError(404, "not_found", "Asset not found");
      if (req.method === "DELETE") {
        requireJsonContentType(req, true);
        const references = repository.assetReferenceRecordIds(id);
        if (references.length > 0) {
          throw new HttpError(409, "asset_in_use", `Asset is still referenced by ${references.length} record(s)`);
        }
        repository.deleteAsset(id);
        setEmpty(res, 204);
        return;
      }
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["storageRefs", "originalName", "mediaType", "sizeBytes"]);
      // Re-pointing storage is the whole point of an asset: assetId stays stable.
      const candidate: unknown = {
        ...existing,
        ...(input.storageRefs === undefined ? {} : { storageRefs: storageRefsField(input.storageRefs) }),
        ...(input.originalName === undefined ? {} : { originalName: stringField(input.originalName, "originalName") }),
        ...(input.mediaType === undefined ? {} : { mediaType: stringField(input.mediaType, "mediaType") }),
        ...(input.sizeBytes === undefined ? {} : { sizeBytes: sizeBytesField(input.sizeBytes) }),
      };
      assertValidAsset(candidate);
      repository.updateAsset(candidate);
      setJson(res, 200, candidate);
      return;
    }
    const relationMatch = /^\/api\/entities\/([^/]+)\/relations$/.exec(pathname);
    if (relationMatch !== null && req.method === "POST") {
      requireJsonContentType(req);
      const sourceId = decodeSegment(relationMatch[1]!);
      const source = repository.findEntityById(sourceId);
      if (source === null) throw new HttpError(404, "not_found", "Entity not found");
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["kind", "targetId", "note"]);
      const kind = enumField(input.kind, RELATION_KINDS, "kind");
      const targetId = stringField(input.targetId, "targetId", { nonEmpty: true });
      if (targetId === sourceId) throw new HttpError(400, "self_relation", "An entity cannot relate to itself");
      const target = repository.findEntityById(targetId);
      if (target === null) throw new HttpError(404, "not_found", `Unknown entity: ${targetId}`);
      const note = input.note === undefined ? undefined : stringField(input.note, "note");
      const shared = note === undefined ? {} : { note };
      // The edge is symmetric, so both entities are written in one transaction.
      const updatedSource = withRelation(source, { kind, entityId: targetId, ...shared });
      const updatedTarget = withRelation(target, { kind, entityId: sourceId, ...shared });
      repository.writeEntities([updatedSource, updatedTarget]);
      setJson(res, 200, { source: updatedSource, target: updatedTarget });
      return;
    }
    const relationItemMatch = /^\/api\/entities\/([^/]+)\/relations\/([^/]+)$/.exec(pathname);
    if (relationItemMatch !== null && req.method === "DELETE") {
      requireJsonContentType(req, true);
      const sourceId = decodeSegment(relationItemMatch[1]!);
      const targetId = decodeSegment(relationItemMatch[2]!);
      const source = repository.findEntityById(sourceId);
      if (source === null) throw new HttpError(404, "not_found", "Entity not found");
      const updatedSource = withoutRelation(source, targetId);
      const target = repository.findEntityById(targetId);
      if (target === null) {
        repository.writeEntities([updatedSource]);
        setJson(res, 200, { source: updatedSource });
        return;
      }
      const updatedTarget = withoutRelation(target, sourceId);
      repository.writeEntities([updatedSource, updatedTarget]);
      setJson(res, 200, { source: updatedSource, target: updatedTarget });
      return;
    }
    const assetContentMatch = /^\/api\/assets\/([^/]+)\/content$/.exec(pathname);
    if (assetContentMatch !== null && req.method === "GET") {
      const id = decodeSegment(assetContentMatch[1]!);
      const asset = repository.findAssetById(id);
      if (asset === null) throw new HttpError(404, "not_found", "Asset not found");
      if (config.assetRoot === undefined) {
        throw new HttpError(404, "asset_root_not_configured", "Set LIFEOS_ASSET_ROOT to serve local originals");
      }
      const localRef = asset.storageRefs.find((ref) => ref.sourceId === "local");
      if (localRef === undefined) throw new HttpError(404, "not_a_local_asset", "Asset has no local reference");
      const resolved = resolveLocalAsset(config.assetRoot, localRef.sourceRef);
      res.writeHead(200, {
        "content-type": resolved.mediaType,
        "content-length": String(statSync(resolved.file).size),
        "cache-control": "private, max-age=300",
        "content-disposition": "inline",
      });
      res.end(readFileSync(resolved.file));
      return;
    }
    throw new HttpError(404, "not_found", "API route not found");
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const root = resolve(config.webDirectory);
    const requested = pathname === "/" ? "index.html" : pathname.slice(1);
    const candidate = resolve(root, requested);
    const relativePath = relative(root, candidate);
    if (isAbsolute(relativePath) || relativePath.startsWith("..") || relativePath.includes("..\\") || relativePath.includes("../")) {
      throw new HttpError(404, "not_found", "Not found");
    }
    let file = candidate;
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
    } catch {
      file = resolve(root, "index.html");
      try {
        if (!statSync(file).isFile()) throw new Error("missing web build");
      } catch {
        throw new HttpError(404, "not_found", "Web build is not available; run npm run build");
      }
    }
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".ico": "image/x-icon",
      ".webp": "image/webp",
      ".woff2": "font/woff2",
    };
    res.writeHead(200, { "content-type": mime[extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  let closed = false;
  const app: LifeosApp = {
    repository,
    backupScheduler,
    weatherArchiveScheduler,
    handler: async function handler(req, res): Promise<void> {
      const startedAt = Date.now();
      try {
        checkRequestSecurity(req);
        const rawPath = rawPathname(req);
        const url = new URL(req.url ?? "/", "http://lifeos.invalid");
        if (rawPath.startsWith("/api/")) {
          await handleApi(req, res, rawPath, url);
        } else if (req.method === "GET" || req.method === "HEAD") {
          if (req.method === "HEAD") {
            // Static files are only a convenience for production; Vite handles development assets.
            res.writeHead(404);
            res.end();
          } else {
            serveStatic(res, decodeStaticPathname(rawPath));
          }
        } else {
          throw new HttpError(404, "not_found", "Not found");
        }
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const httpError = error instanceof HttpError
          ? error
          : error instanceof MovieModuleError
            ? new HttpError(error.status, error.code, error.message)
          : error instanceof SyntaxError
            ? new HttpError(400, "invalid_json", "Invalid request")
            : new HttpError(500, "internal_error", "Internal server error");
        setJson(res, httpError.status, { error: httpError.code, message: httpError.message });
        requestLog(httpError.status, req.method ?? "?", rawPathname(req), startedAt, `${httpError.code}: ${httpError.message}`);
        return;
      }
      requestLog(res.statusCode, req.method ?? "?", rawPathname(req), startedAt);
    },
    close: () => {
      if (closed) return;
      closed = true;
      backupScheduler.stop();
      weatherArchiveScheduler.stop();
      repository.close();
    },
  };
  return app;
}

export function createHttpServer(config: ApiConfig): { server: Server; app: LifeosApp } {
  const app = createApp(config);
  const server = createServer((req, res) => {
    void app.handler(req, res);
  });
  server.on("close", app.close);
  return { server, app };
}
