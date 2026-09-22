import { randomUUID } from "node:crypto";
import {
  assertValidAsset,
  assertValidEntity,
  findEntityMentions,
  normalizeEntitySearchTerm,
  PLACE_ROLES,
  type Asset,
  type Entity,
  type EntityKind,
  type EntityRef,
  type EntityRelation,
  type Movie,
  type MovieExternalIds,
  type PlacePeriod,
  type PlaceRole,
  type StorageReference,
} from "@lifeos/core";
import type { SqliteRecordRepository } from "./repository.js";
import { HttpError } from "./http-kit.js";
import {
  type JsonObject,
  boundedIntegerField,
  coreValidated,
  enumField,
  hasOnlyKeys,
  jsonObject,
  nowInstant,
  parseDateQuery,
  stringField,
} from "./field-validate.js";
import { aliasesField, sizeBytesField } from "./record-builders.js";

const ASSET_KINDS: readonly string[] = ["photo", "audio", "file"];

export const MOVIE_FIELD_NAMES = [
  "mediaType",
  "originalTitle",
  "releaseYear",
  "posterUrl",
  "overview",
  "externalIds",
  "doubanRating",
  "personalRating",
  "personalReview",
  "watchedAt",
] as const;

export function movieScoreField(value: unknown, name: string, halfStep: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10 || (halfStep && !Number.isInteger(value * 2))) {
    throw new HttpError(400, "invalid_field", `${name} must be between 0 and 10${halfStep ? " in 0.5 increments" : ""}`);
  }
  return value;
}

export function movieExternalIdsField(value: unknown): MovieExternalIds {
  const input = jsonObject(value, "externalIds");
  hasOnlyKeys(input, ["tmdb", "imdb", "douban"]);
  const ids: { tmdb?: string; imdb?: string; douban?: string } = {};
  if (input.tmdb !== undefined) ids.tmdb = String(boundedIntegerField(typeof input.tmdb === "string" && /^\d+$/.test(input.tmdb) ? Number(input.tmdb) : input.tmdb, "externalIds.tmdb", 1, Number.MAX_SAFE_INTEGER));
  if (input.imdb !== undefined) {
    const imdb = stringField(input.imdb, "externalIds.imdb", { nonEmpty: true }).trim().toLowerCase();
    if (!/^tt\d+$/.test(imdb)) throw new HttpError(400, "invalid_field", "externalIds.imdb must look like tt1234567");
    ids.imdb = imdb;
  }
  if (input.douban !== undefined) {
    const raw = typeof input.douban === "number" ? String(input.douban) : stringField(input.douban, "externalIds.douban", { nonEmpty: true }).trim();
    const douban = raw.match(/^https?:\/\/(?:www\.)?(?:movie\.)?douban\.com\/subject\/(\d+)\/?$/i)?.[1] ?? raw;
    if (!/^\d+$/.test(douban) || douban.length === 0 || !Number.isSafeInteger(Number(douban)) || Number(douban) <= 0) {
      throw new HttpError(400, "invalid_field", "externalIds.douban must be a numeric subject id or Douban subject URL");
    }
    ids.douban = douban;
  }
  return ids;
}

export function movieReleaseYearField(value: unknown): number {
  return boundedIntegerField(value, "releaseYear", 1, 9999);
}

export function movieMediaTypeField(value: unknown): "movie" | "tv" {
  if (value !== "movie" && value !== "tv") throw new HttpError(400, "invalid_field", "mediaType must be one of: movie, tv");
  return value;
}

export function movieWatchedAtField(value: unknown): string {
  const parsed = parseDateQuery(stringField(value, "watchedAt"), "watchedAt");
  if (parsed === undefined) throw new HttpError(400, "invalid_date", "watchedAt must use YYYY-MM-DD");
  return parsed;
}

/** Parse movie-only fields, with null accepted only for PATCH-style clearing. */
export function movieFieldsField(input: JsonObject, allowNull: boolean): JsonObject {
  const output: JsonObject = {};
  for (const field of MOVIE_FIELD_NAMES) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value === null) {
      if (!allowNull) throw new HttpError(400, "invalid_field", `${field} cannot be null`);
      output[field] = null;
      continue;
    }
    if (field === "originalTitle" || field === "posterUrl" || field === "overview" || field === "personalReview") {
      output[field] = stringField(value, field);
    } else if (field === "releaseYear") {
      output[field] = movieReleaseYearField(value);
    } else if (field === "mediaType") {
      output[field] = movieMediaTypeField(value);
    } else if (field === "externalIds") {
      output[field] = movieExternalIdsField(value);
    } else if (field === "doubanRating") {
      output[field] = movieScoreField(value, field, false);
    } else if (field === "personalRating") {
      output[field] = movieScoreField(value, field, true);
    } else if (field === "watchedAt") {
      output[field] = movieWatchedAtField(value);
    }
  }
  return output;
}

