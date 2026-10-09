import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ArchiveService, cleanupStaleArchives } from "./archive-service.js";
import { HttpError, setJson, setEmpty } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

const services = new WeakMap<RouteContext["repository"], ArchiveService>();
void cleanupStaleArchives().catch(() => {});
function serviceFor(ctx: RouteContext): ArchiveService { let service = services.get(ctx.repository); if (!service) { service = new ArchiveService(); services.set(ctx.repository, service); } return service; }
export function closeArchiveService(repository: RouteContext["repository"]): void { services.get(repository)?.close(); }
function idField(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) throw new HttpError(400, "archive_invalid_id", "归档编号无效"); return value; }

export const handleArchiveRoutes: RouteHandler = async (ctx, req, res, path, url) => {
  if (!path.startsWith("/api/archive/")) return false;
  const service = serviceFor(ctx);
  if (path === "/api/archive/estimate" && req.method === "GET") { setJson(res, 200, await service.estimate(ctx)); return true; }
  if (path === "/api/archive/uploads" && req.method === "POST") {
    if (!/^application\/octet-stream(?:;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "archive_content_type", "请上传完整加密包文件");
    const id = await service.upload(req); setJson(res, 201, service.view(id)); return true;
  }
  if ((path === "/api/archive/export" || path === "/api/archive/import" || path === "/api/archive/commit") && req.method === "POST") {
    requireJsonContentType(req);
    const input = await readBody(req, Math.min(ctx.config.bodyLimitBytes, 8192)) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "archive_invalid_request", "归档请求格式无效");
    if (path === "/api/archive/commit") {
      if (input.replaceConfirmed !== true) throw new HttpError(400, "archive_confirmation_required", "请确认替换当前空间数据");
      setJson(res, 200, await service.commitImport(ctx, idField(input.id))); return true;
    }
    if (typeof input.password !== "string" || input.password.length < 10 || input.password.length > 1024) throw new HttpError(400, "archive_password_invalid", "密码长度需为 10–1024 个字符");
    const id = path === "/api/archive/export" ? await service.export(ctx, input.password) : idField(input.id);
    if (path === "/api/archive/import") await service.prepareImport(ctx, id, input.password);
    setJson(res, 202, service.view(id)); return true;
  }
  const match = /^\/api\/archive\/jobs\/([0-9a-f-]{36})(\/download)?$/.exec(path);
  if (match) {
    const id = match[1]!;
    if (req.method === "DELETE" && !match[2]) { await service.remove(id); setEmpty(res, 204); return true; }
    if (req.method === "GET") {
      if (!match[2]) { setJson(res, 200, service.view(id)); return true; }
      const job = service.get(id);
      if (job.kind !== "export" || job.phase !== "ready") throw new HttpError(409, "archive_not_ready", "完整加密包尚未生成成功");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="lifeos-${job.manifest!.exportedAt.slice(0, 10)}.lifeos"`, "content-length": String(job.bytes), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      await pipeline(createReadStream(join(job.directory, "archive.lifeos")), res); return true;
    }
  }
  throw new HttpError(404, "not_found", "归档接口不存在");
};
