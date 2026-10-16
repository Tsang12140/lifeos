import { createReadStream, statSync } from "node:fs";
import { HttpError, setEmpty, setJson } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { booleanField, hasOnlyKeys, jsonObject, stringField } from "./field-validate.js";
import type { RouteHandler } from "./route-context.js";

export const handleCalendarBackgroundRoutes: RouteHandler = async (ctx, req, res, pathname, url) => {
  if (!pathname.startsWith("/api/calendar/background")) return false;
  // Keep an empty status for old clients so their mounted artwork is cleared.
  // Settings, images and generation stay inaccessible while their files are retained.
  if (!ctx.calendarBackgrounds.enabled && !(pathname === "/api/calendar/background" && req.method === "GET")) {
    throw new HttpError(503, "background_disabled", "月历照片背景已暂时停用");
  }
  if (pathname === "/api/calendar/background/settings" && req.method === "GET") {
    setJson(res, 200, ctx.calendarBackgrounds.preferences(), { "cache-control": "private, no-store" });
    return true;
  }
  if (pathname === "/api/calendar/background/settings" && req.method === "PUT") {
    requireJsonContentType(req);
    const body = jsonObject(await readBody(req, ctx.config.bodyLimitBytes), "body");
    let preferences;
    try { preferences = ctx.calendarBackgrounds.savePreferences(body); }
    catch (error) {
      if (error instanceof Error && (error.message.includes("照片墙") || error.message.includes("照片尺寸"))) throw new HttpError(400, "invalid_field", error.message);
      throw error;
    }
    setJson(res, 200, preferences, { "cache-control": "private, no-store" });
    return true;
  }
  if (pathname === "/api/calendar/background/viewing" && req.method === "POST") {
    requireJsonContentType(req);
    const body = jsonObject(await readBody(req, ctx.config.bodyLimitBytes), "body");
    hasOnlyKeys(body, ["token", "active"]);
    const token = stringField(body.token, "token");
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(token)) throw new HttpError(400, "invalid_token", "查看标记格式不正确");
    ctx.calendarBackgrounds.viewing(token, booleanField(body.active, "active"));
    setEmpty(res, 204);
    return true;
  }
  const month = url.searchParams.get("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "invalid_month", "月份格式不正确");
  const hideDemo = url.searchParams.get("hideDemo") === "1";
  if (pathname === "/api/calendar/background" && req.method === "GET") {
    setJson(res, 200, ctx.calendarBackgrounds.status(month, hideDemo, new Date(), url.searchParams.get("v") ?? undefined), { "cache-control": "private, no-store" });
    return true;
  }
  if (pathname === "/api/calendar/background/generate" && req.method === "POST") {
    requireJsonContentType(req, true);
    try {
      setJson(res, 200, await ctx.calendarBackgrounds.generateNow(month, hideDemo), { "cache-control": "private, no-store" });
    } catch (error) {
      if (error instanceof Error && error.message === "background_not_enough_photos") throw new HttpError(409, "background_not_enough_photos", "本月至少需要 9 张有效照片才能生成背景");
      if (error instanceof Error && error.message === "background_busy") throw new HttpError(409, "background_busy", "已有拼图正在准备，请稍后再试");
      if (error instanceof Error && error.message === "background_changed") throw new HttpError(409, "background_changed", "照片已发生变化，请重新生成");
      throw error;
    }
    return true;
  }
  if (pathname === "/api/calendar/background/preview" && req.method === "POST") {
    requireJsonContentType(req, true);
    let imageUrl: string | null;
    try { imageUrl = await ctx.calendarBackgrounds.preview(month, hideDemo); }
    catch (error) {
      if (error instanceof Error && error.message === "background_busy") throw new HttpError(409, "background_busy", "已有拼图正在准备，请稍后再试");
      throw error;
    }
    setJson(res, 200, { imageUrl }, { "cache-control": "private, no-store" });
    return true;
  }
  if (pathname === "/api/calendar/background/image" && req.method === "GET") {
    const version = url.searchParams.get("v") ?? "";
    if (!/^[a-f0-9]{64}$/.test(version)) throw new HttpError(400, "invalid_version", "背景版本格式不正确");
    const file = ctx.calendarBackgrounds.file(month, hideDemo, version);
    if (!file) throw new HttpError(404, "not_found", "背景暂不可用");
    // Revalidate private bytes so a deleted/private source or another login cannot reuse an old montage.
    const headers = { "cache-control": "private, max-age=0, must-revalidate", etag: `"${version}"`, vary: "Cookie", "x-content-type-options": "nosniff" };
    if (req.headers["if-none-match"] === `"${version}"`) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, { ...headers, "content-type": "image/webp", "content-length": statSync(file).size });
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return true;
  }
  return false;
};