export function assertMovieOnlyFields(type: EntityKind, input: JsonObject): void {
  if (type !== "movie" && MOVIE_FIELD_NAMES.some((field) => Object.hasOwn(input, field))) {
    throw new HttpError(400, "invalid_field", "Movie fields are only allowed on a movie entity");
  }
}

export function addressField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const address = stringField(value, "address").trim();
  if (address.length > 500) throw new HttpError(400, "invalid_field", "address is too long");
  return address.length === 0 ? undefined : address;
}

export function placeRoleField(value: unknown): PlaceRole {
  if (typeof value !== "string" || !PLACE_ROLES.includes(value as PlaceRole)) {
    throw new HttpError(400, "invalid_field", `role must be one of: ${PLACE_ROLES.join(", ")}`);
  }
  return value as PlaceRole;
}

export function placePeriodField(value: unknown): PlacePeriod {
  const period = jsonObject(value, "period");
  hasOnlyKeys(period, ["from", "until"]);
  const rawFrom = period.from === undefined ? undefined : stringField(period.from, "period.from");
  const rawUntil = period.until === undefined ? undefined : stringField(period.until, "period.until");
  if (rawFrom !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(rawFrom)) {
    throw new HttpError(400, "invalid_field", `period.from must be YYYY-MM: ${rawFrom}`);
  }
  if (rawUntil !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(rawUntil)) {
    throw new HttpError(400, "invalid_field", `period.until must be YYYY-MM: ${rawUntil}`);
  }
  if (rawFrom !== undefined && rawUntil !== undefined && rawFrom > rawUntil) {
    throw new HttpError(400, "invalid_field", "period.from must not be after period.until");
  }
  const candidate: unknown = {
    ...(rawFrom === undefined ? {} : { from: rawFrom }),
    ...(rawUntil === undefined ? {} : { until: rawUntil }),
  };
  // Re-check through core so the API and any future adapter share one rule.
  coreValidated("period", () => {
    assertValidEntity({ type: "place", id: "check", name: "check", period: candidate });
    return true;
  });
  return candidate as PlacePeriod;
}

/** Role and period live on places only; anything else carrying them is a client bug. */
export function placeOnlyFields(type: EntityKind, role: PlaceRole | undefined, period: PlacePeriod | undefined, address: string | null | undefined = undefined): void {
  if (type !== "place" && (role !== undefined || period !== undefined || (address !== undefined && address !== null))) {
    throw new HttpError(400, "invalid_field", "role, period and address are only allowed on a place");
  }
}

/**
 * A typed marker in the text is a relation: `@person` and `#place` both turn
 * into entityRefs. Mentions only ever add: an explicit entityRefs edit is the
 * place to remove one, so a stale name in the text can never silently drop a
 * link the user made on purpose.
 */
export function withMentionRefs(text: string, refs: readonly EntityRef[], repository: SqliteRecordRepository): readonly EntityRef[] {
  const mentions = findEntityMentions(text, repository.listEntities());
  if (mentions.length === 0) return refs;
  const known = new Set(refs.map((ref) => ref.entityId));
  const merged = [...refs];
  for (const mention of mentions) {
    if (known.has(mention.entityId)) continue;
    const entity = repository.findEntityById(mention.entityId);
    if (entity === null) continue;
    known.add(mention.entityId);
    merged.push({ entityType: entity.type, entityId: entity.id, label: entity.name });
  }
  return merged;
}

