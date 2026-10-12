import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { assertValidAsset, assertValidEntity, assertValidTimelineRecord, assertValidCycleIntimacyModuleConfig } from "@lifeos/core";

// Only personal data. Identity, sessions, credentials, storage ledgers and schedules stay on the target.
export const SPACE_TABLES = ["records", "entities", "assets", "asset_trash", "day_summaries", "cycle_intimacy_module", "cycle_intimacy_events", "weather_device_locations", "weather_day_cache", "weather_observation"] as const;
export interface SpaceTable { readonly columns: readonly string[]; readonly rows: readonly (readonly SQLInputValue[])[] }
export type SpaceTables = Record<(typeof SPACE_TABLES)[number], SpaceTable>;

export function readSpaceTables(db: DatabaseSync): SpaceTables {
  const tables = {} as SpaceTables;
  db.exec("BEGIN");
  try {
    for (const name of SPACE_TABLES) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => String(row.name));
      const rows = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => columns.map(column => row[column] as SQLInputValue));
      tables[name] = { columns, rows };
    }
    db.exec("COMMIT");
    return tables;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function spaceFingerprint(tables: SpaceTables): string { return createHash("sha256").update(JSON.stringify(tables)).digest("hex"); }

export function validateSpaceTables(db: DatabaseSync, value: unknown): asserts value is SpaceTables {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("空间数据格式无效");
  const tables = value as Record<string, SpaceTable>;
  if (Object.keys(tables).length !== SPACE_TABLES.length || Object.keys(tables).some(name => !SPACE_TABLES.includes(name as typeof SPACE_TABLES[number]))) throw new Error("空间数据包含不支持的表");
  for (const name of SPACE_TABLES) {
    const table = tables[name];
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => String(row.name));
    if (!table || JSON.stringify(table.columns) !== JSON.stringify(columns) || !Array.isArray(table.rows)) throw new Error("数据版本不兼容，请使用相同或更新的 LifeOS 版本");
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== columns.length || row.some(cell => cell !== null && typeof cell !== "string" && !(typeof cell === "number" && Number.isFinite(cell)))) throw new Error("空间数据行无效");
      const object = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
      if (name === "cycle_intimacy_module") assertValidCycleIntimacyModuleConfig(JSON.parse(String(object.config_json)));
      if (name === "assets" || name === "asset_trash") {
        const asset = JSON.parse(String(name === "assets" ? object.value_json : object.asset_json));
        assertValidAsset(asset);
        if (asset.id !== (name === "assets" ? object.id : object.asset_id)) throw new Error("资产编号与数据行不一致");
      }
      if (name === "entities") {
        const entity = JSON.parse(String(object.value_json)); assertValidEntity(entity);
        if (entity.id !== object.id) throw new Error("人物地点编号与数据行不一致");
      }
      if (name === "records") {
        const time = (field: string) => object[field] === null ? undefined : JSON.parse(String(object[field]));
        assertValidTimelineRecord({ id: object.id, kind: object.kind, body: time("body_json"), createdAt: time("created_at_json"), ...(object.updated_at_json === null ? {} : { updatedAt: time("updated_at_json") }), ...(object.occurred_at_json === null ? {} : { occurredAt: time("occurred_at_json") }), ...(object.weather_json === null ? {} : { weather: time("weather_json") }), entityRefs: time("entity_refs_json"), relatedRecordIds: time("related_record_ids_json"), assetRefs: time("asset_refs_json"), aiDerived: time("ai_derived_json"), ...(object.task_json === null ? {} : { task: time("task_json") }), ...(object.note_json === null ? {} : { note: time("note_json") }), isPrivate: object.is_private === 1, isDemo: object.is_demo === 1, isBackfill: object.is_backfill === 1 });
      }
    }
  }
}

export function replaceSpaceTables(db: DatabaseSync, tables: SpaceTables, expected: string): void {
  validateSpaceTables(db, tables);
  db.exec("BEGIN IMMEDIATE");
  try {
    // This check runs under the same write transaction as replacement.
    const current = {} as SpaceTables;
    for (const name of SPACE_TABLES) {
      const columns = tables[name].columns;
      current[name] = { columns, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => columns.map(column => row[column] as SQLInputValue)) };
    }
    if (spaceFingerprint(current) !== expected) throw new Error("当前空间已发生变化，请重新校验导入包");
    for (const name of SPACE_TABLES) {
      const table = tables[name];
      db.exec(`DELETE FROM ${name}`);
      const insert = db.prepare(`INSERT INTO ${name} (${table.columns.join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`);
      for (const row of table.rows) insert.run(...row);
    }
    // Undo tokens and derived reminder labels must not refer to the previous data.
    db.exec("DELETE FROM cycle_intimacy_day_edit_undo");
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_batches'").get()) db.exec("DELETE FROM assistant_batches");
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_task_labels'").get()) db.exec("DELETE FROM calendar_task_labels");
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_days'").get()) db.exec("DELETE FROM calendar_days");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function spaceCounts(tables: SpaceTables) {
  const deleted = tables.records.columns.indexOf("deleted_at_json");
  return { records: tables.records.rows.length, deletedRecords: tables.records.rows.filter(row => row[deleted] !== null).length, entities: tables.entities.rows.length, assets: tables.assets.rows.length, trashedAssets: tables.asset_trash.rows.filter(row => row[tables.asset_trash.columns.indexOf("restored_at")] === null && row[tables.asset_trash.columns.indexOf("purged_at")] === null).length, summaries: tables.day_summaries.rows.length, cycleEvents: tables.cycle_intimacy_events.rows.length };
}
