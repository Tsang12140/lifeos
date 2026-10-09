import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, openAsBlob, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { MP4, BlobSource, Input } from "mediabunny";
import { VIDEO_LIMITS, assertValidAsset, type Asset, type ContentHash, type VideoMetadata } from "@lifeos/core";
import { HttpError, setJson } from "./http-kit.js";
import { nowInstant } from "./field-validate.js";
import { baseMediaType, resolveAssetOriginal, uploadOriginalName } from "./asset-static.js";
import { StoragePoolError, POOL_SOURCE_ID } from "./storage-pool.js";
import { downloadPoolAsset, poolObjectFor } from "./routes-assets.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

export async function readVideoMetadata(file: string): Promise<VideoMetadata> {
  const input = new Input({ source: new BlobSource(await openAsBlob(file)), formats: [MP4] });
  try {
    const videos = await input.getVideoTracks(), audios = await input.getAudioTracks();
    if (videos.length !== 1 || audios.length > 1 || await videos[0]!.getCodec() !== "avc" || (audios[0] && await audios[0].getCodec() !== "aac")) throw new Error("unsupported_tracks");
    const track = videos[0]!;
    const [width, height, durationSeconds, rates, hdr, format] = await Promise.all([
      track.getDisplayWidth(), track.getDisplayHeight(), input.computeDuration(), track.computeFrameRateMetrics({ targetPacketCount: Infinity }), track.hasHighDynamicRange(), input.getFormat(),
    ]);
    if (format !== MP4 || hdr || width < 2 || height < 2 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || Math.max(width, height) > VIDEO_LIMITS.maxLongEdge || Math.min(width, height) > VIDEO_LIMITS.maxShortEdge
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > VIDEO_LIMITS.maxDurationSeconds + 0.25
      || !Number.isFinite(rates.bestGuessFrameRate) || rates.bestGuessFrameRate <= 0 || !Number.isFinite(rates.maxFrameRate) || rates.maxFrameRate <= 0 || rates.maxFrameRate > VIDEO_LIMITS.maxFrameRate + 0.1) throw new Error("invalid_video_limits");
    return { version: 1, width, height, durationSeconds, frameRate: rates.bestGuessFrameRate, videoCodec: "avc", audioCodec: audios.length ? "aac" : null };
  } catch { throw new HttpError(415, "invalid_compressed_video", "请选择经压缩处理的 MP4 视频（最高1080p、30帧、3分钟，保留AAC声音）"); }
  finally { input.dispose(); }
}

async function receiveVideo(req: IncomingMessage, file: string): Promise<{ bytes: number; hash: ContentHash }> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > VIDEO_LIMITS.maxOutputBytes)) throw new HttpError(413, "video_too_large", "压缩后的视频最多50 MB");
  const handle = await open(file, "wx", 0o600), hash = createHash("sha256"); let bytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > VIDEO_LIMITS.maxOutputBytes) throw new HttpError(413, "video_too_large", "压缩后的视频最多50 MB");
      hash.update(buffer);
      // FileHandle.write may write fewer bytes than requested.
      for (let offset = 0; offset < buffer.length;) offset += (await handle.write(buffer, offset, buffer.length - offset)).bytesWritten;
    }
  } finally { await handle.close(); }
  if (!bytes) throw new HttpError(400, "empty_video", "视频文件为空");
  return { bytes, hash: { algorithm: "sha256", value: hash.digest("hex") } };
}

export function videoByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, "invalid_video_range", "视频读取范围无效");
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); end = size - 1; if (!suffix) start = size; }
  else { start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new HttpError(416, "invalid_video_range", "视频读取范围无效");
  return { start, end };
}