/** LifeOS stores a reference to an original that stays wherever it already lives. */
export function buildAsset(input: JsonObject, id: string, storageRefs: readonly StorageReference[]): Asset {
  const kind = enumField(input.kind, ASSET_KINDS, "kind");
  const originalName = input.originalName === undefined ? undefined : stringField(input.originalName, "originalName");
  const mediaType = input.mediaType === undefined ? undefined : stringField(input.mediaType, "mediaType");
  const sizeBytes = input.sizeBytes === undefined ? undefined : sizeBytesField(input.sizeBytes);
  const candidate: unknown = {
    id,
    kind,
    storageRefs,
    createdAt: nowInstant(),
    ...(originalName === undefined ? {} : { originalName }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
  assertValidAsset(candidate);
  return candidate;
}

/**
 * Entity is a union discriminated by `type`; spreading it directly widens the
 * discriminant, so the result is validated after the edit instead of cast blindly.
 */
export function withEntityEdits(
  entity: Entity,
  edits: { readonly name?: string; readonly aliases?: readonly string[]; readonly description?: string; readonly role?: PlaceRole; readonly period?: PlacePeriod; readonly address?: string | null },
): Entity {
  const candidate: unknown = {
    ...entity,
    ...(edits.name === undefined ? {} : { name: edits.name }),
    ...(edits.aliases === undefined ? {} : { aliases: edits.aliases }),
    ...(edits.description === undefined ? {} : { description: edits.description }),
    ...(edits.role === undefined ? {} : { role: edits.role }),
    ...(edits.period === undefined ? {} : { period: edits.period }),
    ...(edits.address === undefined ? {} : { address: edits.address === null ? undefined : edits.address }),
  };
  assertValidEntity(candidate);
  return candidate;
}

export function withMovieEdits(entity: Entity, edits: JsonObject): Entity {
  if (entity.type !== "movie" || Object.keys(edits).length === 0) return entity;
  const candidate: JsonObject = { ...entity };
  for (const field of MOVIE_FIELD_NAMES) {
    if (!Object.hasOwn(edits, field)) continue;
    const value = edits[field];
    if (value === null) delete candidate[field];
    else candidate[field] = value;
  }
  assertValidEntity(candidate);
  return candidate as Movie;
}

export const MOVIE_INPUT_KEYS = [
  "id",
  "type",
  "name",
  "title",
  "query",
  "aliases",
  "description",
  "mediaType",
  "originalTitle",
  "releaseYear",
  "posterUrl",
  "overview",
  "externalIds",
  "tmdbId",
  "imdbId",
  "doubanId",
  "doubanUrl",
  "doubanRating",
  "personalRating",
  "personalReview",
  "watchedAt",
] as const;

export function moviePayload(input: JsonObject): JsonObject {
  if (Object.hasOwn(input, "movie")) return jsonObject(input.movie, "movie");
  if (Object.hasOwn(input, "candidate")) return jsonObject(input.candidate, "candidate");
  return input;
}

export function movieIdentifierField(value: unknown, name: string): string {
  const id = stringField(value, name, { nonEmpty: true }).trim();
  if (!/^\d+$/.test(id)) throw new HttpError(400, "invalid_field", `${name} must be numeric`);
  return id;
}

export function movieInputEntity(input: JsonObject, idOverride?: string): Movie {
  hasOnlyKeys(input, MOVIE_INPUT_KEYS);
  if (input.type !== undefined && input.type !== "movie") throw new HttpError(400, "invalid_field", "movie.type must be movie");
  const nameValue = input.name ?? input.title;
  const name = stringField(nameValue, "name", { nonEmpty: true });
  const aliases = input.aliases === undefined ? undefined : aliasesField(input.aliases);
  const description = input.description === undefined ? undefined : stringField(input.description, "description");
  const fields = movieFieldsField(input, false);
  const parsedExternal = fields.externalIds as MovieExternalIds | undefined;
  const externalIds: { tmdb?: string; imdb?: string; douban?: string } = {
    ...(parsedExternal?.tmdb === undefined ? {} : { tmdb: String(parsedExternal.tmdb) }),
    ...(parsedExternal?.imdb === undefined ? {} : { imdb: parsedExternal.imdb }),
    ...(parsedExternal?.douban === undefined ? {} : { douban: String(parsedExternal.douban) }),
  };
  if (input.tmdbId !== undefined) externalIds.tmdb = String(boundedIntegerField(typeof input.tmdbId === "string" && /^\d+$/.test(input.tmdbId) ? Number(input.tmdbId) : input.tmdbId, "tmdbId", 1, Number.MAX_SAFE_INTEGER));
  if (input.imdbId !== undefined) {
    const imdb = stringField(input.imdbId, "imdbId", { nonEmpty: true }).trim().toLowerCase();
    if (!/^tt\d+$/.test(imdb)) throw new HttpError(400, "invalid_field", "imdbId must look like tt1234567");
    externalIds.imdb = imdb;
  }
  const doubanInput = input.doubanId ?? input.doubanUrl;
  if (doubanInput !== undefined) {
    const raw = input.doubanUrl === undefined && typeof doubanInput === "number"
      ? String(doubanInput)
      : stringField(doubanInput, input.doubanUrl !== undefined ? "doubanUrl" : "doubanId", { nonEmpty: true });
    const match = input.doubanUrl === undefined ? raw : raw.match(/(?:movie\.)?douban\.com\/subject\/(\d+)/i)?.[1];
    if (match === undefined) throw new HttpError(400, "invalid_field", "doubanUrl must contain a subject id");
    externalIds.douban = match;
  }
  const hasExternalIds = Object.keys(externalIds).length > 0;
  const suppliedId = input.id === undefined ? undefined : stringField(input.id, "id", { nonEmpty: true });
  const providerId = externalIds.tmdb ?? (externalIds.imdb === undefined ? externalIds.douban : externalIds.imdb);
  const providerIdLooksLikeInternal = suppliedId !== undefined && providerId !== undefined && suppliedId === providerId;
  const generatedId = providerId === undefined
    ? `movie_${randomUUID()}`
    : externalIds.tmdb !== undefined
      ? `movie_tmdb_${externalIds.tmdb}`
      : externalIds.imdb !== undefined
        ? `movie_imdb_${externalIds.imdb}`
        : `movie_douban_${externalIds.douban}`;
  const candidate: JsonObject = {
    type: "movie",
    id: idOverride ?? (providerIdLooksLikeInternal ? generatedId : suppliedId ?? generatedId),
    name,
    createdAt: nowInstant(),
    ...(aliases === undefined ? {} : { aliases }),
    ...(description === undefined ? {} : { description }),
    ...fields,
    ...(hasExternalIds ? { externalIds } : {}),
  };
  assertValidEntity(candidate);
  return candidate as Movie;
}

export function movieExternalId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    return trimmed.match(/^https?:\/\/(?:www\.)?(?:movie\.)?douban\.com\/subject\/(\d+)\/?$/i)?.[1] ?? trimmed;
  }
  return undefined;
}

