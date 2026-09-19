import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { assertValidBackupRetention, DEFAULT_BACKUP_RETENTION, type BackupRetention } from "./backup-retention.js";
import {
  assertValidAsset,
  assertValidCycleIntimacyModuleData,
  assertValidEntity,
  assertValidTimelineRecord,
  entitySearchTerms,
  normalizeEntitySearchTerm,
  type Asset,
  type AssetKind,
  type CycleIntimacyEvent,
  type CycleIntimacyModuleConfig,
  type CycleIntimacyModuleData,
  type DaySummary,
  type Entity,
  type EntityKind,
  type LifeTime,
  type NoteDetails,
  type RecordKind,
  type TimelineRecord,
} from "@lifeos/core";

export type RecordView = TimelineRecord & { readonly revision: number };

/**
 * The identity of one record as a comparison needs it: a stable id, a revision
 * that only moves when the record's content moves, and whether it sits in the
 * recycle bin.
 *
 * Deliberately excludes the body. Comparing a snapshot against the live data
 * thousands of rows at a time should not drag every journal entry through the
 * diff; whoever needs the text fetches it for the handful of rows they show.
 */
export interface RecordFingerprint {
  readonly id: string;
  readonly revision: number;
  readonly deleted: boolean;
}

export interface RecordListQuery {
  readonly q?: string;
  readonly kind?: RecordKind;
  readonly status?: "todo" | "in_progress" | "done" | "cancelled";
  /** Only records that reference this entity id. */
  readonly entityId?: string;
  /** Only records that reference this asset id. */
  readonly assetId?: string;
}

export interface EntityListQuery {
  readonly type?: EntityKind;
  readonly q?: string;
}

export interface AssetListQuery {
  readonly kind?: AssetKind;
}

export interface ExportData {
  readonly records: readonly TimelineRecord[];
  readonly entities: readonly Entity[];
  readonly assets: readonly Asset[];
  readonly modules?: { readonly cycleIntimacy?: CycleIntimacyModuleData };
}

/** Why a file landed in the orphan trash: the collector, or a manual delete. */
export type AssetTrashOrigin = "orphan-scan" | "asset-delete";

/**
 * A collected photo, kept whole so restoring it is a file move plus an insert.
 * Rows survive the final delete on purpose: the audit trail is how the owner
 * can tell what a past cleanup actually removed.
 */
export interface AssetTrashEntry {
  readonly asset: Asset;
  readonly trashedAt: string;
  readonly origin: AssetTrashOrigin;
  /** Original asset-root-relative path, used to locate the trashed copy. */
  readonly relativePath: string;
  readonly restoredAt?: string;
  readonly purgedAt?: string;
}

export interface BackupRun {
  readonly id: number;
  readonly provider: "local" | "s3";
  readonly kind: "manual" | "scheduled" | "test";
  readonly status: "success" | "failed" | "skipped";
  /** Groups the local and remote halves of one dual-backup operation. */
  readonly batchId?: string;
  readonly fileName?: string;
  readonly location?: string;
  readonly sizeBytes?: number;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** Set once retention moved this snapshot to the recycle bin. */
  readonly prunedAt?: string;
  /** Where the trashed copy lives now, so it can be found and restored. */
  readonly trashLocation?: string;
}

export interface BackupSchedule {
  readonly enabled: boolean;
  readonly hour: number;
  readonly minute: number;
}

const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: false,
  hour: 2,
  minute: 0,
};

export interface WeatherDeviceLocation {
  readonly deviceId: string;
  readonly locationId: string;
  readonly city: string;
  readonly updatedAt: string;
  readonly profileId?: string;
}

export interface WeatherDayCache {
  readonly date: string;
  readonly locationKey: string;
  readonly locationId: string;
  readonly city: string;
  readonly value: unknown;
  readonly capturedAt: string;
  /** True once the day's final archive job has completed. */
  readonly archived: boolean;
}

/** Where an observation came from: the hourly tick, or the owner pressing the button. */
export type WeatherObservationSource = "auto" | "manual";

/**
 * One reading of the sky. A day accumulates these at most once per hour per
 * source; the same hour written twice updates the row rather than growing the
 * table, which is what keeps "file only what happened" true.
 */
export interface WeatherObservation {
  readonly date: string;
  readonly hour: number;
  readonly locationKey: string;
  readonly locationId: string;
  readonly city: string;
  readonly source: WeatherObservationSource;
  readonly text: string;
  readonly icon: string;
  readonly temperature?: string;
  readonly precip?: string;
  readonly cloud?: string;
  readonly windDir?: string;
  readonly windScale?: string;
  /** The upstream observation time, when the provider reported one. */
  readonly observedAt?: string;
  readonly capturedAt: string;
}

export const DEFAULT_CYCLE_INTIMACY_CONFIG: CycleIntimacyModuleConfig = {
  enabled: false,
  cycleLength: 28,
  periodLength: 5,
};

interface RecordRow {
  id: string;
  kind: string;
  body_json: string;
  created_at_json: string;
  updated_at_json: string | null;
  occurred_at_json: string | null;
  weather_json: string | null;
  entity_refs_json: string;
  related_record_ids_json: string;
  asset_refs_json: string;
  ai_derived_json: string;
  task_json: string | null;
  note_json: string | null;
  is_private: number;
  is_demo: number;
  is_backfill: number;
  revision: number;
  deleted_at_json: string | null;
}

function textColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`SQLite column ${name} is not text`);
  return value;
}

function nullableTextColumn(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`SQLite column ${name} is not nullable text`);
  return value;
}

function numberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`SQLite column ${name} is not an integer`);
  return value;
}

function booleanColumn(row: Record<string, unknown>, name: string): boolean {
  const value = numberColumn(row, name);
  if (value !== 0 && value !== 1) throw new Error(`SQLite column ${name} is not a boolean integer`);
  return value === 1;
}

function readRecordRow(row: Record<string, unknown>): RecordRow {
  const isPrivate = booleanColumn(row, "is_private");
  const isDemo = booleanColumn(row, "is_demo");
  const isBackfill = booleanColumn(row, "is_backfill");
  return {
    id: textColumn(row, "id"),
    kind: textColumn(row, "kind"),
    body_json: textColumn(row, "body_json"),
    created_at_json: textColumn(row, "created_at_json"),
    updated_at_json: nullableTextColumn(row, "updated_at_json"),
    occurred_at_json: nullableTextColumn(row, "occurred_at_json"),
    weather_json: nullableTextColumn(row, "weather_json"),
    entity_refs_json: textColumn(row, "entity_refs_json"),
    related_record_ids_json: textColumn(row, "related_record_ids_json"),
    asset_refs_json: textColumn(row, "asset_refs_json"),
    ai_derived_json: textColumn(row, "ai_derived_json"),
    task_json: nullableTextColumn(row, "task_json"),
    note_json: nullableTextColumn(row, "note_json"),
    is_private: isPrivate ? 1 : 0,
    is_demo: isDemo ? 1 : 0,
    is_backfill: isBackfill ? 1 : 0,
    revision: numberColumn(row, "revision"),
    deleted_at_json: nullableTextColumn(row, "deleted_at_json"),
  };
}

