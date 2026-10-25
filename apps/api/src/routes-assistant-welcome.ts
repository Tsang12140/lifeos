import { booleanField, boundedIntegerField, hasOnlyKeys, jsonObject, stringField } from "./field-validate.js";
import { HttpError, setJson } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import type { RouteHandler } from "./route-context.js";

const textField = (value: unknown) => {
  const text = stringField(value, "text", { nonEmpty: true }).trim();
  if (!text || text.length > 120 || /[\r\n\u0000-\u001f]/.test(text)) throw new HttpError(400, "invalid_welcome_text", "问题需为1到120字的单行文字");
  return text;
};
export const handleAssistantWelcomeRoutes: RouteHandler = async (ctx, req, res, pathname, url) => {
  const publicPath = "/api/ai/assistant/welcome", adminPath = "/api/admin/assistant-welcome";
  if (pathname !== publicPath && pathname !== publicPath + "/events" && pathname !== adminPath && !pathname.startsWith(adminPath + "/")) return false;
  const store = ctx.welcomeStore;
  if (pathname.startsWith(adminPath)) {
    if (!ctx.poolAdmin) throw new HttpError(403, "owner_required", "仅管理员可管理开场问题和查看统计");
    if (pathname === adminPath && req.method === "GET") {
      if ([...url.searchParams.keys()].some(k => k !== "days") || url.searchParams.getAll("days").length > 1) throw new HttpError(400, "invalid_days", "统计范围不正确");
      const days = Number(url.searchParams.get("days") ?? 30);
      if (days !== 0 && days !== 7 && days !== 30) throw new HttpError(400, "invalid_days", "请选择近7天、30天或近一年");
      setJson(res, 200, store.snapshot(days)); return true;
    }
    if (url.search) throw new HttpError(400, "unknown_query", "不支持此查询参数");
    if (req.method !== "POST" && req.method !== "PATCH") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, ctx.config.bodyLimitBytes), "body");
    if (pathname === adminPath && req.method === "POST") {
      hasOnlyKeys(input, ["text", "general"]);
      setJson(res, 201, store.create(textField(input.text), input.general === undefined ? false : booleanField(input.general, "general"))); return true;
    }
    const match = /^\/api\/admin\/assistant-welcome\/([a-zA-Z0-9-]+)$/.exec(pathname);
    if (!match || req.method !== "PATCH") throw new HttpError(404, "not_found", "找不到此管理操作");
    hasOnlyKeys(input, ["revision", "text", "enabled", "general", "pinned"]);
    const patch = {
      ...(input.text === undefined ? {} : { text: textField(input.text) }),
      ...(input.enabled === undefined ? {} : { enabled: booleanField(input.enabled, "enabled") }),
      ...(input.general === undefined ? {} : { general: booleanField(input.general, "general") }),
      ...(input.pinned === undefined ? {} : { pinned: booleanField(input.pinned, "pinned") }),
    };
    if (!Object.keys(patch).length) throw new HttpError(400, "empty_welcome_patch", "请选择要修改的内容");
    setJson(res, 200, store.update(match[1]!, boundedIntegerField(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER), patch)); return true;
  }
  if (url.search) throw new HttpError(400, "unknown_query", "不支持此查询参数");
  if (pathname === publicPath && req.method === "GET") {
    setJson(res, 200, store.selection(ctx.poolAccountId), { "cache-control": "no-store" }); return true;
  }
  if (pathname !== publicPath + "/events" || req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
  requireJsonContentType(req);
  const input = jsonObject(await readBody(req, ctx.config.bodyLimitBytes), "body");
  hasOnlyKeys(input, ["selectionId", "type", "promptId"]);
  if (input.type !== "impression" && input.type !== "click") throw new HttpError(400, "invalid_welcome_event", "统计事件不正确");
  const promptId = input.promptId === undefined ? undefined : stringField(input.promptId, "promptId", { nonEmpty: true });
  setJson(res, 200, store.event(ctx.poolAccountId, stringField(input.selectionId, "selectionId", { nonEmpty: true }), input.type, promptId)); return true;
};
