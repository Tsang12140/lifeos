import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  RELATION_KINDS,
  assertValidAsset,
  assertValidStorageReference,
  type Asset,
  type AssetKind,
  type AssetLink,
  type AssetRole,
  type ContentHash,
  type RelationKind,
  type StorageReference,
} from "@lifeos/core";
import { HttpError, setJson, setEmpty, backupHttpError } from "./http-kit.js";
import { readBody, readRawBody, requireJsonContentType } from "./http-body.js";
import {
  coreValidated,
  enumField,
  hasOnlyKeys,
  jsonObject,
  nowInstant,
  stringField,
} from "./field-validate.js";
import {
  aliasesField,
  arrayField,
  assetRefsField,
  contentDisposition,
  decodeSegment,
  requireAssetRoot,
  safeId,
  sizeBytesField,
  storageRefsField,
} from "./record-builders.js";
import { buildAsset } from "./movie-input.js";
import { withRelation, withoutRelation } from "./movie-input.js";
import {
  ASSET_MEDIA_TYPES,
  ASSET_UPLOAD_FORMATS,
  THUMBNAILABLE_ASSET_EXTENSIONS,
  baseMediaType,
  resolveAssetOriginal,
  storeUploadedPhoto,
  uploadOriginalName,
} from "./asset-static.js";
import {
  isCollectableAsset,
  planUnreferencedUploads,
  purgeTrashedAsset,
  resolveWithinRoot,
  restoreTrashedAsset,
  trashAsset,
  trashDaysRemaining,
  trashPathFor,
} from "./asset-gc.js";
import { nextAssetGcAt } from "./asset-gc-scheduler.js";
import { THUMBNAIL_FORMAT, THUMBNAIL_WIDTHS, parseThumbnailWidth } from "./derived-thumbs.js";
import type { RouteContext, RouteHandler } from "./route-context.js";
import { POOL_SOURCE_ID, StoragePoolError } from "./storage-pool.js";
import type { PoolObjectRow } from "./storage-pool-store.js";

const ASSET_KINDS: readonly AssetKind[] = ["photo", "audio", "file"];
const ASSET_ROLES: readonly AssetRole[] = ["photo", "recording", "attachment"];

function isPoolReference(reference: StorageReference): boolean {
  return reference.sourceId === POOL_SOURCE_ID;
}

function poolObjectFor(ctx: RouteContext, asset: Asset, reference: StorageReference): PoolObjectRow {
  if (ctx.poolStore === null) throw new HttpError(503, "storage_pool_unavailable", "存储池尚未就绪");
  const object = ctx.poolStore.poolObject(ctx.poolAccountId, asset.id, reference.sourceRef);
  if (object === null || object.state !== "ready") throw new HttpError(404, "pool_asset_unavailable", "存储池文件不存在或正在核对");
  if (asset.sizeBytes !== undefined && asset.sizeBytes !== object.bytes) {
    throw new HttpError(409, "pool_asset_accounting_mismatch", "文件大小与存储池账目不一致");
  }
  return object;
}

interface DownloadedPoolAsset {
  readonly directory: string;
  readonly file: string;
  readonly bytes: number;
}

async function downloadPoolAsset(ctx: RouteContext, asset: Asset, reference: StorageReference): Promise<DownloadedPoolAsset> {
  if (ctx.poolStore === null || !ctx.poolBridge.enabled) throw new HttpError(503, "storage_pool_unavailable", "存储池尚未启用");
  const readiness = await ctx.poolPreflight();
  const object = poolObjectFor(ctx, asset, reference);
  let directory: string;
  try { directory = mkdtempSync(join(tmpdir(), "lifeos-pool-download-")); }
  catch { throw new HttpError(500, "pool_temp_unavailable", "无法准备临时下载文件"); }
  const file = join(directory, "original.bin");
  let reservation: { readonly id: string; readonly bytes: number } | undefined;
  let settled = false;
  try {
    reservation = ctx.poolStore.reserveDownload(ctx.poolAccountId, asset.id, reference.sourceRef, readiness.month, readiness.trafficFreeBytes);
    const result = await ctx.poolBridge.downloadToFile(reference.sourceRef, file);
    if (result.bytes !== object.bytes) {
      ctx.poolStore.markDownloadUncertain(reservation.id);
      settled = true;
      throw new HttpError(502, "pool_download_size_mismatch", "下载大小与文件账目不一致，流量预留待核对");
    }
    ctx.poolStore.finishDownload(reservation.id, result.month, result.bytes);
    settled = true;
    return { directory, file, bytes: result.bytes };
  } catch (error) {
    if (reservation !== undefined && !settled) {
      if (error instanceof StoragePoolError && error.uncertain) ctx.poolStore.markDownloadUncertain(reservation.id);
      else ctx.poolStore.refundDownload(reservation.id);
    }
    rmSync(directory, { recursive: true, force: true });
    if (error instanceof HttpError) throw error;
    if (error instanceof StoragePoolError) {
      throw new HttpError(error.status, error.code === "quota_exceeded" ? "pool_quota_exceeded" : "pool_download_failed", error.code === "quota_exceeded" ? "存储池项目额度不足" : "存储池下载失败");
    }
    if (error instanceof Error && error.message.includes("额度不足")) {
      throw new HttpError(409, "pool_quota_exceeded", error.message);
    }
    throw new HttpError(503, "pool_download_failed", "存储池下载失败，额度状态待核对");
  }
}

