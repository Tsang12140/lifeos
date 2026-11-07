import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, setJson } from "../http-kit.js";
import type { RouteContext, RouteHandler } from "../route-context.js";
import { readVolumeConfig, resolveWithinRoot, type VolumeConfig } from "./volume-config.js";
import { forgetVolume, probeVolume, type VolumeProbe } from "./volume-probe.js";
import { sendVolumeFile } from "./volume-stream.js";

/**
 * Everything the volume module exposes lives under `/api/volume/`. Mounting one
 * handler here is the *entire* server integration: removing this file and its
 * single call site leaves the rest of the API untouched.
 *
 * `requireAuth` has already run by the time this handler is reached
 * (`apps/api/src/server.ts:602`), so these routes inherit the app's own login.
 */

let resolved: VolumeConfig | null | undefined;

/** Read once per process: an environment change needs a restart anyway. */
function volumeConfig(): VolumeConfig | null {
  if (resolved === undefined) resolved = readVolumeConfig();
  return resolved;
}

function statusBody(config: VolumeConfig, probe: VolumeProbe): Record<string, unknown> {
  return {
    enabled: true,
    root: config.root,
    state: probe.state,
    latencyMs: probe.latencyMs,
    reason: probe.reason ?? null,
    checkedAt: probe.checkedAt,
  };
}

function requireConfig(): VolumeConfig {
  const config = volumeConfig();
  if (config === null) throw new HttpError(503, "volume_disabled", "还没有设置硬盘文件夹（LIFEOS_VOLUME_ROOT）");
  return config;
}

export const handleVolumeRoutes: RouteHandler = async (
  _ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  if (!pathname.startsWith("/api/volume/")) return false;

  if (pathname === "/api/volume/status" && (req.method === "GET" || req.method === "HEAD")) {
    const config = volumeConfig();
    if (config === null) {
      setJson(res, 200, { enabled: false });
      return true;
    }
    setJson(res, 200, statusBody(config, await probeVolume(config.root)));
    return true;
  }

  if (pathname === "/api/volume/refresh" && req.method === "POST") {
    const config = requireConfig();
    forgetVolume(config.root);
    setJson(res, 200, statusBody(config, await probeVolume(config.root)));
    return true;
  }

  if (pathname === "/api/volume/file") {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "只支持 GET");
    const config = requireConfig();
    const relativePath = url.searchParams.get("path");
    if (relativePath === null || relativePath === "") throw new HttpError(400, "missing_path", "缺少 path 参数");

    // The probe runs first so "disk unplugged" is never reported as "file gone".
    const probe = await probeVolume(config.root);
    if (probe.state === "offline") {
      throw new HttpError(409, "volume_offline", probe.reason ?? "硬盘未连接", { state: "offline" });
    }

    const absolute = resolveWithinRoot(config.root, relativePath);
    if (absolute === null) throw new HttpError(400, "invalid_reference", "这个路径不在硬盘文件夹里");
    await sendVolumeFile(absolute, req, res);
    return true;
  }

  throw new HttpError(404, "not_found", "没有这个收藏接口");
};
