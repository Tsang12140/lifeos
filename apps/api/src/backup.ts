import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ApiConfig } from "./config.js";
import type { BackupRun, SqliteRecordRepository } from "./repository.js";
import { normalizeBackupEndpoint, publicBackupConfig, resolvedBackupS3 } from "./backup-config.js";

type S3Config = NonNullable<ApiConfig["backupS3"]>;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer | string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function dateStamp(date: Date): string {
  return amzDate(date).slice(0, 8);
}

function stamp(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
}

function localObjectPath(config: S3Config, key: string): string | undefined {
  const endpoint = new URL(normalizeBackupEndpoint(config.endpoint));
  if (endpoint.protocol !== "file:") return undefined;
  const root = resolve(fileURLToPath(endpoint));
  const parts = [config.bucket, ...key.replace(/^\/+/, "").split("/")].filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\\"))) throw new Error("本地对象存储 Key 不安全");
  const path = resolve(join(root, ...parts));
  if (path !== root && !path.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("本地对象存储 Key 越界");
  return path;
}

function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function objectUrl(config: S3Config, key: string): URL {
  const endpoint = new URL(normalizeBackupEndpoint(config.endpoint));
  const basePath = endpoint.pathname.replace(/\/$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  const path = config.forcePathStyle ? `${basePath}/${config.bucket}/${cleanKey}` : `${basePath}/${cleanKey}`;
  const host = config.forcePathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  return new URL(`${endpoint.protocol}//${host}${path}`);
}

function signingPath(config: S3Config, key: string): string {
  const endpoint = new URL(normalizeBackupEndpoint(config.endpoint));
  const basePath = endpoint.pathname.replace(/\/$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  return config.forcePathStyle ? `${basePath}/${config.bucket}/${cleanKey}` : `${basePath}/${cleanKey}`;
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

function s3Error(status: number, body: string): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  if (code === "AccessDenied") return "对象存储拒绝上传，请检查 Bucket 的 PutObject 权限。";
  if (code === "SignatureDoesNotMatch") return "对象存储签名失败，请检查 Endpoint、Region、密钥和 Path-style 设置。";
  if (code === "NoSuchBucket") return "对象存储 Bucket 不存在，请检查名称。";
  return `对象存储上传失败：HTTP ${status}${code ? ` (${code})` : ""}`;
}

async function uploadObject(config: S3Config, key: string, body: Buffer, contentType: string): Promise<string> {
  const localPath = localObjectPath(config, key);
  if (localPath !== undefined) {
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, body);
    return pathToFileURL(localPath).toString();
  }
  const url = objectUrl(config, key);
  const now = new Date();
  const requestDate = amzDate(now);
  const requestDateStamp = dateStamp(now);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    "content-type": contentType,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": requestDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
  const canonicalRequest = ["PUT", canonicalPath(signingPath(config, key)), "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${requestDateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", requestDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(config.secretAccessKey, requestDateStamp, config.region), stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "PUT", headers: { ...headers, authorization }, body: new Uint8Array(body), signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error(`对象存储上传失败：${error instanceof Error && error.name === "TimeoutError" ? "请求超时（60 秒）" : "网络连接失败"}`);
  }
  if (!response.ok) throw new Error(s3Error(response.status, await response.text().catch(() => "")));
  return url.toString();
}

export interface BackupArtifact {
  readonly filename: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export type DualBackupProviderResult = {
  readonly status: "success" | "failed" | "skipped";
  readonly fileName?: string;
  readonly location?: string;
  readonly sizeBytes?: number;
  readonly error?: string;
};

export interface DualBackupResult {
  readonly batchId: string;
  readonly status: "success" | "partial" | "local_only" | "failed";
  readonly local: DualBackupProviderResult;
  readonly s3: DualBackupProviderResult;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export async function createBackupArtifact(config: ApiConfig, repository: SqliteRecordRepository): Promise<BackupArtifact> {
  const directory = resolve(config.backupDirectory ?? join(config.dataDirectory, "backups"));
  await mkdir(directory, { recursive: true });
  const filename = `lifeos-${stamp()}-${randomUUID().slice(0, 8)}.sqlite`;
  const path = join(directory, filename);
  await repository.backupTo(path);
  const sizeBytes = (await stat(path)).size;
  return { filename, path, sizeBytes };
}

function record(repository: SqliteRecordRepository, run: Omit<BackupRun, "id">): void {
  try { repository.recordBackupRun(run); } catch { /* backup success must not be hidden by history bookkeeping */ }
}

export async function createLocalBackup(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  options: { readonly kind?: BackupRun["kind"]; readonly batchId?: string } = {},
): Promise<BackupArtifact> {
  const startedAt = new Date().toISOString();
  try {
    const artifact = await createBackupArtifact(config, repository);
    record(repository, { provider: "local", kind: options.kind ?? "manual", status: "success", ...(options.batchId === undefined ? {} : { batchId: options.batchId }), fileName: artifact.filename, location: artifact.path, sizeBytes: artifact.sizeBytes, startedAt, finishedAt: new Date().toISOString() });
    return artifact;
  } catch (error) {
    record(repository, { provider: "local", kind: options.kind ?? "manual", status: "failed", ...(options.batchId === undefined ? {} : { batchId: options.batchId }), error: error instanceof Error ? error.message : "本地备份失败", startedAt, finishedAt: new Date().toISOString() });
    throw error;
  }
}

export async function uploadS3Backup(config: ApiConfig, repository: SqliteRecordRepository): Promise<{ readonly filename: string; readonly location: string; readonly sizeBytes: number }> {
  const s3 = resolvedBackupS3(config);
  if (s3 === undefined || !s3.enabled) throw new Error("对象存储尚未配置，请设置 BACKUP_S3_* 环境变量");
  const artifact = await createBackupArtifact(config, repository);
  const startedAt = new Date().toISOString();
  try {
    const prefix = s3.prefix.replace(/^\/+|\/+$/g, "") || "backups/db";
    const location = await uploadObject(s3, `${prefix}/${artifact.filename}`, await readFile(artifact.path), "application/vnd.sqlite3");
    record(repository, { provider: "s3", kind: "manual", status: "success", fileName: artifact.filename, location, sizeBytes: artifact.sizeBytes, startedAt, finishedAt: new Date().toISOString() });
    return { filename: artifact.filename, location, sizeBytes: artifact.sizeBytes };
  } catch (error) {
    record(repository, { provider: "s3", kind: "manual", status: "failed", fileName: artifact.filename, error: error instanceof Error ? error.message : "对象存储备份失败", startedAt, finishedAt: new Date().toISOString() });
    throw error;
  }
}

/**
 * Create one SQLite artifact, persist the local result first, then upload the
 * exact same bytes to S3. The remote half can fail or be skipped without
 * erasing the local success; both rows share a batch id for the UI/calendar.
 */
export async function createDualBackup(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  kind: BackupRun["kind"] = "manual",
): Promise<DualBackupResult> {
  const startedAt = new Date().toISOString();
  const batchId = randomUUID();
  let artifact: BackupArtifact | undefined;
  let local: DualBackupProviderResult;
  try {
    artifact = await createBackupArtifact(config, repository);
    local = { status: "success", fileName: artifact.filename, location: artifact.path, sizeBytes: artifact.sizeBytes };
    record(repository, { provider: "local", kind, status: "success", batchId, fileName: artifact.filename, location: artifact.path, sizeBytes: artifact.sizeBytes, startedAt, finishedAt: new Date().toISOString() });
    void pruneLocalBackups(config).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "本地备份失败";
    local = { status: "failed", error: message };
    record(repository, { provider: "local", kind, status: "failed", batchId, error: message, startedAt, finishedAt: new Date().toISOString() });
    const remoteMessage = `本地备份失败，未尝试对象存储：${message}`;
    const s3: DualBackupProviderResult = { status: "skipped", error: remoteMessage };
    record(repository, { provider: "s3", kind, status: "skipped", batchId, error: remoteMessage, startedAt, finishedAt: new Date().toISOString() });
    return { batchId, status: "failed", local, s3, startedAt, finishedAt: new Date().toISOString() };
  }

  let s3Config: ReturnType<typeof resolvedBackupS3>;
  let s3ConfigError: string | undefined;
  try {
    s3Config = resolvedBackupS3(config);
  } catch (error) {
    s3Config = undefined;
    s3ConfigError = error instanceof Error ? error.message : "对象存储配置无效";
  }
  if (s3ConfigError !== undefined) {
    const s3: DualBackupProviderResult = { status: "failed", fileName: artifact.filename, error: s3ConfigError };
    record(repository, { provider: "s3", kind, status: "failed", batchId, fileName: artifact.filename, error: s3ConfigError, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    return { batchId, status: "partial", local, s3, startedAt, finishedAt: new Date().toISOString() };
  }
  if (s3Config === undefined || !s3Config.enabled) {
    const publicConfig = publicBackupConfig(config);
    const message = !publicConfig.configured
      ? "对象存储尚未配置，已跳过远端备份"
      : !publicConfig.enabled
        ? "对象存储已停用，已跳过远端备份"
        : "对象存储缺少密钥，已跳过远端备份";
    const s3: DualBackupProviderResult = { status: "skipped", error: message };
    record(repository, { provider: "s3", kind, status: "skipped", batchId, fileName: artifact.filename, error: message, startedAt, finishedAt: new Date().toISOString() });
    return { batchId, status: "local_only", local, s3, startedAt, finishedAt: new Date().toISOString() };
  }

  const remoteStartedAt = new Date().toISOString();
  try {
    const prefix = s3Config.prefix.replace(/^\/+|\/+$/g, "") || "backups/db";
    const body = await readFile(artifact.path);
    const location = await uploadObject(s3Config, `${prefix}/${artifact.filename}`, body, "application/vnd.sqlite3");
    const s3: DualBackupProviderResult = { status: "success", fileName: artifact.filename, location, sizeBytes: artifact.sizeBytes };
    record(repository, { provider: "s3", kind, status: "success", batchId, fileName: artifact.filename, location, sizeBytes: artifact.sizeBytes, startedAt: remoteStartedAt, finishedAt: new Date().toISOString() });
    return { batchId, status: "success", local, s3, startedAt, finishedAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "对象存储备份失败";
    const s3: DualBackupProviderResult = { status: "failed", fileName: artifact.filename, error: message };
    record(repository, { provider: "s3", kind, status: "failed", batchId, fileName: artifact.filename, error: message, startedAt: remoteStartedAt, finishedAt: new Date().toISOString() });
    return { batchId, status: "partial", local, s3, startedAt, finishedAt: new Date().toISOString() };
  }
}

export async function testS3Backup(config: ApiConfig, repository: SqliteRecordRepository): Promise<string> {
  const s3 = resolvedBackupS3(config);
  if (s3 === undefined || !s3.enabled) throw new Error("对象存储尚未配置，请设置 BACKUP_S3_* 环境变量");
  const prefix = s3.prefix.replace(/^\/+|\/+$/g, "") || "backups/db";
  const filename = `${prefix}/lifeos-connection-test-${stamp()}.txt`;
  const startedAt = new Date().toISOString();
  try {
    const body = Buffer.from(`LifeOS object storage test\n${new Date().toISOString()}\n`, "utf8");
    const location = await uploadObject(s3, filename, body, "text/plain; charset=utf-8");
    record(repository, { provider: "s3", kind: "test", status: "success", fileName: filename, location, sizeBytes: body.byteLength, startedAt, finishedAt: new Date().toISOString() });
    return location;
  } catch (error) {
    record(repository, { provider: "s3", kind: "test", status: "failed", fileName: filename, error: error instanceof Error ? error.message : "对象存储连接测试失败", startedAt, finishedAt: new Date().toISOString() });
    throw error;
  }
}

export async function pruneLocalBackups(config: ApiConfig, days = 30): Promise<number> {
  const directory = resolve(config.backupDirectory ?? join(config.dataDirectory, "backups"));
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  try {
    for (const filename of await readdir(directory)) {
      if (!/^lifeos-.*\.sqlite$/.test(filename)) continue;
      const path = join(directory, filename);
      if ((await stat(path)).mtimeMs < cutoff) { await unlink(path); removed += 1; }
    }
  } catch { /* missing backup directory is normal before the first run */ }
  return removed;
}
