import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import { assertValidAsset, type Asset } from "@lifeos/core";
import { SqliteRecordRepository } from "./repository.js";
import { spaceCounts, spaceFingerprint, type SpaceTables } from "./portable-space.js";
import { ARCHIVE_MAX_BYTES, MANIFEST_MAX_BYTES, decryptArchive, encryptArchive } from "./encrypted-archive.js";
import { trashPathFor } from "./asset-gc.js";
import { ASSET_MEDIA_TYPES, baseMediaType } from "./asset-static.js";
import { downloadPoolAsset, poolObjectFor } from "./routes-assets.js";
import { POOL_SOURCE_ID, StoragePoolError } from "./storage-pool.js";
import { HttpError } from "./http-kit.js";
import type { RouteContext } from "./route-context.js";

interface ArchiveFile { assetId: string; trash: boolean; bytes: number; sha256: string; mediaType: string }
interface Manifest { format: "lifeos.space"; version: 1; exportedAt: string; tables: SpaceTables; files: ArchiveFile[] }
interface Original { asset: Asset; trash: boolean; file?: string; bytes: number }
interface Job { id: string; directory: string; kind: "export" | "upload" | "import"; phase: "working" | "ready" | "failed"; createdAt: number; bytes?: number; error?: string; manifest?: Manifest; targetFingerprint?: string; targetCounts?: ReturnType<typeof spaceCounts>; controller: AbortController }
const TTL = 15 * 60_000;
let active = 0;
const TEMP_PREFIX = "lifeos-space-archive-";
export async function cleanupStaleArchives(): Promise<void> {
  const root = resolve(tmpdir());
  for (const name of await readdir(root)) {
    if (!/^lifeos-space-archive-[A-Za-z0-9]+$/.test(name)) continue;
    const directory = resolve(root, name);
    if (!directory.startsWith(root + sep)) continue;
    try { const info = await lstat(directory); if (info.isDirectory() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > TTL) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* A live operation may own the directory; retry on the next sweep. */ }
  }
}
const sweepTimer = setInterval(() => { void cleanupStaleArchives().catch(() => {}); }, 60_000); sweepTimer.unref();

function assetsIn(tables: SpaceTables): { asset: Asset; trash: boolean; relativePath?: string }[] {
  const assets = tables.assets.rows.map(row => ({ asset: JSON.parse(String(row[tables.assets.columns.indexOf("value_json")])) as Asset, trash: false }));
  for (const row of tables.asset_trash.rows) {
    if (row[tables.asset_trash.columns.indexOf("restored_at")] !== null || row[tables.asset_trash.columns.indexOf("purged_at")] !== null) continue;
    assets.push({ asset: JSON.parse(String(row[tables.asset_trash.columns.indexOf("asset_json")])), trash: true, relativePath: String(row[tables.asset_trash.columns.indexOf("relative_path")]) } as typeof assets[number]);
  }
  return assets;
}

