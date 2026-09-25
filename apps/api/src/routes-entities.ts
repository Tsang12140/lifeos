import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RELATION_KINDS,
  assertValidEntity,
  type Entity,
  type EntityKind,
  type PlacePeriod,
  type PlaceRole,
  type RelationKind,
} from "@lifeos/core";
import { HttpError, setJson, setEmpty } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import {
  coreValidated,
  enumField,
  hasOnlyKeys,
  jsonObject,
  nowInstant,
  stringField,
} from "./field-validate.js";
import { aliasesField } from "./record-builders.js";
import { contentDisposition, decodeSegment, safeId } from "./record-builders.js";
import { randomUUID } from "node:crypto";
import {
  MOVIE_FIELD_NAMES,
  MOVIE_INPUT_KEYS,
  addressField,
  assertMovieOnlyFields,
  placeOnlyFields,
  placePeriodField,
  placeRoleField,
  mergeMovie,
  movieExternalIdsMatch,
  movieFieldsField,
  movieIdentifierField,
  movieInputEntity,
  movieMatch,
  moviePayload,
  movieTitleMatches,
  withEntityEdits,
  withMovieEdits,
  withRelation,
  withoutRelation,
} from "./movie-input.js";
import { readRuntimeMovieConfig } from "./movie-config.js";
import { MovieModuleError } from "./movie.js";
import { canonicalPersonName } from "@lifeos/core";
import type { RouteContext, RouteHandler } from "./route-context.js";

const ENTITY_KINDS: readonly EntityKind[] = ["person", "project", "place", "topic", "movie"];

export const handleEntitiesRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository } = ctx;
  if (pathname === "/api/entities" && req.method === "GET") {
    const typeRaw = url.searchParams.get("type");
    const q = url.searchParams.get("q") ?? undefined;
    if (q !== undefined && q.length > 200) throw new HttpError(400, "invalid_query", "q is too long");
    const type = typeRaw === null || typeRaw === "" ? undefined : enumField(typeRaw, ENTITY_KINDS, "type");
    setJson(res, 200, {
      items: repository.listEntities({ ...(type === undefined ? {} : { type }), ...(q === undefined ? {} : { q }) }),
    });
    return true;
  }
  if (pathname === "/api/entities" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["id", "type", "name", "aliases", "description", "role", "period", "address", ...MOVIE_FIELD_NAMES]);
    const type = enumField(input.type, ENTITY_KINDS, "type");
    if (type === "movie" && !readRuntimeMovieConfig(config).enabled) throw new MovieModuleError(409, "movie_module_disabled", "观影模块未启用；请先在设置中启用");
    assertMovieOnlyFields(type, input);
    const rawName = stringField(input.name, "name", { nonEmpty: true });
    const name = type === "person" ? canonicalPersonName(rawName) : rawName;
    const description = input.description === undefined ? undefined : stringField(input.description, "description");
    const aliases = input.aliases === undefined ? undefined : aliasesField(input.aliases);
    const role = input.role === undefined ? undefined : placeRoleField(input.role);
    const period = input.period === undefined ? undefined : placePeriodField(input.period);
    const address = addressField(input.address);
    const movieFields = movieFieldsField(input, false);
    placeOnlyFields(type, role, period, address);
    // An explicit id keeps seeded or imported objects addressable and predictable.
    const id = input.id === undefined ? `${type}_${randomUUID()}` : stringField(input.id, "id", { nonEmpty: true });
    if (repository.findEntityById(id) !== null) throw new HttpError(409, "entity_exists", `Entity already exists: ${id}`);
    const entity: Entity = {
      type,
      id,
      name,
      createdAt: nowInstant(),
      ...(aliases === undefined ? {} : { aliases }),
      ...(description === undefined ? {} : { description }),
      ...(role === undefined ? {} : { role }),
      ...(period === undefined ? {} : { period }),
      ...(address === undefined ? {} : { address }),
      ...movieFields,
    };
    assertValidEntity(entity);
    repository.insertEntity(entity);
    setJson(res, 201, entity);
    return true;
  }
  const entityMatch = /^\/api\/entities\/([^/]+)$/.exec(pathname);
  if (entityMatch !== null && (req.method === "PATCH" || req.method === "DELETE")) {
    const id = decodeSegment(entityMatch[1]!);
    const existing = repository.findEntityById(id);
    if (existing === null) throw new HttpError(404, "not_found", "Entity not found");
    if (req.method === "DELETE") {
      requireJsonContentType(req, true);
      const references = repository.entityReferenceRecordIds(id);
      if (references.length > 0) {
        throw new HttpError(409, "entity_in_use", `Entity is still referenced by ${references.length} record(s)`);
      }
      // Relations are ours to keep consistent: drop the far side before deleting.
      const related = repository.entitiesRelatingTo(id).filter((entity) => entity.id !== id);
      if (related.length > 0) repository.writeEntities(related.map((entity) => withoutRelation(entity, id)));
      repository.deleteEntity(id);
      setEmpty(res, 204);
      return true;
    }
    if (existing.type === "movie" && !readRuntimeMovieConfig(config).enabled) throw new MovieModuleError(409, "movie_module_disabled", "观影模块未启用；请先在设置中启用");
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["name", "aliases", "description", "role", "period", "address", ...MOVIE_FIELD_NAMES]);
    assertMovieOnlyFields(existing.type, input);
    const role = input.role === undefined ? undefined : input.role === null ? null : placeRoleField(input.role);
    const period = input.period === undefined ? undefined : input.period === null ? null : placePeriodField(input.period);
    const address = input.address === undefined ? undefined : input.address === null ? null : addressField(input.address);
    const movieFields = movieFieldsField(input, true);
    placeOnlyFields(existing.type, role, period, address);
    const updated = withEntityEdits(existing, {
      ...(input.name === undefined ? {} : { name: existing.type === "person" ? canonicalPersonName(stringField(input.name, "name", { nonEmpty: true })) : stringField(input.name, "name", { nonEmpty: true }) }),
      ...(input.aliases === undefined ? {} : { aliases: aliasesField(input.aliases) }),
      ...(input.description === undefined ? {} : { description: stringField(input.description, "description") }),
      ...(role === undefined ? {} : { role }),
      ...(period === undefined ? {} : { period }),
      ...(address === undefined ? {} : { address }),
    });
    const movieUpdated = withMovieEdits(updated, movieFields);
    repository.updateEntity(movieUpdated);
    setJson(res, 200, movieUpdated);
    return true;
  }

  return false;
};
