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
import { HttpError, backupHttpError, setJson, setEmpty } from "./http-kit.js";
import {
  type JsonObject,
  isJsonObject,
  jsonObject,
  hasOnlyKeys,
  stringField,
  enumField,
  booleanField,
  boundedIntegerField,
  cycleIntimacyConfig,
  cycleIntimacyEvent,
  revisionField,
  parseLifeTime,
  nowInstant,
} from "./field-validate.js";
import {
  buildRecord,
  patchRecord,
  safeId,
  requireAssetRoot,
  contentDisposition,
  arrayField,
  coreValidated,
  decodeSegment,
  entityRefsField,
  relatedRecordIdsField,
  assetRefsField,
  assertImportReferences,
  storageRefsField,
  sizeBytesField,
  aliasesField,
} from "./record-builders.js";
import {
  MOVIE_FIELD_NAMES,
  MOVIE_INPUT_KEYS,
  assertMovieOnlyFields,
  movieScoreField,
  movieExternalIdsField,
  movieReleaseYearField,
  movieWatchedAtField,
  movieFieldsField,
  moviePayload,
  movieIdentifierField,
  movieInputEntity,
  movieExternalId,
  movieTitleMatches,
  movieMatch,
  movieExternalIdsMatch,
  movieNameHasCjk,
  mergeMovie,
  withEntityEdits,
  withMovieEdits,
  withRelation,
  withoutRelation,
  addressField,
  placeRoleField,
  placePeriodField,
  placeOnlyFields,
  withMentionRefs,
  buildAsset,
} from "./movie-input.js";
import {
  SERVABLE_ASSET_EXTENSIONS,
  THUMBNAILABLE_ASSET_EXTENSIONS,
  ASSET_MEDIA_TYPES,
  ASSET_UPLOAD_FORMATS,
  baseMediaType,
  uploadOriginalName,
  storeUploadedPhoto,
  resolveLocalAsset,
  resolveAssetOriginal,
} from "./asset-static.js";
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
import { handleBackupRoutes } from "./routes-backup.js";
import { handleRecordsRoutes } from "./routes-records.js";
import { summaryPayload, collectSummarisableRecords } from "./summary-routes.js";
import { dateForTime, sortTimeline, filterDate, assertTimeZone, filterDateRange, datesBetween } from "./timeline-query.js";
import type { RouteContext } from "./route-context.js";
import { readBody, requireJsonContentType, readRawBody } from "./http-body.js";

const SESSION_COOKIE = "lifeos_session";
const WEATHER_DEVICE_COOKIE = "lifeos_weather_device";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECORD_KINDS: readonly RecordKind[] = ["journal", "task", "event", "note"];
const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];
const ENTITY_KINDS: readonly EntityKind[] = ["person", "project", "place", "topic", "movie"];
const ASSET_KINDS: readonly AssetKind[] = ["photo", "audio", "file"];
const ASSET_ROLES: readonly AssetRole[] = ["photo", "recording", "attachment"];
const CYCLE_INTIMACY_EVENT_KINDS: readonly CycleIntimacyEventKind[] = ["intimacy", "fitness", "period_start", "period_end"];




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



function parseDateQuery(value: string | null, name: string): string | undefined {
  if (value === null) return undefined;
  try {
    return createDateOnly(value).value;
  } catch {
    throw new HttpError(400, "invalid_date", `${name} must use YYYY-MM-DD`);
  }
}


interface LifeosApp {
  readonly repository: SqliteRecordRepository;
  readonly backupScheduler: BackupScheduler;
  readonly weatherArchiveScheduler: WeatherArchiveScheduler;
  readonly assetGcScheduler: AssetGcScheduler;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly close: () => void;
}

/** The shape every summaries endpoint answers with: the rows plus whose they are. */

export const requestLog = (() => {
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


function createApp(config: ApiConfig, repository = new SqliteRecordRepository(config.databasePath)): LifeosApp {
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
    const ctx: RouteContext = {
      config,
      repository,
      backupScheduler,
      weatherArchiveScheduler,
      thumbnails,
      loginFailures,
      authenticated,
      requireAuth,
      checkRequestSecurity,
    };
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
    if (await handleBackupRoutes(ctx, req, res, pathname, url)) return;
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
    if (await handleRecordsRoutes(ctx, req, res, pathname, url)) return;
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
