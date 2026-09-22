import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, setJson, setEmpty } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import {
  cycleIntimacyConfig,
  cycleIntimacyEvent,
  hasOnlyKeys,
  jsonObject,
  stringField,
} from "./field-validate.js";
import { decodeSegment, safeId } from "./record-builders.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

export const handleModulesRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository, weatherArchiveScheduler, loginFailures, authenticated } = ctx;
  if (pathname === "/api/modules/cycle-intimacy" && req.method === "GET") {
    setJson(res, 200, repository.cycleIntimacyModule());
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/config" && req.method === "PUT") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    setJson(res, 200, repository.writeCycleIntimacyConfig(cycleIntimacyConfig(input)));
    return true;
  }
  if (pathname === "/api/modules/cycle-intimacy/events" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    const event = cycleIntimacyEvent(input);
    if (repository.cycleIntimacyModule().events.some((existing) => existing.date === event.date && existing.kind === event.kind)) {
      throw new HttpError(409, "event_exists", "This calendar marker already exists");
    }
    setJson(res, 201, repository.addCycleIntimacyEvent(event));
    return true;
  }
  const cycleEventMatch = /^\/api\/modules\/cycle-intimacy\/events\/([^/]+)$/.exec(pathname);
  if (cycleEventMatch !== null && req.method === "DELETE") {
    const id = decodeSegment(cycleEventMatch[1]!);
    if (!repository.deleteCycleIntimacyEvent(id)) throw new HttpError(404, "not_found", "Cycle module event not found");
    setJson(res, 200, repository.cycleIntimacyModule());
    return true;
  }

  return false;
};

