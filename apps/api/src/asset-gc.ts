import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Asset, StorageReference } from "@lifeos/core";
import type { ApiConfig } from "./config.js";
import type { AssetTrashEntry, AssetTrashOrigin, SqliteRecordRepository } from "./repository.js";

/**
 * Photos dropped onto the composer are *copied* into the asset root, so an
 * upload that never becomes part of a record is a file LifeOS owns and may
 * reclaim. Everything else in the asset root belongs to the owner: the only
 * paths this module ever moves or deletes are ones under `uploads/`.
 *
 * The rule set is deliberately three conditions wide — ours, unreferenced,
 * past the grace period — because a false positive destroys a photo, while a
 * false negative merely keeps a file for another day.
 */

/** LifeOS writes every dropped photo below this prefix and nothing else. */
export const ASSET_UPLOAD_PREFIX = "uploads/";
/** Collected files wait here, still restorable, before the final delete. */
export const ASSET_TRASH_SEGMENT = "_orphan-trash";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizeRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

/** A relative path is usable only when it cannot climb out of the asset root. */
function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath === "" || relativePath.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(relativePath)) return false;
  return relativePath.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * True only for references LifeOS wrote itself: a local source under `uploads/`,
 * not already parked in the trash. Reference-style assets that point at the
 * owner's own photo library never qualify, which is what keeps this whole
 * feature from ever deleting a photo the owner put there by hand.
 */
export function isOwnedUploadReference(reference: StorageReference): boolean {
  if (reference.sourceId !== "local") return false;
  const normalized = normalizeRelative(reference.sourceRef);
  if (!normalized.startsWith(ASSET_UPLOAD_PREFIX)) return false;
  if (normalized.startsWith(`${ASSET_UPLOAD_PREFIX}${ASSET_TRASH_SEGMENT}/`)) return false;
  return isSafeRelativePath(normalized);
}

/**
 * An asset is collectable only when *every* reference is our own upload. A
 * mixed asset is left alone: reclaiming half of it would break the record that
 * still needs the other half.
 */
export function isCollectableAsset(asset: Asset): boolean {
  return asset.storageRefs.length > 0 && asset.storageRefs.every(isOwnedUploadReference);
}

/** `uploads/2026/09/a.jpg` → `uploads/_orphan-trash/2026/09/a.jpg`. */
export function trashPathFor(relativePath: string): string | null {
  const normalized = normalizeRelative(relativePath);
  if (!isOwnedUploadReference({ sourceId: "local", sourceRef: normalized })) return null;
  return `${ASSET_UPLOAD_PREFIX}${ASSET_TRASH_SEGMENT}/${normalized.slice(ASSET_UPLOAD_PREFIX.length)}`;
}

/** The inverse of `trashPathFor`, used when a collected file is put back. */
export function originalPathFor(trashedRelativePath: string): string | null {
  const normalized = normalizeRelative(trashedRelativePath);
  const trashPrefix = `${ASSET_UPLOAD_PREFIX}${ASSET_TRASH_SEGMENT}/`;
  if (!normalized.startsWith(trashPrefix)) return null;
  const restored = `${ASSET_UPLOAD_PREFIX}${normalized.slice(trashPrefix.length)}`;
  return isSafeRelativePath(restored) ? restored : null;
}

/** Resolves a verified relative path inside the root, refusing anything outside. */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  const base = resolve(root);
  const full = resolve(base, normalizeRelative(relativePath));
  if (full === base || !full.startsWith(base + sep)) return null;
  return full;
}

export interface UnreferencedUpload {
  readonly asset: Asset;
  /** The moment this upload becomes collectable. */
  readonly dueAt: Date;
  /** Whole days left before that happens, floored at zero. */
  readonly daysRemaining: number;
  /** Already past the grace period — the next pass will collect it. */
  readonly overdue: boolean;
}

/**
 * When this upload's grace period started counting.
 *
 * `lastUsedAt` wins over `createdAt` because a photo re-dropped from identical
 * bytes is genuinely in use again: without that, the same bytes dropped on day
 * six would still be collected on day seven, and content-hash reuse would have
 * quietly shortened a photo's life.
 */
