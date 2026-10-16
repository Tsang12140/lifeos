import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import {
  assertValidAssetLink,
  assertValidEntityRef,
  assertValidNoteDetails,
  assertValidStorageReference,
  assertValidWeatherAttachment,
  assertValidTextEntityDecisions,
  rebaseEntityDecisions,
  resolveTextEntityMentions,
  type Asset,
  type AssetLink,
  type AssetRole,
  type EntityRef,
  type ExportBundleV1,
  type NoteDetails,
  type StorageReference,
  type TaskStatus,
  type TimelineRecord,
  type WeatherAttachment,
  type TextEntityDecision,
} from "@lifeos/core";
import type { ApiConfig } from "./config.js";
import type { RecordView, SqliteRecordRepository } from "./repository.js";
import { HttpError } from "./http-kit.js";
import {
  type JsonObject,
  booleanField,
  enumField,
  hasOnlyKeys,
  jsonObject,
  nowInstant,
  parseLifeTime,
  parseNoteDetails,
  revisionField,
  stringField,
} from "./field-validate.js";

const RECORD_KINDS: readonly string[] = ["journal", "task", "event", "note"];
const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "cancelled"];
const ASSET_KINDS: readonly string[] = ["photo", "audio", "video", "file"];

function withMentionRefs(text: string, refs: readonly EntityRef[], repository: SqliteRecordRepository, decisions: readonly TextEntityDecision[] = []): readonly EntityRef[] {
  const entities = repository.listEntities();
  const found = resolveTextEntityMentions(text, entities, decisions);
  const seen = new Set(refs.map((ref) => ref.entityType + ":" + ref.entityId));
  const merged = [...refs];
  for (const mention of found) {
    const key = mention.entityType + ":" + mention.entityId;
    if (seen.has(key)) continue;
    seen.add(key);
    const entity = entities.find((item) => item.id === mention.entityId);
    merged.push({ entityType: mention.entityType, entityId: mention.entityId, ...(entity ? { label: entity.name } : {}) });
  }
  return merged;
}

export { withMentionRefs };

function entityDecisionsField(value: unknown, text: string, repository: SqliteRecordRepository): readonly TextEntityDecision[] {
  return coreValidated("entityMentions", () => {
    assertValidTextEntityDecisions(value, text);
    for (const decision of value) {
      if (decision.entityId === null) continue;
      const entity = repository.findEntityById(decision.entityId);
      if (entity === null || entity.type !== decision.entityType) throw new HttpError(400, "unknown_entity", "标记关联的对象不存在或类型不符");
    }
    return value;
  });
}

