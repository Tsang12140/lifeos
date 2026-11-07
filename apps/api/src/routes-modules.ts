import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_PERIOD_SPAN_DAYS } from "@lifeos/core";
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

/**
 * 「这期只标了结束」的补记开始日。前端按预计持续天数倒推后传上来，这里只做
 * 边界校验（必须先于结束、且不超出一次经期的上限），不替它重新算一遍。
 */
function periodStartDateField(value: unknown, endDate: string): string {
  const start = parseDateQuery(stringField(value, "periodStartDate"), "periodStartDate");
  if (start === undefined) throw new HttpError(400, "invalid_date", "periodStartDate must be a date");
  const gap = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(gap) || gap < 1 || gap > MAX_PERIOD_SPAN_DAYS - 1) {
    throw new HttpError(400, "invalid_date", `periodStartDate must be 1-${MAX_PERIOD_SPAN_DAYS - 1} days before the end`);
  }
  return start;
}

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
  if (await handleHabitRoutes(ctx, req, res, pathname, url)) return true;
  if (pathname === "/api/modules/cycle-intimacy" && req.method === "GET") {
    setJson(res, 200, cycleModuleResponse(repository));
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/config" && req.method === "PUT") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    // Habit edits have their own revision-checked routes. Old settings clients
    // must not erase habits or overwrite marks from a stale config snapshot.
    const current = repository.cycleIntimacyModule().config;
    const proposed = cycleIntimacyConfig(input);
    if (proposed.subjectId && !repository.findEntityById(proposed.subjectId)?.type?.includes("person")) throw new HttpError(400, "unknown_subject", "请从联系人中选择人物");
    repository.writeCycleIntimacyConfig({ ...proposed, ...(current.habits ? { habits: current.habits } : {}), ...(current.otherSubjects ? { otherSubjects: current.otherSubjects } : {}) });
    setJson(res, 200, cycleModuleResponse(repository));
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/transfer" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["groupKeys", "targetSubjectId", "revision"]);
    if (!Array.isArray(input.groupKeys) || input.groupKeys.length > 100 || !input.groupKeys.every(key => typeof key === "string" && key.length > 0)) throw new HttpError(400, "invalid_groups", "请选择要转移的经期");
    const targetSubjectId = input.targetSubjectId === null || input.targetSubjectId === undefined ? undefined : stringField(input.targetSubjectId, "targetSubjectId", { nonEmpty: true });
    if (targetSubjectId && repository.findEntityById(targetSubjectId)?.type !== "person") throw new HttpError(400, "unknown_subject", "请从联系人中选择人物");
    if (stringField(input.revision, "revision") !== repository.cycleIntimacyEventRevision()) throw new HttpError(409, "cycle_conflict", "周期记录已改变，请重新载入");
    try { repository.transferCyclePeriods(input.groupKeys as string[], targetSubjectId); }
    catch (error) { throw new HttpError(409, "cycle_transfer_conflict", error instanceof Error ? error.message : "转移失败"); }
    setJson(res, 200, cycleModuleResponse(repository));
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/day-edit" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["date", "kinds", "revision", "periodStartDate"]);
    const date = parseDateQuery(stringField(input.date, "date"), "date");
    if (date === undefined) throw new HttpError(400, "invalid_date", "date is required");
    if (!Array.isArray(input.kinds) || input.kinds.length > MOBILE_CYCLE_EVENT_KINDS.length) {
      throw new HttpError(400, "invalid_field", "kinds must be a set of mobile cycle event kinds");
    }
    const kinds = input.kinds.map((kind, index) => enumField(kind, MOBILE_CYCLE_EVENT_KINDS, `kinds[${index}]`));
    if (new Set(kinds).size !== kinds.length) throw new HttpError(400, "invalid_field", "kinds must not contain duplicates");
    const revision = stringField(input.revision, "revision", { nonEmpty: true });
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new HttpError(400, "invalid_revision", "revision must be a cycle event revision");
    const periodStartDate = input.periodStartDate === undefined ? undefined : periodStartDateField(input.periodStartDate, date);
    if (periodStartDate !== undefined && !kinds.includes("period_end")) {
      throw new HttpError(400, "invalid_field", "periodStartDate is only allowed when the end is being recorded");
    }
    try {
      setJson(res, 200, repository.editCycleIntimacyDay(date, kinds, revision, periodStartDate));
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
    const event = cycleIntimacyEvent(input, ["periodStartDate"]);
    const periodStartDate = input.periodStartDate === undefined ? undefined : periodStartDateField(input.periodStartDate, event.date);
    if (periodStartDate !== undefined && event.kind !== "period_end") {
      throw new HttpError(400, "invalid_field", "periodStartDate is only allowed on a period end");
    }
    if (repository.cycleIntimacyModule().events.some((existing) => existing.date === event.date && existing.kind === event.kind)) {
      throw new HttpError(409, "event_exists", "This calendar marker already exists");
    }
    repository.addCycleIntimacyEvent(event, periodStartDate);
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
import { handleHabitRoutes } from "./routes-habits.js";
