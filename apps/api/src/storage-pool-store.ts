import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface PoolUserQuota {
  readonly storageLimitBytes: number;
  readonly trafficLimitBytes: number;
}

export interface PoolUserUsage extends PoolUserQuota {
  readonly storageUsedBytes: number;
  readonly storageReservedBytes: number;
  readonly trafficUsedBytes: number;
  readonly trafficReservedBytes: number;
}

export interface PoolObjectRow {
  readonly attemptId: string;
  readonly objectKey: string | null;
  readonly accountId: string;
  readonly assetId: string;
  readonly bytes: number;
  readonly state: "uploading" | "pending" | "ready" | "deleting";
}

export interface PoolObjectIssue extends PoolObjectRow {}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label} in storage pool ledger`);
  return parsed;
}

function assertBytes(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function assertMonth(month: string): void {
  if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) {
    throw new Error("month must use UTC YYYY-MM format");
  }
}

function nextMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return monthNumber === 12 ? `${String(year + 1).padStart(4, "0")}-01` : `${String(year).padStart(4, "0")}-${String(monthNumber + 1).padStart(2, "0")}`;
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  return integer(row[key], key);
}

export class StoragePoolStore {
  readonly #db: DatabaseSync;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 10_000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS storage_pool_user_quotas (
        account_id TEXT PRIMARY KEY NOT NULL,
        storage_limit_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_limit_bytes >= 0),
        traffic_limit_bytes INTEGER NOT NULL DEFAULT 0 CHECK (traffic_limit_bytes >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS storage_pool_objects (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        object_key TEXT UNIQUE,
        account_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        state TEXT NOT NULL CHECK (state IN ('uploading', 'pending', 'ready', 'deleting')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS storage_pool_objects_account_state
        ON storage_pool_objects (account_id, state);
      CREATE TABLE IF NOT EXISTS storage_pool_user_traffic (
        account_id TEXT NOT NULL,
        month TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        PRIMARY KEY (account_id, month)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS storage_pool_download_reservations (
        reservation_id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        object_key TEXT NOT NULL,
        month TEXT NOT NULL,
        next_month TEXT,
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'uncertain')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS storage_pool_downloads_account_month
        ON storage_pool_download_reservations (account_id, month, state);
    `);
    const reservationColumns = this.#db.prepare("PRAGMA table_info(storage_pool_download_reservations)").all() as Record<string, unknown>[];
    if (!reservationColumns.some((column) => column.name === "next_month")) {
      this.#db.exec("ALTER TABLE storage_pool_download_reservations ADD COLUMN next_month TEXT");
    }
  }

  public close(): void { this.#db.close(); }

  public ensureAccount(accountId: string): void {
    this.#db.prepare(`INSERT OR IGNORE INTO storage_pool_user_quotas (account_id, updated_at) VALUES (?, ?)`)
      .run(accountId, Date.now());
  }

  public quota(accountId: string): PoolUserQuota {
    const row = this.#db.prepare(`SELECT storage_limit_bytes, traffic_limit_bytes FROM storage_pool_user_quotas WHERE account_id = ?`).get(accountId) as Record<string, unknown> | undefined;
    if (row === undefined) return { storageLimitBytes: 0, trafficLimitBytes: 0 };
    return { storageLimitBytes: rowNumber(row, "storage_limit_bytes"), trafficLimitBytes: rowNumber(row, "traffic_limit_bytes") };
  }

  public usage(accountId: string, month: string): PoolUserUsage {
    assertMonth(month);
    const quota = this.quota(accountId);
    const storage = this.#db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN state IN ('ready', 'deleting') THEN bytes ELSE 0 END), 0) AS used,
        COALESCE(SUM(CASE WHEN state IN ('uploading', 'pending') THEN bytes ELSE 0 END), 0) AS reserved
      FROM storage_pool_objects WHERE account_id = ?
    `).get(accountId) as Record<string, unknown>;
    const traffic = this.#db.prepare(`
      SELECT
        COALESCE((SELECT bytes FROM storage_pool_user_traffic WHERE account_id = ? AND month = ?), 0) AS used,
        COALESCE((SELECT SUM(bytes) FROM storage_pool_download_reservations WHERE account_id = ? AND (month = ? OR next_month = ?)), 0) AS reserved
    `).get(accountId, month, accountId, month, month) as Record<string, unknown>;
    return {
      ...quota,
      storageUsedBytes: rowNumber(storage, "used"),
      storageReservedBytes: rowNumber(storage, "reserved"),
      trafficUsedBytes: rowNumber(traffic, "used"),
      trafficReservedBytes: rowNumber(traffic, "reserved"),
    };
  }

  public totals(accountIds: readonly string[], month: string): PoolUserUsage {
    assertMonth(month);
    const rows = accountIds.map((accountId) => this.usage(accountId, month));
    return rows.reduce<PoolUserUsage>((total, row) => ({
      storageLimitBytes: total.storageLimitBytes + row.storageLimitBytes,
      trafficLimitBytes: total.trafficLimitBytes + row.trafficLimitBytes,
      storageUsedBytes: total.storageUsedBytes + row.storageUsedBytes,
      storageReservedBytes: total.storageReservedBytes + row.storageReservedBytes,
      trafficUsedBytes: total.trafficUsedBytes + row.trafficUsedBytes,
      trafficReservedBytes: total.trafficReservedBytes + row.trafficReservedBytes,
    }), { storageLimitBytes: 0, trafficLimitBytes: 0, storageUsedBytes: 0, storageReservedBytes: 0, trafficUsedBytes: 0, trafficReservedBytes: 0 });
  }

  public projectAccounted(month: string): { readonly storageBytes: number; readonly trafficBytes: number } {
    assertMonth(month);
    const storage = this.#db.prepare(`
      SELECT COALESCE(SUM(bytes), 0) AS bytes FROM storage_pool_objects
      WHERE object_key IS NOT NULL AND state IN ('ready', 'pending', 'deleting')
    `).get() as Record<string, unknown>;
    const traffic = this.#db.prepare(`
      SELECT
        COALESCE((SELECT SUM(bytes) FROM storage_pool_user_traffic WHERE month = ?), 0) +
        COALESCE((SELECT SUM(bytes) FROM storage_pool_download_reservations WHERE state = 'uncertain' AND (month = ? OR next_month = ?)), 0) AS bytes
    `).get(month, month, month) as Record<string, unknown>;
    return { storageBytes: rowNumber(storage, "bytes"), trafficBytes: rowNumber(traffic, "bytes") };
  }

  public objectIssues(): readonly PoolObjectIssue[] {
    const rows = this.#db.prepare(`SELECT attempt_id, object_key, account_id, asset_id, bytes, state FROM storage_pool_objects WHERE state <> 'ready' ORDER BY created_at`).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      attemptId: String(row.attempt_id), objectKey: row.object_key === null ? null : String(row.object_key),
      accountId: String(row.account_id), assetId: String(row.asset_id), bytes: rowNumber(row, "bytes"),
      state: String(row.state) as PoolObjectRow["state"],
    }));
  }

  public downloadIssues(): readonly { readonly accountId: string; readonly month: string; readonly bytes: number; readonly state: "reserved" | "uncertain" }[] {
    const rows = this.#db.prepare(`SELECT account_id, month, bytes, state FROM storage_pool_download_reservations ORDER BY created_at`).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      accountId: String(row.account_id), month: String(row.month), bytes: rowNumber(row, "bytes"),
      state: String(row.state) as "reserved" | "uncertain",
    }));
  }

  public saveQuota(accountId: string, quota: PoolUserQuota, projectStorageLimit: number, projectTrafficLimit: number): void {
    assertBytes(quota.storageLimitBytes, "storageLimitBytes");
    assertBytes(quota.trafficLimitBytes, "trafficLimitBytes");
    assertBytes(projectStorageLimit, "projectStorageLimit");
    assertBytes(projectTrafficLimit, "projectTrafficLimit");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureAccount(accountId);
      const current = this.#db.prepare(`SELECT storage_limit_bytes, traffic_limit_bytes FROM storage_pool_user_quotas WHERE account_id = ?`).get(accountId) as Record<string, unknown>;
      const all = this.#db.prepare(`SELECT COALESCE(SUM(storage_limit_bytes), 0) AS storage, COALESCE(SUM(traffic_limit_bytes), 0) AS traffic FROM storage_pool_user_quotas`).get() as Record<string, unknown>;
      const storageTotal = rowNumber(all, "storage") - rowNumber(current, "storage_limit_bytes") + quota.storageLimitBytes;
      const trafficTotal = rowNumber(all, "traffic") - rowNumber(current, "traffic_limit_bytes") + quota.trafficLimitBytes;
      const isReduction = quota.storageLimitBytes <= rowNumber(current, "storage_limit_bytes")
        && quota.trafficLimitBytes <= rowNumber(current, "traffic_limit_bytes")
        && (quota.storageLimitBytes < rowNumber(current, "storage_limit_bytes") || quota.trafficLimitBytes < rowNumber(current, "traffic_limit_bytes"));
      if (!isReduction && (storageTotal > projectStorageLimit || trafficTotal > projectTrafficLimit)) {
        throw new Error("分配额度总和超过 LifeOS 当前项目额度");
      }
      this.#db.prepare(`UPDATE storage_pool_user_quotas SET storage_limit_bytes = ?, traffic_limit_bytes = ?, updated_at = ? WHERE account_id = ?`)
        .run(quota.storageLimitBytes, quota.trafficLimitBytes, Date.now(), accountId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public reserveUpload(accountId: string, assetId: string, bytes: number, projectStorageFree: number): string {
    assertBytes(bytes, "bytes");
    assertBytes(projectStorageFree, "projectStorageFree");
    const attemptId = randomUUID();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureAccount(accountId);
      const usage = this.usage(accountId, new Date().toISOString().slice(0, 7));
      const projectReservations = this.#db.prepare(`
        SELECT COALESCE(SUM(bytes), 0) AS bytes FROM storage_pool_objects
        WHERE state IN ('uploading', 'pending')
      `).get() as Record<string, unknown>;
      if (bytes + rowNumber(projectReservations, "bytes") > projectStorageFree) throw new Error("项目存储池额度不足");
      if (usage.storageUsedBytes + usage.storageReservedBytes + bytes > usage.storageLimitBytes) {
        throw new Error("用户存储额度不足");
      }
      this.#db.prepare(`INSERT INTO storage_pool_objects (attempt_id, object_key, account_id, asset_id, bytes, state, created_at) VALUES (?, NULL, ?, ?, ?, 'uploading', ?)`)
        .run(attemptId, accountId, assetId, bytes, Date.now());
      this.#db.exec("COMMIT");
      return attemptId;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public completeUpload(attemptId: string, objectKey: string): void {
    const result = this.#db.prepare(`UPDATE storage_pool_objects SET object_key = ?, state = 'ready' WHERE attempt_id = ? AND state IN ('uploading', 'pending')`)
      .run(objectKey, attemptId);
    if (Number(result.changes) !== 1) throw new Error("上传额度预留状态已改变");
  }

  public keepPendingUpload(attemptId: string, objectKey?: string): void {
    const result = objectKey === undefined
      ? this.#db.prepare(`UPDATE storage_pool_objects SET state = 'pending' WHERE attempt_id = ? AND state IN ('uploading', 'pending')`).run(attemptId)
      : this.#db.prepare(`UPDATE storage_pool_objects SET object_key = ?, state = 'pending' WHERE attempt_id = ? AND state IN ('uploading', 'pending')`).run(objectKey, attemptId);
    if (Number(result.changes) !== 1) throw new Error("待确认上传额度预留不存在");
  }

  public releaseUploadReservation(attemptId: string): void {
    this.#db.prepare(`DELETE FROM storage_pool_objects WHERE attempt_id = ? AND state = 'uploading'`).run(attemptId);
  }

  public poolObject(accountId: string, assetId: string, objectKey: string): PoolObjectRow | null {
    const row = this.#db.prepare(`SELECT attempt_id, object_key, account_id, asset_id, bytes, state FROM storage_pool_objects WHERE account_id = ? AND asset_id = ? AND object_key = ?`)
      .get(accountId, assetId, objectKey) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      attemptId: String(row.attempt_id), objectKey: String(row.object_key), accountId: String(row.account_id),
      assetId: String(row.asset_id), bytes: rowNumber(row, "bytes"), state: String(row.state) as PoolObjectRow["state"],
    };
  }

  public beginDelete(accountId: string, assetId: string, objectKey: string): PoolObjectRow | null {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.poolObject(accountId, assetId, objectKey);
      if (row === null || row.state !== "ready") { this.#db.exec("ROLLBACK"); return null; }
      this.#db.prepare(`UPDATE storage_pool_objects SET state = 'deleting' WHERE attempt_id = ? AND state = 'ready'`).run(row.attemptId);
      this.#db.exec("COMMIT");
      return { ...row, state: "deleting" };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public finishDelete(attemptId: string): void {
    const result = this.#db.prepare(`DELETE FROM storage_pool_objects WHERE attempt_id = ? AND state = 'deleting'`).run(attemptId);
    if (Number(result.changes) !== 1) throw new Error("删除额度记录状态已改变");
  }

  public reserveDownload(accountId: string, assetId: string, objectKey: string, month: string, projectTrafficFree: number): { readonly id: string; readonly bytes: number } {
    assertMonth(month);
    assertBytes(projectTrafficFree, "projectTrafficFree");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const object = this.poolObject(accountId, assetId, objectKey);
      if (object === null || object.state !== "ready") throw new Error("对象不可读取");
      const usage = this.usage(accountId, month);
      if (object.bytes > projectTrafficFree) throw new Error("项目月流量额度不足");
      if (usage.trafficUsedBytes + usage.trafficReservedBytes + object.bytes > usage.trafficLimitBytes) {
        throw new Error("用户月流量额度不足");
      }
      const id = randomUUID();
      this.#db.prepare(`INSERT INTO storage_pool_download_reservations (reservation_id, account_id, object_key, month, next_month, bytes, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`)
        .run(id, accountId, objectKey, month, nextMonth(month), object.bytes, Date.now());
      this.#db.exec("COMMIT");
      return { id, bytes: object.bytes };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public finishDownload(reservationId: string, chargedMonth: string, bytes: number): void {
    assertMonth(chargedMonth);
    assertBytes(bytes, "bytes");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare(`SELECT account_id, month, bytes FROM storage_pool_download_reservations WHERE reservation_id = ?`).get(reservationId) as Record<string, unknown> | undefined;
      if (row === undefined) throw new Error("下载额度预留不存在");
      const reservedBytes = rowNumber(row, "bytes");
      if (reservedBytes !== bytes) throw new Error("下载文件大小与额度预留不符");
      const accountId = String(row.account_id);
      this.#db.prepare(`INSERT INTO storage_pool_user_traffic (account_id, month, bytes) VALUES (?, ?, ?) ON CONFLICT(account_id, month) DO UPDATE SET bytes = bytes + excluded.bytes`)
        .run(accountId, chargedMonth, bytes);
      this.#db.prepare(`DELETE FROM storage_pool_download_reservations WHERE reservation_id = ?`).run(reservationId);
      this.#db.exec("COMMIT");
      return;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public refundDownload(reservationId: string): void {
    this.#db.prepare(`DELETE FROM storage_pool_download_reservations WHERE reservation_id = ? AND state = 'reserved'`).run(reservationId);
  }

  public markDownloadUncertain(reservationId: string): void {
    this.#db.prepare(`UPDATE storage_pool_download_reservations SET state = 'uncertain' WHERE reservation_id = ?`).run(reservationId);
  }
}
