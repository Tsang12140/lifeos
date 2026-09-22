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
import { handleAssetsRoutes } from "./routes-assets.js";
import { handleEntitiesRoutes } from "./routes-entities.js";
import { handleAiMovieRoutes } from "./routes-ai-movie.js";
import { handleWeatherRoutes } from "./routes-weather.js";
import { handleModulesRoutes } from "./routes-modules.js";
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
    if (await handleAiMovieRoutes(ctx, req, res, pathname, url)) return;
    if (await handleWeatherRoutes(ctx, req, res, pathname, url)) return;
    if (await handleModulesRoutes(ctx, req, res, pathname, url)) return;
    if (await handleRecordsRoutes(ctx, req, res, pathname, url)) return;
    if (await handleEntitiesRoutes(ctx, req, res, pathname, url)) return;
    if (await handleAssetsRoutes(ctx, req, res, pathname, url)) return;
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