// A Safari range probe must not redownload the entire object on every request.
// Cache only compressed copies, isolate by repository/account, coalesce concurrent reads,
// and charge upstream traffic through downloadPoolAsset exactly when it occurs.
type Lease = { file: string; directory: string; bytes: number };
type CacheEntry = { owner: RouteContext["repository"]; key: string; bytes: number; pending: Promise<Lease>; lease?: Lease; users: number; stale: boolean; timer?: ReturnType<typeof setTimeout> };
const downloads = new Set<CacheEntry>();
function expire(entry: CacheEntry): void {
  entry.stale = true; clearTimeout(entry.timer);
  if (entry.users || !entry.lease) return;
  downloads.delete(entry); rmSync(entry.lease.directory, { recursive: true, force: true });
}
export function clearVideoDownloadCache(owner?: RouteContext["repository"]): void { for (const entry of downloads) if (!owner || entry.owner === owner) expire(entry); }
async function acquireVideo(ctx: RouteContext, asset: Asset): Promise<{ file: string; release: () => void }> {
  const reference = asset.storageRefs.find(ref => ref.sourceId === POOL_SOURCE_ID)!;
  poolObjectFor(ctx, asset, reference); // Recheck ownership/deletion even when cached.
  const key = `${ctx.poolAccountId}:${asset.id}:${reference.sourceRef}`;
  let entry = [...downloads].find(item => item.owner === ctx.repository && item.key === key && !item.stale);
  if (!entry) {
    const limit = 200 * 1024 * 1024;
    const occupied = () => [...downloads].reduce((sum, item) => sum + item.bytes, 0);
    for (const other of downloads) { if (occupied() + asset.sizeBytes! <= limit) break; if (!other.users && other.lease) expire(other); }
    if (occupied() + asset.sizeBytes! > limit) throw new HttpError(503, "video_cache_busy", "视频读取繁忙，请稍后重试");
    entry = { owner: ctx.repository, key, bytes: asset.sizeBytes!, users: 0, stale: false, pending: downloadPoolAsset(ctx, asset, reference) };
    downloads.add(entry);
    const current = entry;
    current.pending = current.pending.then(async lease => {
      current.lease = lease;
      if (reference.contentHash) {
        const hash = createHash("sha256"); for await (const chunk of createReadStream(lease.file)) hash.update(chunk);
        if (hash.digest("hex") !== reference.contentHash.value) throw new HttpError(502, "video_hash_mismatch", "云端视频校验失败，请重试或联系管理员");
      }
      current.timer = setTimeout(() => expire(current), 120_000); current.timer.unref();
      return lease;
    }).catch(error => { expire(current); downloads.delete(current); throw error; });
  }
  entry.users++;
  const current = entry;
  try {
    const lease = await current.pending;
    return { file: lease.file, release: () => { current.users--; if (current.stale) expire(current); } };
  } catch (error) { current.users--; expire(current); throw error; }
}

