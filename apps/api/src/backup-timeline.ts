import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { downloadSnapshotObject, MAX_SNAPSHOT_BYTES } from "./backup.js";
import type { ApiConfig } from "./config.js";
import type { RecordFingerprint, RecordView } from "./repository.js";

/**
 * The time machine read layer: "what did the workspace look like at T, and what
 * has happened since?"
 *
 * Nothing in here restores anything. Version one is deliberately read-only, so a
 * half-finished recovery can never be the reason a record disappears. Two rules
 * keep that promise true in practice rather than only on paper:
 *
 * 1. A snapshot is never opened where it lives. SQLite creates `-wal`/`-shm`
 *    sidecars next to whatever file it opens — even for a read-only connection —
 *    so opening the owner's backup in place would litter `data/backups/` and put
 *    a WAL replay within reach of a file we are only meant to read. Every read
 *    works on a throwaway copy under `<dataDirectory>/derived/snapshots/`, and the
 *    copy is deleted again when the read finishes.
 * 2. That copy is opened with `readOnly: true`, and only ever through this module,
 *    so a bug here can raise an error but cannot write a row.
 */

/**
 * `lifeos-YYYYMMDD-HHMMSS-xxxxxxxx.sqlite` — the only shape `createBackupArtifact`
 * writes. Checking it before touching the filesystem is what keeps a crafted name
 * (`../../lifeos.sqlite`, `..\..\`) out of the backup directory.
 */
export const SNAPSHOT_FILE_NAME_PATTERN = /^lifeos-\d{8}-\d{6}-[0-9a-f]{8}\.sqlite$/;

/** How many records each diff row spells out before it stops listing. */
export const SNAPSHOT_SAMPLE_LIMIT = 20;

const PREVIEW_LENGTH = 60;

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type SnapshotSource = "local" | "remote";

export type SnapshotUnavailableReason = "invalid-name" | "missing" | "transport" | "unreadable";

/**
 * Carries a machine-readable reason so the route layer can pick a status code
 * without pattern-matching on Chinese prose.
 */
export class SnapshotUnavailableError extends Error {
  public readonly reason: SnapshotUnavailableReason;

  public constructor(reason: SnapshotUnavailableReason, message: string) {
    super(message);
    this.name = "SnapshotUnavailableError";
    this.reason = reason;
  }
}

export interface SnapshotCounts {
  /** Records on the timeline at that moment. */
  readonly records: number;
  /** Records already in the recycle bin at that moment. */
  readonly recordsTrashed: number;
  readonly photos: number;
  readonly people: number;
  readonly entities: number;
  readonly assets: number;
  readonly summaries: number;
}

export interface SnapshotDiffSample {
  readonly id: string;
  readonly kind: string;
  /**
   * Empty when the record was marked private. A diff that showed the text anyway
   * would turn "what disappeared" into a way around the mask.
   */
  readonly preview: string;
  readonly isPrivate: boolean;
  readonly occurredDay?: string;
  /**
   * Photos this record pointed at *at that moment*, and that the API can still
   * draw today. That second half is the honest half: the snapshot holds the
   * database, not the photographs, so a picture the collector has since taken
   * away cannot come back through the time machine. It is reported instead —
   * see `photosGone` — rather than promised and then rendered as a broken tile.
   */
  readonly photos?: readonly string[];
  /** How many of that moment's photos no longer have a file behind them. */
  readonly photosGone?: number;
  /** Set on `changed` samples: the revision in the snapshot, and the revision now. */
  readonly revisions?: { readonly then: number; readonly now: number };
  /** Set on `gone` samples that are sitting in the recycle bin and can be restored. */
  readonly restorable?: boolean;
}

export interface SnapshotDiffBucket {
  readonly total: number;
  /** Capped at `sampleLimit`; `total` is the honest number. */
  readonly samples: readonly SnapshotDiffSample[];
}

export interface SnapshotDiff {
  /** On the timeline in the snapshot, not on it now. */
  readonly gone: SnapshotDiffBucket;
  /** On the timeline in both places, content changed since. */
  readonly changed: SnapshotDiffBucket;
  /** On the timeline now, absent from the snapshot. */
  readonly added: SnapshotDiffBucket;
  readonly unchanged: number;
  /** Records already in the recycle bin at that moment — not part of any bucket. */
  readonly trashedInSnapshot: number;
  readonly sampleLimit: number;
}