export function buildRecord(input: JsonObject, repository: SqliteRecordRepository): TimelineRecord {
  hasOnlyKeys(input, ["kind", "content", "entityMentions", "occurredAt", "dueAt", "isPrivate", "isDemo", "isBackfill", "weather", "note", "entityRefs", "relatedRecordIds", "assetRefs"]);
  const kind = enumField(input.kind, RECORD_KINDS, "kind");
  const content = stringField(input.content, "content");
  const decisions = input.entityMentions === undefined ? undefined : entityDecisionsField(input.entityMentions, content, repository);
  if (input.occurredAt !== undefined && input.occurredAt === null) throw new HttpError(400, "invalid_time", "occurredAt cannot be null on create");
  if (input.dueAt !== undefined && kind !== "task") throw new HttpError(400, "invalid_field", "dueAt is only valid for task records");
  const occurredAt = input.occurredAt === undefined ? undefined : parseLifeTime(input.occurredAt, "occurredAt");
  const dueAt = input.dueAt === undefined ? undefined : parseLifeTime(input.dueAt, "dueAt");
  const isPrivate = input.isPrivate === undefined ? undefined : booleanField(input.isPrivate, "isPrivate");
  const isDemo = input.isDemo === undefined ? undefined : booleanField(input.isDemo, "isDemo");
  const isBackfill = input.isBackfill === undefined ? undefined : booleanField(input.isBackfill, "isBackfill");
  const weather = input.weather === undefined ? undefined : coreValidated("weather", () => {
    assertValidWeatherAttachment(input.weather);
    return input.weather as WeatherAttachment;
  });
  const note = input.note === undefined ? undefined : (() => {
    if (kind !== "note") throw new HttpError(400, "invalid_field", "note is only valid for note records");
    const details = parseNoteDetails(input.note);
    if (details.folderId && !repository.notes.find(details.folderId)) throw new HttpError(400, "unknown_folder", "笔记文件夹不存在");
    return details;
  })();
  const id = randomUUID();
  const explicitRefs = input.entityRefs === undefined ? ([] as const) : entityRefsField(input.entityRefs, repository);
  const common = {
    id,
    createdAt: nowInstant(),
    body: { original: content, ...(decisions === undefined ? {} : { entityMentions: decisions }) },
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(isPrivate === undefined ? {} : { isPrivate }),
    ...(isDemo === undefined ? {} : { isDemo }),
    ...(isBackfill === undefined ? {} : { isBackfill }),
    ...(weather === undefined ? {} : { weather }),
    ...(note === undefined ? {} : { note }),
    entityRefs: withMentionRefs(content, explicitRefs, repository, decisions),
    relatedRecordIds:
      input.relatedRecordIds === undefined ? ([] as const) : relatedRecordIdsField(input.relatedRecordIds, id, repository),
    assetRefs: input.assetRefs === undefined ? ([] as const) : assetRefsField(input.assetRefs, repository),
    aiDerived: [] as const,
  };
  if (kind === "task") return { ...common, kind: "task", task: { status: "todo", ...(dueAt === undefined ? {} : { dueAt }) } };
  if (dueAt !== undefined) throw new HttpError(400, "invalid_field", "dueAt is only valid for task records");
  const record = { ...common, kind } as TimelineRecord;
  repository.notes.assertFolder(record);
  assertJournalDate(record);
  return record;
}

