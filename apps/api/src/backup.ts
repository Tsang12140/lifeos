import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ApiConfig } from "./config.js";
import type { BackupRun, SqliteRecordRepository } from "./repository.js";
import { backupTransportOf, normalizeBackupEndpoint, publicBackupConfig, resolvedBackupS3, type BackupTransport } from "./backup-config.js";
import { planBackupRetention, retentionHorizonDays, type BackupRetention } from "./backup-retention.js";

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
    hourCycle: "h23",
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

/** Encoded exactly the way the request URL encodes it, so signature and wire agree. */
function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(entries: readonly (readonly [string, string])[]): string {
  return [...entries]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (leftKey === rightKey ? (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) : (leftKey < rightKey ? -1 : 1)))
    .map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`)
    .join("&");
}

/**
 * LifeOS shares its bucket with Clockin-B, so it may only ever touch the two
 * namespaces it owns. Anything else is refused before a request is even signed.
 */
export function trashPrefixOf(config: S3Config): string {
  return `${config.prefix.replace(/^\/+|\/+$/g, "")}-trash`;
}

function assertOwnedKey(config: S3Config, key: string): string {
  const clean = key.replace(/^\/+/, "");
  const owned = [config.prefix.replace(/^\/+|\/+$/g, ""), trashPrefixOf(config)];
  if (!owned.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`))) {
    throw new Error(`拒绝操作不属于 LifeOS 的对象（该桶与 Clockin-B 共用）：${clean}`);
  }
  return clean;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

interface S3RequestOptions {
  readonly method: "PUT" | "GET" | "DELETE" | "HEAD";
  readonly key: string;
  readonly body?: Buffer;
  readonly contentType?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly query?: readonly (readonly [string, string])[];
  /** Bucket-level operations (listing) sign the bucket root instead of an object key. */
  readonly keyless?: boolean;
  readonly failureLabel?: string;
}

/**
 * The single place where requests are signed. Uploads, copies, deletes and
 * listings all route through it, so signing can only be got wrong once.
 */