export interface SnapshotReading {
  readonly fileName: string;
  readonly source: SnapshotSource;
  readonly sizeBytes: number;
  readonly counts: SnapshotCounts;
  readonly diff: SnapshotDiff;
}

/**
 * The slice of the repository the diff reads. Narrow on purpose: it is the only
 * thing this module can do to the live data, and no method on it can write.
 */
export interface TimelineSource {
  recordFingerprints(): readonly RecordFingerprint[];
  list(): readonly RecordView[];
  /**
   * Photo assets whose local original is still on disk.
   *
   * Optional so a test can hand in the two required methods alone. Absent, the
   * diff reports no photos at all — a missing image is a smaller lie than an
   * `<img>` pointed at an asset id nobody can serve.
   */
  photoAssetIds?(): readonly string[];
}

/** One record in the shape a comparison needs. Both sides of the diff use this. */
export interface DiffableRecord {
  readonly id: string;
  readonly revision: number;
  readonly deleted: boolean;
  readonly kind: string;
  readonly preview: string;
  readonly isPrivate: boolean;
  readonly occurredDay?: string;
  readonly photos?: readonly string[];
  readonly photosGone?: number;
}

export function assertSafeSnapshotFileName(fileName: string): string {
  if (!SNAPSHOT_FILE_NAME_PATTERN.test(fileName)) {
    throw new SnapshotUnavailableError("invalid-name", `不是合法的快照文件名：${fileName}`);
  }
  return fileName;
}

/** `<dataDirectory>/derived/snapshots` — disposable, rebuilt on demand, never a source of truth. */
export function snapshotCacheDirectory(config: ApiConfig): string {
  return join(resolve(config.dataDirectory), "derived", "snapshots");
}

export function backupDirectoryOf(config: ApiConfig): string {
  return resolve(config.backupDirectory ?? join(config.dataDirectory, "backups"));
}

interface MaterializedSnapshot {
  readonly path: string;
  readonly source: SnapshotSource;
  readonly sizeBytes: number;
}

/**
 * A leftover `-wal` from an earlier open would be replayed onto whatever we write
 * next, so the sidecars go first: they belong to a connection that is long gone,
 * not to the snapshot file.
 */
function clearSnapshotSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // Best effort. A sidecar we cannot remove is a stale cache, not a data risk.
    }
  }
}

function assertSnapshotSize(sizeBytes: number, fileName: string): void {
  if (sizeBytes > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotUnavailableError("unreadable", `快照 ${fileName} 有 ${sizeBytes} 字节，超出可读取的上限。`);
  }
}

/**
 * Puts a readable copy of `fileName` in the cache. Prefers the local backup
 * directory — retention may already have pruned the local copy while the object
 * store still has it, so a miss falls through to the remote copy rather than
 * failing.
 */
async function materializeSnapshot(config: ApiConfig, fileName: string): Promise<MaterializedSnapshot> {
  assertSafeSnapshotFileName(fileName);
  const directory = snapshotCacheDirectory(config);
  mkdirSync(directory, { recursive: true });
  const cachePath = join(directory, fileName);
  clearSnapshotSidecars(cachePath);

  const localPath = join(backupDirectoryOf(config), fileName);
  if (existsSync(localPath)) {
    const sizeBytes = statSync(localPath).size;
    assertSnapshotSize(sizeBytes, fileName);
    copyFileSync(localPath, cachePath);
    return { path: cachePath, source: "local", sizeBytes };
  }

  let bytes: Buffer | undefined;
  try {
    bytes = await downloadSnapshotObject(config, fileName);
  } catch (error) {
    throw new SnapshotUnavailableError("transport", error instanceof Error ? error.message : String(error));
  }
  if (bytes === undefined) {
    throw new SnapshotUnavailableError("missing", `找不到快照 ${fileName}：本地备份目录里没有，对象存储也没有可用的副本。`);
  }
  assertSnapshotSize(bytes.byteLength, fileName);
  writeFileSync(cachePath, bytes);
  return { path: cachePath, source: "remote", sizeBytes: bytes.byteLength };
}

