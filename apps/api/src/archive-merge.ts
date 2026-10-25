import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { SPACE_TABLES, type SpaceTable, type SpaceTables } from "./portable-space.js";

/**
 * Archive v2: selective export + incremental merge.
 *
 * Nothing here deletes or overwrites target content. Every decision is either
 * "add", "skip because the same thing is already there" or "conflict, keep the
 * target and tell the owner". The only destructive operation lives in the
 * explicit batch undo.
 */

export const ARCHIVE_CATEGORIES = ["journal", "task", "event", "note", "entity", "summary", "cycle", "asset"] as const;
export type ArchiveCategory = (typeof ARCHIVE_CATEGORIES)[number];

export interface ArchiveSelection {
  readonly categories: readonly ArchiveCategory[];
  readonly from?: string;
  readonly to?: string;
}

export interface ArchiveFileLike { readonly assetId: string; readonly trash: boolean; readonly sha256: string }

const CATEGORY_SET = new Set<string>(ARCHIVE_CATEGORIES);
const SHANGHAI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

function dateField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name}需为 YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${name}不是有效日期`);
  return value;
}

export function parseSelection(value: unknown): ArchiveSelection {
  if (value === undefined || value === null) return { categories: [...ARCHIVE_CATEGORIES] };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("导出范围无效");
  const record = value as Record<string, unknown>;
  const raw = record.categories;
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("导出范围无效");
  const categories: ArchiveCategory[] = [];
  for (const item of (raw ?? ARCHIVE_CATEGORIES) as unknown[]) {
    if (typeof item !== "string" || !CATEGORY_SET.has(item)) throw new Error("导出范围包含未知分类");
    if (!categories.includes(item as ArchiveCategory)) categories.push(item as ArchiveCategory);
  }
  if (!categories.length) throw new Error("请至少选择一类内容");
  const from = dateField(record.from, "开始日期"), to = dateField(record.to, "结束日期");
  if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
  return { categories, ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

export function parseSelectionQuery(params: URLSearchParams): ArchiveSelection {
  const categories = params.get("categories");
  return parseSelection({
    categories: categories === null || categories === "" ? [...ARCHIVE_CATEGORIES] : categories.split(",").filter(Boolean),
    ...(params.get("from") === null ? {} : { from: params.get("from") }),
    ...(params.get("to") === null ? {} : { to: params.get("to") }),
  });
}

export function isCompleteSelection(selection: ArchiveSelection): boolean {
  return ARCHIVE_CATEGORIES.every(category => selection.categories.includes(category)) && !selection.from && !selection.to;
}

// ---------------------------------------------------------------------------
// Row helpers

export function rowObject<T extends keyof SpaceTables>(tables: SpaceTables, name: T, row: readonly SQLInputValue[]): Record<string, SQLInputValue> {
  return Object.fromEntries(tables[name].columns.map((column, index) => [column, row[index] ?? null]));
}

function jsonCell(value: SQLInputValue | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function arrayOf(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }

function stable(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stable(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

/** Fingerprint of one stored row, independent of physical column order. */
export function tableRowFingerprint(table: SpaceTable, row: readonly SQLInputValue[]): string {
  const object = Object.fromEntries(table.columns.map((column, index) => [column, row[index] ?? null]));
  return createHash("sha256").update(stable(object)).digest("hex");
}

export function spaceRowKey(name: keyof SpaceTables, object: Record<string, SQLInputValue>): string | null {
  const text = (key: string) => object[key] === null || object[key] === undefined ? null : String(object[key]);
  switch (name) {
    case "records": case "entities": case "assets": case "note_folders": case "note_versions": case "cycle_intimacy_events":
      return text("id");
    case "asset_trash": return text("asset_id");
    case "day_summaries": return text("date");
    case "cycle_intimacy_module": return text("id");
    case "weather_device_locations": return text("device_id");
    case "weather_day_cache": { const date = text("date"), location = text("location_key"); return date === null || location === null ? null : `${date}\u0000${location}`; }
    case "weather_observation": { const date = text("date"), hour = text("hour"), location = text("location_key"), source = text("source"); return date === null || hour === null || location === null || source === null ? null : `${date}\u0000${hour}\u0000${location}\u0000${source}`; }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Time and content normalization

function lifeTimeDay(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const time = value as Record<string, unknown>;
  if (typeof time.value !== "string") return null;
  if (time.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(time.value) ? time.value : null;
  if (time.kind === "local") return /^\d{4}-\d{2}-\d{2}/.test(time.value) ? time.value.slice(0, 10) : null;
  if (time.kind === "instant") {
    const parsed = new Date(time.value);
    return Number.isNaN(parsed.getTime()) ? null : SHANGHAI_DAY.format(parsed);
  }
  return null;
}

export function recordDay(object: Record<string, SQLInputValue>): string | null {
  return lifeTimeDay(jsonCell(object.occurred_at_json)) ?? lifeTimeDay(jsonCell(object.created_at_json));
}

function contentHashOfCell(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const refs = arrayOf((value as Record<string, unknown>).storageRefs);
  for (const ref of refs) {
    const hash = (ref as Record<string, unknown> | null)?.contentHash as Record<string, unknown> | undefined;
    if (hash && hash.algorithm === "sha256" && typeof hash.value === "string") return hash.value;
  }
  return undefined;
}

export function entityNameMap(tables: SpaceTables): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of tables.entities.rows) {
    const object = rowObject(tables, "entities", row);
    const entity = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (entity && typeof entity.id === "string" && typeof entity.name === "string") map.set(entity.id, entity.name.trim());
  }
  return map;
}

export function assetHashMap(tables: SpaceTables, files: readonly ArchiveFileLike[] = []): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) if (!file.trash) map.set(file.assetId, file.sha256);
  for (const row of tables.assets.rows) {
    const object = rowObject(tables, "assets", row);
    const id = object.id === null || object.id === undefined ? null : String(object.id);
    if (id !== null && !map.has(id)) {
      const hash = contentHashOfCell(jsonCell(object.value_json));
      if (hash) map.set(id, hash);
    }
  }
  for (const file of files) if (file.trash) map.set(file.assetId, file.sha256);
  for (const row of tables.asset_trash.rows) {
    const object = rowObject(tables, "asset_trash", row);
    const id = object.asset_id === null || object.asset_id === undefined ? null : String(object.asset_id);
    if (id !== null && !map.has(id)) {
      const hash = contentHashOfCell(jsonCell(object.asset_json));
      if (hash) map.set(id, hash);
    }
  }
  return map;
}

function normalizeBody(body: unknown, names: ReadonlyMap<string, string>, hashes: ReadonlyMap<string, string>): unknown {
  if (!body || typeof body !== "object") return body;
  const copy = structuredClone(body) as Record<string, unknown>;
  if (Array.isArray(copy.entityMentions)) {
    copy.entityMentions = copy.entityMentions.map(item => {
      if (!item || typeof item !== "object") return item;
      const mention = { ...(item as Record<string, unknown>) };
      if (typeof mention.entityId === "string") mention.entityId = names.get(mention.entityId) ?? mention.entityId;
      return mention;
    });
  }
  if (Array.isArray(copy.transcriptRaw)) {
    copy.transcriptRaw = copy.transcriptRaw.map(item => {
      if (!item || typeof item !== "object") return item;
      const transcript = { ...(item as Record<string, unknown>) };
      if (typeof transcript.assetId === "string") transcript.assetId = hashes.get(transcript.assetId) ?? transcript.assetId;
      return transcript;
    });
  }
  return copy;
}

function normalizeTime(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const time = value as Record<string, unknown>;
  return { kind: time.kind ?? null, value: time.value ?? null };
}

/**
 * Identity of a record's content, independent of its database id: kind,
 * normalized body, its own captured time, entity names and photo hashes.
 * When a record carries no explicit time, the exact creation instant is used
 * so that only a byte-for-byte copy can collide.
 */
export function recordFingerprint(object: Record<string, SQLInputValue>, names: ReadonlyMap<string, string>, hashes: ReadonlyMap<string, string>): string {
  const body = normalizeBody(jsonCell(object.body_json), names, hashes);
  const entities = arrayOf(jsonCell(object.entity_refs_json)).map(ref => {
    const item = ref as Record<string, unknown> | null;
    return `${String(item?.entityType ?? "")}:${names.get(String(item?.entityId ?? "")) ?? String(item?.entityId ?? "")}`;
  }).sort();
  const assets = arrayOf(jsonCell(object.asset_refs_json)).map(ref => {
    const item = ref as Record<string, unknown> | null;
    return `${String(item?.role ?? "")}:${hashes.get(String(item?.assetId ?? "")) ?? "missing"}`;
  }).sort();
  const occurred = object.occurred_at_json === null || object.occurred_at_json === undefined ? null : normalizeTime(jsonCell(object.occurred_at_json));
  return createHash("sha256").update(stable([
    String(object.kind ?? ""), body,
    occurred ?? { created: normalizeTime(jsonCell(object.created_at_json)) }, entities, assets,
  ])).digest("hex");
}

export function recordFingerprints(tables: SpaceTables, files: readonly ArchiveFileLike[] = []): Map<string, string> {
  const names = entityNameMap(tables), hashes = assetHashMap(tables, files), map = new Map<string, string>();
  for (const row of tables.records.rows) {
    const object = rowObject(tables, "records", row);
    if (object.id !== null && object.id !== undefined) map.set(String(object.id), recordFingerprint(object, names, hashes));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Selective export

export interface SelectedSpace { readonly tables: SpaceTables; readonly complete: boolean; readonly selection: ArchiveSelection }

function copyTable(table: SpaceTable, rows: readonly (readonly SQLInputValue[])[]): SpaceTable { return { columns: table.columns, rows }; }

export function selectSpaceTables(tables: SpaceTables, selection: ArchiveSelection): SelectedSpace {
  const complete = isCompleteSelection(selection);
  const categories = new Set<string>(selection.categories);
  const inRange = (day: string | null): boolean =>
    !selection.from && !selection.to ? true
      : day !== null && (!selection.from || day >= selection.from) && (!selection.to || day <= selection.to);

  const records: (readonly SQLInputValue[])[] = [];
  const entityIds = new Set<string>();
  const assetIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const row of tables.records.rows) {
    const object = rowObject(tables, "records", row);
    const kind = String(object.kind ?? "");
    if (!categories.has(kind) || !inRange(recordDay(object))) continue;
    records.push(row);
    if (kind === "note") noteIds.add(String(object.id));
    for (const ref of arrayOf(jsonCell(object.entity_refs_json))) {
      const id = (ref as Record<string, unknown> | null)?.entityId;
      if (typeof id === "string") entityIds.add(id);
    }
    for (const mention of arrayOf((jsonCell(object.body_json) as Record<string, unknown> | null)?.entityMentions)) {
      const id = (mention as Record<string, unknown> | null)?.entityId;
      if (typeof id === "string") entityIds.add(id);
    }
    for (const ref of arrayOf(jsonCell(object.asset_refs_json))) {
      const id = (ref as Record<string, unknown> | null)?.assetId;
      if (typeof id === "string") assetIds.add(id);
    }
    for (const transcript of arrayOf((jsonCell(object.body_json) as Record<string, unknown> | null)?.transcriptRaw)) {
      const id = (transcript as Record<string, unknown> | null)?.assetId;
      if (typeof id === "string") assetIds.add(id);
    }
  }

  const entityById = new Map<string, { row: readonly SQLInputValue[]; object: Record<string, SQLInputValue>; entity: Record<string, unknown> }>();
  for (const row of tables.entities.rows) {
    const object = rowObject(tables, "entities", row);
    const entity = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (entity && typeof entity.id === "string") entityById.set(entity.id, { row, object, entity });
  }
  let entityRows: readonly (readonly SQLInputValue[])[];
  if (categories.has("entity")) entityRows = tables.entities.rows;
  else {
    const keep = new Set(entityIds), queue = [...entityIds];
    while (queue.length) {
      const current = entityById.get(queue.pop()!);
      if (!current) continue;
      for (const relation of arrayOf(current.entity.relations)) {
        const id = (relation as Record<string, unknown> | null)?.entityId;
        if (typeof id === "string" && !keep.has(id) && entityById.has(id)) { keep.add(id); queue.push(id); }
      }
    }
    entityRows = tables.entities.rows.filter(row => keep.has(String(rowObject(tables, "entities", row).id)));
  }
  for (const row of entityRows) {
    const avatar = (jsonCell(rowObject(tables, "entities", row).value_json) as Record<string, unknown> | null)?.avatarAssetId;
    if (typeof avatar === "string") assetIds.add(avatar);
  }

  const assetRows = categories.has("asset") ? tables.assets.rows : tables.assets.rows.filter(row => {
    const id = rowObject(tables, "assets", row).id;
    return id !== null && id !== undefined && assetIds.has(String(id));
  });

  const summaryRows = categories.has("summary") ? tables.day_summaries.rows.filter(row => {
    const object = rowObject(tables, "day_summaries", row);
    const value = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (value?.status !== "manual") return false;
    return inRange(typeof value.date === "string" ? value.date : String(object.date ?? ""));
  }) : [];

  const cycleRows = categories.has("cycle") ? tables.cycle_intimacy_events.rows.filter(row => inRange(String(rowObject(tables, "cycle_intimacy_events", row).date ?? ""))) : [];
  const moduleRows = categories.has("cycle") ? tables.cycle_intimacy_module.rows : [];

  const folderRows: readonly (readonly SQLInputValue[])[] = (() => {
    if (!categories.has("note")) {
      const wanted = new Set<string>();
      for (const row of records) {
        const note = jsonCell(rowObject(tables, "records", row).note_json) as Record<string, unknown> | null;
        if (typeof note?.folderId === "string") wanted.add(note.folderId);
      }
      if (!wanted.size) return [];
      const folders = new Map<string, Record<string, unknown>>();
      for (const row of tables.note_folders.rows) {
        const folder = jsonCell(rowObject(tables, "note_folders", row).value_json) as Record<string, unknown> | null;
        if (folder && typeof folder.id === "string") folders.set(folder.id, folder);
      }
      const result: string[] = [];
      for (const id of wanted) {
        let cursor: Record<string, unknown> | undefined = folders.get(id);
        const trail = new Set<string>();
        while (cursor && typeof cursor.id === "string" && !trail.has(cursor.id)) {
          trail.add(cursor.id);
          if (!wanted.has(cursor.id)) { wanted.add(cursor.id); result.push(cursor.id); }
          cursor = typeof cursor.parentId === "string" ? folders.get(cursor.parentId) : undefined;
        }
      }
      return tables.note_folders.rows.filter(row => wanted.has(String(rowObject(tables, "note_folders", row).id)));
    }
    return tables.note_folders.rows;
  })();
  const versionRows = tables.note_versions.rows.filter(row => noteIds.has(String(rowObject(tables, "note_versions", row).record_id ?? "")));

  return {
    complete, selection,
    tables: {
      records: copyTable(tables.records, records),
      entities: copyTable(tables.entities, entityRows),
      assets: copyTable(tables.assets, assetRows),
      asset_trash: copyTable(tables.asset_trash, complete ? tables.asset_trash.rows : []),
      day_summaries: copyTable(tables.day_summaries, summaryRows),
      cycle_intimacy_module: copyTable(tables.cycle_intimacy_module, moduleRows),
      cycle_intimacy_events: copyTable(tables.cycle_intimacy_events, cycleRows),
      weather_device_locations: copyTable(tables.weather_device_locations, complete ? tables.weather_device_locations.rows : []),
      weather_day_cache: copyTable(tables.weather_day_cache, complete ? tables.weather_day_cache.rows : []),
      weather_observation: copyTable(tables.weather_observation, complete ? tables.weather_observation.rows : []),
      note_folders: copyTable(tables.note_folders, folderRows),
      note_versions: copyTable(tables.note_versions, versionRows),
    },
  };
}

// ---------------------------------------------------------------------------
// Merge plan

export interface MergeConflict { readonly table: string; readonly key: string; readonly label: string; readonly reason: string }
export interface MergeTableSummary { readonly add: number; readonly skip: number; readonly conflict: number }
export interface MergeSummary {
  readonly complete: boolean;
  readonly selection: ArchiveSelection;
  readonly tables: Record<string, MergeTableSummary>;
  readonly files: { readonly write: number; readonly reuse: number };
  readonly strippedReferences: number;
  readonly conflicts: readonly MergeConflict[];
  readonly conflictTotal: number;
}
export interface MergeAssetFile { readonly table: "assets" | "asset_trash"; readonly assetId: string; readonly trash: boolean; readonly fileIndex: number }
export interface MergePlan { readonly summary: MergeSummary; readonly inserts: SpaceTables; readonly assetFiles: readonly MergeAssetFile[] }

function emptyTables(tables: SpaceTables): SpaceTables {
  const result = {} as SpaceTables;
  for (const name of SPACE_TABLES) result[name] = { columns: tables[name].columns, rows: [] };
  return result;
}

function recordLabel(object: Record<string, SQLInputValue>): string {
  const body = jsonCell(object.body_json) as Record<string, unknown> | null;
  const text = typeof body?.edited === "string" && body.edited.trim() ? body.edited : typeof body?.original === "string" ? body.original : "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed ? (trimmed.length > 36 ? `${trimmed.slice(0, 36)}…` : trimmed) : `${String(object.kind ?? "记录")}记录`;
}

export function planMerge(target: SpaceTables, incoming: SpaceTables, archiveFiles: readonly ArchiveFileLike[], selection: ArchiveSelection): MergePlan {
  const stats = new Map<string, { add: number; skip: number; conflict: number }>();
  const stat = (name: string) => { let value = stats.get(name); if (!value) { value = { add: 0, skip: 0, conflict: 0 }; stats.set(name, value); } return value; };
  const conflicts: MergeConflict[] = [];
  const conflict = (table: string, key: string, label: string, reason: string) => { stat(table).conflict += 1; conflicts.push({ table, key, label, reason }); };
  let strippedReferences = 0;

  const incomingNames = entityNameMap(incoming);
  const incomingHashes = assetHashMap(incoming, archiveFiles);
  const targetNames = entityNameMap(target);
  const targetHashes = assetHashMap(target);
  const targetRecordFingerprints = recordFingerprints(target);
  const targetRecordIds = new Set(targetRecordFingerprints.keys());
  const targetFingerprintValues = new Set(targetRecordFingerprints.values());

  const fileIndexFor = new Map<string, number>();
  archiveFiles.forEach((file, index) => fileIndexFor.set(`${file.trash ? "trash" : "asset"}\u0000${file.assetId}`, index));

  // ---- note folders -------------------------------------------------------
  const incomingFolders = new Map<string, Record<string, SQLInputValue>>();
  for (const row of incoming.note_folders.rows) {
    const object = rowObject(incoming, "note_folders", row);
    incomingFolders.set(String(object.id), object);
  }
  const targetFolderById = new Map<string, Record<string, SQLInputValue>>();
  const targetFolderByKey = new Map<string, string>();
  for (const row of target.note_folders.rows) {
    const object = rowObject(target, "note_folders", row);
    const folder = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (!folder || typeof folder.id !== "string") continue;
    targetFolderById.set(folder.id, object);
    targetFolderByKey.set(`${typeof folder.parentId === "string" ? folder.parentId : ""}\u0000${String(folder.name ?? "")}`, folder.id);
  }
  const folderMap = new Map<string, string>();
  const addedFolderRows: (readonly SQLInputValue[])[] = [];
  const resolveFolder = (id: string, trail: Set<string>): string | null => {
    const cached = folderMap.get(id);
    if (cached !== undefined) return cached;
    const object = incomingFolders.get(id);
    if (!object || trail.has(id)) return null;
    trail.add(id);
    const folder = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (!folder || typeof folder.name !== "string") return null;
    let parentId = typeof folder.parentId === "string" ? resolveFolder(folder.parentId, trail) : null;
    if (typeof folder.parentId === "string" && parentId === null) {
      // The parent was not exported; the folder cannot be attached where it was.
      conflict("note_folders", id, String(folder.name), "上级文件夹不在导入范围内，已放到根目录");
      parentId = null;
    }
    if (targetFolderById.has(id)) {
      const existing = jsonCell(targetFolderById.get(id)!.value_json) as Record<string, unknown> | null;
      if (existing && existing.name === folder.name && (existing.parentId ?? null) === parentId) stat("note_folders").skip += 1;
      else conflict("note_folders", id, String(folder.name), "文件夹编号相同但内容不同，已保留现有文件夹");
      folderMap.set(id, id);
      return id;
    }
    const key = `${parentId ?? ""}\u0000${folder.name}`;
    const existing = targetFolderByKey.get(key);
    if (existing) {
      stat("note_folders").skip += 1;
      folderMap.set(id, existing);
      return existing;
    }
    const row: Record<string, SQLInputValue> = { ...object, value_json: JSON.stringify({ ...folder, parentId }) };
    addedFolderRows.push(incoming.note_folders.columns.map(column => row[column] ?? null));
    folderMap.set(id, id);
    targetFolderByKey.set(key, id);
    stat("note_folders").add += 1;
    return id;
  };
  for (const id of incomingFolders.keys()) resolveFolder(id, new Set());

  // ---- entities -----------------------------------------------------------
  const targetEntityById = new Map<string, Record<string, SQLInputValue>>();
  const targetEntityByKey = new Map<string, string>();
  for (const row of target.entities.rows) {
    const object = rowObject(target, "entities", row);
    const entity = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (!entity || typeof entity.id !== "string") continue;
    targetEntityById.set(entity.id, object);
    const key = `${String(entity.type ?? "")}\u0000${String(entity.name ?? "").trim()}`;
    if (!targetEntityByKey.has(key)) targetEntityByKey.set(key, entity.id);
  }
  const entityMap = new Map<string, string>();
  const addedEntities: { object: Record<string, SQLInputValue>; entity: Record<string, unknown> }[] = [];
  for (const row of incoming.entities.rows) {
    const object = rowObject(incoming, "entities", row);
    const entity = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (!entity || typeof entity.id !== "string") continue;
    const existing = targetEntityById.get(entity.id);
    if (existing) {
      const same = stable(jsonCell(existing.value_json)) === stable(entity) && String(existing.address ?? "") === String(object.address ?? "");
      if (same) stat("entities").skip += 1;
      else conflict("entities", entity.id, String(entity.name ?? entity.id), "人物地点编号相同但内容不同，已保留现有资料");
      entityMap.set(entity.id, entity.id);
      continue;
    }
    const key = `${String(entity.type ?? "")}\u0000${String(entity.name ?? "").trim()}`;
    const matched = targetEntityByKey.get(key);
    if (matched) {
      stat("entities").skip += 1;
      entityMap.set(entity.id, matched);
      continue;
    }
    entityMap.set(entity.id, entity.id);
    addedEntities.push({ object, entity });
    stat("entities").add += 1;
  }

  // ---- assets -------------------------------------------------------------
  const targetAssetById = new Map<string, Record<string, SQLInputValue>>();
  const targetAssetByHash = new Map<string, string>();
  for (const row of target.assets.rows) {
    const object = rowObject(target, "assets", row);
    const id = object.id === null || object.id === undefined ? null : String(object.id);
    if (id === null) continue;
    targetAssetById.set(id, object);
    const hash = contentHashOfCell(jsonCell(object.value_json));
    if (hash && !targetAssetByHash.has(hash)) targetAssetByHash.set(hash, id);
  }
  const assetMap = new Map<string, string>();
  const assetFiles: MergeAssetFile[] = [];
  const addedAssets: { object: Record<string, SQLInputValue>; asset: Record<string, unknown>; hash: string }[] = [];
  let reusedAssets = 0;
  for (const row of incoming.assets.rows) {
    const object = rowObject(incoming, "assets", row);
    const asset = jsonCell(object.value_json) as Record<string, unknown> | null;
    if (!asset || typeof asset.id !== "string") continue;
    const hash = incomingHashes.get(asset.id) ?? "";
    const existing = targetAssetById.get(asset.id);
    if (existing) {
      const existingAsset = jsonCell(existing.value_json);
      const existingHash = contentHashOfCell(existingAsset);
      const same = existingHash && hash ? existingHash === hash : stable(existingAsset) === stable(asset);
      if (same) stat("assets").skip += 1;
      else conflict("assets", asset.id, String(asset.originalName ?? asset.id), "原件编号相同但内容不同，已保留现有原件");
      assetMap.set(asset.id, asset.id);
      continue;
    }
    const matched = hash ? targetAssetByHash.get(hash) : undefined;
    if (matched) {
      stat("assets").skip += 1;
      reusedAssets += 1;
      assetMap.set(asset.id, matched);
      continue;
    }
    if (hash && targetAssetByHash.has(hash)) {
      // A duplicate inside the same archive: reuse the copy already planned.
      stat("assets").skip += 1;
      reusedAssets += 1;
      assetMap.set(asset.id, targetAssetByHash.get(hash)!);
      continue;
    }
    const index = fileIndexFor.get(`asset\u0000${asset.id}`);
    if (index === undefined) throw new Error("完整包资产清单不一致");
    if (hash) targetAssetByHash.set(hash, asset.id);
    assetMap.set(asset.id, asset.id);
    addedAssets.push({ object, asset, hash });
    assetFiles.push({ table: "assets", assetId: asset.id, trash: false, fileIndex: index });
    stat("assets").add += 1;
  }
  // Purchased/free trash rows travel only with the full package.
  const targetTrashIds = new Set(target.asset_trash.rows.map(row => String(rowObject(target, "asset_trash", row).asset_id ?? "")));
  const addedTrash: { object: Record<string, SQLInputValue>; asset: Record<string, unknown> }[] = [];
  for (const row of incoming.asset_trash.rows) {
    const object = rowObject(incoming, "asset_trash", row);
    const asset = jsonCell(object.asset_json) as Record<string, unknown> | null;
    if (!asset || typeof asset.id !== "string") continue;
    if (targetTrashIds.has(asset.id)) { stat("asset_trash").skip += 1; continue; }
    const index = fileIndexFor.get(`trash\u0000${asset.id}`);
    addedTrash.push({ object, asset });
    stat("asset_trash").add += 1;
    if (index !== undefined) {
      assetFiles.push({ table: "asset_trash", assetId: asset.id, trash: true, fileIndex: index });
      if (!assetMap.has(asset.id)) assetMap.set(asset.id, asset.id);
    }
  }

  // ---- records ------------------------------------------------------------
  const addedRecords: { object: Record<string, SQLInputValue>; id: string }[] = [];
  const addedRecordIds = new Set<string>();
  for (const row of incoming.records.rows) {
    const object = rowObject(incoming, "records", row);
    const id = String(object.id);
    const fingerprint = recordFingerprint(object, incomingNames, incomingHashes);
    if (targetRecordIds.has(id)) {
      if (targetRecordFingerprints.get(id) === fingerprint) stat("records").skip += 1;
      else conflict("records", id, recordLabel(object), "记录编号相同但内容不同，已保留现有记录");
      continue;
    }
    if (targetFingerprintValues.has(fingerprint)) { stat("records").skip += 1; continue; }
    addedRecords.push({ object, id });
    addedRecordIds.add(id);
    stat("records").add += 1;
  }
  const knownRecords = new Set([...targetRecordIds, ...addedRecordIds]);

  // ---- summaries, cycle, weather, note versions ---------------------------
  const targetSummaryDates = new Set(target.day_summaries.rows.map(row => String(rowObject(target, "day_summaries", row).date ?? "")));
  const addedSummaries: (readonly SQLInputValue[])[] = [];
  for (const row of incoming.day_summaries.rows) {
    const object = rowObject(incoming, "day_summaries", row);
    const date = String(object.date ?? "");
    if (targetSummaryDates.has(date)) {
      const targetRow = target.day_summaries.rows.find(item => String(rowObject(target, "day_summaries", item).date ?? "") === date)!;
      const targetObject = rowObject(target, "day_summaries", targetRow);
      if (stable(jsonCell(targetObject.value_json)) === stable(jsonCell(object.value_json))) stat("day_summaries").skip += 1;
      else conflict("day_summaries", date, date, "同一天已有不同的小结，已保留现有小结");
      continue;
    }
    addedSummaries.push(row);
    stat("day_summaries").add += 1;
  }

  const addedModules: (readonly SQLInputValue[])[] = [];
  for (const row of incoming.cycle_intimacy_module.rows) {
    if (target.cycle_intimacy_module.rows.length) {
      const targetConfig = rowObject(target, "cycle_intimacy_module", target.cycle_intimacy_module.rows[0]!).config_json;
      if (String(targetConfig) === String(rowObject(incoming, "cycle_intimacy_module", row).config_json)) stat("cycle_intimacy_module").skip += 1;
      else conflict("cycle_intimacy_module", "1", "周期设置", "周期设置已存在且不同，已保留当前设置");
      continue;
    }
    addedModules.push(row);
    stat("cycle_intimacy_module").add += 1;
  }

  const targetCycleKeys = new Set(target.cycle_intimacy_events.rows.map(row => { const object = rowObject(target, "cycle_intimacy_events", row); return `${object.date}\u0000${object.kind}`; }));
  const addedCycles: (readonly SQLInputValue[])[] = [];
  for (const row of incoming.cycle_intimacy_events.rows) {
    const object = rowObject(incoming, "cycle_intimacy_events", row);
    const key = `${object.date}\u0000${object.kind}`;
    if (targetCycleKeys.has(key)) { stat("cycle_intimacy_events").skip += 1; continue; }
    addedCycles.push(row);
    stat("cycle_intimacy_events").add += 1;
  }

  const mergeKeyed = (name: "weather_device_locations" | "weather_day_cache" | "weather_observation", targetRows: SpaceTable["rows"], incomingRows: SpaceTable["rows"]) => {
    const targetKeys = new Set(targetRows.map(row => spaceRowKey(name, rowObject(target, name, row))));
    const added: (readonly SQLInputValue[])[] = [];
    for (const row of incomingRows) {
      const key = spaceRowKey(name, rowObject(incoming, name, row));
      if (key !== null && targetKeys.has(key)) { stat(name).skip += 1; continue; }
      added.push(row);
      stat(name).add += 1;
    }
    return added;
  };
  const addedWeatherDevices = mergeKeyed("weather_device_locations", target.weather_device_locations.rows, incoming.weather_device_locations.rows);
  const addedWeatherDays = mergeKeyed("weather_day_cache", target.weather_day_cache.rows, incoming.weather_day_cache.rows);
  const addedWeatherObservations = mergeKeyed("weather_observation", target.weather_observation.rows, incoming.weather_observation.rows);

  const targetVersionKeys = new Set(target.note_versions.rows.map(row => { const object = rowObject(target, "note_versions", row); return `${object.record_id}\u0000${object.revision}`; }));
  const addedVersions: (readonly SQLInputValue[])[] = [];
  for (const row of incoming.note_versions.rows) {
    const object = rowObject(incoming, "note_versions", row);
    if (!addedRecordIds.has(String(object.record_id))) { stat("note_versions").skip += 1; continue; }
    const key = `${object.record_id}\u0000${object.revision}`;
    if (targetVersionKeys.has(key)) { stat("note_versions").skip += 1; continue; }
    addedVersions.push(row);
    stat("note_versions").add += 1;
  }

  // ---- build inserted rows with remapped references -----------------------
  const remapEntityRefs = (value: unknown): unknown[] => {
    const result: unknown[] = [];
    for (const ref of arrayOf(value)) {
      const item = ref as Record<string, unknown> | null;
      if (!item || typeof item.entityId !== "string") continue;
      const mapped = entityMap.get(item.entityId);
      if (!mapped) { strippedReferences += 1; continue; }
      result.push({ ...item, entityId: mapped });
    }
    return result;
  };
  const remapAssetRefs = (value: unknown): unknown[] => {
    const result: unknown[] = [];
    for (const ref of arrayOf(value)) {
      const item = ref as Record<string, unknown> | null;
      if (!item || typeof item.assetId !== "string") continue;
      const mapped = assetMap.get(item.assetId);
      if (!mapped) { strippedReferences += 1; continue; }
      result.push({ ...item, assetId: mapped });
    }
    return result;
  };
  const remapBody = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const body = { ...(value as Record<string, unknown>) };
    if (Array.isArray(body.entityMentions)) body.entityMentions = body.entityMentions.map(item => {
      const mention = item && typeof item === "object" ? { ...(item as Record<string, unknown>) } : item;
      if (!mention || typeof mention !== "object") return mention;
      if (typeof (mention as Record<string, unknown>).entityId !== "string") return mention;
      const id = String((mention as Record<string, unknown>).entityId);
      const mapped = entityMap.get(id);
      if (!mapped) strippedReferences += 1;
      (mention as Record<string, unknown>).entityId = mapped ?? null;
      return mention;
    });
    if (Array.isArray(body.transcriptRaw)) {
      const transcript: unknown[] = [];
      for (const item of body.transcriptRaw) {
        if (!item || typeof item !== "object") continue;
        const entry = { ...(item as Record<string, unknown>) };
        if (typeof entry.assetId === "string") {
          const mapped = assetMap.get(entry.assetId);
          if (!mapped) { strippedReferences += 1; continue; }
          entry.assetId = mapped;
        }
        transcript.push(entry);
      }
      body.transcriptRaw = transcript;
    }
    return body;
  };

  const recordRows: (readonly SQLInputValue[])[] = [];
  for (const added of addedRecords) {
    const next: Record<string, SQLInputValue> = { ...added.object };
    next.entity_refs_json = JSON.stringify(remapEntityRefs(jsonCell(added.object.entity_refs_json)));
    next.asset_refs_json = JSON.stringify(remapAssetRefs(jsonCell(added.object.asset_refs_json)));
    next.body_json = JSON.stringify(remapBody(jsonCell(added.object.body_json)));
    const related = arrayOf(jsonCell(added.object.related_record_ids_json)).filter(id => typeof id === "string" && knownRecords.has(id));
    if (related.length !== arrayOf(jsonCell(added.object.related_record_ids_json)).length) strippedReferences += 1;
    next.related_record_ids_json = JSON.stringify(related);
    if (added.object.note_json !== null && added.object.note_json !== undefined) {
      const note = jsonCell(added.object.note_json) as Record<string, unknown> | null;
      if (note && typeof note.folderId === "string") {
        const mapped = folderMap.get(note.folderId);
        if (mapped) next.note_json = JSON.stringify({ ...note, folderId: mapped });
        else {
          const { folderId: _folderId, ...rest } = note;
          next.note_json = JSON.stringify(rest);
          strippedReferences += 1;
        }
      }
    }
    recordRows.push(incoming.records.columns.map(column => next[column] ?? null));
  }

  const entityRows: (readonly SQLInputValue[])[] = addedEntities.map(added => {
    const entity: Record<string, unknown> = { ...added.entity };
    if (Array.isArray(entity.relations)) {
      const relations: unknown[] = [];
      for (const relation of entity.relations) {
        const item = relation as Record<string, unknown> | null;
        if (!item || typeof item.entityId !== "string") continue;
        const mapped = entityMap.get(item.entityId);
        if (!mapped) { strippedReferences += 1; continue; }
        relations.push({ ...item, entityId: mapped });
      }
      entity.relations = relations;
    }
    if (typeof entity.avatarAssetId === "string") {
      const mapped = assetMap.get(entity.avatarAssetId);
      if (mapped) entity.avatarAssetId = mapped;
      else { delete entity.avatarAssetId; strippedReferences += 1; }
    }
    const next: Record<string, SQLInputValue> = { ...added.object, value_json: JSON.stringify(entity) };
    return incoming.entities.columns.map(column => next[column] ?? null);
  });

  // Asset rows keep their ids; the service rewrites storageRefs when it stores
  // new bytes. Reused assets are not inserted at all.
  const assetRows: (readonly SQLInputValue[])[] = addedAssets.map(added => incoming.assets.columns.map(column => added.object[column] ?? null));
  const trashRows: (readonly SQLInputValue[])[] = addedTrash.map(added => incoming.asset_trash.columns.map(column => added.object[column] ?? null));

  const inserts = emptyTables(incoming);
  inserts.records.rows = recordRows;
  inserts.entities.rows = entityRows;
  inserts.assets.rows = assetRows;
  inserts.asset_trash.rows = trashRows;
  inserts.day_summaries.rows = addedSummaries;
  inserts.cycle_intimacy_module.rows = addedModules;
  inserts.cycle_intimacy_events.rows = addedCycles;
  inserts.weather_device_locations.rows = addedWeatherDevices;
  inserts.weather_day_cache.rows = addedWeatherDays;
  inserts.weather_observation.rows = addedWeatherObservations;
  inserts.note_folders.rows = addedFolderRows;
  inserts.note_versions.rows = addedVersions;

  const tables: Record<string, MergeTableSummary> = {};
  for (const name of SPACE_TABLES) tables[name] = { add: 0, skip: 0, conflict: 0 };
  for (const [name, value] of stats) tables[name] = value;

  return {
    summary: {
      complete: isCompleteSelection(selection),
      selection,
      tables,
      files: { write: assetFiles.length, reuse: reusedAssets },
      strippedReferences,
      conflicts: conflicts.slice(0, 50),
      conflictTotal: conflicts.length,
    },
    inserts,
    assetFiles,
  };
}
