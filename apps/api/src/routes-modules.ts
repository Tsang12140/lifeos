import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, setJson, setEmpty } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import {
  cycleIntimacyConfig,
  cycleIntimacyEvent,
  enumField,
  hasOnlyKeys,
  jsonObject,
  parseDateQuery,
  stringField,
} from "./field-validate.js";
import { decodeSegment, safeId } from "./record-builders.js";
import { ConflictError, type MobileCycleEventKind, type SqliteRecordRepository } from "./repository.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

const MOBILE_CYCLE_EVENT_KINDS: readonly MobileCycleEventKind[] = ["period_start", "period_end", "intimacy"];

function cycleModuleResponse(repository: SqliteRecordRepository) {
  return { ...repository.cycleIntimacyModule(), eventRevision: repository.cycleIntimacyEventRevision() };
}

export const handleModulesRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository, weatherArchiveScheduler, loginFailures, authenticated } = ctx;
  if (pathname === "/api/modules/cycle-intimacy" && req.method === "GET") {
    setJson(res, 200, cycleModuleResponse(repository));
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/config" && req.method === "PUT") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    repository.writeCycleIntimacyConfig(cycleIntimacyConfig(input));
    setJson(res, 200, cycleModuleResponse(repository));
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/day-edit" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["date", "kinds", "revision"]);
    const date = parseDateQuery(stringField(input.date, "date"), "date");
    if (date === undefined) throw new HttpError(400, "invalid_date", "date is required");
    if (!Array.isArray(input.kinds) || input.kinds.length > MOBILE_CYCLE_EVENT_KINDS.length) {
      throw new HttpError(400, "invalid_field", "kinds must be a set of mobile cycle event kinds");
    }
    const kinds = input.kinds.map((kind, index) => enumField(kind, MOBILE_CYCLE_EVENT_KINDS, `kinds[${index}]`));
    if (new Set(kinds).size !== kinds.length) throw new HttpError(400, "invalid_field", "kinds must not contain duplicates");
    const revision = stringField(input.revision, "revision", { nonEmpty: true });
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new HttpError(400, "invalid_revision", "revision must be a cycle event revision");
    try {
      setJson(res, 200, repository.editCycleIntimacyDay(date, kinds, revision));
    } catch (error) {
      if (error instanceof ConflictError) throw new HttpError(409, "cycle_conflict", error.message);
      throw error;
    }
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/day-edit/undo" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["token"]);
    const token = stringField(input.token, "token", { nonEmpty: true });
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, "invalid_field", "token is invalid");
    try {
      setJson(res, 200, repository.undoCycleIntimacyDayEdit(token));
    } catch (error) {
      if (error instanceof ConflictError) throw new HttpError(409, "undo_unavailable", error.message);
      throw error;
    }
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/events" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    const event = cycleIntimacyEvent(input);
    if (repository.cycleIntimacyModule().events.some((existing) => existing.date === event.date && existing.kind === event.kind)) {
      throw new HttpError(409, "event_exists", "This calendar marker already exists");
    }
    repository.addCycleIntimacyEvent(event);
    setJson(res, 201, cycleModuleResponse(repository));
    return true;
  }
  const cycleEventMatch = /^\/api\/modules\/cycle-intimacy\/events\/([^/]+)$/.exec(pathname);
  if (cycleEventMatch !== null && req.method === "DELETE") {
    const id = decodeSegment(cycleEventMatch[1]!);
    if (!repository.deleteCycleIntimacyEvent(id)) throw new HttpError(404, "not_found", "Cycle module event not found");
    setJson(res, 200, cycleModuleResponse(repository));
    return true;
  }

  return false;
};
