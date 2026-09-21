import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, type WriteStream } from "node:fs";
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
  assertValidNoteDetails,
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
  type ContentHash,
  type DaySummary,
  type Entity,
  type EntityKind,
  type EntityRef,
  type EntityRelation,
  type ExportBundleV1,
  type Movie,
  type MovieExternalIds,
  type NoteDetails,
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
import { isCollectableAsset, planUnreferencedUploads, purgeTrashedAsset, resolveWithinRoot, restoreTrashedAsset, trashAsset, trashDaysRemaining, trashPathFor } from "./asset-gc.js";
import { AssetGcScheduler, nextAssetGcAt } from "./asset-gc-scheduler.js";
import { buildManualDaySummary, createDaySummaryProvider, resolveDaySummaries } from "./summary.js";
import { answerLifeosAssistant, type AssistantHistoryItem } from "./assistant.js";
import { createDualBackup, createLocalBackup, pruneBackups, testS3Backup, uploadS3Backup } from "./backup.js";
import { BackupScheduler, BACKUP_TIME_ZONE, publicNextBackupAt, shanghaiDateKey } from "./backup-scheduler.js";
import { publicBackupConfig, saveRuntimeBackupConfig } from "./backup-config.js";
import { BACKUP_RETENTION_LIMITS, buildBackupRetentionView, DEFAULT_BACKUP_RETENTION, describeBackupRetention, type BackupRetention } from "./backup-retention.js";
import { readSnapshot, SnapshotUnavailableError } from "./backup-timeline.js";
import { AI_REASONING_EFFORTS, publicAiConfig, saveRuntimeAiConfig, testRuntimeAiConfig } from "./ai-config.js";
import { clearWeatherCache, decideForcedRefresh, fetchRealtimeWeather, fetchWeatherSnapshot, recordWeatherObservation, verifyWeatherLocation, WEATHER_OBSERVATION_TIME_ZONE } from "./weather.js";
import { selectDayObservations } from "./weather-selection.js";
import { listWeatherProfiles, publicWeatherConfig, readRuntimeWeatherConfig, readWeatherProfile, saveRuntimeWeatherConfig, saveWeatherProfile, type WeatherLocationOverride } from "./weather-config.js";
import { WeatherArchiveScheduler, WEATHER_ARCHIVE_TIME_ZONE } from "./weather-archive-scheduler.js";
import { publicMovieConfig, readRuntimeMovieConfig, saveRuntimeMovieConfig } from "./movie-config.js";
import { MovieModuleError, resolveMovies, testMovieConfig, type MovieCandidate } from "./movie.js";
import { THUMBNAIL_FORMAT, THUMBNAIL_WIDTHS, createThumbnailCache, parseThumbnailWidth } from "./derived-thumbs.js";

const SESSION_COOKIE = "lifeos_session";
const WEATHER_DEVICE_COOKIE = "lifeos_weather_device";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECORD_KINDS: readonly RecordKind[] = ["journal", "task", "event", "note"];
const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];
const ENTITY_KINDS: readonly EntityKind[] = ["person", "project", "place", "topic", "movie"];
const ASSET_KINDS: readonly AssetKind[] = ["photo", "audio", "file"];
const ASSET_ROLES: readonly AssetRole[] = ["photo", "recording", "attachment"];
const CYCLE_INTIMACY_EVENT_KINDS: readonly CycleIntimacyEventKind[] = ["intimacy", "fitness", "period_start", "period_end"];

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

/**
 * Reads the request body as raw bytes. Every caller shares one size guard: the
 * declared Content-Length is rejected before a single byte is buffered, and the
 * streamed size is checked again so a chunked request cannot lie its way past
 * the limit.
 */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const raw = await readRawBody(req, limit);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
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

/** Parse note metadata at the HTTP boundary so all clients receive the same
 * 400-shaped error instead of a raw core validation exception. */