export function movieTitleMatches(left: Movie, right: Movie): boolean {
  const terms = new Set([left.name, ...(left.aliases ?? [])].map((term) => normalizeEntitySearchTerm(term)));
  return [right.name, ...(right.aliases ?? [])].some((term) => terms.has(normalizeEntitySearchTerm(term)));
}

export function movieMatch(repository: SqliteRecordRepository, candidate: Movie): Movie | null {
  const incoming = candidate.externalIds ?? {};
  const movies = repository.listEntities({ type: "movie" }) as readonly Movie[];
  const tmdb = movieExternalId(incoming.tmdb);
  if (tmdb !== undefined) {
    const match = movies.find((movie) => movieExternalId(movie.externalIds?.tmdb) === tmdb);
    if (match !== undefined) return match;
  }
  const imdb = movieExternalId(incoming.imdb)?.toLowerCase();
  if (imdb !== undefined) {
    const match = movies.find((movie) => movieExternalIdsMatch(movie, "imdb", imdb));
    if (match !== undefined) return match;
  }
  const douban = movieExternalId(incoming.douban);
  if (douban !== undefined) {
    const match = movies.find((movie) => movieExternalIdsMatch(movie, "douban", douban) && movieTitleMatches(movie, candidate));
    if (match !== undefined) return match;
  }
  // A caller may be editing a manually-created movie that has no provider ID;
  // its explicit LifeOS id is still a safe final upsert key.
  const byId = movies.find((movie) => movie.id === candidate.id);
  return byId ?? null;
}

export function movieExternalIdsMatch(movie: Movie, key: "imdb" | "douban", expected: string): boolean {
  const actual = movieExternalId(movie.externalIds?.[key]);
  return actual !== undefined && actual.toLowerCase() === expected.toLowerCase();
}

export function movieNameHasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

export function mergeMovie(existing: Movie, incoming: Movie): Movie {
  const name = movieNameHasCjk(incoming.name) || !movieNameHasCjk(existing.name) ? incoming.name : existing.name;
  const aliases = [...new Set([existing.name, incoming.name, ...(existing.aliases ?? []), ...(incoming.aliases ?? [])])].filter((alias) => alias !== name);
  const externalIds = { ...(existing.externalIds ?? {}), ...(incoming.externalIds ?? {}) };
  const candidate: JsonObject = {
    ...existing,
    ...incoming,
    id: existing.id,
    createdAt: existing.createdAt,
    name,
    ...(aliases.length === 0 ? {} : { aliases }),
    ...(Object.keys(externalIds).length === 0 ? {} : { externalIds }),
  };
  assertValidEntity(candidate);
  return candidate as Movie;
}

export function withRelation(entity: Entity, relation: EntityRelation): Entity {
  const relations = (entity.relations ?? []).filter((existing) => existing.entityId !== relation.entityId);
  relations.push(relation);
  const candidate: unknown = { ...entity, relations };
  assertValidEntity(candidate);
  return candidate;
}

export function withoutRelation(entity: Entity, targetId: string): Entity {
  const relations = (entity.relations ?? []).filter((existing) => existing.entityId !== targetId);
  const { relations: _dropped, ...rest } = entity;
  // No relations means no field at all, so the stored shape stays lean.
  const candidate: unknown = relations.length === 0 ? rest : { ...rest, relations };
  assertValidEntity(candidate);
  return candidate;
}