export class ArchiveService {
  readonly #jobs = new Map<string, Job>();
  #busy = false;
  #passwordFailures = 0;
  #passwordWindow = 0;
  async #new(kind: Job["kind"]): Promise<Job> {
    if (this.#jobs.size >= 3) throw new HttpError(429, "archive_job_limit", "临时完整包过多，请关闭旧窗口后再试");
    const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    await chmod(directory, 0o700);
    const job: Job = { id: randomUUID(), directory, kind, phase: "working", createdAt: Date.now(), controller: new AbortController() };
    this.#jobs.set(job.id, job);
    const timer = setTimeout(() => { void this.remove(job.id).catch(() => {}); }, TTL); timer.unref();
    return job;
  }
  get(id: string): Job {
    const job = this.#jobs.get(id);
    if (!job || Date.now() - job.createdAt > TTL) throw new HttpError(404, "archive_expired", "临时加密包已过期，请重新生成或上传");
    return job;
  }
  view(id: string) {
    const job = this.get(id);
    return { id, kind: job.kind, phase: job.phase, bytes: job.bytes, error: job.error, expiresAt: new Date(job.createdAt + TTL).toISOString(), ...(job.manifest ? { exportedAt: job.manifest.exportedAt, counts: spaceCounts(job.manifest.tables), targetCounts: job.targetCounts } : {}) };
  }
  async remove(id: string): Promise<void> {
    const job = this.#jobs.get(id); if (!job) return;
    job.controller.abort(); this.#jobs.delete(id);
    const directory = resolve(job.directory), root = resolve(tmpdir());
    if (!directory.startsWith(root + sep) || !/^lifeos-space-archive-[A-Za-z0-9]+$/.test(directory.slice(root.length + 1))) throw new Error("拒绝清理非归档临时目录");
    // In-flight work owns cleanup until it has released open files.
    if (job.phase !== "working") await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  close(): void { for (const job of this.#jobs.values()) void this.remove(job.id).catch(() => {}); }
  async #work(job: Job, task: () => Promise<void>): Promise<void> {
    try { await task(); if (job.controller.signal.aborted) throw new Error("已取消"); job.phase = "ready"; }
    catch (error) { job.phase = "failed"; job.error = error instanceof Error ? error.message : "归档处理失败"; }
    finally {
      this.#busy = false; active--;
      if (job.phase === "failed" || job.controller.signal.aborted) await rm(job.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  }
  #reserve(): void { if (this.#busy || active >= 2) throw new HttpError(429, "archive_busy", "正在处理加密包，请稍后再试"); this.#busy = true; active++; }

  async #originals(ctx: RouteContext, tables: SpaceTables): Promise<Original[]> {
    const originals: Original[] = [];
    for (const item of assetsIn(tables)) {
      const { asset, trash } = item; assertValidAsset(asset);
      const remote = asset.storageRefs.find(ref => ref.sourceId === POOL_SOURCE_ID);
      if (remote) { originals.push({ asset, trash, bytes: poolObjectFor(ctx, asset, remote).bytes }); continue; }
      const ref = asset.storageRefs.find(ref => ref.sourceId === "local");
      if (!ref || !ctx.config.assetRoot) throw new HttpError(409, "archive_original_missing", `无法读取原件：${asset.originalName ?? asset.id}`);
      const relative = trash ? trashPathFor(item.relativePath ?? ref.sourceRef) : ref.sourceRef;
      if (!relative) throw new HttpError(409, "archive_original_missing", "回收站原件路径无效");
      try { const root = await realpath(ctx.config.assetRoot), file = await realpath(resolve(root, relative)); if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error("原件路径无效"); const bytes = (await stat(file)).size; originals.push({ asset, trash, file, bytes }); }
      catch { throw new HttpError(409, "archive_original_missing", `原件已缺失，无法生成完整包：${asset.originalName ?? asset.id}`); }
    }
    if (originals.length > 100_000) throw new HttpError(413, "archive_too_many_files", "文件数量超过完整包上限");
    return originals;
  }
  async estimate(ctx: RouteContext) {
    const tables = ctx.repository.portableSpace(), originals = await this.#originals(ctx, tables);
    const originalBytes = originals.reduce((sum, item) => sum + item.bytes, 0);
    const cloudReadBytes = originals.filter(item => !item.file).reduce((sum, item) => sum + item.bytes, 0);
    const metadataBytes = Buffer.byteLength(JSON.stringify(tables));
    if (metadataBytes > MANIFEST_MAX_BYTES / 2 || originalBytes + metadataBytes > ARCHIVE_MAX_BYTES - MANIFEST_MAX_BYTES) throw new HttpError(413, "archive_too_large", "完整包超过 20 GB 或元数据上限，请先整理数据");
    const estimatedBytes = originalBytes + metadataBytes + originals.length * 256 + 56;
    const disk = await statfs(tmpdir());
    if (Number(disk.bavail) * Number(disk.bsize) < estimatedBytes * 2 + 64 * 1024 ** 2) throw new HttpError(507, "archive_disk_full", "服务器临时空间不足，暂时无法生成完整包");
    if (cloudReadBytes && ctx.poolStore) {
      const readiness = await ctx.poolPreflight(), usage = ctx.poolStore.usage(ctx.poolAccountId, readiness.month);
      if (cloudReadBytes > readiness.trafficFreeBytes || cloudReadBytes > usage.trafficLimitBytes - usage.trafficUsedBytes - usage.trafficReservedBytes) throw new HttpError(409, "archive_traffic_quota", "完整包所需原件下载流量超过剩余额度");
    }
    return { counts: spaceCounts(tables), originalBytes, cloudReadBytes, estimatedBytes, requiresAccountPassword: ctx.config.archivePasswordVerifier !== undefined || ctx.config.password !== undefined, maxBytes: ARCHIVE_MAX_BYTES };
  }
  async export(ctx: RouteContext, password: string): Promise<string> {
    this.#reserve();
    let job: Job;
    try {
      if (Date.now() - this.#passwordWindow > 60_000) { this.#passwordWindow = Date.now(); this.#passwordFailures = 0; }
      if (this.#passwordFailures >= 5) throw new HttpError(429, "archive_password_limited", "密码尝试过多，请一分钟后再试");
      if (ctx.config.archivePasswordVerifier && !(await ctx.config.archivePasswordVerifier(password))) { this.#passwordFailures++; throw new HttpError(403, "archive_password_invalid", "当前账号密码不正确"); }
      if (!ctx.config.archivePasswordVerifier && ctx.config.password !== undefined) {
        const expected = Buffer.from(ctx.config.password), actual = Buffer.from(password);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) { this.#passwordFailures++; throw new HttpError(403, "archive_password_invalid", "当前登录密码不正确"); }
      }
      if (password.length < 10 || password.length > 1024) throw new HttpError(400, "archive_password_invalid", "密码长度需为 10–1024 个字符");
      await this.estimate(ctx);
      job = await this.#new("export");
    } catch (error) { this.#busy = false; active--; throw error; }
    void this.#work(job, async () => {
      const tables = ctx.repository.portableSpace(), originals = await this.#originals(ctx, tables);
      const files: ArchiveFile[] = [];
      // Pin bytes into our private workspace before encryption. A missing/racing original fails the whole job.
      for (const [index, item] of originals.entries()) {
        job.controller.signal.throwIfAborted();
        const file = join(job.directory, `file-${index}`);
        if (item.file) await copyFile(item.file, file);
        else {
          const remote = item.asset.storageRefs.find(ref => ref.sourceId === POOL_SOURCE_ID)!;
          const downloaded = await downloadPoolAsset(ctx, item.asset, remote);
          try { await copyFile(downloaded.file, file); } finally { await rm(downloaded.directory, { recursive: true, force: true }); }
        }
        await chmod(file, 0o600);
        const digest = await hashFile(file), known = item.asset.storageRefs.find(ref => ref.contentHash?.algorithm === "sha256")?.contentHash;
        if (digest.bytes !== item.bytes || (known && known.value !== digest.sha256)) throw new Error("原件大小或校验值已改变，请重新生成完整包");
        files.push({ assetId: item.asset.id, trash: item.trash, ...digest, mediaType: mediaTypeOf(item.asset) });
      }
      const manifest: Manifest = { format: "lifeos.space", version: 1, exportedAt: new Date().toISOString(), tables, files };
      const json = Buffer.from(JSON.stringify(manifest));
      if (json.length > MANIFEST_MAX_BYTES) throw new Error("完整包元数据过大");
      const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
      async function* parts() { yield length; yield json; for (let index = 0; index < files.length; index++) for await (const chunk of createReadStream(join(job.directory, `file-${index}`))) yield Buffer.from(chunk); }
      await encryptArchive(parts(), join(job.directory, "archive.lifeos"), password, job.controller.signal);
      password = "";
      job.bytes = (await stat(join(job.directory, "archive.lifeos"))).size;
      if (job.bytes > ARCHIVE_MAX_BYTES) throw new Error("完整包超过 20 GB");
      job.manifest = manifest;
      for (let index = 0; index < files.length; index++) await rm(join(job.directory, `file-${index}`));
    });
    return job.id;
  }
  async upload(req: IncomingMessage): Promise<string> {
    this.#reserve(); let job: Job | undefined;
    try {
      const declared = Number(req.headers["content-length"]);
      if (req.headers["content-length"] !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > ARCHIVE_MAX_BYTES)) throw new HttpError(413, "archive_too_large", "加密包最大 20 GB");
      if (Number.isFinite(declared)) { const disk = await statfs(tmpdir()); if (Number(disk.bavail) * Number(disk.bsize) < declared * 3 + 64 * 1024 ** 2) throw new HttpError(507, "archive_disk_full", "服务器临时空间不足，暂时无法校验完整包"); }
      job = await this.#new("upload"); const current = job;
      let bytes = 0;
      async function* chunks() { for await (const chunk of req) { bytes += chunk.length; if (bytes > ARCHIVE_MAX_BYTES) throw new HttpError(413, "archive_too_large", "加密包最大 20 GB"); yield chunk; } }
      await pipeline(chunks(), createWriteStream(join(current.directory, "archive.lifeos"), { flags: "wx", mode: 0o600 }), { signal: current.controller.signal });
      job.bytes = bytes; job.phase = "ready"; return job.id;
    } catch (error) { if (job) { job.phase = "failed"; await this.remove(job.id); } throw error; }
    finally { this.#busy = false; active--; }
  }
  async prepareImport(ctx: RouteContext, id: string, password: string): Promise<void> {
    const job = this.get(id); if (job.kind !== "upload" || job.phase !== "ready") throw new HttpError(409, "archive_invalid_state", "请重新上传完整包");
    this.#reserve(); job.phase = "working"; job.kind = "import";
    void this.#work(job, async () => {
      const payload = join(job.directory, "payload");
      await decryptArchive(join(job.directory, "archive.lifeos"), payload, password, job.controller.signal); password = "";
      const file = await open(payload, "r");
      try {
        const length = Buffer.alloc(4); if ((await file.read(length, 0, 4, 0)).bytesRead !== 4) throw new Error("完整包清单缺失");
        const size = length.readUInt32BE(); if (size > MANIFEST_MAX_BYTES || size < 2) throw new Error("完整包清单大小无效");
        const json = Buffer.alloc(size); if ((await file.read(json, 0, size, 4)).bytesRead !== size) throw new Error("完整包清单被截断");
        const manifest = JSON.parse(json.toString("utf8")) as Manifest;
        if (manifest.format !== "lifeos.space" || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100_000 || !Number.isFinite(Date.parse(manifest.exportedAt))) throw new Error("完整包版本或清单无效");
        // A trusted schema and a disposable repository validate all SQL rows before touching the target.
        const validation = new SqliteRecordRepository(join(job.directory, "validate.sqlite"));
        try { validation.restorePortableSpace(manifest.tables, spaceFingerprint(validation.portableSpace())); validation.exportData(); validation.cycleIntimacyModule(); } finally { validation.close(); }
        const expectedAssets = assetsIn(manifest.tables);
        if (expectedAssets.length !== manifest.files.length) throw new Error("完整包文件数量与资产不一致");
        let offset = 4 + size;
        for (const [index, item] of manifest.files.entries()) {
          job.controller.signal.throwIfAborted();
          const expected = expectedAssets[index];
          if (!expected || item.assetId !== expected.asset.id || item.trash !== expected.trash || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("完整包资产清单无效");
          if (offset + item.bytes > (await stat(payload)).size) throw new Error("完整包原件被截断");
          const target = join(job.directory, `file-${index}`);
          if (item.bytes) await pipeline(createReadStream(payload, { start: offset, end: offset + item.bytes - 1 }), createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal: job.controller.signal });
          else { const empty = await open(target, "wx", 0o600); await empty.close(); }
          const digest = await hashFile(target); if (digest.sha256 !== item.sha256) throw new Error("完整包原件校验失败");
          offset += item.bytes;
        }
        if (offset !== (await stat(payload)).size) throw new Error("完整包包含未声明的数据");
        job.manifest = manifest; const target = ctx.repository.portableSpace(); job.targetFingerprint = spaceFingerprint(target); job.targetCounts = spaceCounts(target);
      } finally { await file.close(); }
      await rm(payload);
    });
  }

  async commitImport(ctx: RouteContext, id: string): Promise<{ backup: string }> {
    const job = this.get(id);
    if (job.kind !== "import" || job.phase !== "ready" || !job.manifest || !job.targetFingerprint) throw new HttpError(409, "archive_invalid_state", "完整包尚未校验成功");
    this.#reserve(); job.phase = "working";
    const tables = structuredClone(job.manifest.tables);
    const importId = randomUUID();
    const root = ctx.config.assetRoot;
    if (!ctx.poolBridge.enabled && !root && job.manifest.files.length) { this.#busy = false; active--; job.phase = "ready"; throw new HttpError(409, "archive_asset_root_missing", "请先配置本地原件目录"); }
    const writes: string[] = [], uploads: { attempt: string; key: string }[] = [];
    let committed = false;
    const backupDirectory = ctx.config.backupDirectory ?? join(ctx.config.dataDirectory, "backups");
    const backup = `lifeos-before-import-${importId}.sqlite`;
    try {
      if (spaceFingerprint(ctx.repository.portableSpace()) !== job.targetFingerprint) throw new HttpError(409, "archive_target_changed", "当前空间已发生变化，请重新校验导入包");
      await mkdir(backupDirectory, { recursive: true });
      await ctx.repository.backupTo(join(backupDirectory, backup));
      await chmod(join(backupDirectory, backup), 0o600);
      ctx.repository.recordBackupRun({ provider: "local", kind: "manual", status: "success", fileName: backup, location: join(backupDirectory, backup), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), sizeBytes: (await stat(join(backupDirectory, backup))).size });
      for (const [index, item] of job.manifest.files.entries()) {
        job.controller.signal.throwIfAborted();
        const table = item.trash ? tables.asset_trash : tables.assets;
        const column = table.columns.indexOf(item.trash ? "asset_json" : "value_json");
        const row = table.rows.find(row => String(row[table.columns.indexOf(item.trash ? "asset_id" : "id")]) === item.assetId);
        if (!row) throw new Error("导入资产行缺失");
        const asset = JSON.parse(String(row[column])) as Asset;
        const extension = extensionFor(item.mediaType);
        const ref = `uploads/archive-${importId}/${index}${extension}`;
        const hash = { algorithm: "sha256" as const, value: item.sha256 };
        if (ctx.poolBridge.enabled && !ctx.poolTransition?.localPrimary && !item.trash) {
          if (!ctx.poolStore) throw new Error("存储池尚未就绪");
          const readiness = await ctx.poolPreflight();
          const attempt = ctx.poolStore.reserveUpload(ctx.poolAccountId, item.assetId, item.bytes, readiness.storageFreeBytes);
          try {
            const result = await ctx.poolBridge.putFile(join(job.directory, `file-${index}`), asset.originalName ?? `${item.assetId}${extension}`, asset.mediaType ?? "application/octet-stream");
            ctx.poolStore.keepPendingUpload(attempt, result.key); uploads.push({ attempt, key: result.key });
            (row as unknown[])[column] = JSON.stringify({ ...asset, sizeBytes: item.bytes, storageRefs: [{ sourceId: POOL_SOURCE_ID, sourceRef: result.key, mediaType: asset.mediaType, contentHash: hash }] });
          } catch (error) {
            if (error instanceof StoragePoolError && !error.uncertain) ctx.poolStore.releaseUploadReservation(attempt);
            else ctx.poolStore.keepPendingUpload(attempt, error instanceof StoragePoolError ? error.pendingKey : undefined);
            throw error;
          }
        } else {
          if (!root) throw new Error("回收站原件需要本地原件目录");
          const relative = item.trash ? trashPathFor(ref)! : ref;
          const destination = join(root, relative);
          // Every generated destination is within the configured root; never overwrite a prior original.
          if (!resolve(destination).startsWith(resolve(root) + sep)) throw new Error("导入原件路径越界");
          await mkdir(join(destination, ".."), { recursive: true });
          const canonicalRoot = await realpath(root), canonicalParent = await realpath(join(destination, ".."));
          if (!canonicalParent.startsWith(canonicalRoot + sep)) throw new Error("导入原件路径越界");
          await copyFile(join(job.directory, `file-${index}`), destination, 1); writes.push(destination);
          (row as unknown[])[column] = JSON.stringify({ ...asset, sizeBytes: item.bytes, storageRefs: [{ sourceId: "local", sourceRef: ref, mediaType: asset.mediaType, contentHash: hash }] });
          if (item.trash) (row as unknown[])[table.columns.indexOf("relative_path")] = ref;
        }
      }
      // Make every remote file readable before publishing its reference. If the DB CAS fails,
      // only these newly uploaded objects are compensated; old originals are never deleted.
      for (const upload of uploads) ctx.poolStore!.completeUpload(upload.attempt, upload.key);
      // Single transaction with compare-and-swap; concurrent edits refuse the replacement.
      ctx.repository.restorePortableSpace(tables, job.targetFingerprint);
      committed = true;
      job.phase = "ready";
      await this.remove(id).catch(() => {});
      return { backup };
    } catch (error) {
      if (!committed) {
        for (const destination of writes) await rm(destination, { force: true });
        for (const upload of uploads) {
          try { await ctx.poolBridge.delete(upload.key); ctx.poolStore!.discardConfirmedArchiveUpload(upload.attempt, upload.key); }
          catch { /* Keep the charged pending/ready object for administrator reconciliation. */ }
        }
      }
      job.phase = "ready";
      throw error;
    } finally { this.#busy = false; active--; if (job.controller.signal.aborted) await rm(job.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  }
}

const MIME_EXTENSIONS: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/heic": ".heic", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg", "video/mp4": ".mp4", "video/webm": ".webm", "application/pdf": ".pdf" };
function mediaTypeOf(asset: Asset): string { return baseMediaType(asset.mediaType) || baseMediaType(asset.storageRefs.find(ref => ref.mediaType)?.mediaType) || ASSET_MEDIA_TYPES[extname(asset.storageRefs[0]?.sourceRef ?? "").toLowerCase()] || "application/octet-stream"; }
function extensionFor(mime: string | undefined): string { return MIME_EXTENSIONS[mime ?? ""] ?? ".bin"; }
async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> { const hash = createHash("sha256"); let bytes = 0; for await (const chunk of createReadStream(file)) { bytes += chunk.length; hash.update(chunk); } return { bytes, sha256: hash.digest("hex") }; }