/** Removes the throwaway copy. Reads must not accumulate state. */
function discardCachedCopy(path: string): void {
  clearSnapshotSidecars(path);
  try {
    rmSync(path, { force: true });
  } catch {
    // A cache file we cannot delete is a disk-space question, not a correctness one.
  }
}

interface SnapshotRead<T> {
  readonly source: SnapshotSource;
  readonly sizeBytes: number;
  readonly value: T;
}

async function withSnapshot<T>(
  config: ApiConfig,
  fileName: string,
  work: (db: DatabaseSync) => T,
): Promise<SnapshotRead<T>> {
  const materialized = await materializeSnapshot(config, fileName);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(materialized.path, { readOnly: true });
  } catch (error) {
    discardCachedCopy(materialized.path);
    throw new SnapshotUnavailableError("unreadable", `快照 ${fileName} 打不开：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { source: materialized.source, sizeBytes: materialized.sizeBytes, value: work(db) };
  } finally {
    try {
      db.close();
    } finally {
      discardCachedCopy(materialized.path);
    }
  }
}

function snapshotTables(db: DatabaseSync): ReadonlySet<string> {
  const names = new Set<string>();
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const name = row["name"];
    if (typeof name === "string") names.add(name);
  }
  return names;
}

function tableCount(db: DatabaseSync, tables: ReadonlySet<string>, table: string): number {
  if (!tables.has(table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as Record<string, unknown> | undefined;
  return Number(row?.["total"] ?? 0);
}

/**
 * Counts rows whose JSON payload declares a given kind.
 *
 * Parsed in JavaScript rather than with `json_extract`: the column is opaque JSON
 * in a STRICT table, one pass over a few hundred rows costs nothing, and a row
 * whose payload we cannot read is skipped instead of blanking the whole view.
 */
function countJsonKind(db: DatabaseSync, tables: ReadonlySet<string>, table: string, kind: string): number {
  if (!tables.has(table)) return 0;
  let total = 0;
  for (const row of db.prepare(`SELECT value_json AS value FROM ${table}`).all()) {
    const value = row["value"];
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === kind) total += 1;
    } catch {
      // Unreadable payload: not counted, and not fatal.
    }
  }
  return total;
}

/**
 * The asset ids of one kind inside a snapshot.
 *
 * `assets` is a key–value table, so the kind lives inside `value_json` and has to
 * be read in JavaScript — the same trade `countJsonKind` makes, for the same
 * reason: one unreadable payload drops one row instead of blanking the view.
 */
function snapshotIdsOfKind(db: DatabaseSync, tables: ReadonlySet<string>, table: string, kind: string): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!tables.has(table)) return ids;
  for (const row of db.prepare(`SELECT id, value_json AS value FROM ${table}`).all()) {
    const id = row["id"];
    const value = row["value"];
    if (typeof id !== "string" || typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === kind) ids.add(id);
    } catch {
      // Unreadable payload: this one asset is skipped, nothing else is.
    }
  }
  return ids;
}

/**
 * Asset ids a record pointed at, in reference order, without duplicates.
 *
 * Accepts either side's shape: the snapshot hands over the raw `asset_refs_json`
 * column, while a live `RecordView` hands over an already-parsed `assetRefs`.
 */
function referencedAssetIds(assetRefs: unknown): readonly string[] {
  let parsed: unknown = assetRefs;
  if (typeof assetRefs === "string") {
    if (assetRefs.length === 0) return [];
    try {
      parsed = JSON.parse(assetRefs);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const assetId = (entry as { assetId?: unknown }).assetId;
    if (typeof assetId !== "string" || assetId.length === 0) continue;
    if (!ids.includes(assetId)) ids.push(assetId);
  }
  return ids;
}

/**
 * Splits one record's asset references into the pictures a panel can draw, and
 * the pictures it can only talk about.
 *
 * `knownPhotoIds` is what the snapshot recorded as a photo. Without it the caller
 * is describing the present, where every drawable reference is simply drawable —
 * only the snapshot side can say "this used to be a picture and the file is gone".
 * An audio clip or an attachment therefore never counts as a missing photo.
 */
function photosOf(
  assetRefsJson: unknown,
  drawable: ReadonlySet<string>,
  knownPhotoIds?: ReadonlySet<string>,
): { readonly photos: readonly string[]; readonly photosGone: number } {
  const photos: string[] = [];
  let photosGone = 0;
  for (const assetId of referencedAssetIds(assetRefsJson)) {
    if (drawable.has(assetId)) {
      photos.push(assetId);
      continue;
    }
    if (knownPhotoIds !== undefined && knownPhotoIds.has(assetId)) photosGone += 1;
  }
  return { photos, photosGone };
}

function countRecords(db: DatabaseSync, tables: ReadonlySet<string>): { readonly live: number; readonly trashed: number } {
  if (!tables.has("records")) return { live: 0, trashed: 0 };
  const row = db.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN deleted_at_json IS NULL THEN 1 ELSE 0 END) AS live FROM records",
  ).get() as Record<string, unknown> | undefined;
  const total = Number(row?.["total"] ?? 0);
  const live = Number(row?.["live"] ?? 0);
  return { live, trashed: total - live };
}

function readSnapshotCounts(db: DatabaseSync): SnapshotCounts {
  const tables = snapshotTables(db);
  const records = countRecords(db, tables);
  return {
    records: records.live,
    recordsTrashed: records.trashed,
    photos: countJsonKind(db, tables, "assets", "photo"),
    people: countJsonKind(db, tables, "entities", "person"),
    entities: tableCount(db, tables, "entities"),
    assets: tableCount(db, tables, "assets"),
    summaries: tableCount(db, tables, "day_summaries"),
  };
}

function previewOf(original: string, edited: string | null, isPrivate: boolean): string {
  if (isPrivate) return "";
  const source = edited !== null && edited.trim().length > 0 ? edited : original;
  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
}

/** The calendar day a record belongs to, in the owner's timezone. */
function occurredDay(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const time = value as { kind?: unknown; value?: unknown };
  if (typeof time.value !== "string" || time.value.length === 0) return undefined;
  // A date-only value is already a day; pushing it through a timezone would move it.
  if (time.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(time.value) ? time.value : undefined;
  const parsed = Date.parse(time.value);
  if (Number.isNaN(parsed)) return undefined;
  return DAY_FORMAT.format(new Date(parsed));
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readSnapshotRecords(db: DatabaseSync, drawable: ReadonlySet<string>): readonly DiffableRecord[] {
  const tables = snapshotTables(db);
  if (!tables.has("records")) return [];
  // What the snapshot itself counted as a photo, so an attachment or a recording
  // is never reported as a picture that went missing.
  const snapshotPhotoIds = snapshotIdsOfKind(db, tables, "assets", "photo");
  const rows = db
    .prepare("SELECT id, kind, revision, deleted_at_json, is_private, body_original, body_edited, occurred_at_json, asset_refs_json FROM records")
    .all();
  const records: DiffableRecord[] = [];
  for (const row of rows) {
    const id = row["id"];
    if (typeof id !== "string") continue;
    const isPrivate = Number(row["is_private"] ?? 0) === 1;
    const day = occurredDay(parseJsonColumn(row["occurred_at_json"]));
    // A masked record gives up its pictures for the same reason it gives up its
    // text: otherwise "what disappeared" becomes a way to look at a private photo.
    const pictures = isPrivate
      ? { photos: [] as readonly string[], photosGone: 0 }
      : photosOf(row["asset_refs_json"], drawable, snapshotPhotoIds);
    records.push({
      id,
      revision: Number(row["revision"] ?? 1),
      deleted: row["deleted_at_json"] !== null && row["deleted_at_json"] !== undefined,
      kind: typeof row["kind"] === "string" ? row["kind"] : "journal",
      preview: previewOf(
        typeof row["body_original"] === "string" ? row["body_original"] : "",
        typeof row["body_edited"] === "string" ? row["body_edited"] : null,
        isPrivate,
      ),
      isPrivate,
      ...(day === undefined ? {} : { occurredDay: day }),
      ...(pictures.photos.length === 0 ? {} : { photos: pictures.photos }),
      ...(pictures.photosGone === 0 ? {} : { photosGone: pictures.photosGone }),
    });
  }
  return records;
}

/**
 * The live half, assembled from fingerprints plus the hydrated views.
 *
 * The fingerprints are what make "gone" honest: they include the recycle bin, so a
 * record that disappeared from the timeline can be reported as *restorable* rather
 * than destroyed. The views supply the text for records that are still around.
 */
function readLiveRecords(source: TimelineSource, drawable: ReadonlySet<string>): readonly DiffableRecord[] {
  const views = new Map(source.list().map((view) => [view.id, view]));
  return source.recordFingerprints().map((fingerprint): DiffableRecord => {
    const view = views.get(fingerprint.id);
    if (view === undefined) {
      return {
        id: fingerprint.id,
        revision: fingerprint.revision,
        deleted: fingerprint.deleted,
        kind: "",
        preview: "",
        isPrivate: false,
      };
    }
    const isPrivate = view.isPrivate === true;
    const day = occurredDay(view.occurredAt);
    // No earlier state to compare against on this side, so nothing here can be
    // reported as a photo that went missing: `photosGone` stays absent.
    const pictures = isPrivate ? [] : photosOf(view.assetRefs, drawable).photos;
    return {
      id: fingerprint.id,
      revision: fingerprint.revision,
      deleted: fingerprint.deleted,
      kind: view.kind,
      preview: previewOf(view.body.original, view.body.edited ?? null, isPrivate),
      isPrivate,
      ...(day === undefined ? {} : { occurredDay: day }),
      ...(pictures.length === 0 ? {} : { photos: pictures }),
    };
  });
}

function sampleOf(row: DiffableRecord): SnapshotDiffSample {
  return {
    id: row.id,
    kind: row.kind,
    preview: row.preview,
    isPrivate: row.isPrivate,
    ...(row.occurredDay === undefined ? {} : { occurredDay: row.occurredDay }),
    ...(row.photos === undefined ? {} : { photos: row.photos }),
    ...(row.photosGone === undefined ? {} : { photosGone: row.photosGone }),
  };
}

/**
 * Sorts both sides into gone / changed / added, from the snapshot's point of view.
 *
 * A record that sits in the recycle bin in the snapshot is counted separately and
 * lands in no bucket: it was already off the timeline back then, so calling it
 * "gone" would report a loss that happened before the moment being looked at.
 */
export function classifyRecords(
  snapshot: readonly DiffableRecord[],
  live: readonly DiffableRecord[],
  sampleLimit: number = SNAPSHOT_SAMPLE_LIMIT,
): SnapshotDiff {
  const snapshotById = new Map(snapshot.map((row) => [row.id, row]));
  const liveById = new Map(live.map((row) => [row.id, row]));

  const gone: SnapshotDiffSample[] = [];
  const changed: SnapshotDiffSample[] = [];
  const added: SnapshotDiffSample[] = [];
  let goneTotal = 0;
  let changedTotal = 0;
  let addedTotal = 0;
  let unchanged = 0;
  let trashedInSnapshot = 0;

  for (const row of snapshot) {
    if (row.deleted) {
      trashedInSnapshot += 1;
      continue;
    }
    const now = liveById.get(row.id);
    if (now === undefined || now.deleted) {
      goneTotal += 1;
      if (gone.length < sampleLimit) {
        gone.push({ ...sampleOf(row), ...(now === undefined ? {} : { restorable: true }) });
      }
      continue;
    }
    if (now.revision !== row.revision) {
      changedTotal += 1;
      if (changed.length < sampleLimit) {
        changed.push({ ...sampleOf(row), revisions: { then: row.revision, now: now.revision } });
      }
      continue;
    }
    unchanged += 1;
  }

  for (const row of live) {
    if (row.deleted) continue;
    const before = snapshotById.get(row.id);
    // Records the snapshot already had on the timeline are settled above.
    if (before !== undefined && !before.deleted) continue;
    addedTotal += 1;
    if (added.length < sampleLimit) added.push(sampleOf(row));
  }

  return {
    gone: { total: goneTotal, samples: gone },
    changed: { total: changedTotal, samples: changed },
    added: { total: addedTotal, samples: added },
    unchanged,
    trashedInSnapshot,
    sampleLimit,
  };
}

/**
 * Reads one point in time: what it held, and how it differs from right now.
 *
 * Counts and diff come back together because the view shows them side by side, and
 * a single open of the snapshot is measurably cheaper than two when the point only
 * exists in the object store.
 */
export async function readSnapshot(
  config: ApiConfig,
  fileName: string,
  source: TimelineSource,
  sampleLimit: number = SNAPSHOT_SAMPLE_LIMIT,
): Promise<SnapshotReading> {
  // Resolved once, outside the snapshot, then handed to both sides: "which photos
  // can still be drawn today" is a property of right now, not of either side of
  // the comparison.
  const drawable = new Set(source.photoAssetIds?.() ?? []);
  const read = await withSnapshot(config, fileName, (db) => ({
    counts: readSnapshotCounts(db),
    records: readSnapshotRecords(db, drawable),
  }));
  return {
    fileName,
    source: read.source,
    sizeBytes: read.sizeBytes,
    counts: read.value.counts,
    diff: classifyRecords(read.value.records, readLiveRecords(source, drawable), sampleLimit),
  };
}

/** One snapshot as the collector sees it: what it is, and where it lives. */
export interface ShelfSnapshot {
  readonly provider: string;
  readonly status: string;
  readonly location?: string;
  readonly prunedAt?: string;
}

export interface SnapshotAssetReferences {
  /** Every asset id any snapshot still on the shelf points at. */
  readonly ids: ReadonlySet<string>;
  /** Snapshots that could not be read. Non-empty means "we do not know". */
  readonly unreadable: readonly string[];
}

/** The asset ids one snapshot's records point at, timeline and recycle bin alike. */
function referencedIdsInSnapshot(db: DatabaseSync): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!snapshotTables(db).has("records")) return ids;
  for (const row of db.prepare("SELECT asset_refs_json FROM records").all()) {
    for (const id of referencedAssetIds(row["asset_refs_json"])) ids.add(id);
  }
  return ids;
}

/**
 * The synchronous twin of `withSnapshot`, for a file that is already on this disk.
 *
 * The collector has no `await` to hang a remote fetch on, and it never needs one:
 * only snapshots that are *still on the shelf locally* get a say, and a snapshot
 * retention has already pruned is out of the window by definition.
 */
function withLocalSnapshotCopy<T>(config: ApiConfig, fileName: string, work: (db: DatabaseSync) => T): T {
  const directory = snapshotCacheDirectory(config);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  clearSnapshotSidecars(path);
  copyFileSync(join(backupDirectoryOf(config), fileName), path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    discardCachedCopy(path);
    throw error;
  }
  try {
    return work(db);
  } finally {
    try {
      db.close();
    } finally {
      discardCachedCopy(path);
    }
  }
}

/**
 * Every asset id the snapshots still on the shelf point at.
 *
 * The collector's old rule was "no record points at it", which forgets that a
 * picture can be gone from the timeline and still be in the time machine: delete a
 * record today and its photos stop being referenced, so the orphan scan would
 * collect them once the grace period ran out — while a snapshot from last week
 * still draws them. "A photo from a past moment is still resolvable" only holds if
 * a reference from a snapshot that has not been pruned weighs exactly as much as a
 * live one.
 *
 * A pruned snapshot is out of the window on purpose: retention has already called
 * it gone, and the collector looks after the present, not the whole history.
 *
 * Unreadable snapshots are *reported*, never skipped quietly. Swallowing the failure
 * would silently lower the reference count, and the next thing that happens to a
 * picture with no references is deletion — while a file kept another day costs
 * almost nothing. So the caller is told what could not be read instead of being
 * left to assume the best.
 */
export function collectSnapshotAssetIds(
  config: ApiConfig,
  shelf: readonly ShelfSnapshot[],
): SnapshotAssetReferences {
  const ids = new Set<string>();
  const unreadable: string[] = [];
  for (const entry of shelf) {
    if (entry.provider !== "local" || entry.status !== "success" || entry.prunedAt !== undefined) continue;
    const fileName = (entry.location ?? "").split(/[\\/]/).pop() ?? "";
    if (!SNAPSHOT_FILE_NAME_PATTERN.test(fileName)) continue;
    // A row whose file is not on this disk protects nothing: there are no bytes to
    // read, so there is nothing the time machine could draw from it either. That is
    // *not* the same as unreadable, and it must not be — a snapshot file the owner
    // deleted by hand would otherwise wedge collection forever, because a row
    // retention cannot find is a row retention never prunes.
    if (!existsSync(join(backupDirectoryOf(config), fileName))) continue;
    try {
      for (const id of withLocalSnapshotCopy(config, fileName, referencedIdsInSnapshot)) ids.add(id);
    } catch {
      unreadable.push(fileName);
    }
  }
  return { ids, unreadable };
}