export const handleVideoRoutes: RouteHandler = async (ctx, req, res, pathname, url) => {
  if (pathname === "/api/assets/videos" && req.method === "POST") {
    if (baseMediaType(req.headers["content-type"]) !== "video/mp4") throw new HttpError(415, "video_media_type", "只接收压缩后的MP4视频");
    if (!ctx.poolBridge.enabled && !ctx.config.assetRoot) throw new HttpError(503, "video_storage_unavailable", "视频存储尚未配置");
    const directory = mkdtempSync(join(tmpdir(), "lifeos-video-upload-")), file = join(directory, "compressed.mp4");
    let attempt: string | undefined, returnedKey: string | undefined;
    try {
      const received = await receiveVideo(req, file), videoMetadata = await readVideoMetadata(file);
      const existing = ctx.repository.findAssetByContentHash("sha256", received.hash.value);
      if (existing?.kind === "video") {
        const ref = existing.storageRefs.find(item => item.sourceId === POOL_SOURCE_ID); if (ref) poolObjectFor(ctx, existing, ref);
        const asset = { ...existing, lastUsedAt: nowInstant() }; ctx.repository.updateAsset(asset); setJson(res, 201, asset); return true;
      }
      const id = `asset_${randomUUID()}`, originalName = uploadOriginalName(url.searchParams.get("name")) ?? "视频.mp4";
      let sourceId: string, sourceRef: string;
      // New videos go straight to the quota-governed pool, even during historical photo migration.
      if (ctx.poolBridge.enabled) {
        if (!ctx.poolStore) throw new HttpError(503, "storage_pool_unavailable", "存储池尚未就绪");
        const readiness = await ctx.poolPreflight();
        attempt = ctx.poolStore.reserveUpload(ctx.poolAccountId, id, received.bytes, readiness.storageFreeBytes);
        const uploaded = await ctx.poolBridge.putFile(file, originalName, "video/mp4"); returnedKey = uploaded.key;
        ctx.poolStore.keepPendingUpload(attempt, returnedKey); sourceId = POOL_SOURCE_ID; sourceRef = returnedKey;
      } else {
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
        const relative = `uploads/${day.slice(0, 4)}/${day.slice(5, 7)}`;
        mkdirSync(join(ctx.config.assetRoot!, relative), { recursive: true });
        sourceId = "local"; sourceRef = `${relative}/${received.hash.value}.mp4`;
        try { copyFileSync(file, join(ctx.config.assetRoot!, sourceRef), constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const asset: Asset = { id, kind: "video", mediaType: "video/mp4", originalName, sizeBytes: received.bytes, videoMetadata, createdAt: nowInstant(), storageRefs: [{ sourceId, sourceRef, mediaType: "video/mp4", contentHash: received.hash }] };
      assertValidAsset(asset); ctx.repository.insertAsset(asset);
      if (attempt && returnedKey) ctx.poolStore!.completeUpload(attempt, returnedKey);
      setJson(res, 201, asset); return true;
    } catch (error) {
      if (attempt) {
        if (returnedKey || (error instanceof StoragePoolError && error.uncertain)) ctx.poolStore!.keepPendingUpload(attempt, returnedKey ?? (error instanceof StoragePoolError ? error.pendingKey : undefined));
        else if (error instanceof StoragePoolError) ctx.poolStore!.releaseUploadReservation(attempt);
        else ctx.poolStore!.keepPendingUpload(attempt);
      }
      if (error instanceof HttpError) throw error;
      if (error instanceof Error && error.message.includes("额度不足")) throw new HttpError(409, "pool_quota_exceeded", error.message);
      throw new HttpError(503, "video_upload_failed", "视频保存失败，云端状态可能需要管理员核对");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const match = /^\/api\/assets\/([^/]+)\/(?:video|content)$/.exec(pathname);
  if (!match || !["GET", "HEAD"].includes(req.method ?? "")) return false;
  const asset = ctx.repository.findAssetById(decodeURIComponent(match[1]!));
  if (asset?.kind !== "video") return false;
  const size = asset.sizeBytes!;
  const etag = `"${asset.storageRefs[0]?.contentHash?.value ?? asset.id}"`;
  const headers: Record<string, string> = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, no-store", etag, "content-disposition": "inline" };
  const remote = asset.storageRefs.find(ref => ref.sourceId === POOL_SOURCE_ID);
  if (remote) poolObjectFor(ctx, asset, remote);
  if (req.headers["if-none-match"] === etag && !req.headers.range) { res.writeHead(304, headers); res.end(); return true; }
  let range: ReturnType<typeof videoByteRange>;
  try { range = videoByteRange(req.headers["if-range"] && req.headers["if-range"] !== etag ? undefined : req.headers.range, size); }
  catch { res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": "0" }); res.end(); return true; }
  headers["content-length"] = String(range ? range.end - range.start + 1 : size);
  if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
  headers["x-lifeos-asset-source"] = remote ? "pool" : "local";
  if (req.method === "HEAD") { res.writeHead(range ? 206 : 200, headers); res.end(); return true; }
  let release = () => {};
  try {
    const resolved = remote ? await acquireVideo(ctx, asset) : resolveAssetOriginal(ctx.config, ctx.repository, asset.id);
    if ("release" in resolved) release = resolved.release;
    if (!existsSync(resolved.file) || statSync(resolved.file).size !== size) throw new HttpError(404, "video_missing", "压缩视频文件不可用");
    res.writeHead(range ? 206 : 200, headers);
    await pipeline(createReadStream(resolved.file, range ?? undefined), res).catch(error => { if (!res.destroyed) throw error; });
  } finally { release(); }
  return true;
};