export function patchRecord(
  current: RecordView,
  input: JsonObject,
  repository: SqliteRecordRepository,
): { expectedRevision: number; record: TimelineRecord } {
  hasOnlyKeys(input, ["revision", "content", "entityMentions", "occurredAt", "dueAt", "isPrivate", "isBackfill", "weather", "note", "status", "entityRefs", "relatedRecordIds", "assetRefs"]);
  const expectedRevision = revisionField(input.revision);
  const { revision: _revision, ...base } = current;
  let record: TimelineRecord = base;
  if (Object.hasOwn(input, "isPrivate")) {
    record = { ...record, isPrivate: booleanField(input.isPrivate, "isPrivate") };
  }
  if (Object.hasOwn(input, "isBackfill")) {
    record = { ...record, isBackfill: booleanField(input.isBackfill, "isBackfill") };
  }
  if (Object.hasOwn(input, "weather")) {
    if (input.weather === null) {
      const { weather: _weather, ...withoutWeather } = record;
      record = withoutWeather;
    } else {
      const weather = coreValidated("weather", () => {
        assertValidWeatherAttachment(input.weather);
        return input.weather as WeatherAttachment;
      });
      record = { ...record, weather };
    }
  }
  if (Object.hasOwn(input, "note")) {
    if (record.kind !== "note") throw new HttpError(400, "invalid_field", "note is only valid for note records");
    if (input.note === null) {
      const { note: _note, ...withoutNote } = record;
      record = withoutNote;
    } else {
      record = { ...record, note: parseNoteDetails(input.note) };
    }
  }
  if (input.content !== undefined) {
    const content = stringField(input.content, "content");
    record = { ...record, body: { ...record.body, edited: content, ...(record.body.entityMentions === undefined ? {} : { entityMentions: rebaseEntityDecisions(record.body.edited ?? record.body.original, content, record.body.entityMentions) }) } };
    // A plain-text client must not leave a previous rich-text rendering on screen.
    if(record.kind==="note"&&record.note?.html!==undefined&&!(input.note&&typeof input.note==="object"&&"html" in input.note)){
      const {html:_html,...note}=record.note;record={...record,note};
    }
  }
  if (input.entityMentions !== undefined) {
    const decisions = entityDecisionsField(input.entityMentions, record.body.edited ?? record.body.original, repository);
    record = { ...record, body: { ...record.body, entityMentions: decisions } };
  }
  if (Object.hasOwn(input, "occurredAt")) {
    if (input.occurredAt === null) {
      const { occurredAt: _occurredAt, ...withoutOccurredAt } = record;
      record = withoutOccurredAt;
    } else {
      record = { ...record, occurredAt: parseLifeTime(input.occurredAt, "occurredAt") };
    }
  }
  if (Object.hasOwn(input, "dueAt") || Object.hasOwn(input, "status")) {
    if (record.kind !== "task") throw new HttpError(400, "invalid_field", "dueAt and status are only valid for task records");
    const task = record.task;
    const taskWithoutDueAt = Object.hasOwn(input, "dueAt") && input.dueAt === null
      ? (() => {
          const { dueAt: _dueAt, ...withoutDueAt } = task;
          return withoutDueAt;
        })()
      : task;
    const nextTask = {
      ...taskWithoutDueAt,
      ...(Object.hasOwn(input, "dueAt") && input.dueAt !== null ? { dueAt: parseLifeTime(input.dueAt, "dueAt") } : {}),
      ...(Object.hasOwn(input, "status") ? { status: enumField(input.status, TASK_STATUSES, "status") } : {}),
    };
    record = { ...record, task: nextTask };
  }
  if (input.entityRefs !== undefined) {
    record = { ...record, entityRefs: entityRefsField(input.entityRefs, repository) };
  }
  // Only a write that carries text re-reads the mentions in it, so removing a
  // chip by hand is not undone by an unrelated status change.
  if (input.content !== undefined || input.entityMentions !== undefined) {
    const previousMentions = resolveTextEntityMentions(current.body.edited ?? current.body.original, repository.listEntities(), current.body.entityMentions);
    const managedIds = new Set(previousMentions.map((mention) => mention.entityId));
    // A spelling snapshot is not permission to remove independently reviewed
    // relations (notably assistant entries). Only explicit marking edits do so.
    const refs = input.entityMentions === undefined ? record.entityRefs : record.entityRefs.filter((ref) => !managedIds.has(ref.entityId));
    record = { ...record, entityRefs: withMentionRefs(record.body.edited ?? record.body.original, refs, repository, record.body.entityMentions) };
  }
  if (input.relatedRecordIds !== undefined) {
    record = { ...record, relatedRecordIds: relatedRecordIdsField(input.relatedRecordIds, record.id, repository) };
  }
  if (input.assetRefs !== undefined) {
    record = { ...record, assetRefs: assetRefsField(input.assetRefs, repository) };
  }
  record = { ...record, updatedAt: nowInstant() };
  repository.notes.assertFolder(record);
  assertJournalDate(record);
  return { expectedRevision, record };
}

export function safeId(segment: string): string {
  if (segment.length === 0 || segment.length > 512) throw new HttpError(400, "invalid_id", "Invalid record id");
  return segment;
}

/**
 * The orphan-trash endpoints only mean something when an asset root is
 * configured: without one there are no LifeOS-owned uploads to collect.
 */
export function requireAssetRoot(config: ApiConfig): string {
  const root = config.assetRoot;
  if (root === undefined || root === "") {
    throw new HttpError(404, "asset_root_missing", "LIFEOS_ASSET_ROOT is not configured");
  }
  return root;
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

export function arrayField(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_field", `${name} must be an array`);
  return value;
}

/** Re-runs the core rules so adapter input validation cannot drift from the domain rules. */
export function coreValidated<T>(name: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new HttpError(400, "invalid_field", `${name}: ${error instanceof Error ? error.message : "invalid value"}`);
  }
}

export function decodeSegment(segment: string): string {
  try {
    return safeId(decodeURIComponent(segment));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_id", "Invalid id");
  }
}

