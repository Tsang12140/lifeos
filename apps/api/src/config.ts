import { isIP } from "node:net";
import { resolve } from "node:path";

export interface BackupS3Config {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly password?: string;
  readonly dataDirectory: string;
  readonly webDirectory: string;
  /**
   * Optional directory that holds originals referenced by assets. When set,
   * `GET /api/assets/:id/content` streams them read-only; LifeOS never copies
   * or owns these files.
   */
  readonly assetRoot?: string;
  readonly allowedOrigins: readonly string[];
  readonly cookieSecure: boolean;
  readonly bodyLimitBytes: number;
  /**
   * Photos dropped onto the composer are copied into the asset root, so they
   * need a limit of their own: a JPEG is orders of magnitude larger than any
   * JSON body this API accepts.
   */
  readonly assetUploadLimitBytes: number;
  /**
   * A dropped photo that never reaches a record lives in `uploads/` for this
   * many days before the collector moves it aside. Long enough for the common
   * "dropped it tonight, wrote the entry days later" rhythm.
   */
  readonly assetOrphanGraceDays: number;
  /**
   * How long a collected file stays restorable in the orphan trash before it
   * is deleted for good. Grace plus trash is the real window of regret.
   */
  readonly assetTrashDays: number;
  readonly backupDirectory?: string;
  readonly backupS3?: BackupS3Config;
  /**
   * Day summaries are optional: without a key the API answers from the offline
   * rule, so browsing a calendar never depends on a third party being reachable.
   */
  readonly deepseekApiKey?: string;
  readonly deepseekModel: string;
  readonly deepseekBaseUrl: string;
  readonly qweatherApiKey?: string;
  readonly qweatherLocation?: string;
  readonly qweatherCity?: string;
  readonly qweatherHost: string;
  /** Optional TMDb key used only by the opt-in movie module. */
  readonly tmdbApiKey?: string;
  /** Per-tenant key material derived from the identity database's stable master secret. */
  readonly tenantConfigSecrets?: Partial<Record<"ai" | "weather" | "movie" | "backup", string>>;
  /** Extra object-storage path segment used by non-owner spaces. */
  readonly backupObjectPrefix?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_ASSET_UPLOAD_LIMIT = 25 * 1024 * 1024;
const DEFAULT_ASSET_ORPHAN_GRACE_DAYS = 7;
const DEFAULT_ASSET_TRASH_DAYS = 30;
const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_QWEATHER_HOST = "devapi.qweather.com";

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("LIFEOS_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized === "127.0.0.1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."));
}

function splitOrigins(raw: string | undefined, host: string): string[] {
  const defaults = ["http://localhost:5173", "http://127.0.0.1:5173"];
  if (raw === undefined || raw.trim() === "") {
    return isLoopbackHost(host) ? defaults : [];
  }
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  if (env.LIFEOS_ACCOUNT_MODE === "1") {
    throw new Error("LIFEOS_ACCOUNT_MODE is not available yet; the account identity foundation is not connected to HTTP routes");
  }
  const host = env.LIFEOS_HOST?.trim() || DEFAULT_HOST;
  const port = parsePort(env.LIFEOS_PORT);
  const dataDirectory = resolve(env.LIFEOS_DATA_DIR?.trim() || "data");
  const databasePath = resolve(env.LIFEOS_DB_PATH?.trim() || `${dataDirectory}/lifeos.sqlite`);
  const password = env.LIFEOS_PASSWORD?.length ? env.LIFEOS_PASSWORD : undefined;
  if (!isLoopbackHost(host) && password === undefined) {
    throw new Error("LIFEOS_PASSWORD is required when LIFEOS_HOST is not loopback");
  }
  const webDirectory = resolve(env.LIFEOS_WEB_DIR?.trim() || "apps/web/dist");
  const assetRoot = env.LIFEOS_ASSET_ROOT?.trim();
  const cookieSecure = env.LIFEOS_COOKIE_SECURE === "1" || env.LIFEOS_COOKIE_SECURE?.toLowerCase() === "true";
  const deepseekApiKey = env.LIFEOS_DEEPSEEK_API_KEY?.trim();
  const qweatherApiKey = env.QWEATHER_KEY?.trim();
  const tmdbApiKey = (env.LIFEOS_TMDB_API_KEY?.trim() || env.TMDB_API_KEY?.trim()) || undefined;
  const backupDirectory = resolve(env.LIFEOS_BACKUP_DIR?.trim() || env.BACKUP_DIR?.trim() || `${dataDirectory}/backups`);
  const backupBucket = env.BACKUP_S3_BUCKET?.trim() || "";
  const backupAccessKeyId = env.BACKUP_S3_ACCESS_KEY_ID?.trim() || "";
  const backupSecretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY?.trim() || "";
  const backupS3 = backupBucket && backupAccessKeyId && backupSecretAccessKey
    ? {
        enabled: env.BACKUP_S3_ENABLED?.toLowerCase() !== "false",
        endpoint: env.BACKUP_S3_ENDPOINT?.trim() || "https://s3.amazonaws.com",
        region: env.BACKUP_S3_REGION?.trim() || "us-east-1",
        bucket: backupBucket,
        prefix: env.BACKUP_S3_PREFIX?.trim() || "backups/db",
        forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE?.toLowerCase() !== "false",
        accessKeyId: backupAccessKeyId,
        secretAccessKey: backupSecretAccessKey,
      }
    : undefined;
  return {
    host,
    port,
    databasePath,
    ...(password === undefined ? {} : { password }),
    dataDirectory,
    webDirectory,
    ...(assetRoot === undefined || assetRoot === "" ? {} : { assetRoot: resolve(assetRoot) }),
    allowedOrigins: splitOrigins(env.LIFEOS_ALLOWED_ORIGINS, host),
    cookieSecure,
    bodyLimitBytes: parsePositiveInt(env.LIFEOS_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT, "LIFEOS_BODY_LIMIT_BYTES"),
    assetUploadLimitBytes: parsePositiveInt(env.LIFEOS_ASSET_UPLOAD_LIMIT_BYTES, DEFAULT_ASSET_UPLOAD_LIMIT, "LIFEOS_ASSET_UPLOAD_LIMIT_BYTES"),
    assetOrphanGraceDays: parsePositiveInt(env.LIFEOS_ASSET_ORPHAN_GRACE_DAYS, DEFAULT_ASSET_ORPHAN_GRACE_DAYS, "LIFEOS_ASSET_ORPHAN_GRACE_DAYS"),
    assetTrashDays: parsePositiveInt(env.LIFEOS_ASSET_TRASH_DAYS, DEFAULT_ASSET_TRASH_DAYS, "LIFEOS_ASSET_TRASH_DAYS"),
    backupDirectory,
    ...(backupS3 === undefined ? {} : { backupS3 }),
    ...(deepseekApiKey === undefined || deepseekApiKey === "" ? {} : { deepseekApiKey }),
    deepseekModel: env.LIFEOS_DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
    deepseekBaseUrl: (env.LIFEOS_DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/$/, ""),
    ...(qweatherApiKey === undefined || qweatherApiKey === "" ? {} : { qweatherApiKey }),
    ...(env.QWEATHER_LOCATION?.trim() ? { qweatherLocation: env.QWEATHER_LOCATION.trim() } : {}),
    ...(env.QWEATHER_CITY?.trim() ? { qweatherCity: env.QWEATHER_CITY.trim() } : {}),
    qweatherHost: (env.QWEATHER_HOST?.trim() || DEFAULT_QWEATHER_HOST).replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    ...(tmdbApiKey === undefined || tmdbApiKey === "" ? {} : { tmdbApiKey }),
  };
}

export { isLoopbackHost };