async function signedS3Request(config: S3Config, options: S3RequestOptions): Promise<{ url: URL; response: Response }> {
  let cleanKey = "";
  if (options.keyless === true) {
    const prefixEntry = options.query?.find(([key]) => key === "prefix");
    if (prefixEntry === undefined) throw new Error("列举对象时必须限定 LifeOS 自己的前缀");
    assertOwnedKey(config, prefixEntry[1]);
  } else {
    cleanKey = assertOwnedKey(config, options.key);
  }
  const url = objectUrl(config, cleanKey);
  const query = options.query === undefined ? "" : canonicalQuery(options.query);
  if (query.length > 0) url.search = query;
  const body = options.body ?? Buffer.alloc(0);
  const now = new Date();
  const requestDate = amzDate(now);
  const requestDateStamp = dateStamp(now);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": requestDate,
    ...(options.contentType === undefined ? {} : { "content-type": options.contentType }),
    ...(options.extraHeaders ?? {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
  const canonicalRequest = [options.method, canonicalPath(signingPath(config, cleanKey)), query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${requestDateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", requestDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(config.secretAccessKey, requestDateStamp, config.region), stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers: { ...headers, authorization },
      ...(options.method === "PUT" ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const detail = error instanceof Error && error.name === "TimeoutError" ? "请求超时（60 秒）" : "网络连接失败";
    throw new Error(`${options.failureLabel ?? "对象存储请求"}失败：${detail}`);
  }
  return { url, response };
}

async function uploadObject(config: S3Config, key: string, body: Buffer, contentType: string): Promise<string> {
  // Only reachable through an explicitly opted-in file:// endpoint. Every
  // caller gets its config from resolvedBackupS3(), which rejects a local
  // pseudo-bucket unless LIFEOS_ALLOW_FILE_BACKUP=1, so this branch can never
  // turn a real deployment into a silent no-op upload.
  const localPath = localObjectPath(config, key);
  if (localPath !== undefined) {
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, body);
    return pathToFileURL(localPath).toString();
  }
  const { url, response } = await signedS3Request(config, { method: "PUT", key, body, contentType, failureLabel: "对象存储上传" });
  if (!response.ok) throw new Error(s3Error(response.status, await response.text().catch(() => "")));
  return url.toString();
}

async function deleteObject(config: S3Config, key: string): Promise<void> {
  const { response } = await signedS3Request(config, { method: "DELETE", key, failureLabel: "对象存储删除" });
  // 204 on success; 404 means it is already gone, which is the outcome we want.
  if (!response.ok && response.status !== 404) throw new Error(s3Error(response.status, await response.text().catch(() => "")));
}

/**
 * S3 has no rename, so trashing an object is a copy followed by a delete. A copy
 * that did not actually happen must never be followed by the delete.
 */
async function moveObject(config: S3Config, fromKey: string, toKey: string): Promise<void> {
  const source = `/${config.bucket}/${assertOwnedKey(config, fromKey)}`;
  // Encode the key but keep the slashes: slash-encoded copy sources are rejected.
  const copySource = encodeURIComponent(source).replaceAll("%2F", "/");
  const { response } = await signedS3Request(config, {
    method: "PUT",
    key: toKey,
    extraHeaders: { "x-amz-copy-source": copySource },
    failureLabel: "对象存储移动",
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) throw new Error(s3Error(response.status, body));
  // A copy can answer 200 while the XML body reports the real failure.
  if (/<Error>/i.test(body)) {
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? body.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`对象存储移动失败：HTTP 200 但返回错误 (${code})`);
  }
  await deleteObject(config, fromKey);
}

interface S3ObjectSummary {
  readonly key: string;
  readonly sizeBytes: number;
  /** Used to expire recycle-bin entries, so it has to be parsed, not guessed. */
  readonly lastModified?: string;
}

async function listObjects(config: S3Config, prefix: string, maxKeys = 1000): Promise<readonly S3ObjectSummary[]> {
  const { response } = await signedS3Request(config, {
    method: "GET",
    key: "",
    keyless: true,
    query: [["list-type", "2"], ["prefix", prefix], ["max-keys", String(maxKeys)]],
    failureLabel: "对象存储列举",
  });
  if (!response.ok) throw new Error(s3Error(response.status, await response.text().catch(() => "")));
  const body = await response.text();
  const items: S3ObjectSummary[] = [];
  for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const chunk = match[1] ?? "";
    const key = /<Key>([^<]*)<\/Key>/.exec(chunk)?.[1];
    if (key === undefined) continue;
    const lastModified = /<LastModified>([^<]*)<\/LastModified>/.exec(chunk)?.[1];
    items.push({
      key: decodeXmlEntities(key),
      sizeBytes: Number(/<Size>(\d+)<\/Size>/.exec(chunk)?.[1] ?? 0),
      ...(lastModified === undefined ? {} : { lastModified }),
    });
  }
  return items;
}

/** Turns a recorded https location back into the object key inside the bucket. */
function objectKeyFromLocation(config: S3Config, location: string): string | undefined {
  try {
    const url = new URL(location);
    const endpoint = new URL(normalizeBackupEndpoint(config.endpoint));
    const basePath = endpoint.pathname.replace(/\/$/, "");
    let path = decodeURIComponent(url.pathname);
    if (basePath.length > 0 && path.startsWith(basePath)) path = path.slice(basePath.length);
    path = path.replace(/^\/+/, "");
    if (config.forcePathStyle && path.startsWith(`${config.bucket}/`)) path = path.slice(config.bucket.length + 1);
    return path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
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
/**
 * One dual backup, plus the retention pass that follows it.
 *
 * Retention is deliberately a *wrapper* around the backup rather than a call in
 * the middle of it: the recycle-bin sweep issues its own S3 requests, and
 * letting those interleave with the upload made the request order
 * non-deterministic (a listing could arrive before the PUT). Running it after
 * both halves are recorded keeps the sequence local → remote → prune, which is
 * exactly what the settings page promises.
 */
export async function createDualBackup(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  kind: BackupRun["kind"] = "manual",
): Promise<DualBackupResult> {
  const result = await runDualBackup(config, repository, kind);
  try {
    await pruneBackups(config, repository);
  } catch { /* retention is best-effort: the snapshots above are already recorded */ }
  return result;
}

async function runDualBackup(
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

export interface S3ConnectionTestResult {
  readonly location: string;
  /**
   * How the test object actually travelled. A `file` transport only wrote to a
   * local directory, so the caller must not report it as a working cloud
   * connection.
   */
  readonly transport: BackupTransport;
}

export async function testS3Backup(config: ApiConfig, repository: SqliteRecordRepository): Promise<S3ConnectionTestResult> {
  const s3 = resolvedBackupS3(config);
  if (s3 === undefined || !s3.enabled) throw new Error("对象存储尚未配置，请设置 BACKUP_S3_* 环境变量");
  const transport = backupTransportOf(s3.endpoint);
  const prefix = s3.prefix.replace(/^\/+|\/+$/g, "") || "backups/db";
  const filename = `${prefix}/lifeos-connection-test-${stamp()}.txt`;
  const startedAt = new Date().toISOString();
  try {
    const body = Buffer.from(`LifeOS object storage test\n${new Date().toISOString()}\n`, "utf8");
    const location = await uploadObject(s3, filename, body, "text/plain; charset=utf-8");
    record(repository, { provider: "s3", kind: "test", status: "success", fileName: filename, location, sizeBytes: body.byteLength, startedAt, finishedAt: new Date().toISOString() });
    return { location, transport };
  } catch (error) {
    record(repository, { provider: "s3", kind: "test", status: "failed", fileName: filename, error: error instanceof Error ? error.message : "对象存储连接测试失败", startedAt, finishedAt: new Date().toISOString() });
    throw error;
  }
}

/**
 * Deletes the local snapshots the retention policy does not keep.
 *
 * Files the history does not know about (left behind by older versions) are only
 * swept once they are older than the widest retention window, so a gap in
 * `backup_runs` can never silently wipe a snapshot the policy meant to keep.
 */
export interface BackupPruneResult {
  readonly trashedLocal: number;
  readonly trashedRemote: number;
  readonly failedRemote: number;
  readonly purgedLocal: number;
  readonly purgedRemote: number;
}

function isOlderThan(value: string | undefined, cutoffMs: number): boolean {
  if (value === undefined) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < cutoffMs;
}

/**
 * Applies the retention policy.
 *
 * Nothing is deleted outright. Cleaned snapshots are *moved into a recycle bin
 * first* — the local file into `<backupDir>/_trash`, the remote object into
 * `<prefix>-trash/` — because this bucket has versioning switched off, so an S3
 * DELETE would be permanent. Only entries that have sat in the recycle bin for
 * longer than `trashDays` are removed for real.
 */
export async function pruneBackups(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  policy: BackupRetention = repository.getBackupRetention(),
  now = new Date(),
): Promise<BackupPruneResult> {
  const result = { trashedLocal: 0, trashedRemote: 0, failedRemote: 0, purgedLocal: 0, purgedRemote: 0 };
  const directory = resolve(config.backupDirectory ?? join(config.dataDirectory, "backups"));
  const trashDirectory = join(directory, "_trash");
  const purgeCutoff = now.getTime() - policy.trashDays * 86_400_000;
  const prunedAt = now.toISOString();
  const s3 = (() => {
    try {
      return resolvedBackupS3(config);
    } catch {
      return undefined;
    }
  })();

  // ---- Move doomed snapshots into the recycle bin -------------------------
  const live = repository.listAllBackupRuns().filter((run) => run.prunedAt === undefined && run.status === "success");
  const localSubjects = live
    .filter((run) => run.provider === "local" && typeof run.location === "string" && run.location.length > 0)
    .map((run) => ({ startedAt: run.startedAt, id: run.id, location: run.location as string }));
  const remoteSubjects = live
    .filter((run) => run.provider === "s3" && typeof run.location === "string" && run.location.length > 0)
    .map((run) => ({ startedAt: run.startedAt, id: run.id, location: run.location as string }));

  const known = new Set([...localSubjects, ...remoteSubjects].map((entry) => entry.location));
  const localPlan = planBackupRetention(localSubjects, policy, now).filter((entry) => !entry.keep);
  const remotePlan = planBackupRetention(remoteSubjects, policy, now).filter((entry) => !entry.keep);

  await mkdir(trashDirectory, { recursive: true });
  for (const entry of localPlan) {
    try {
      const trashPath = join(trashDirectory, entry.location.split(/[\\/]/).pop() ?? `restored-${entry.id}.sqlite`);
      await rename(entry.location, trashPath);
      repository.markBackupRunPruned(entry.id, prunedAt, trashPath);
      result.trashedLocal += 1;
    } catch { /* already moved or never existed */ }
  }
  if (s3 !== undefined && s3.enabled) {
    for (const entry of remotePlan) {
      const key = objectKeyFromLocation(s3, entry.location);
      if (key === undefined) continue;
      try {
        const trashKey = `${trashPrefixOf(s3)}/${key.split("/").pop() ?? key}`;
        await moveObject(s3, key, trashKey);
        repository.markBackupRunPruned(entry.id, prunedAt, trashKey);
        result.trashedRemote += 1;
      } catch {
        // A failed remote move must not mark the run as pruned: the object is
        // still live, so it stays in the plan for the next attempt.
        result.failedRemote += 1;
      }
    }
  }

  // ---- Purge recycle-bin entries that have aged out -----------------------
  try {
    for (const filename of await readdir(trashDirectory)) {
      const path = join(trashDirectory, filename);
      if ((await stat(path)).mtimeMs < purgeCutoff) {
        await unlink(path);
        result.purgedLocal += 1;
      }
    }
  } catch { /* no recycle bin yet */ }
  if (s3 !== undefined && s3.enabled) {
    try {
      for (const item of await listObjects(s3, `${trashPrefixOf(s3)}/`)) {
        if (isOlderThan(item.lastModified, purgeCutoff)) {
          await deleteObject(s3, item.key);
          result.purgedRemote += 1;
        }
      }
    } catch { /* listing the recycle bin is best-effort */ }
  }

  // ---- Sweep files the history does not know about ------------------------
  // Conservative on purpose: only files older than the widest retention window,
  // so a gap in backup_runs can never wipe something the policy meant to keep.
  const horizonMs = now.getTime() - retentionHorizonDays(policy) * 86_400_000;
  try {
    for (const filename of await readdir(directory)) {
      if (!/^lifeos-.*\.sqlite$/.test(filename)) continue;
      const path = join(directory, filename);
      if (known.has(path)) continue;
      if ((await stat(path)).mtimeMs < horizonMs) {
        await unlink(path);
        result.purgedLocal += 1;
      }
    }
  } catch { /* missing backup directory is normal before the first run */ }

  return result;
}