export function entityRefsField(value: unknown, repository: SqliteRecordRepository): readonly EntityRef[] {
  const items = arrayField(value, "entityRefs");
  const refs = coreValidated("entityRefs", () => {
    items.forEach((item, index) => assertValidEntityRef(item, `entityRefs[${index}]`));
    return items as readonly EntityRef[];
  });
  const seen = new Set<string>();
  const resolved: EntityRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.entityId)) throw new HttpError(400, "duplicate_reference", `entityRefs repeats ${ref.entityId}`);
    seen.add(ref.entityId);
    const entity = repository.findEntityById(ref.entityId);
    if (entity === null) throw new HttpError(400, "unknown_entity", `Unknown entity: ${ref.entityId}`);
    if (entity.type !== ref.entityType) {
      throw new HttpError(400, "entity_type_mismatch", `Entity ${ref.entityId} is a ${entity.type}, not a ${ref.entityType}`);
    }
    // Storing the label keeps the timeline readable even if the entity is deleted later.
    resolved.push(ref.label === undefined ? { entityType: ref.entityType, entityId: ref.entityId, label: entity.name } : ref);
  }
  return resolved;
}

export function relatedRecordIdsField(value: unknown, selfId: string, repository: SqliteRecordRepository): readonly string[] {
  const items = arrayField(value, "relatedRecordIds");
  const ids = coreValidated("relatedRecordIds", () => {
    items.forEach((item, index) => {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`relatedRecordIds[${index}] must be a non-empty string`);
      }
    });
    return items as readonly string[];
  });
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === selfId) throw new HttpError(400, "self_reference", "A record cannot relate to itself");
    if (seen.has(id)) throw new HttpError(400, "duplicate_reference", `relatedRecordIds repeats ${id}`);
    seen.add(id);
    if (repository.findById(id) === null) throw new HttpError(400, "unknown_record", `Unknown record: ${id}`);
  }
  return ids;
}

export function assetRefsField(value: unknown, repository: SqliteRecordRepository): readonly AssetLink[] {
  const items = arrayField(value, "assetRefs");
  const refs = coreValidated("assetRefs", () => {
    items.forEach((item, index) => assertValidAssetLink(item, `assetRefs[${index}]`));
    return items as readonly AssetLink[];
  });
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.assetId)) throw new HttpError(400, "duplicate_reference", `assetRefs repeats ${ref.assetId}`);
    seen.add(ref.assetId);
    if (repository.findAssetById(ref.assetId) === null) {
      throw new HttpError(400, "unknown_asset", `Unknown asset: ${ref.assetId}`);
    }
  }
  return refs;
}

/**
 * Import is the only write path that hands us a pre-assembled object graph, so
 * it is the only path where a reference can point at nothing: POST and PATCH
 * resolve every ref against the database as they go, but a bundle arrives whole.
 * Enforce the same invariant here — each ref must resolve to something the
 * database knows about, either because the bundle carries it or because it is
 * already stored.
 *
 * Soft-deleted records and trashed assets count as "known": their tombstones
 * are still in the database, and refusing them would make an owner's own export
 * un-importable after they emptied the recycle bin.
 */