function graceAnchorOf(asset: Asset): number | null {
  const raw = asset.lastUsedAt?.value ?? asset.createdAt?.value;
  if (raw === undefined) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Uploads that no record points at, each with the moment it becomes
 * collectable.
 *
 * `referencedAssetIds` must include soft-deleted records: a record sitting in
 * the recycle bin can still be restored, and its photos have to survive that.
 * An asset without a usable time to anchor on is skipped rather than guessed at.
 */
export function planUnreferencedUploads(
  assets: readonly Asset[],
  referencedAssetIds: ReadonlySet<string>,
  now: Date,
  graceDays: number,
): readonly UnreferencedUpload[] {
  const uploads: UnreferencedUpload[] = [];
  for (const asset of assets) {
    if (referencedAssetIds.has(asset.id)) continue;
    if (!isCollectableAsset(asset)) continue;
    const anchor = graceAnchorOf(asset);
    if (anchor === null) continue;
    const dueAt = new Date(anchor + graceDays * MS_PER_DAY);
    const remainingMs = dueAt.getTime() - now.getTime();
    uploads.push({
      asset,
      dueAt,
      daysRemaining: Math.max(0, Math.ceil(remainingMs / MS_PER_DAY)),
      overdue: remainingMs <= 0,
    });
  }
  return uploads;
}

/** Trash entries whose month of regret has run out. */
export function planTrashPurge(
  entries: readonly AssetTrashEntry[],
  now: Date,
  trashDays: number,
): readonly AssetTrashEntry[] {
  return entries.filter((entry) => {
    if (entry.restoredAt !== undefined || entry.purgedAt !== undefined) return false;
    const trashedAt = Date.parse(entry.trashedAt);
    if (!Number.isFinite(trashedAt)) return false;
    return now.getTime() - trashedAt >= trashDays * MS_PER_DAY;
  });
}

/** Whole days left before a collected file is deleted for good. */
export function trashDaysRemaining(entry: AssetTrashEntry, now: Date, trashDays: number): number {
  const trashedAt = Date.parse(entry.trashedAt);
  if (!Number.isFinite(trashedAt)) return 0;
  return Math.max(0, Math.ceil((trashedAt + trashDays * MS_PER_DAY - now.getTime()) / MS_PER_DAY));
}

/** Instants go into SQLite as plain ISO strings, exactly like backup runs. */
function instantOf(value: Date): string {
  return value.toISOString();
}

/** Moves one file inside the root. Returns false when there was nothing to move. */
function moveWithinRoot(root: string, from: string, to: string): boolean {
  const source = resolveWithinRoot(root, from);
  const target = resolveWithinRoot(root, to);
  if (source === null || target === null) return false;
  // A file the owner already removed by hand is not an error: the asset row is
  // stale, and the caller still needs to retire it.
  if (!existsSync(source)) return false;
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(source, target);
  } catch {
    copyFileSync(source, target);
    rmSync(source, { force: true });
  }
  return true;
}

/**
 * Moves every reference of an asset into the trash, records the collection,
 * and retires the asset row. Files that are already gone are skipped, so a
 * stale row is cleaned up instead of retried forever.
 */
export function trashAsset(
  root: string,
  repository: SqliteRecordRepository,
  asset: Asset,
  origin: AssetTrashOrigin,
  now: Date,
): void {
  for (const reference of asset.storageRefs) {
    const target = trashPathFor(reference.sourceRef);
    if (target === null) continue;
    moveWithinRoot(root, reference.sourceRef, target);
  }
  repository.insertAssetTrash({
    asset,
    trashedAt: instantOf(now),
    origin,
    relativePath: asset.storageRefs[0]!.sourceRef,
  });
  repository.deleteAsset(asset.id);
}

export interface AssetGcReport {
  readonly collected: readonly string[];
  readonly purged: readonly string[];
  readonly failed: readonly string[];
}

/**
 * One full pass of the collector: move unreferenced uploads past their grace
 * period into the trash, then delete whatever has been sitting there longer
 * than `trashDays`.
 *
 * Both halves are best-effort per asset — a single unreadable file must not
 * stop the rest of the pass, and the caller gets the ids back so a failure is
 * visible instead of silent.
 */
export function runAssetGc(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  now: Date = new Date(),
): AssetGcReport {
  const root = config.assetRoot;
  if (root === undefined) return { collected: [], purged: [], failed: [] };

  const collected: string[] = [];
  const purged: string[] = [];
  const failed: string[] = [];

  const uploads = planUnreferencedUploads(
    repository.listAssets(),
    repository.referencedAssetIds(),
    now,
    config.assetOrphanGraceDays,
  );
  for (const upload of uploads) {
    if (!upload.overdue) continue;
    try {
      trashAsset(root, repository, upload.asset, "orphan-scan", now);
      collected.push(upload.asset.id);
    } catch {
      failed.push(upload.asset.id);
    }
  }

  for (const entry of planTrashPurge(repository.listAssetTrash(), now, config.assetTrashDays)) {
    try {
      if (purgeTrashedAsset(config, repository, entry.asset.id, now)) purged.push(entry.asset.id);
    } catch {
      failed.push(entry.asset.id);
    }
  }

  return { collected, purged, failed };
}

/**
 * Deletes a collected file for good, either because its month ran out or
 * because the owner asked. The trash row stays behind as the audit trail of
 * what was removed and when.
 */
export function purgeTrashedAsset(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  assetId: string,
  now: Date = new Date(),
): boolean {
  const root = config.assetRoot;
  if (root === undefined) return false;
  const entry = repository.findAssetTrash(assetId);
  if (entry === null || entry.restoredAt !== undefined || entry.purgedAt !== undefined) return false;
  const trashed = trashPathFor(entry.relativePath);
  if (trashed !== null) {
    const target = resolveWithinRoot(root, trashed);
    if (target !== null) rmSync(target, { force: true });
  }
  repository.markAssetTrashPurged(assetId, instantOf(now));
  return true;
}

/**
 * Puts a collected file back where it was and re-registers its asset row, so a
 * record can reference it again. Returns false when there is nothing to undo.
 */
export function restoreTrashedAsset(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  assetId: string,
  now: Date = new Date(),
): boolean {
  const root = config.assetRoot;
  if (root === undefined) return false;
  const entry = repository.findAssetTrash(assetId);
  if (entry === null || entry.restoredAt !== undefined || entry.purgedAt !== undefined) return false;
  const trashed = trashPathFor(entry.relativePath);
  if (trashed !== null) moveWithinRoot(root, trashed, entry.relativePath);
  if (repository.findAssetById(entry.asset.id) === null) repository.insertAsset(entry.asset);
  else repository.updateAsset(entry.asset);
  repository.markAssetTrashRestored(assetId, instantOf(now));
  return true;
}