function parseJson<T>(value: string, name: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Corrupt JSON in SQLite column ${name}`);
  }
}

function entityAddress(entity: Entity): string | null {
  return entity.type === "place" ? entity.address ?? null : null;
}

function assetTrashEntryFrom(row: Record<string, unknown>): AssetTrashEntry {
  const asset = parseJson<unknown>(textColumn(row, "asset_json"), "asset_trash.asset_json");
  assertValidAsset(asset);
  const restoredAt = nullableTextColumn(row, "restored_at");
  const purgedAt = nullableTextColumn(row, "purged_at");
  return {
    asset,
    trashedAt: textColumn(row, "trashed_at"),
    origin: textColumn(row, "origin") === "asset-delete" ? "asset-delete" : "orphan-scan",
    relativePath: textColumn(row, "relative_path"),
    ...(restoredAt === null ? {} : { restoredAt }),
    ...(purgedAt === null ? {} : { purgedAt }),
  };
}

/**
 * Entity rows pre-date the dedicated address column and therefore may carry
 * the field only inside value_json. Read both forms so old databases and
 * partially migrated rows remain importable.
 */
function entityFromRow(row: Record<string, unknown>): Entity {
  const value = parseJson<unknown>(textColumn(row, "value_json"), "entities.value_json");
  const storedAddress = row.address === undefined || row.address === null ? undefined : textColumn(row, "address");
  const candidate = storedAddress !== undefined && typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), ...(Object.prototype.hasOwnProperty.call(value, "address") ? {} : { address: storedAddress }) }
    : value;
  assertValidEntity(candidate);
  return candidate;
}

// The early weather attachment implementation saved the QWeather location ID
// in `city`. Preserve the original snapshot, but never expose a known raw ID
// as a place name in the timeline or exported views.
const LEGACY_WEATHER_LOCATION_NAMES: Readonly<Record<string, string>> = {
  "101280803": "佛山南海区",
};

function normalizeWeatherAttachment(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const weather = value as Readonly<Record<string, unknown>>;
  const locationId = typeof weather.locationId === "string" ? weather.locationId : "";
  const city = typeof weather.city === "string" ? weather.city : "";
  const friendlyName = city === locationId ? LEGACY_WEATHER_LOCATION_NAMES[locationId] : undefined;
  return friendlyName === undefined ? value : { ...weather, city: friendlyName };
}

function rowToView(row: RecordRow): RecordView {
  const candidate: unknown = {
    id: row.id,
    kind: row.kind,
    body: parseJson(row.body_json, "body_json"),
    createdAt: parseJson(row.created_at_json, "created_at_json"),
    ...(row.updated_at_json === null ? {} : { updatedAt: parseJson(row.updated_at_json, "updated_at_json") }),
    ...(row.occurred_at_json === null ? {} : { occurredAt: parseJson(row.occurred_at_json, "occurred_at_json") }),
    ...(row.weather_json === null ? {} : { weather: normalizeWeatherAttachment(parseJson(row.weather_json, "weather_json")) }),
    entityRefs: parseJson(row.entity_refs_json, "entity_refs_json"),
    relatedRecordIds: parseJson(row.related_record_ids_json, "related_record_ids_json"),
    assetRefs: parseJson(row.asset_refs_json, "asset_refs_json"),
    aiDerived: parseJson(row.ai_derived_json, "ai_derived_json"),
    ...(row.task_json === null ? {} : { task: parseJson(row.task_json, "task_json") }),
    ...(row.note_json === null ? {} : { note: parseJson<NoteDetails>(row.note_json, "note_json") }),
    ...(row.is_private === 1 ? { isPrivate: true } : {}),
    ...(row.is_demo === 1 ? { isDemo: true } : {}),
    ...(row.is_backfill === 1 ? { isBackfill: true } : {}),
  };
  assertValidTimelineRecord(candidate);
  return { ...candidate, revision: row.revision };
}

function readTimeSortValue(time: LifeTime | undefined): number | null {
  if (time === undefined) return null;
  if (time.kind === "instant") {
    const parsed = Date.parse(time.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (time.kind === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(time.value);
    if (match === null) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const parsed = Date.parse(`${time.value}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function timelineSortValue(record: TimelineRecord): number {
  return readTimeSortValue(record.occurredAt) ?? readTimeSortValue(record.createdAt) ?? 0;
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function recordInsertParams(record: TimelineRecord): readonly (string | number | null)[] {
  return [
    record.id,
    record.kind,
    JSON.stringify(record.body),
    record.body.original,
    record.body.edited ?? null,
    JSON.stringify(record.createdAt),
    jsonOrNull(record.updatedAt),
    jsonOrNull(record.occurredAt),
    jsonOrNull(record.weather),
    JSON.stringify(record.entityRefs),
    JSON.stringify(record.relatedRecordIds),
    JSON.stringify(record.assetRefs),
    JSON.stringify(record.aiDerived),
    jsonOrNull(record.kind === "task" ? record.task : undefined),
    jsonOrNull(record.kind === "note" ? record.note : undefined),
    record.isPrivate === true ? 1 : 0,
    record.isDemo === true ? 1 : 0,
    record.isBackfill === true ? 1 : 0,
    timelineSortValue(record),
  ];
}

function ensureUniqueIds<T extends { id: string }>(values: readonly T[], name: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate ${name} id in import bundle: ${value.id}`);
    ids.add(value.id);
  }
}

export class SqliteRecordRepository {
  readonly #db: DatabaseSync;

  public constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        body_original TEXT NOT NULL,
        body_edited TEXT,
        created_at_json TEXT NOT NULL,
        updated_at_json TEXT,
        occurred_at_json TEXT,
        weather_json TEXT,
        entity_refs_json TEXT NOT NULL,
        related_record_ids_json TEXT NOT NULL,
        asset_refs_json TEXT NOT NULL,
        ai_derived_json TEXT NOT NULL,
        task_json TEXT,
        note_json TEXT,
        is_private INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0,
        is_backfill INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        timeline_sort INTEGER NOT NULL,
        deleted_at_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS records_timeline_idx ON records (deleted_at_json, timeline_sort DESC, created_at_json DESC, id DESC);
      CREATE INDEX IF NOT EXISTS records_kind_idx ON records (deleted_at_json, kind);
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        address TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS asset_trash (
        asset_id TEXT PRIMARY KEY NOT NULL,
        trashed_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        asset_json TEXT NOT NULL,
        restored_at TEXT,
        purged_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS asset_trash_trashed_idx ON asset_trash (trashed_at DESC);
      CREATE TABLE IF NOT EXISTS day_summaries (
        date TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL,
        value_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cycle_intimacy_module (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        config_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cycle_intimacy_events (
        id TEXT PRIMARY KEY NOT NULL,
        date TEXT NOT NULL,
        kind TEXT NOT NULL,
        UNIQUE (date, kind)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cycle_intimacy_events_date_idx ON cycle_intimacy_events (date, kind);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS backup_runs (
        id INTEGER PRIMARY KEY,
        batch_id TEXT,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        file_name TEXT,
        location TEXT,
        size_bytes INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        pruned_at TEXT,
        trash_location TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS backup_runs_started_idx ON backup_runs (started_at DESC);
      CREATE TABLE IF NOT EXISTS backup_schedule (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        hour INTEGER NOT NULL DEFAULT 2,
        minute INTEGER NOT NULL DEFAULT 0,
        last_run_key TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS backup_retention (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        daily_days INTEGER NOT NULL,
        weekly_weeks INTEGER NOT NULL,
        monthly_months INTEGER NOT NULL,
        trash_days INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS weather_device_locations (
        device_id TEXT PRIMARY KEY NOT NULL,
        location_id TEXT NOT NULL,
        city TEXT NOT NULL,
        updated_at_json TEXT NOT NULL,
        profile_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS weather_day_cache (
        date TEXT NOT NULL,
        location_key TEXT NOT NULL,
        location_id TEXT NOT NULL,
        city TEXT NOT NULL,
        value_json TEXT NOT NULL,
        captured_at_json TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, location_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS weather_day_cache_location_idx ON weather_day_cache (location_key, date);
      CREATE TABLE IF NOT EXISTS weather_observation (
        date TEXT NOT NULL,
        hour INTEGER NOT NULL,
        location_key TEXT NOT NULL,
        location_id TEXT NOT NULL,
        city TEXT NOT NULL,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        icon TEXT NOT NULL,
        temperature TEXT,
        precip TEXT,
        cloud TEXT,
        wind_dir TEXT,
        wind_scale TEXT,
        observed_at TEXT,
        captured_at_json TEXT NOT NULL,
        PRIMARY KEY (date, hour, location_key, source)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS weather_observation_day_idx ON weather_observation (date, location_key);
    `);
    const recordColumns = this.#db.prepare("PRAGMA table_info(records)").all() as readonly Record<string, unknown>[];
    if (!recordColumns.some((column) => column.name === "is_private")) {
      this.#db.exec("ALTER TABLE records ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0");
    }
    if (!recordColumns.some((column) => column.name === "is_demo")) {
      this.#db.exec("ALTER TABLE records ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");
    }
    if (!recordColumns.some((column) => column.name === "is_backfill")) {
      this.#db.exec("ALTER TABLE records ADD COLUMN is_backfill INTEGER NOT NULL DEFAULT 0");
    }
    if (!recordColumns.some((column) => column.name === "weather_json")) {
      this.#db.exec("ALTER TABLE records ADD COLUMN weather_json TEXT");
    }
    if (!recordColumns.some((column) => column.name === "note_json")) {
      this.#db.exec("ALTER TABLE records ADD COLUMN note_json TEXT");
    }
    const weatherLocationColumns = this.#db.prepare("PRAGMA table_info(weather_device_locations)").all() as readonly Record<string, unknown>[];
    if (!weatherLocationColumns.some((column) => column.name === "profile_id")) {
      this.#db.exec("ALTER TABLE weather_device_locations ADD COLUMN profile_id TEXT");
    }
    const entityColumns = this.#db.prepare("PRAGMA table_info(entities)").all() as readonly Record<string, unknown>[];
    if (!entityColumns.some((column) => column.name === "address")) {
      this.#db.exec("ALTER TABLE entities ADD COLUMN address TEXT");
    }
    // Backfill the nullable column from imports written before the column was
    // introduced. Keeping the JSON value too is intentional: exports remain
    // self-contained and old readers can still understand them.
    const legacyEntityRows = this.#db.prepare("SELECT id, value_json FROM entities WHERE address IS NULL").all() as readonly Record<string, unknown>[];
    if (legacyEntityRows.length > 0) {
      const updateEntityAddress = this.#db.prepare("UPDATE entities SET address = ? WHERE id = ?");
      for (const row of legacyEntityRows) {
        const value = parseJson<unknown>(textColumn(row, "value_json"), "entities.value_json");
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const entity = value as Record<string, unknown>;
        if (entity.type === "place" && typeof entity.address === "string") updateEntityAddress.run(entity.address, textColumn(row, "id"));
      }
    }
    const weatherCacheColumns = this.#db.prepare("PRAGMA table_info(weather_day_cache)").all() as readonly Record<string, unknown>[];
    if (!weatherCacheColumns.some((column) => column.name === "archived")) {
      this.#db.exec("ALTER TABLE weather_day_cache ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
    const backupRunColumns = this.#db.prepare("PRAGMA table_info(backup_runs)").all() as readonly Record<string, unknown>[];
    if (!backupRunColumns.some((column) => column.name === "batch_id")) {
      this.#db.exec("ALTER TABLE backup_runs ADD COLUMN batch_id TEXT");
    }
    if (!backupRunColumns.some((column) => column.name === "pruned_at")) {
      this.#db.exec("ALTER TABLE backup_runs ADD COLUMN pruned_at TEXT");
    }
    if (!backupRunColumns.some((column) => column.name === "trash_location")) {
      this.#db.exec("ALTER TABLE backup_runs ADD COLUMN trash_location TEXT");
    }
    const retentionColumns = this.#db.prepare("PRAGMA table_info(backup_retention)").all() as readonly Record<string, unknown>[];
    if (retentionColumns.length > 0 && !retentionColumns.some((column) => column.name === "trash_days")) {
      this.#db.exec(`ALTER TABLE backup_retention ADD COLUMN trash_days INTEGER NOT NULL DEFAULT ${DEFAULT_BACKUP_RETENTION.trashDays}`);
    }
    this.#migrateLegacyDemoLabels();
  }

  /**
   * The first data set used a visible prefix as its only batch marker. Convert
   * that reserved prefix into a real field exactly once, without touching user
   * records or changing when a record happened.
   */
  #migrateLegacyDemoLabels(): void {
    const rows = this.#db.prepare(`
      SELECT id, body_json, body_original, body_edited
      FROM records
      WHERE body_original LIKE '【示例】%' OR body_edited LIKE '【示例】%'
    `).all() as readonly Record<string, unknown>[];
    if (rows.length === 0) return;
    const stripPrefix = (value: string): string => value.startsWith("【示例】") ? value.slice("【示例】".length).trimStart() : value;
    const update = this.#db.prepare(`
      UPDATE records
      SET body_json = ?, body_original = ?, body_edited = ?, is_demo = 1, revision = revision + 1
      WHERE id = ?
    `);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const original = stripPrefix(textColumn(row, "body_original"));
        const editedValue = nullableTextColumn(row, "body_edited");
        const edited = editedValue === null ? undefined : stripPrefix(editedValue);
        const body = parseJson<Record<string, unknown>>(textColumn(row, "body_json"), "body_json");
        const nextBody = { ...body, original, ...(edited === undefined ? {} : { edited }) };
        update.run(JSON.stringify(nextBody), original, edited ?? null, textColumn(row, "id"));
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public close(): void {
    this.#db.close();
  }

  public purgeExpiredSessions(now = Date.now()): void {
    this.#db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  }

  public createSession(tokenHash: string, expiresAt: number): void {
    this.#db.prepare("INSERT OR REPLACE INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)").run(tokenHash, expiresAt);
  }

  public hasSession(tokenHash: string, now = Date.now()): boolean {
    const row = this.#db.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(tokenHash) as Record<string, unknown> | undefined;
    return row !== undefined && typeof row.expires_at === "number" && row.expires_at > now;
  }

  public deleteSession(tokenHash: string): void {
    this.#db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  public async backupTo(destinationPath: string): Promise<number> {
    return backup(this.#db, destinationPath);
  }

  public getBackupSchedule(): BackupSchedule {
    const row = this.#db.prepare("SELECT enabled, hour, minute FROM backup_schedule WHERE id = 1").get() as Record<string, unknown> | undefined;
    if (row === undefined) return DEFAULT_BACKUP_SCHEDULE;
    const enabled = row.enabled === 1;
    const hour = typeof row.hour === "number" && Number.isInteger(row.hour) && row.hour >= 0 && row.hour <= 23
      ? row.hour
      : DEFAULT_BACKUP_SCHEDULE.hour;
    const minute = typeof row.minute === "number" && Number.isInteger(row.minute) && row.minute >= 0 && row.minute <= 59
      ? row.minute
      : DEFAULT_BACKUP_SCHEDULE.minute;
    return { enabled, hour, minute };
  }

  public saveBackupSchedule(schedule: BackupSchedule): void {
    if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) throw new Error("备份小时必须在 0 到 23 之间");
    if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) throw new Error("备份分钟必须在 0 到 59 之间");
    this.#db.prepare(`
      INSERT INTO backup_schedule (id, enabled, hour, minute)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, hour = excluded.hour, minute = excluded.minute
    `).run(schedule.enabled ? 1 : 0, schedule.hour, schedule.minute);
  }

  /**
   * Claim one scheduled local date/time. SQLite serializes the conditional
   * write, so two timer callbacks (or a callback racing a restart) cannot run
   * the same scheduled slot twice.
   */
  public claimBackupScheduleRun(runKey: string): boolean {
    if (!runKey.trim()) throw new Error("备份排程标识不能为空");
    this.#db.prepare("INSERT INTO backup_schedule (id, enabled, hour, minute) VALUES (1, 0, 2, 0) ON CONFLICT(id) DO NOTHING").run();
    const result = this.#db.prepare(`
      UPDATE backup_schedule
      SET last_run_key = ?
      WHERE id = 1 AND (last_run_key IS NULL OR last_run_key <> ?)
    `).run(runKey, runKey) as { changes?: number };
    return result.changes === 1;
  }

  public backupScheduleLastRunKey(): string | undefined {
    const row = this.#db.prepare("SELECT last_run_key FROM backup_schedule WHERE id = 1").get() as Record<string, unknown> | undefined;
    return typeof row?.last_run_key === "string" ? row.last_run_key : undefined;
  }

  /** Falls back to the documented defaults whenever nothing has been saved yet. */
  public getBackupRetention(): BackupRetention {
    const row = this.#db.prepare("SELECT daily_days, weekly_weeks, monthly_months, trash_days FROM backup_retention WHERE id = 1").get() as Record<string, unknown> | undefined;
    if (row === undefined) return DEFAULT_BACKUP_RETENTION;
    const dailyDays = row.daily_days;
    const weeklyWeeks = row.weekly_weeks;
    const monthlyMonths = row.monthly_months;
    const trashDays = row.trash_days;
    if (typeof dailyDays !== "number" || typeof weeklyWeeks !== "number" || typeof monthlyMonths !== "number" || typeof trashDays !== "number") {
      return DEFAULT_BACKUP_RETENTION;
    }
    const candidate: BackupRetention = { dailyDays, weeklyWeeks, monthlyMonths, trashDays };
    try {
      assertValidBackupRetention(candidate);
      return candidate;
    } catch {
      // A hand-edited database must not break backups; fall back rather than throw.
      return DEFAULT_BACKUP_RETENTION;
    }
  }

  public saveBackupRetention(policy: BackupRetention): void {
    assertValidBackupRetention(policy);
    this.#db.prepare(`
      INSERT INTO backup_retention (id, daily_days, weekly_weeks, monthly_months, trash_days)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        daily_days = excluded.daily_days,
        weekly_weeks = excluded.weekly_weeks,
        monthly_months = excluded.monthly_months,
        trash_days = excluded.trash_days
    `).run(policy.dailyDays, policy.weeklyWeeks, policy.monthlyMonths, policy.trashDays);
  }

  public recordBackupRun(run: Omit<BackupRun, "id">): void {
    this.#db.prepare(`
      INSERT INTO backup_runs (id, batch_id, provider, kind, status, file_name, location, size_bytes, error, started_at, finished_at)
      VALUES (coalesce((SELECT max(id) + 1 FROM backup_runs), 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.batchId ?? null,
      run.provider,
      run.kind,
      run.status,
      run.fileName ?? null,
      run.location ?? null,
      run.sizeBytes ?? null,
      run.error ?? null,
      run.startedAt,
      run.finishedAt ?? null,
    );
  }

  public listBackupRuns(limit = 20): readonly BackupRun[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.#backupRuns(`SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ${safeLimit}`);
  }

  /**
   * Retention has to see the whole history: a truncated list would silently stop
   * older snapshots from ever being planned (and therefore never cleaned).
   */
  public listAllBackupRuns(max = 5000): readonly BackupRun[] {
    const safeMax = Math.max(1, Math.min(max, Math.trunc(max)));
    return this.#backupRuns(`SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ${safeMax}`);
  }

  #backupRuns(sql: string): readonly BackupRun[] {
    return this.#db.prepare(sql).all().map((row) => {
      const value = row as Record<string, unknown>;
      const provider = textColumn(value, "provider");
      const kind = textColumn(value, "kind");
      const status = textColumn(value, "status");
      return {
        id: numberColumn(value, "id"),
        provider: provider === "s3" ? "s3" : "local",
        kind: kind === "scheduled" ? "scheduled" : kind === "test" ? "test" : "manual",
        status: status === "failed" ? "failed" : status === "skipped" ? "skipped" : "success",
        ...(nullableTextColumn(value, "batch_id") === null ? {} : { batchId: nullableTextColumn(value, "batch_id")! }),
        ...(nullableTextColumn(value, "file_name") === null ? {} : { fileName: nullableTextColumn(value, "file_name")! }),
        ...(nullableTextColumn(value, "location") === null ? {} : { location: nullableTextColumn(value, "location")! }),
        ...(value.size_bytes === null ? {} : { sizeBytes: numberColumn(value, "size_bytes") }),
        ...(nullableTextColumn(value, "error") === null ? {} : { error: nullableTextColumn(value, "error")! }),
        startedAt: textColumn(value, "started_at"),
        ...(nullableTextColumn(value, "finished_at") === null ? {} : { finishedAt: nullableTextColumn(value, "finished_at")! }),
        ...(nullableTextColumn(value, "pruned_at") === null ? {} : { prunedAt: nullableTextColumn(value, "pruned_at")! }),
        ...(nullableTextColumn(value, "trash_location") === null ? {} : { trashLocation: nullableTextColumn(value, "trash_location")! }),
      } satisfies BackupRun;
    });
  }

  /** Records that retention moved a snapshot to the recycle bin. */
  public markBackupRunPruned(id: number, prunedAt: string, trashLocation?: string): void {
    this.#db.prepare("UPDATE backup_runs SET pruned_at = ?, trash_location = ? WHERE id = ?")
      .run(prunedAt, trashLocation ?? null, id);
  }

  /** Data for the optional private calendar overlay, kept outside free-form notes. */
  public cycleIntimacyModule(): CycleIntimacyModuleData {
    const row = this.#db.prepare("SELECT config_json FROM cycle_intimacy_module WHERE id = 1").get() as Record<string, unknown> | undefined;
    const config = row === undefined
      ? DEFAULT_CYCLE_INTIMACY_CONFIG
      : parseJson<CycleIntimacyModuleConfig>(textColumn(row, "config_json"), "cycle_intimacy_module.config_json");
    const events = this.#db.prepare("SELECT id, date, kind FROM cycle_intimacy_events ORDER BY date ASC, kind ASC, id ASC").all().map((eventRow) => {
      const rowValue = eventRow as Record<string, unknown>;
      return {
        id: textColumn(rowValue, "id"),
        date: textColumn(rowValue, "date"),
        kind: textColumn(rowValue, "kind") as CycleIntimacyEvent["kind"],
      };
    });
    const module: CycleIntimacyModuleData = { config, events };
    assertValidCycleIntimacyModuleData(module);
    return module;
  }

  public writeCycleIntimacyConfig(config: CycleIntimacyModuleConfig): CycleIntimacyModuleData {
    const existing = this.cycleIntimacyModule();
    assertValidCycleIntimacyModuleData({ config, events: existing.events });
    this.#db.prepare(`
      INSERT INTO cycle_intimacy_module (id, config_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json
    `).run(JSON.stringify(config));
    return this.cycleIntimacyModule();
  }

  public addCycleIntimacyEvent(event: CycleIntimacyEvent): CycleIntimacyModuleData {
    const existing = this.cycleIntimacyModule();
    assertValidCycleIntimacyModuleData({ config: existing.config, events: [...existing.events, event] });
    this.#db.prepare("INSERT INTO cycle_intimacy_events (id, date, kind) VALUES (?, ?, ?)").run(event.id, event.date, event.kind);
    return this.cycleIntimacyModule();
  }

  public deleteCycleIntimacyEvent(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM cycle_intimacy_events WHERE id = ?").run(id);
    return Number(result.changes) === 1;
  }

  public findById(id: string, includeDeleted = false): RecordView | null {
    const row = this.#db.prepare(`SELECT * FROM records WHERE id = ?${includeDeleted ? "" : " AND deleted_at_json IS NULL"}`).get(id);
    return row === undefined ? null : rowToView(readRecordRow(row));
  }

  public getWeatherDeviceLocation(deviceId: string): WeatherDeviceLocation | null {
    const row = this.#db.prepare("SELECT device_id, location_id, city, updated_at_json, profile_id FROM weather_device_locations WHERE device_id = ?").get(deviceId);
    if (row === undefined) return null;
    return {
      deviceId: textColumn(row, "device_id"),
      locationId: textColumn(row, "location_id"),
      city: textColumn(row, "city"),
      updatedAt: textColumn(row, "updated_at_json"),
      ...(nullableTextColumn(row, "profile_id") === null ? {} : { profileId: nullableTextColumn(row, "profile_id") as string }),
    };
  }

  /** All per-device locations, used by the daily archive job. */
  public listWeatherDeviceLocations(): readonly WeatherDeviceLocation[] {
    return this.#db.prepare("SELECT device_id, location_id, city, updated_at_json, profile_id FROM weather_device_locations ORDER BY device_id").all().map((row) => ({
      deviceId: textColumn(row, "device_id"),
      locationId: textColumn(row, "location_id"),
      city: textColumn(row, "city"),
      updatedAt: textColumn(row, "updated_at_json"),
      ...(nullableTextColumn(row, "profile_id") === null ? {} : { profileId: nullableTextColumn(row, "profile_id") as string }),
    }));
  }

  public saveWeatherDeviceLocation(deviceId: string, locationId: string, city: string, updatedAt: string, profileId?: string): WeatherDeviceLocation {
    this.#db.prepare(`
      INSERT INTO weather_device_locations (device_id, location_id, city, updated_at_json, profile_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET location_id = excluded.location_id, city = excluded.city, updated_at_json = excluded.updated_at_json, profile_id = excluded.profile_id
    `).run(deviceId, locationId, city, updatedAt, profileId ?? null);
    return { deviceId, locationId, city, updatedAt, ...(profileId === undefined ? {} : { profileId }) };
  }

  public getWeatherDayCache(date: string, locationKey: string): WeatherDayCache | null {
    const row = this.#db.prepare("SELECT date, location_key, location_id, city, value_json, captured_at_json, archived FROM weather_day_cache WHERE date = ? AND location_key = ?").get(date, locationKey);
    if (row === undefined) return null;
    return {
      date: textColumn(row, "date"),
      locationKey: textColumn(row, "location_key"),
      locationId: textColumn(row, "location_id"),
      city: textColumn(row, "city"),
      value: parseJson<unknown>(textColumn(row, "value_json"), "weather_day_cache.value_json"),
      capturedAt: textColumn(row, "captured_at_json"),
      archived: booleanColumn(row, "archived"),
    };
  }

  public listWeatherDayCache(from: string, to: string, locationKey?: string): readonly WeatherDayCache[] {
    const rows = locationKey === undefined
      ? this.#db.prepare("SELECT date, location_key, location_id, city, value_json, captured_at_json, archived FROM weather_day_cache WHERE date >= ? AND date <= ? ORDER BY date ASC, location_key ASC").all(from, to)
      : this.#db.prepare("SELECT date, location_key, location_id, city, value_json, captured_at_json, archived FROM weather_day_cache WHERE date >= ? AND date <= ? AND location_key = ? ORDER BY date ASC").all(from, to, locationKey);
    return rows.map((row) => ({
      date: textColumn(row, "date"),
      locationKey: textColumn(row, "location_key"),
      locationId: textColumn(row, "location_id"),
      city: textColumn(row, "city"),
      value: parseJson<unknown>(textColumn(row, "value_json"), "weather_day_cache.value_json"),
      capturedAt: textColumn(row, "captured_at_json"),
      archived: booleanColumn(row, "archived"),
    }));
  }

  public saveWeatherDayCache(date: string, locationKey: string, locationId: string, city: string, value: unknown, capturedAt: string, archived = false): void {
    this.#db.prepare(`
      INSERT INTO weather_day_cache (date, location_key, location_id, city, value_json, captured_at_json, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, location_key) DO UPDATE SET
        location_id = excluded.location_id,
        city = excluded.city,
        value_json = excluded.value_json,
        captured_at_json = excluded.captured_at_json,
        archived = max(weather_day_cache.archived, excluded.archived)
    `).run(date, locationKey, locationId, city, JSON.stringify(value), capturedAt, archived ? 1 : 0);
  }

  /**
   * Writes one observation. The primary key is (date, hour, locationKey,
   * source), so a repeat within the same hour replaces the previous reading
   * instead of adding a row — two presses in one hour are one fact.
   */
  public saveWeatherObservation(observation: WeatherObservation): void {
    this.#db.prepare(`
      INSERT INTO weather_observation (date, hour, location_key, location_id, city, source, text, icon, temperature, precip, cloud, wind_dir, wind_scale, observed_at, captured_at_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, hour, location_key, source) DO UPDATE SET
        location_id = excluded.location_id,
        city = excluded.city,
        text = excluded.text,
        icon = excluded.icon,
        temperature = excluded.temperature,
        precip = excluded.precip,
        cloud = excluded.cloud,
        wind_dir = excluded.wind_dir,
        wind_scale = excluded.wind_scale,
        observed_at = excluded.observed_at,
        captured_at_json = excluded.captured_at_json
    `).run(
      observation.date,
      observation.hour,
      observation.locationKey,
      observation.locationId,
      observation.city,
      observation.source,
      observation.text,
      observation.icon,
      observation.temperature ?? null,
      observation.precip ?? null,
      observation.cloud ?? null,
      observation.windDir ?? null,
      observation.windScale ?? null,
      observation.observedAt ?? null,
      observation.capturedAt,
    );
  }

  public listWeatherObservations(date: string, locationKey?: string): readonly WeatherObservation[] {
    const rows = locationKey === undefined
      ? this.#db.prepare("SELECT date, hour, location_key, location_id, city, source, text, icon, temperature, precip, cloud, wind_dir, wind_scale, observed_at, captured_at_json FROM weather_observation WHERE date = ? ORDER BY hour ASC, source ASC").all(date)
      : this.#db.prepare("SELECT date, hour, location_key, location_id, city, source, text, icon, temperature, precip, cloud, wind_dir, wind_scale, observed_at, captured_at_json FROM weather_observation WHERE date = ? AND location_key = ? ORDER BY hour ASC, source ASC").all(date, locationKey);
    return rows.map((row) => this.#weatherObservationFromRow(row));
  }

  public countWeatherObservations(date: string, locationKey?: string): number {
    const row = locationKey === undefined
      ? this.#db.prepare("SELECT count(*) AS total FROM weather_observation WHERE date = ?").get(date)
      : this.#db.prepare("SELECT count(*) AS total FROM weather_observation WHERE date = ? AND location_key = ?").get(date, locationKey);
    return row === undefined ? 0 : numberColumn(row, "total");
  }

  #weatherObservationFromRow(row: Record<string, unknown>): WeatherObservation {
    const temperature = nullableTextColumn(row, "temperature");
    const precip = nullableTextColumn(row, "precip");
    const cloud = nullableTextColumn(row, "cloud");
    const windDir = nullableTextColumn(row, "wind_dir");
    const windScale = nullableTextColumn(row, "wind_scale");
    const observedAt = nullableTextColumn(row, "observed_at");
    const source = textColumn(row, "source");
    return {
      date: textColumn(row, "date"),
      hour: numberColumn(row, "hour"),
      locationKey: textColumn(row, "location_key"),
      locationId: textColumn(row, "location_id"),
      city: textColumn(row, "city"),
      source: source === "manual" ? "manual" : "auto",
      text: textColumn(row, "text"),
      icon: textColumn(row, "icon"),
      ...(temperature === null ? {} : { temperature }),
      ...(precip === null ? {} : { precip }),
      ...(cloud === null ? {} : { cloud }),
      ...(windDir === null ? {} : { windDir }),
      ...(windScale === null ? {} : { windScale }),
      ...(observedAt === null ? {} : { observedAt }),
      capturedAt: textColumn(row, "captured_at_json"),
    };
  }

  public list(query: RecordListQuery = {}): readonly RecordView[] {
    const where = ["deleted_at_json IS NULL"];
    const params: (string | number)[] = [];
    if (query.kind !== undefined) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.status !== undefined) {
      where.push("json_extract(task_json, '$.status') = ?");
      params.push(query.status);
    }
    if (query.q !== undefined && query.q.length > 0) {
      // instr() treats '%' and '_' literally, unlike LIKE, and keeps Chinese text intact.
      where.push("instr(body_original || char(10) || coalesce(body_edited, '') || char(10) || coalesce(json_extract(note_json, '$.title'), '') || char(10) || coalesce(json_extract(note_json, '$.source'), '') || char(10) || id, ?) > 0");
      params.push(query.q);
    }
    if (query.entityId !== undefined && query.entityId.length > 0) {
      // json_each keeps the match exact; a substring test would confuse person_1 with person_10.
      where.push("EXISTS (SELECT 1 FROM json_each(entity_refs_json) WHERE json_extract(value, '$.entityId') = ?)");
      params.push(query.entityId);
    }
    if (query.assetId !== undefined && query.assetId.length > 0) {
      where.push("EXISTS (SELECT 1 FROM json_each(asset_refs_json) WHERE json_extract(value, '$.assetId') = ?)");
      params.push(query.assetId);
    }
    const sql = `SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY timeline_sort DESC, created_at_json DESC, id DESC`;
    return this.#db.prepare(sql).all(...params).map((row) => rowToView(readRecordRow(row)));
  }

  /**
   * Every record's identity, recycle bin included — the live half of a time
   * machine comparison.
   *
   * It reads through this connection rather than letting the caller open the
   * database file, so a diff can never race a write in progress and, more to the
   * point, can never modify anything: the shape it returns is three scalars wide.
   */
  public recordFingerprints(): readonly RecordFingerprint[] {
    const rows = this.#db.prepare("SELECT id, revision, deleted_at_json FROM records").all();
    return rows.map((row) => ({
      id: textColumn(row, "id"),
      revision: numberColumn(row, "revision"),
      deleted: nullableTextColumn(row, "deleted_at_json") !== null,
    }));
  }

  public insert(record: TimelineRecord): void {
    assertValidTimelineRecord(record);
    this.#db.prepare(`
      INSERT INTO records (
        id, kind, body_json, body_original, body_edited, created_at_json, updated_at_json,
        occurred_at_json, weather_json, entity_refs_json, related_record_ids_json, asset_refs_json,
        ai_derived_json, task_json, note_json, is_private, is_demo, is_backfill, revision, timeline_sort, deleted_at_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
    `).run(...recordInsertParams(record));
  }

  public update(record: TimelineRecord, expectedRevision: number): boolean {
    assertValidTimelineRecord(record);
    const result = this.#db.prepare(`
      UPDATE records SET
        kind = ?, body_json = ?, body_original = ?, body_edited = ?, created_at_json = ?, updated_at_json = ?,
        occurred_at_json = ?, weather_json = ?, entity_refs_json = ?, related_record_ids_json = ?, asset_refs_json = ?,
        ai_derived_json = ?, task_json = ?, note_json = ?, is_private = ?, is_demo = ?, is_backfill = ?, revision = revision + 1, timeline_sort = ?
      WHERE id = ? AND revision = ? AND deleted_at_json IS NULL
    `).run(
      record.kind,
      JSON.stringify(record.body),
      record.body.original,
      record.body.edited ?? null,
      JSON.stringify(record.createdAt),
      jsonOrNull(record.updatedAt),
      jsonOrNull(record.occurredAt),
      jsonOrNull(record.weather),
      JSON.stringify(record.entityRefs),
      JSON.stringify(record.relatedRecordIds),
      JSON.stringify(record.assetRefs),
      JSON.stringify(record.aiDerived),
      jsonOrNull(record.kind === "task" ? record.task : undefined),
      jsonOrNull(record.kind === "note" ? record.note : undefined),
      record.isPrivate === true ? 1 : 0,
      record.isDemo === true ? 1 : 0,
      record.isBackfill === true ? 1 : 0,
      timelineSortValue(record),
      record.id,
      expectedRevision,
    );
    return Number(result.changes) === 1;
  }

  public softDelete(id: string, expectedRevision: number, deletedAt: string): boolean {
    const result = this.#db.prepare(`
      UPDATE records SET deleted_at_json = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND deleted_at_json IS NULL
    `).run(deletedAt, id, expectedRevision);
    return Number(result.changes) === 1;
  }

  public exportData(): ExportData {
    const records = this.#db.prepare("SELECT * FROM records WHERE deleted_at_json IS NULL ORDER BY timeline_sort DESC, created_at_json DESC, id DESC")
      .all()
      .map((row) => {
        const view = rowToView(readRecordRow(row));
        const { revision: _revision, ...record } = view;
        return record;
      });
    const entities: Entity[] = [];
    for (const row of this.#db.prepare("SELECT value_json, address FROM entities ORDER BY id").all()) {
      entities.push(entityFromRow(row));
    }
    const assets: Asset[] = [];
    for (const row of this.#db.prepare("SELECT value_json FROM assets ORDER BY id").all()) {
      const value = parseJson<unknown>(textColumn(row, "value_json"), "assets.value_json");
      assertValidAsset(value);
      assets.push(value);
    }
    return { records, entities, assets, modules: { cycleIntimacy: this.cycleIntimacyModule() } };
  }

  public importData(data: ExportData): void {
    ensureUniqueIds(data.records, "record");
    ensureUniqueIds(data.entities, "entity");
    ensureUniqueIds(data.assets, "asset");
    for (const record of data.records) assertValidTimelineRecord(record);
    for (const entity of data.entities) assertValidEntity(entity);
    for (const asset of data.assets) assertValidAsset(asset);
    const cycleIntimacy = data.modules?.cycleIntimacy;
    if (cycleIntimacy !== undefined) {
      assertValidCycleIntimacyModuleData(cycleIntimacy);
      ensureUniqueIds(cycleIntimacy.events, "cycle intimacy event");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const recordConflict = this.#db.prepare("SELECT id FROM records WHERE id = ?");
      const entityConflict = this.#db.prepare("SELECT id FROM entities WHERE id = ?");
      const assetConflict = this.#db.prepare("SELECT id FROM assets WHERE id = ?");
      const cycleEventConflict = this.#db.prepare("SELECT id FROM cycle_intimacy_events WHERE id = ?");
      const cycleEventDayKindConflict = this.#db.prepare("SELECT id FROM cycle_intimacy_events WHERE date = ? AND kind = ?");
      for (const record of data.records) {
        if (recordConflict.get(record.id) !== undefined) throw new ConflictError(`Record already exists: ${record.id}`);
      }
      for (const entity of data.entities) {
        if (entityConflict.get(entity.id) !== undefined) throw new ConflictError(`Entity already exists: ${entity.id}`);
      }
      for (const asset of data.assets) {
        if (assetConflict.get(asset.id) !== undefined) throw new ConflictError(`Asset already exists: ${asset.id}`);
      }
      if (cycleIntimacy !== undefined) {
        for (const event of cycleIntimacy.events) {
          if (cycleEventConflict.get(event.id) !== undefined) throw new ConflictError(`Cycle module event already exists: ${event.id}`);
          if (cycleEventDayKindConflict.get(event.date, event.kind) !== undefined) throw new ConflictError(`Cycle module event already exists for ${event.date}`);
        }
      }
      const insertRecord = this.#db.prepare(`
        INSERT INTO records (
          id, kind, body_json, body_original, body_edited, created_at_json, updated_at_json,
          occurred_at_json, weather_json, entity_refs_json, related_record_ids_json, asset_refs_json,
          ai_derived_json, task_json, note_json, is_private, is_demo, is_backfill, revision, timeline_sort, deleted_at_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
      `);
      for (const record of data.records) {
        insertRecord.run(...recordInsertParams(record));
      }
      const insertEntity = this.#db.prepare("INSERT INTO entities (id, value_json, address) VALUES (?, ?, ?)");
      for (const entity of data.entities) insertEntity.run(entity.id, JSON.stringify(entity), entityAddress(entity));
      const insertAsset = this.#db.prepare("INSERT INTO assets (id, value_json) VALUES (?, ?)");
      for (const asset of data.assets) insertAsset.run(asset.id, JSON.stringify(asset));
      if (cycleIntimacy !== undefined) {
        this.#db.prepare(`
          INSERT INTO cycle_intimacy_module (id, config_json) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json
        `).run(JSON.stringify(cycleIntimacy.config));
        const insertCycleEvent = this.#db.prepare("INSERT INTO cycle_intimacy_events (id, date, kind) VALUES (?, ?, ?)");
        for (const event of cycleIntimacy.events) insertCycleEvent.run(event.id, event.date, event.kind);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public listEntities(query: EntityListQuery = {}): readonly Entity[] {
    const items: Entity[] = [];
    const needle = query.q === undefined ? undefined : normalizeEntitySearchTerm(query.q);
    for (const row of this.#db.prepare("SELECT value_json, address FROM entities").all()) {
      const value = entityFromRow(row);
      if (query.type !== undefined && value.type !== query.type) continue;
      // Aliases are searchable, so "@彬哥" and "彬哥" both find 阿彬.
      if (needle !== undefined && needle.length > 0 && !entitySearchTerms(value).some((term) => normalizeEntitySearchTerm(term).includes(needle))) continue;
      items.push(value);
    }
    return items.sort(
      (left, right) => left.name.localeCompare(right.name, "zh-Hans-CN") || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  }

  public findEntityById(id: string): Entity | null {
    const row = this.#db.prepare("SELECT value_json, address FROM entities WHERE id = ?").get(id);
    if (row === undefined) return null;
    return entityFromRow(row);
  }

  public insertEntity(entity: Entity): void {
    assertValidEntity(entity);
    this.#db.prepare("INSERT INTO entities (id, value_json, address) VALUES (?, ?, ?)").run(entity.id, JSON.stringify(entity), entityAddress(entity));
  }

  public updateEntity(entity: Entity): boolean {
    assertValidEntity(entity);
    const result = this.#db.prepare("UPDATE entities SET value_json = ?, address = ? WHERE id = ?").run(JSON.stringify(entity), entityAddress(entity), entity.id);
    return Number(result.changes) === 1;
  }

  /**
   * Rewrites several entities in one transaction. A relation lives on both
   * sides, so a half-applied write would leave the graph inconsistent.
   */
  public writeEntities(entities: readonly Entity[]): void {
    for (const entity of entities) assertValidEntity(entity);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.#db.prepare("UPDATE entities SET value_json = ?, address = ? WHERE id = ?");
      for (const entity of entities) {
        const result = update.run(JSON.stringify(entity), entityAddress(entity), entity.id);
        if (Number(result.changes) !== 1) throw new Error(`Entity disappeared during write: ${entity.id}`);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every entity that stores a relation to `entityId`. */
  public entitiesRelatingTo(entityId: string): readonly Entity[] {
    return this.listEntities().filter((entity) => (entity.relations ?? []).some((relation) => relation.entityId === entityId));
  }

  public deleteEntity(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM entities WHERE id = ?").run(id);
    return Number(result.changes) === 1;
  }

  /** Active records that still point at this entity; used to refuse unsafe deletes. */
  public entityReferenceRecordIds(entityId: string): readonly string[] {
    return this.#referenceRecordIds("entity_refs_json", "entityId", entityId);
  }

  public listAssets(query: AssetListQuery = {}): readonly Asset[] {
    const items: Asset[] = [];
    for (const row of this.#db.prepare("SELECT value_json FROM assets").all()) {
      const value = parseJson<unknown>(textColumn(row, "value_json"), "assets.value_json");
      assertValidAsset(value);
      if (query.kind !== undefined && value.kind !== query.kind) continue;
      items.push(value);
    }
    return items.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  /**
   * Photo assets whose local original is still on disk — the ones `<img>` can
   * actually be pointed at.
   *
   * "Local" is deliberately the same test the timeline uses before it draws a
   * grid (`storageRefs` naming `local`), because that is what makes a file this
   * API is allowed to serve at all. The time machine needs it to keep its word:
   * it would rather say "one of that moment's photos is gone" than put a tile on
   * screen that can never load.
   */
  public photoAssetIds(): readonly string[] {
    return this.listAssets({ kind: "photo" })
      .filter((asset) => asset.storageRefs.some((storageRef) => storageRef.sourceId === "local"))
      .map((asset) => asset.id);
  }

  /**
   * The live asset whose bytes hash to this value, if any.
   *
   * Only the `assets` table is searched, so a collected file sitting in the
   * trash is deliberately invisible: a drag should never silently resurrect
   * something the owner removed. The scan is linear over every asset, which is
   * fine at personal scale; a dedicated index table is the obvious next step if
   * that ever stops being true.
   */
  public findAssetByContentHash(algorithm: string, value: string): Asset | null {
    for (const asset of this.listAssets()) {
      for (const reference of asset.storageRefs) {
        if (reference.contentHash?.algorithm === algorithm && reference.contentHash.value === value) return asset;
      }
    }
    return null;
  }

  public findAssetById(id: string): Asset | null {
    const row = this.#db.prepare("SELECT value_json FROM assets WHERE id = ?").get(id);
    if (row === undefined) return null;
    const value = parseJson<unknown>(textColumn(row, "value_json"), "assets.value_json");
    assertValidAsset(value);
    return value;
  }

  public insertAsset(asset: Asset): void {
    assertValidAsset(asset);
    this.#db.prepare("INSERT INTO assets (id, value_json) VALUES (?, ?)").run(asset.id, JSON.stringify(asset));
  }

  public updateAsset(asset: Asset): boolean {
    assertValidAsset(asset);
    const result = this.#db.prepare("UPDATE assets SET value_json = ? WHERE id = ?").run(JSON.stringify(asset), asset.id);
    return Number(result.changes) === 1;
  }

  public deleteAsset(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM assets WHERE id = ?").run(id);
    return Number(result.changes) === 1;
  }

  /**
   * Records a collection. The asset row itself is gone by design, so the whole
   * asset is stored here: restoring is then a file move plus this row's value.
   */
  public insertAssetTrash(entry: AssetTrashEntry): void {
    this.#db
      .prepare(
        `INSERT INTO asset_trash (asset_id, trashed_at, origin, relative_path, asset_json, restored_at, purged_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(asset_id) DO UPDATE SET
           trashed_at = excluded.trashed_at,
           origin = excluded.origin,
           relative_path = excluded.relative_path,
           asset_json = excluded.asset_json,
           restored_at = NULL,
           purged_at = NULL`,
      )
      .run(entry.asset.id, entry.trashedAt, entry.origin, entry.relativePath, JSON.stringify(entry.asset));
  }

  /** Newest first, including entries already restored or purged (audit trail). */
  public listAssetTrash(): readonly AssetTrashEntry[] {
    const rows = this.#db
      .prepare("SELECT asset_json, trashed_at, origin, relative_path, restored_at, purged_at FROM asset_trash ORDER BY trashed_at DESC")
      .all();
    return rows.map((row) => assetTrashEntryFrom(row));
  }

  public findAssetTrash(assetId: string): AssetTrashEntry | null {
    const row = this.#db
      .prepare("SELECT asset_json, trashed_at, origin, relative_path, restored_at, purged_at FROM asset_trash WHERE asset_id = ?")
      .get(assetId);
    return row === undefined ? null : assetTrashEntryFrom(row);
  }

  public markAssetTrashRestored(assetId: string, at: string): boolean {
    const result = this.#db.prepare("UPDATE asset_trash SET restored_at = ? WHERE asset_id = ?").run(at, assetId);
    return Number(result.changes) === 1;
  }

  public markAssetTrashPurged(assetId: string, at: string): boolean {
    const result = this.#db.prepare("UPDATE asset_trash SET purged_at = ? WHERE asset_id = ?").run(at, assetId);
    return Number(result.changes) === 1;
  }

  /** Active records that still point at this asset; used to refuse unsafe deletes. */
  public assetReferenceRecordIds(assetId: string): readonly string[] {
    return this.#referenceRecordIds("asset_refs_json", "assetId", assetId);
  }

  /**
   * Every asset id that any record points at — soft-deleted records included.
   *
   * That inclusion is the whole point: a record sitting in the recycle bin can
   * still be restored, so its photos must never be mistaken for orphans. One
   * pass over the table is also far cheaper than asking per asset.
   */
  public referencedAssetIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const row of this.#db.prepare("SELECT asset_refs_json FROM records").all()) {
      const refs = parseJson<readonly Record<string, unknown>[]>(textColumn(row, "asset_refs_json"), "asset_refs_json");
      for (const ref of refs) {
        const assetId = ref["assetId"];
        if (typeof assetId === "string" && assetId !== "") ids.add(assetId);
      }
    }
    return ids;
  }

  /**
   * Day summaries are derived data, so they live in their own table and carry the
   * fingerprint of the record versions they describe. A row whose fingerprint no
   * longer matches is recomputed rather than served.
   */
  public readDaySummary(date: string): DaySummary | null {
    const row = this.#db.prepare("SELECT value_json FROM day_summaries WHERE date = ?").get(date);
    if (row === undefined) return null;
    return parseJson<DaySummary>(textColumn(row, "value_json"), "day_summaries.value_json");
  }

  public writeDaySummary(summary: DaySummary): void {
    this.#db
      .prepare(`
        INSERT INTO day_summaries (date, fingerprint, value_json) VALUES (?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET fingerprint = excluded.fingerprint, value_json = excluded.value_json
      `)
      .run(summary.date, summary.sourceRevision, JSON.stringify(summary));
  }

  #referenceRecordIds(column: "entity_refs_json" | "asset_refs_json", key: string, value: string): readonly string[] {
    const rows = this.#db.prepare(`SELECT id, ${column} AS refs_json FROM records WHERE deleted_at_json IS NULL ORDER BY id`).all();
    const ids: string[] = [];
    for (const row of rows) {
      const refs = parseJson<readonly Record<string, unknown>[]>(textColumn(row, "refs_json"), column);
      if (refs.some((ref) => ref[key] === value)) ids.push(textColumn(row, "id"));
    }
    return ids;
  }
}

export class ConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