export function parseNoteDetails(value: unknown): NoteDetails {
  return coreValidated("note", () => {
    assertValidNoteDetails(value);
    return value;
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
  hasOnlyKeys(input, ["kind", "content", "occurredAt", "dueAt", "isPrivate", "isDemo", "isBackfill", "weather", "note", "entityRefs", "relatedRecordIds", "assetRefs"]);
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
  const note = input.note === undefined ? undefined : (() => {
    if (kind !== "note") throw new HttpError(400, "invalid_field", "note is only valid for note records");
    return parseNoteDetails(input.note);
  })();
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
    ...(note === undefined ? {} : { note }),
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
  hasOnlyKeys(input, ["revision", "content", "occurredAt", "dueAt", "isPrivate", "isBackfill", "weather", "note", "status", "entityRefs", "relatedRecordIds", "assetRefs"]);
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
  if (Object.hasOwn(input, "note")) {
    if (record.kind !== "note") throw new HttpError(400, "invalid_field", "note is only valid for note records");
    if (input.note === null) {
      const { note: _note, ...withoutNote } = record;
      record = withoutNote;
    } else {
      record = { ...record, note: parseNoteDetails(input.note) };
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

/**
 * The orphan-trash endpoints only mean something when an asset root is
 * configured: without one there are no LifeOS-owned uploads to collect.
 */
function requireAssetRoot(config: ApiConfig): string {
  const root = config.assetRoot;
  if (root === undefined || root === "") {
    throw new HttpError(404, "asset_root_missing", "LIFEOS_ASSET_ROOT is not configured");
  }
  return root;
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

/**
 * Import is the only write path that hands us a pre-assembled object graph, so
 * it is the only path where a reference can point at nothing: POST and PATCH
 * resolve every ref against the database as they go, but a bundle arrives whole.
 * Enforce the same invariant here — each ref must resolve to something the
 * database knows about, either because the bundle carries it or because it is
 * already stored.
 *
 * Soft-deleted records and trashed assets count as "known": their tombstones
 * are still in the database, and refusing them would make an owner's own export
 * un-importable after they emptied the recycle bin.
 */
function assertImportReferences(bundle: ExportBundleV1, repository: SqliteRecordRepository): void {
  const incomingRecords = new Set(bundle.records.map((record) => record.id));
  const incomingEntityTypes = new Map(bundle.entities.map((entity) => [entity.id, entity.type]));
  const incomingAssets = new Set(bundle.assets.map((asset) => asset.id));

  for (const entity of bundle.entities) {
    for (const relation of entity.relations ?? []) {
      if (relation.entityId === entity.id) {
        throw new HttpError(400, "self_relation", "An entity cannot relate to itself");
      }
      if (incomingEntityTypes.has(relation.entityId) || repository.findEntityById(relation.entityId) !== null) continue;
      throw new HttpError(400, "unknown_entity", `Unknown entity: ${relation.entityId}`);
    }
  }

  for (const record of bundle.records) {
    const seenEntities = new Set<string>();
    for (const ref of record.entityRefs) {
      if (seenEntities.has(ref.entityId)) throw new HttpError(400, "duplicate_reference", `entityRefs repeats ${ref.entityId}`);
      seenEntities.add(ref.entityId);
      const actualType = incomingEntityTypes.get(ref.entityId) ?? repository.findEntityById(ref.entityId)?.type;
      if (actualType === undefined) throw new HttpError(400, "unknown_entity", `Unknown entity: ${ref.entityId}`);
      if (actualType !== ref.entityType) {
        throw new HttpError(400, "entity_type_mismatch", `Entity ${ref.entityId} is a ${actualType}, not a ${ref.entityType}`);
      }
    }
    const seenAssets = new Set<string>();
    for (const ref of record.assetRefs) {
      if (seenAssets.has(ref.assetId)) throw new HttpError(400, "duplicate_reference", `assetRefs repeats ${ref.assetId}`);
      seenAssets.add(ref.assetId);
      if (incomingAssets.has(ref.assetId) || repository.findAssetById(ref.assetId) !== null) continue;
      if (repository.findAssetTrash(ref.assetId) !== null) continue;
      throw new HttpError(400, "unknown_asset", `Unknown asset: ${ref.assetId}`);
    }
    const seenRecords = new Set<string>();
    for (const id of record.relatedRecordIds) {
      if (id === record.id) throw new HttpError(400, "self_reference", "A record cannot relate to itself");
      if (seenRecords.has(id)) throw new HttpError(400, "duplicate_reference", `relatedRecordIds repeats ${id}`);
      seenRecords.add(id);
      if (incomingRecords.has(id) || repository.findById(id, true) !== null) continue;
      throw new HttpError(400, "unknown_record", `Unknown record: ${id}`);
    }
  }
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
 * What a thumbnail can actually be built from. Narrower than what can be served:
 * HEIC is excluded because sharp's prebuilt libvips ships without libheif's HEIC
 * decoder, and a 500 on the timeline is worse than a large-but-working image.
 * Everything else here is a raster format libvips reads, GIF included — the first
 * frame is what a still thumbnail of an animation should be anyway.
 */
const THUMBNAILABLE_ASSET_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

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
 * Accepted photo types for uploads. The declared media type picks the stored
 * extension; a sniff of the leading bytes then has to agree with it, so a text
 * file renamed to `.jpg` never reaches the disk. HEIC is deliberately absent:
 * browsers cannot render it, and a thumbnail nobody can see is worse than a
 * clear rejection.
 */
const ASSET_UPLOAD_FORMATS: Readonly<Record<string, { readonly extension: string; readonly matches: (bytes: Buffer) => boolean }>> = {
  "image/jpeg": { extension: ".jpg", matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/png": { extension: ".png", matches: (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { extension: ".webp", matches: (bytes) => bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP" },
  "image/gif": { extension: ".gif", matches: (bytes) => bytes.length >= 6 && (bytes.toString("latin1", 0, 6) === "GIF87a" || bytes.toString("latin1", 0, 6) === "GIF89a") },
  "image/avif": { extension: ".avif", matches: (bytes) => bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp" && (bytes.toString("latin1", 8, 12) === "avif" || bytes.toString("latin1", 8, 12) === "avis") },
};

/** `image/jpeg; charset=binary` still means `image/jpeg`. */
function baseMediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Keeps the name a person recognises, minus anything that could steer a path.
 * The stored file is named by its content hash; this is metadata for display only.
 */
function uploadOriginalName(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "").trim();
  return cleaned.length === 0 ? undefined : Array.from(cleaned).slice(0, 120).join("");
}

/**
 * Writes one dropped photo under `<assetRoot>/uploads/YYYY/MM/`, dated in
 * Shanghai so a photo taken late at night lands in the folder its owner
 * expects. The file name is the picture's own sha256 — the same digest the
 * asset row carries — which is what makes the path content-addressed: the same
 * bytes can only ever land at one path, so "do I already have this picture?"
 * is answered by the name rather than by a scan. Nothing from the request
 * reaches the path, so a hostile original name is still harmless.
 *
 * A file already sitting at the target path is left untouched. The caller
 * checks the asset table for this digest first, so an existing file means the
 * same bytes written by an earlier run that died before its row landed:
 * rewriting it gains nothing, and `wx` would report that as a collision.
 * Only files written from here on are named this way — the rows already in the
 * database keep their UUID paths, and nothing moves them.
 */
function storeUploadedPhoto(root: string, bytes: Buffer, format: { readonly extension: string }, digest: string): string {
  const day = shanghaiDateKey(new Date());
  const relativeDirectory = `uploads/${day.slice(0, 4)}/${day.slice(5, 7)}`;
  const directory = resolve(root, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  const fileName = `${digest}${format.extension}`;
  const target = resolve(directory, fileName);
  if (!existsSync(target)) {
    // `wx` refuses to overwrite: a racing writer must not be able to eat a photo,
    // and losing that race is the same "the bytes are already there" answer.
    try {
      writeFileSync(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
  }
  return `${relativeDirectory}/${fileName}`;
}

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

/**
 * The local original behind an asset id, or the reason there is none. Both the
 * content route and the thumbnail route need exactly this chain, and the errors are
 * the same either way: no root configured, no local reference, file gone.
 */
function resolveAssetOriginal(config: ApiConfig, repository: SqliteRecordRepository, id: string): { readonly reference: StorageReference; readonly file: string; readonly mediaType: string } {
  const asset = repository.findAssetById(id);
  if (asset === null) throw new HttpError(404, "not_found", "Asset not found");
  if (config.assetRoot === undefined) {
    throw new HttpError(404, "asset_root_not_configured", "Set LIFEOS_ASSET_ROOT to serve local originals");
  }
  const reference = asset.storageRefs.find((ref) => ref.sourceId === "local");
  if (reference === undefined) throw new HttpError(404, "not_a_local_asset", "Asset has no local reference");
  return { reference, ...resolveLocalAsset(config.assetRoot, reference.sourceRef) };
}

export interface LifeosApp {
  readonly repository: SqliteRecordRepository;
  readonly backupScheduler: BackupScheduler;
  readonly weatherArchiveScheduler: WeatherArchiveScheduler;
  readonly assetGcScheduler: AssetGcScheduler;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly close: () => void;
}

/** The shape every summaries endpoint answers with: the rows plus whose they are. */
function summaryPayload(items: readonly DaySummary[], provider: { readonly providerId: string; readonly model?: string; readonly kind: "ai" | "rule" }): Record<string, unknown> {
  return {
    items,
    provider: provider.providerId,
    ...(provider.model === undefined ? {} : { model: provider.model }),
    ai: provider.kind === "ai",
  };
}

/**
 * Every record a day summary may read, bucketed by the caller's calendar day.
 *
 * Notes are included rather than filtered out, because a day that has nothing
 * else still deserves a cell: the summariser treats them as filler and is told
 * not to describe them as events. Private records stay out either way — a
 * summary is shown on the grid.
 */
function collectSummarisableRecords(repository: SqliteRecordRepository, timeZone: string): Map<string, RecordView[]> {
  const byDate = new Map<string, RecordView[]>();
  for (const record of repository.list({})) {
    if (record.isPrivate === true) continue;
    const date = dateForTime(record.occurredAt ?? record.createdAt, timeZone);
    const bucket = byDate.get(date);
    if (bucket === undefined) byDate.set(date, [record]);
    else bucket.push(record);
  }
  return byDate;
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
  const assetGcScheduler = new AssetGcScheduler({
    repository,
    config,
    onError: (error) => console.error("[asset-gc] collection pass failed:", error),
    onReport: (report) => {
      // Silence is the normal outcome: most passes find nothing to do. The one thing
      // that must never pass unnoticed is a snapshot that could not be read, because
      // that is the pass where the reference count was unknowable and collection was
      // skipped on purpose.
      if (report.snapshotUnreadable.length > 0) {
        console.error(`[asset-gc] collection skipped: ${report.snapshotUnreadable.length} snapshot(s) could not be read`, report.snapshotUnreadable);
      }
      if (report.collected.length > 0 || report.purged.length > 0 || report.failed.length > 0) {
        console.log(`[asset-gc] collected ${report.collected.length}, purged ${report.purged.length}, failed ${report.failed.length}`);
      }
    },
  });
  assetGcScheduler.start();
  // The summary provider is built per request from the AI settings (see
  // createDaySummaryProvider): the key lives in a file, so one provider frozen at
  // boot would keep using whatever key the process happened to start with. The
  // summaries it produces are still cached per day, so opening a month does not
  // re-ask for days that have not changed.
  // Derived thumbnails live under the data directory and are rebuilt on demand, so
  // nothing has to be migrated, migrated back, or backed up: deleting the directory
  // is a supported operation, not a repair.
  const thumbnails = createThumbnailCache(config.dataDirectory);

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
    // The time machine: reads one point in time without altering it. The snapshot
    // is copied into a scratch directory under the data directory and opened
    // read-only, so this route can look at the owner's real backup set but has no
    // way to write to it.
    if (pathname === "/api/backup/snapshot" && req.method === "GET") {
      const fileName = (url.searchParams.get("fileName") ?? "").trim();
      try {
        setJson(res, 200, await readSnapshot(config, fileName, repository));
      } catch (error) {
        if (!(error instanceof SnapshotUnavailableError)) throw error;
        // The mapping lives here, not in the read layer, because these are HTTP
        // answers: a point that vanished between listing and clicking is a 404
        // rather than a 500, and an unreachable object store is a 502 so the view
        // can blame the copy instead of the request.
        const mapping = error.reason === "invalid-name"
          ? { status: 400, code: "invalid_snapshot_name" }
          : error.reason === "missing"
            ? { status: 404, code: "snapshot_missing" }
            : error.reason === "transport"
              ? { status: 502, code: "snapshot_unavailable" }
              : { status: 500, code: "snapshot_unreadable" };
        throw new HttpError(mapping.status, mapping.code, error.message);
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
      hasOnlyKeys(input, ["enabled", "baseUrl", "model", "thinking", "reasoningEffort", "apiKey", "clearApiKey", "summaryPrompt"]);
      try {
        const status = saveRuntimeAiConfig(config, {
          enabled: input.enabled === undefined ? true : booleanField(input.enabled, "enabled"),
          baseUrl: stringField(input.baseUrl, "baseUrl", { nonEmpty: true }),
          model: stringField(input.model, "model", { nonEmpty: true }),
          ...(input.thinking === undefined ? {} : { thinking: booleanField(input.thinking, "thinking") }),
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort === null ? null : enumField(input.reasoningEffort, AI_REASONING_EFFORTS, "reasoningEffort") }),
          ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
          ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
          // `null` restores the shipped wording; omitting it leaves the current one alone.
          ...(input.summaryPrompt === undefined ? {} : { summaryPrompt: input.summaryPrompt === null ? null : stringField(input.summaryPrompt, "summaryPrompt") }),
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
      // Same three-tier day-key rule as every other date endpoint: the regex
      // alone would let 2026-02-30 through, and this value is used as a cache key.
      const requestedDate = parseDateQuery(url.searchParams.get("date"), "date") ?? null;
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      const override = weatherLocationOverride(config, deviceLocation);
      // A manual refresh is rate-limited, but being told to wait is not an
      // error: answer 200 with the cached snapshot and say how long.
      const wantsForce = url.searchParams.get("force") === "1";
      const escalated = url.searchParams.get("escalate") === "1";
      let force = false;
      let throttle: { readonly retryAfterMs: number } | null = null;
      if (wantsForce) {
        const key = `${deviceLocation?.locationId ?? readRuntimeWeatherConfig(config).locationId}:${readRuntimeWeatherConfig(config).apiHost}`;
        const decision = decideForcedRefresh(key, Date.now(), escalated);
        if (decision.allowed) force = true;
        else throttle = { retryAfterMs: decision.retryAfterMs };
      }
      const result = await fetchWeatherSnapshot(config, requestedDate, override, repository, { force });
      setJson(res, 200, {
        weatherSnapshot: result.snapshot,
        location: result.location,
        ...(throttle === null ? {} : { throttled: true, retryAfterMs: throttle.retryAfterMs }),
      });
      return;
    }
    if (pathname === "/api/weather/current" && req.method === "POST") {
      requireJsonContentType(req, true);
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      const result = await fetchRealtimeWeather(config, weatherLocationOverride(config, deviceLocation));
      if (result === null) throw new HttpError(502, "weather_current_failed", "实时天气暂时不可用，请检查天气配置");
      // The owner pressed the button, so this reading is worth keeping: it is
      // the one that means "I was outside right then".
      recordWeatherObservation(repository, { weather: result.weather, location: result.location, source: "manual" });
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
    if (pathname === "/api/weather/observations" && req.method === "GET") {
      const date = parseDateQuery(url.searchParams.get("date"), "date");
      if (date === undefined) throw new HttpError(400, "invalid_date", "date is required");
      const deviceId = weatherDeviceId(req, res, config);
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      const activeOverride = deviceLocation === null ? undefined : weatherLocationOverride(config, deviceLocation);
      const runtime = activeOverride === undefined ? readRuntimeWeatherConfig(config) : activeOverride;
      const locationKey = runtime.locationId || runtime.city;
      const all = repository.listWeatherObservations(date, locationKey || undefined);
      // A day can overflow with routine ticks. What the owner gets back is the
      // day's kept history, not every raw row that was ever written.
      setJson(res, 200, {
        date,
        timeZone: WEATHER_OBSERVATION_TIME_ZONE,
        total: all.length,
        items: selectDayObservations(all),
      });
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
      // Date/range reads feed Today and Calendar. Notes are a separate content
      // library and must not leak into those time-oriented surfaces.
      const timeScoped = date !== undefined || from !== undefined || to !== undefined;
      const sourceRecords = repository.list(query).filter((record) => !(timeScoped && record.kind === "note"));
      const scoped = filterDate(sourceRecords, date, timeZone);
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
      const byDate = collectSummarisableRecords(repository, timeZone);
      // Resolved per request, not per process: the AI key lives in the settings
      // file, so reading it here is what makes "save the key, reopen the calendar"
      // work without restarting the API.
      const daySummaryProvider = createDaySummaryProvider(config);
      const items = await resolveDaySummaries({
        dates,
        recordsForDate: (date) => byDate.get(date) ?? [],
        cache: repository,
        provider: daySummaryProvider,
        force: url.searchParams.get("force") === "1",
      });
      setJson(res, 200, summaryPayload(items, daySummaryProvider));
      return;
    }
    if (pathname === "/api/summaries/manual" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["entries", "timeZone"]);
      const entries = Array.isArray(input.entries) ? input.entries : null;
      if (entries === null) throw new HttpError(400, "invalid_entries", "entries must be an array");
      if (entries.length > 400) throw new HttpError(400, "invalid_entries", "entries must not exceed 400 items");
      const timeZone = typeof input.timeZone === "string" ? input.timeZone : "UTC";
      assertTimeZone(timeZone);
      const byDate = collectSummarisableRecords(repository, timeZone);
      const saved: DaySummary[] = [];
      const cleared: string[] = [];
      for (const entry of entries) {
        const item = jsonObject(entry, "entries[]");
        hasOnlyKeys(item, ["date", "text"]);
        const date = stringField(item.date, "date", { nonEmpty: true });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "invalid_date", `entries[].date must be YYYY-MM-DD, received ${date}`);
        const text = stringField(item.text, "text");
        // An emptied field is a revert, not a blank summary: the row is dropped so
        // the next read recomputes it from the records.
        if (text.trim() === "") {
          repository.deleteDaySummary(date);
          cleared.push(date);
          continue;
        }
        const summary = buildManualDaySummary(date, text, byDate.get(date) ?? []);
        repository.writeDaySummary(summary);
        saved.push(summary);
      }
      setJson(res, 200, { items: saved, cleared });
      return;
    }
    if (pathname === "/api/summaries/regenerate" && req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["date", "from", "to", "timeZone"]);
      const single = input.date === undefined ? undefined : parseDateQuery(stringField(input.date, "date", { nonEmpty: true }), "date");
      let from = single;
      let to = single;
      if (single === undefined) {
        if (input.from === undefined || input.to === undefined) throw new HttpError(400, "invalid_range", "date, or both from and to, are required");
        from = parseDateQuery(stringField(input.from, "from", { nonEmpty: true }), "from");
        to = parseDateQuery(stringField(input.to, "to", { nonEmpty: true }), "to");
      }
      if (from === undefined || to === undefined) throw new HttpError(400, "invalid_range", "date, or both from and to, are required");
      if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
      const timeZone = typeof input.timeZone === "string" ? input.timeZone : "UTC";
      assertTimeZone(timeZone);
      const dates = datesBetween(from, to);
      if (dates.length > 400) throw new HttpError(400, "invalid_range", "range must not exceed 400 days");
      const byDate = collectSummarisableRecords(repository, timeZone);
      const daySummaryProvider = createDaySummaryProvider(config);
      // Forcing is what makes this a regenerate rather than a read: it steps over
      // the cached row — including one the owner typed — and writes a fresh one.
      const items = await resolveDaySummaries({
        dates,
        recordsForDate: (date) => byDate.get(date) ?? [],
        cache: repository,
        provider: daySummaryProvider,
        force: true,
      });
      setJson(res, 200, summaryPayload(items, daySummaryProvider));
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
      // A bundle is the one payload that can carry a reference to nothing; check
      // the whole graph before it reaches the transaction.
      assertImportReferences(bundle, repository);
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
    // A photo dropped onto the composer arrives as raw bytes, not JSON, so it
    // gets its own route with its own size limit. Everything else about assets
    // stays reference-based: this route is the only place LifeOS writes a file.
    if (pathname === "/api/assets/uploads" && req.method === "POST") {
      if (config.assetRoot === undefined) {
        throw new HttpError(404, "asset_root_not_configured", "Set LIFEOS_ASSET_ROOT to store local originals");
      }
      const mediaType = baseMediaType(req.headers["content-type"]);
      const format = ASSET_UPLOAD_FORMATS[mediaType];
      if (format === undefined) {
        throw new HttpError(415, "unsupported_media_type", "Only JPEG, PNG, WebP, GIF and AVIF photos can be uploaded");
      }
      const bytes = await readRawBody(req, config.assetUploadLimitBytes);
      if (bytes.length === 0) throw new HttpError(400, "empty_upload", "The uploaded photo is empty");
      if (!format.matches(bytes)) {
        throw new HttpError(415, "content_type_mismatch", "The uploaded bytes are not the declared image type");
      }
      // The hash is computed from the bytes we actually received, never taken
      // from the request. A client that lied about it could otherwise poison the
      // index and be handed a different photo back the next time it asked.
      const contentHash: ContentHash = { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") };
      // The copy the library already holds wins over writing another file. The
      // composer asks /api/assets/resolve before it spends the bandwidth, but
      // that is a courtesy, not a guard: a script, a second tab, or a resolve
      // that missed all arrive here with bytes the library already has. Reusing
      // the row is what keeps one photo to one file on disk -- the basis of the
      // content-addressed plan, and of the time machine's promise that a photo
      // from a past moment is still resolvable.
      //
      // The reuse answers 201 with the existing asset, identical to a fresh
      // upload. `.review/photo-grid-seed.mjs` reads the id out of a 201, and a
      // separate shape would only make callers branch on something they do not
      // act on differently.
      const existing = repository.findAssetByContentHash(contentHash.algorithm, contentHash.value);
      if (existing !== null) {
        // Taking the photo back into use moves the collector's anchor forward,
        // so the grace period restarts from now -- the same rule /resolve uses.
        const reused: Asset = { ...existing, lastUsedAt: nowInstant() };
        repository.updateAsset(reused);
        setJson(res, 201, reused);
        return;
      }
      let sourceRef: string;
      try {
        // The digest goes into the path, so the file lands under a name that is
        // the picture's own identity rather than a fresh UUID: a second copy of
        // these bytes cannot be written under a different name later on.
        sourceRef = storeUploadedPhoto(config.assetRoot, bytes, format, contentHash.value);
      } catch {
        throw new HttpError(500, "asset_write_failed", "Could not write the photo into LIFEOS_ASSET_ROOT");
      }
      const originalName = uploadOriginalName(url.searchParams.get("name"));
      const uploadRef = coreValidated("storageRefs", () => {
        const candidate: StorageReference = { sourceId: "local", sourceRef, mediaType, contentHash };
        assertValidStorageReference(candidate, "storageRefs[0]");
        return candidate;
      });
      // One dropped photo is one photo asset. The record links to it when the
      // entry is saved; until then it is an unreferenced upload that
      // DELETE /api/assets/:id still accepts.
      const asset = buildAsset(
        { kind: "photo", mediaType, sizeBytes: bytes.length, ...(originalName === undefined ? {} : { originalName }) },
        `asset_${randomUUID()}`,
        [uploadRef],
      );
      repository.insertAsset(asset);
      setJson(res, 201, asset);
      return;
    }
    // Content-hash reuse: the composer asks this before it spends bandwidth on
    // bytes the library already holds. A miss is a normal answer, not a
    // failure, so it is a 200 carrying `matched: false` — a 404 here would
    // fill the client's diagnostics log with noise on every new photo.
    if (pathname === "/api/assets/resolve" && req.method === "POST") {
      requireJsonContentType(req);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["algorithm", "value"]);
      const algorithm = enumField(input.algorithm, ["sha256"], "algorithm");
      const value = stringField(input.value, "value");
      if (!/^[0-9a-f]{64}$/.test(value)) {
        throw new HttpError(400, "invalid_hash", "value must be a lowercase sha256 hex digest");
      }
      const match = repository.findAssetByContentHash(algorithm, value);
      if (match === null) {
        setJson(res, 200, { matched: false });
        return;
      }
      // Reusing an upload puts the photo back in use, so the orphan collector's
      // anchor moves forward and the grace period restarts from now.
      const reused: Asset = { ...match, lastUsedAt: nowInstant() };
      repository.updateAsset(reused);
      setJson(res, 200, { matched: true, asset: reused });
      return;
    }
    // The derived-thumbnail bookkeeping answers without an asset root: reporting an
    // empty cache is the honest reply when there is nowhere to keep one, and the
    // settings card should show that rather than an error.
    if (pathname === "/api/assets/thumbnails" && req.method === "GET") {
      const stats = thumbnails.stats();
      setJson(res, 200, {
        count: stats.count,
        bytes: stats.bytes,
        widths: [...THUMBNAIL_WIDTHS],
        directory: stats.directory,
      });
      return;
    }
    if (pathname === "/api/assets/thumbnails" && req.method === "DELETE") {
      const cleared = thumbnails.clear();
      setJson(res, 200, { removed: cleared.removed, freedBytes: cleared.freedBytes });
      return;
    }
    // The trash routes have to come before the `:id` matcher below: "trash" is
    // a perfectly good asset id as far as that pattern is concerned.
    if (pathname === "/api/assets/trash" && req.method === "GET") {
      requireAssetRoot(config);
      const now = new Date();
      const pending = planUnreferencedUploads(
        repository.listAssets(),
        repository.referencedAssetIds(),
        now,
        config.assetOrphanGraceDays,
      ).map((upload) => ({
        asset: upload.asset,
        dueAt: upload.dueAt.toISOString(),
        daysRemaining: upload.daysRemaining,
        overdue: upload.overdue,
      }));
      const trashed = repository
        .listAssetTrash()
        .filter((entry) => entry.restoredAt === undefined && entry.purgedAt === undefined)
        .map((entry) => ({
          asset: entry.asset,
          trashedAt: entry.trashedAt,
          origin: entry.origin,
          daysRemaining: trashDaysRemaining(entry, now, config.assetTrashDays),
        }));
      setJson(res, 200, {
        graceDays: config.assetOrphanGraceDays,
        trashDays: config.assetTrashDays,
        nextRunAt: nextAssetGcAt(now).toISOString(),
        pending,
        trashed,
      });
      return;
    }
    const assetTrashMatch = /^\/api\/assets\/trash\/([^/]+)(\/restore)?$/.exec(pathname);
    if (assetTrashMatch !== null) {
      requireAssetRoot(config);
      const trashedId = decodeSegment(assetTrashMatch[1]!);
      if (assetTrashMatch[2] !== undefined && req.method === "POST") {
        if (!restoreTrashedAsset(config, repository, trashedId)) {
          throw new HttpError(404, "not_found", "Nothing to restore for this asset");
        }
        setEmpty(res, 204);
        return;
      }
      if (assetTrashMatch[2] === undefined && req.method === "DELETE") {
        requireJsonContentType(req, true);
        if (!purgeTrashedAsset(config, repository, trashedId)) {
          throw new HttpError(404, "not_found", "Nothing to delete for this asset");
        }
        setEmpty(res, 204);
        return;
      }
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
        // Deleting an asset must not leave its file behind. Ours go to the same
        // trash the collector uses, so a mistake is recoverable; reference-style
        // assets point into the owner's own folders, so we only unregister them.
        if (config.assetRoot !== undefined && isCollectableAsset(existing)) {
          trashAsset(config.assetRoot, repository, existing, "asset-delete", new Date());
        } else {
          repository.deleteAsset(id);
        }
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
      const resolved = resolveAssetOriginal(config, repository, decodeSegment(assetContentMatch[1]!));
      res.writeHead(200, {
        "content-type": resolved.mediaType,
        "content-length": String(statSync(resolved.file).size),
        "cache-control": "private, max-age=300",
        "content-disposition": "inline",
      });
      res.end(readFileSync(resolved.file));
      return;
    }
    // The derived thumbnail: the timeline grid, the composer tray and the week-card
    // backgrounds were all pulling whole originals for a few hundred pixels of paint.
    // Same URL shape as the original so the client has one helper with one optional
    // width, and the same short private lifetime — the file on disk is the cache.
    const assetThumbnailMatch = /^\/api\/assets\/([^/]+)\/thumbnail$/.exec(pathname);
    if (assetThumbnailMatch !== null && req.method === "GET") {
      const width = parseThumbnailWidth(url.searchParams.get("w"));
      if (width === null) {
        throw new HttpError(400, "unsupported_thumbnail_width", `w must be one of ${THUMBNAIL_WIDTHS.join(", ")}`);
      }
      const original = resolveAssetOriginal(config, repository, decodeSegment(assetThumbnailMatch[1]!));
      if (!THUMBNAILABLE_ASSET_EXTENSIONS.has(extname(original.file).toLowerCase())) {
        throw new HttpError(415, "unsupported_thumbnail_type", "A thumbnail can only be derived from a raster image");
      }
      let file: string;
      try {
        file = await thumbnails.ensure(original.reference, original.file, width);
      } catch {
        throw new HttpError(500, "thumbnail_failed", "Could not derive a thumbnail from this original");
      }
      res.writeHead(200, {
        "content-type": `image/${THUMBNAIL_FORMAT}`,
        "content-length": String(statSync(file).size),
        "cache-control": "private, max-age=300",
        "content-disposition": "inline",
      });
      res.end(readFileSync(file));
      return;
    }
    // A collected file no longer lives at its original path, so the thumbnail
    // in the trash panel needs its own reader. Read-only, and only while the
    // entry is still restorable.
    const trashContentMatch = /^\/api\/assets\/trash\/([^/]+)\/content$/.exec(pathname);
    if (trashContentMatch !== null && req.method === "GET") {
      const root = requireAssetRoot(config);
      const trashedId = decodeSegment(trashContentMatch[1]!);
      const entry = repository.findAssetTrash(trashedId);
      if (entry === null || entry.purgedAt !== undefined) throw new HttpError(404, "not_found", "Asset not found");
      const trashedRelative = trashPathFor(entry.relativePath);
      const file = trashedRelative === null ? null : resolveWithinRoot(root, trashedRelative);
      if (file === null || !existsSync(file)) throw new HttpError(404, "not_found", "Collected file is gone");
      res.writeHead(200, {
        "content-type": ASSET_MEDIA_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(statSync(file).size),
        "cache-control": "private, max-age=60",
        "content-disposition": "inline",
      });
      res.end(readFileSync(file));
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
    assetGcScheduler,
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
      assetGcScheduler.stop();
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
