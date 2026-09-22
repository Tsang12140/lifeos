import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import {
  assertValidAssetLink,
  assertValidEntityRef,
  assertValidNoteDetails,
  assertValidStorageReference,
  assertValidWeatherAttachment,
  findEntityMentions,
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
const ASSET_KINDS: readonly string[] = ["photo", "audio", "file"];

function withMentionRefs(text: string, refs: readonly EntityRef[], repository: SqliteRecordRepository): readonly EntityRef[] {
  const entities = repository.listEntities();
  const found = findEntityMentions(text, entities);
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

export function buildRecord(input: JsonObject, repository: SqliteRecordRepository): TimelineRecord {
  hasOnlyKeys(input, ["kind", "content", "occurredAt", "dueAt", "isPrivate", "isDemo", "isBackfill", "weather", "note", "entityRefs", "relatedRecordIds", "assetRefs"]);
  const kind = enumField(input.kind, RECORD_KINDS, "kind");
  const content = stringField(input.content, "content");
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
    return parseNoteDetails(input.note);
  })();
  const id = randomUUID();
  const explicitRefs = input.entityRefs === undefined ? ([] as const) : entityRefsField(input.entityRefs, repository);
  const common = {
    id,
    createdAt: nowInstant(),
    body: { original: content },
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(isPrivate === undefined ? {} : { isPrivate }),
    ...(isDemo === undefined ? {} : { isDemo }),
    ...(isBackfill === undefined ? {} : { isBackfill }),
    ...(weather === undefined ? {} : { weather }),
    ...(note === undefined ? {} : { note }),
    entityRefs: withMentionRefs(content, explicitRefs, repository),
    relatedRecordIds:
      input.relatedRecordIds === undefined ? ([] as const) : relatedRecordIdsField(input.relatedRecordIds, id, repository),
    assetRefs: input.assetRefs === undefined ? ([] as const) : assetRefsField(input.assetRefs, repository),
    aiDerived: [] as const,
  };
  if (kind === "task") return { ...common, kind: "task", task: { status: "todo", ...(dueAt === undefined ? {} : { dueAt }) } };
  if (dueAt !== undefined) throw new HttpError(400, "invalid_field", "dueAt is only valid for task records");
  return { ...common, kind } as TimelineRecord;
}

export function patchRecord(
  current: RecordView,
  input: JsonObject,
  repository: SqliteRecordRepository,
): { expectedRevision: number; record: TimelineRecord } {
  hasOnlyKeys(input, ["revision", "content", "occurredAt", "dueAt", "isPrivate", "isBackfill", "weather", "note", "status", "entityRefs", "relatedRecordIds", "assetRefs"]);
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
    record = { ...record, body: { ...record.body, edited: content } };
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
  if (input.content !== undefined) {
    record = { ...record, entityRefs: withMentionRefs(record.body.edited ?? record.body.original, record.entityRefs, repository) };
  }
  if (input.relatedRecordIds !== undefined) {
    record = { ...record, relatedRecordIds: relatedRecordIdsField(input.relatedRecordIds, record.id, repository) };
  }
  if (input.assetRefs !== undefined) {
    record = { ...record, assetRefs: assetRefsField(input.assetRefs, repository) };
  }
  record = { ...record, updatedAt: nowInstant() };
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
    for (const relation of entity.relations ?? []) {
      if (relation.entityId === entity.id) {
        throw new HttpError(400, "self_relation", "An entity cannot relate to itself");
      }
      if (incomingEntityTypes.has(relation.entityId) || repository.findEntityById(relation.entityId) !== null) continue;
      throw new HttpError(400, "unknown_entity", `Unknown entity: ${relation.entityId}`);
    }
  }

  for (const record of bundle.records) {
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