export function assertImportReferences(bundle: ExportBundleV1, repository: SqliteRecordRepository): void {
  const incomingRecords = new Set(bundle.records.map((record) => record.id));
  const incomingEntityTypes = new Map(bundle.entities.map((entity) => [entity.id, entity.type]));
  const incomingAssets = new Set(bundle.assets.map((asset) => asset.id));

  for (const entity of bundle.entities) {
    if ((entity.type === "person" || entity.type === "place") && entity.avatarAssetId) {
      const avatar = bundle.assets.find(asset => asset.id === entity.avatarAssetId) ?? repository.findAssetById(entity.avatarAssetId);
      if (!avatar || avatar.kind !== "photo" || avatar.purpose !== "avatar") throw new HttpError(400, "invalid_avatar", "导入的人物头像不存在或类型不符");
    }
    for (const relation of entity.relations ?? []) {
      if (relation.entityId === entity.id) {
        throw new HttpError(400, "self_relation", "An entity cannot relate to itself");
      }
      if (incomingEntityTypes.has(relation.entityId) || repository.findEntityById(relation.entityId) !== null) continue;
      throw new HttpError(400, "unknown_entity", `Unknown entity: ${relation.entityId}`);
    }
  }

  for (const record of bundle.records) {
    for (const decision of record.body.entityMentions ?? []) {
      if (decision.entityId === null) continue;
      const type = incomingEntityTypes.get(decision.entityId) ?? repository.findEntityById(decision.entityId)?.type;
      if (type !== decision.entityType) throw new HttpError(400, "unknown_entity", "导入的正文标记关联对象不存在或类型不符");
      if (!record.entityRefs.some((ref) => ref.entityId === decision.entityId && ref.entityType === decision.entityType)) throw new HttpError(400, "invalid_reference", "导入的正文标记缺少对应关联");
    }
    const seenEntities = new Set<string>();
    for (const ref of record.entityRefs) {
      if (seenEntities.has(ref.entityId)) throw new HttpError(400, "duplicate_reference", `entityRefs repeats ${ref.entityId}`);
      seenEntities.add(ref.entityId);
      const actualType = incomingEntityTypes.get(ref.entityId) ?? repository.findEntityById(ref.entityId)?.type;
      if (actualType === undefined) throw new HttpError(400, "unknown_entity", `Unknown entity: ${ref.entityId}`);
      if (actualType !== ref.entityType) {
        throw new HttpError(400, "entity_type_mismatch", `Entity ${ref.entityId} is a ${actualType}, not a ${ref.entityType}`);
      }
    }
    const seenAssets = new Set<string>();
    for (const ref of record.assetRefs) {
      if (seenAssets.has(ref.assetId)) throw new HttpError(400, "duplicate_reference", `assetRefs repeats ${ref.assetId}`);
      seenAssets.add(ref.assetId);
      if (incomingAssets.has(ref.assetId) || repository.findAssetById(ref.assetId) !== null) continue;
      if (repository.findAssetTrash(ref.assetId) !== null) continue;
      throw new HttpError(400, "unknown_asset", `Unknown asset: ${ref.assetId}`);
    }
    const seenRecords = new Set<string>();
    for (const id of record.relatedRecordIds) {
      if (id === record.id) throw new HttpError(400, "self_reference", "A record cannot relate to itself");
      if (seenRecords.has(id)) throw new HttpError(400, "duplicate_reference", `relatedRecordIds repeats ${id}`);
      seenRecords.add(id);
      if (incomingRecords.has(id) || repository.findById(id, true) !== null) continue;
      throw new HttpError(400, "unknown_record", `Unknown record: ${id}`);
    }
  }
}

export function storageRefsField(value: unknown): readonly StorageReference[] {
  const items = arrayField(value, "storageRefs");
  if (items.length === 0) throw new HttpError(400, "invalid_field", "storageRefs must not be empty");
  return coreValidated("storageRefs", () => {
    items.forEach((item, index) => assertValidStorageReference(item, `storageRefs[${index}]`));
    return items as readonly StorageReference[];
  });
}

export function sizeBytesField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, "invalid_field", "sizeBytes must be a non-negative number");
  }
  return value;
}

export function aliasesField(value: unknown): readonly string[] {
  const items = arrayField(value, "aliases");
  const cleaned = coreValidated("aliases", () => {
    items.forEach((item, index) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new Error(`aliases[${index}] must be a non-empty string`);
      }
    });
    return items as readonly string[];
  });
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const alias of cleaned) {
    const trimmed = alias.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

import { calendarToday } from "@lifeos/core";
import { dateForTime } from "./timeline-query.js";

function assertJournalDate(record: Pick<TimelineRecord, "kind" | "occurredAt" | "createdAt">): void {
  if (record.kind === "journal" && dateForTime(record.occurredAt ?? record.createdAt, "Asia/Shanghai") > calendarToday()) {
    throw new HttpError(400, "future_journal", "未来日期不能写日记，请选择今天或之前的日期");
  }
}