function poolOperationHttpError(error: unknown, operation: string): HttpError {
  if (error instanceof StoragePoolError) {
    const status = error.code === "quota_exceeded" ? 409 : error.status;
    return new HttpError(status, error.code === "quota_exceeded" ? "pool_quota_exceeded" : `pool_${operation}_failed`, error.code === "quota_exceeded" ? "存储池项目额度不足" : "存储池操作失败，状态待核对");
  }
  return new HttpError(503, `pool_${operation}_failed`, "存储池操作失败，状态待核对");
}

export const handleAssetsRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository, thumbnails } = ctx;


  if (pathname === "/api/assets" && req.method === "GET") {
    const kindRaw = url.searchParams.get("kind");
    const kind = kindRaw === null || kindRaw === "" ? undefined : enumField(kindRaw, ASSET_KINDS, "kind");
    setJson(res, 200, { items: repository.listAssets(kind === undefined ? {} : { kind }) });
    return true;
  }
  if (pathname === "/api/assets" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["id", "kind", "storageRefs", "originalName", "mediaType", "sizeBytes"]);
    const id = input.id === undefined ? `asset_${randomUUID()}` : stringField(input.id, "id", { nonEmpty: true });
    if (repository.findAssetById(id) !== null) throw new HttpError(409, "asset_exists", `Asset already exists: ${id}`);
    const storageRefs = storageRefsField(input.storageRefs);
    if (storageRefs.some(isPoolReference)) throw new HttpError(400, "pool_reference_forbidden", "存储池对象只能由受额度校验的上传流程登记");
    const asset = buildAsset(input, id, storageRefs);
    repository.insertAsset(asset);
    setJson(res, 201, asset);
    return true;
  }
  // A photo dropped onto the composer arrives as raw bytes, not JSON, so it
  // gets its own route with its own size limit. Everything else about assets
  // stays reference-based: this route is the only place LifeOS writes a file.
  if (pathname === "/api/assets/uploads" && req.method === "POST") {
    if (!ctx.poolBridge.enabled && config.assetRoot === undefined) {
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
      const existingPoolRef = existing.storageRefs.find(isPoolReference);
      if (existingPoolRef !== undefined) poolObjectFor(ctx, existing, existingPoolRef);
      // Taking the photo back into use moves the collector's anchor forward,
      // so the grace period restarts from now -- the same rule /resolve uses.
      const reused: Asset = { ...existing, lastUsedAt: nowInstant() };
      repository.updateAsset(reused);
      setJson(res, 201, reused);
      return true;
    }
    const originalName = uploadOriginalName(url.searchParams.get("name"));
    if (ctx.poolBridge.enabled) {
      if (ctx.poolStore === null) throw new HttpError(503, "storage_pool_unavailable", "存储池尚未就绪");
      const readiness = await ctx.poolPreflight();
      const assetId = `asset_${randomUUID()}`;
      let directory: string;
      try { directory = mkdtempSync(join(tmpdir(), "lifeos-pool-upload-")); }
      catch { throw new HttpError(500, "pool_temp_unavailable", "无法准备临时上传文件"); }
      const localPath = join(directory, `upload${format.extension}`);
      let attemptId: string | undefined;
      let returnedKey: string | undefined;
      try {
        writeFileSync(localPath, bytes, { flag: "wx", mode: 0o600 });
        attemptId = ctx.poolStore.reserveUpload(ctx.poolAccountId, assetId, bytes.length, readiness.storageFreeBytes);
        const uploaded = await ctx.poolBridge.putFile(localPath, originalName ?? assetId + format.extension, mediaType);
        returnedKey = uploaded.key;
        ctx.poolStore.keepPendingUpload(attemptId, returnedKey);
        const poolRef = coreValidated("storageRefs", () => {
          const candidate: StorageReference = { sourceId: POOL_SOURCE_ID, sourceRef: returnedKey!, mediaType, contentHash };
          assertValidStorageReference(candidate, "storageRefs[0]");
          return candidate;
        });
        const asset = buildAsset(
          { kind: "photo", mediaType, sizeBytes: bytes.length, ...(originalName === undefined ? {} : { originalName }) },
          assetId,
          [poolRef],
        );
        repository.insertAsset(asset);
        ctx.poolStore.completeUpload(attemptId, returnedKey);
        setJson(res, 201, asset);
        return true;
      } catch (error) {
        if (attemptId !== undefined) {
          if (returnedKey !== undefined) {
            try { ctx.poolStore.keepPendingUpload(attemptId, returnedKey); } catch { /* Preserve the existing reservation for admin review. */ }
          } else if (error instanceof StoragePoolError && !error.uncertain) {
            ctx.poolStore.releaseUploadReservation(attemptId);
          } else if (error instanceof StoragePoolError && error.pendingKey !== undefined) {
            try { ctx.poolStore.keepPendingUpload(attemptId, error.pendingKey); } catch { /* Preserve reservation. */ }
          } else {
            try { ctx.poolStore.keepPendingUpload(attemptId); } catch { /* Preserve reservation. */ }
          }
        }
        if (error instanceof HttpError) throw error;
        if (error instanceof StoragePoolError) throw poolOperationHttpError(error, "upload");
        if (error instanceof Error && error.message.includes("额度不足")) throw new HttpError(409, "pool_quota_exceeded", error.message);
        throw new HttpError(503, "pool_upload_pending", "存储池上传状态待核对，额度预留已保留");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    if (config.assetRoot === undefined) throw new HttpError(404, "asset_root_not_configured", "Set LIFEOS_ASSET_ROOT to store local originals");
    let sourceRef: string;
    try {
      // The digest goes into the path, so the file lands under a name that is
      // the picture's own identity rather than a fresh UUID: a second copy of
      // these bytes cannot be written under a different name later on.
      sourceRef = storeUploadedPhoto(config.assetRoot, bytes, format, contentHash.value);
    } catch {
      throw new HttpError(500, "asset_write_failed", "Could not write the photo into LIFEOS_ASSET_ROOT");
    }
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
    return true;
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
      return true;
    }
    const matchPoolRef = match.storageRefs.find(isPoolReference);
    if (matchPoolRef !== undefined) poolObjectFor(ctx, match, matchPoolRef);
    // Reusing an upload puts the photo back in use, so the orphan collector's
    // anchor moves forward and the grace period restarts from now.
    const reused: Asset = { ...match, lastUsedAt: nowInstant() };
    repository.updateAsset(reused);
    setJson(res, 200, { matched: true, asset: reused });
    return true;
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
    return true;
  }
  if (pathname === "/api/assets/thumbnails" && req.method === "DELETE") {
    const cleared = thumbnails.clear();
    setJson(res, 200, { removed: cleared.removed, freedBytes: cleared.freedBytes });
    return true;
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
    return true;
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
      return true;
    }
    if (assetTrashMatch[2] === undefined && req.method === "DELETE") {
      requireJsonContentType(req, true);
      if (!purgeTrashedAsset(config, repository, trashedId)) {
        throw new HttpError(404, "not_found", "Nothing to delete for this asset");
      }
      setEmpty(res, 204);
      return true;
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
      const poolReference = existing.storageRefs.find(isPoolReference);
      if (poolReference !== undefined) {
        if (ctx.poolStore === null || !ctx.poolBridge.enabled) throw new HttpError(503, "storage_pool_unavailable", "存储池不可用，文件未删除");
        poolObjectFor(ctx, existing, poolReference);
        const deleting = ctx.poolStore.beginDelete(ctx.poolAccountId, existing.id, poolReference.sourceRef);
        if (deleting === null) throw new HttpError(409, "pool_delete_pending", "文件正在删除或需要管理员核对");
        try {
          await ctx.poolBridge.delete(poolReference.sourceRef);
          if (!repository.deleteAsset(id)) throw new Error("asset_metadata_delete_failed");
          ctx.poolStore.finishDelete(deleting.attemptId);
        } catch (error) {
          // Once remote deletion starts, retain the deleting reservation until
          // an administrator reconciles the object and mapping.
          if (error instanceof HttpError) throw error;
          throw poolOperationHttpError(error, "delete");
        }
        setEmpty(res, 204);
        return true;
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
      return true;
    }
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["storageRefs", "originalName", "mediaType", "sizeBytes"]);
    if (input.storageRefs !== undefined) {
      const replacementRefs = storageRefsField(input.storageRefs);
      if (existing.storageRefs.some(isPoolReference) || replacementRefs.some(isPoolReference)) {
        throw new HttpError(409, "pool_reference_immutable", "存储池文件引用只能由受校验的存储池操作管理");
      }
    }
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
    return true;
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
    return true;
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
      return true;
    }
    const updatedTarget = withoutRelation(target, sourceId);
    repository.writeEntities([updatedSource, updatedTarget]);
    setJson(res, 200, { source: updatedSource, target: updatedTarget });
    return true;
  }
  const assetContentMatch = /^\/api\/assets\/([^/]+)\/content$/.exec(pathname);
  if (assetContentMatch !== null && req.method === "GET") {
    const id = decodeSegment(assetContentMatch[1]!);
    const asset = repository.findAssetById(id);
    if (asset === null) throw new HttpError(404, "not_found", "Asset not found");
    const poolReference = asset.storageRefs.find(isPoolReference);
    if (poolReference !== undefined) {
      const downloaded = await downloadPoolAsset(ctx, asset, poolReference);
      try {
        const mediaType = asset.mediaType ?? poolReference.mediaType ?? "application/octet-stream";
        res.writeHead(200, {
          "content-type": mediaType,
          "content-length": String(downloaded.bytes),
          "cache-control": "private, max-age=300",
          "content-disposition": "inline",
        });
        res.end(readFileSync(downloaded.file));
      } finally { rmSync(downloaded.directory, { recursive: true, force: true }); }
      return true;
    }
    const resolved = resolveAssetOriginal(config, repository, id);
    res.writeHead(200, {
      "content-type": resolved.mediaType,
      "content-length": String(statSync(resolved.file).size),
      "cache-control": "private, max-age=300",
      "content-disposition": "inline",
    });
    res.end(readFileSync(resolved.file));
    return true;
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
    const id = decodeSegment(assetThumbnailMatch[1]!);
    const asset = repository.findAssetById(id);
    if (asset === null) throw new HttpError(404, "not_found", "Asset not found");
    const poolReference = asset.storageRefs.find(isPoolReference);
    let file: string;
    if (poolReference !== undefined) {
      poolObjectFor(ctx, asset, poolReference);
      const cached = thumbnails.cached(poolReference, width);
      if (cached !== null) file = cached;
      else {
        const mime = asset.mediaType ?? poolReference.mediaType ?? "";
        const extension = Object.entries(ASSET_MEDIA_TYPES).find(([, value]) => value === mime)?.[0];
        if (extension === undefined || !THUMBNAILABLE_ASSET_EXTENSIONS.has(extension)) {
          throw new HttpError(415, "unsupported_thumbnail_type", "A thumbnail can only be derived from a raster image");
        }
        const downloaded = await downloadPoolAsset(ctx, asset, poolReference);
        try {
          file = await thumbnails.ensure(poolReference, downloaded.file, width);
        } catch {
          throw new HttpError(500, "thumbnail_failed", "Could not derive a thumbnail from this original");
        } finally { rmSync(downloaded.directory, { recursive: true, force: true }); }
      }
    } else {
      const original = resolveAssetOriginal(config, repository, id);
      if (!THUMBNAILABLE_ASSET_EXTENSIONS.has(extname(original.file).toLowerCase())) {
        throw new HttpError(415, "unsupported_thumbnail_type", "A thumbnail can only be derived from a raster image");
      }
      try { file = await thumbnails.ensure(original.reference, original.file, width); }
      catch { throw new HttpError(500, "thumbnail_failed", "Could not derive a thumbnail from this original"); }
    }
    res.writeHead(200, {
      "content-type": `image/${THUMBNAIL_FORMAT}`,
      "content-length": String(statSync(file).size),
      "cache-control": "private, max-age=300",
      "content-disposition": "inline",
    });
    res.end(readFileSync(file));
    return true;
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
    return true;
  }

  return false;
};
