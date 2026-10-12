import { createHash } from "node:crypto";
import { readAmapConfig } from "./amap-location.js";
import { HttpError } from "./http-kit.js";
import type { RouteHandler } from "./route-context.js";
import { decodeSegment } from "./record-builders.js";

const images = new Map<string, { until: number; bytes: Buffer; type: string }>();
const pending = new Map<string, Promise<{ bytes: Buffer; type: string }>>();
const limits = new Map<string, { since: number; count: number }>();

/** Fixed provider origin and bounded image stream. Never expose the service key. */
export async function fetchStaticMap(url: URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
  const type = response.headers.get("content-type")?.split(";")[0];
  if (!response.ok || !response.body || (type !== "image/png" && type !== "image/jpeg")) { await response.body?.cancel(); throw new HttpError(502, "map_unavailable", "地图暂时无法加载，请稍后重试"); }
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new HttpError(502, "map_too_large", "地图暂时无法加载，请稍后重试");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const valid = type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw new HttpError(502, "map_unavailable", "地图暂时无法加载，请稍后重试");
  return { bytes, type };
}

export const handleStaticMap: RouteHandler = async (ctx, req, res, pathname, url) => {
  const match = /^\/api\/places\/([^/]+)\/map$/.exec(pathname);
  if (!match || req.method !== "GET") return false;
  ctx.requireAuth(req);
  const place = ctx.repository.findEntityById(decodeSegment(match[1]!));
  if (!place || place.type !== "place") throw new HttpError(404, "place_missing", "地点不存在");
  if (!Number.isFinite(place.longitude) || !Number.isFinite(place.latitude)) throw new HttpError(409, "place_point_missing", "这个地点尚未保存地图位置");
  for (const key of url.searchParams.keys()) if (!["zoom", "width", "height", "longitude", "latitude", "retry"].includes(key)) throw new HttpError(400, "map_input", "地图参数无效");
  const number = (name: string, fallback: number, min: number, max: number, integer = false) => {
    const raw = url.searchParams.get(name), value = raw === null ? fallback : raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new HttpError(400, "map_input", "地图参数无效");
    return value;
  };
  const zoom = number("zoom", 16, 3, 17, true), width = number("width", 320, 100, 1024, true), height = number("height", 320, 100, 1024, true);
  number("retry", 0, 0, 1000000, true);
  const longitude = number("longitude", place.longitude!, -180, 180), latitude = number("latitude", place.latitude!, -85, 85);
  const runtime = readAmapConfig(ctx.config);
  if (!runtime.apiKey) throw new HttpError(409, "amap_key_missing", "请先在设置中配置地点搜索服务");
  const provider = new URL("https://restapi.amap.com/v3/staticmap");
  provider.search = new URLSearchParams({ key: runtime.apiKey, location: `${longitude.toFixed(6)},${latitude.toFixed(6)}`, zoom: String(zoom), size: `${width}*${height}`, scale: "1", markers: `mid,0xE45454,:${place.longitude!.toFixed(6)},${place.latitude!.toFixed(6)}` }).toString();
  const key = createHash("sha256").update(`${ctx.config.dataDirectory}|${provider.href}`).digest("hex");
  let image = images.get(key);
  if (!image || image.until <= Date.now()) {
    let work = pending.get(key);
    if (!work) {
      const scope = ctx.config.dataDirectory, prior = limits.get(scope), now = Date.now();
      if (prior && now - prior.since < 60000 && prior.count >= 40) throw new HttpError(429, "map_limit", "地图操作太频繁，请稍后重试");
      if (limits.size >= 2048 && !limits.has(scope)) limits.clear();
      limits.set(scope, prior && now - prior.since < 60000 ? { ...prior, count: prior.count + 1 } : { since: now, count: 1 });
      work = fetchStaticMap(provider); pending.set(key, work);
    }
    try {
      image = { ...await work, until: Date.now() + 60000 };
      if (images.size >= 32) images.delete(images.keys().next().value!);
      images.set(key, image);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "map_unavailable", "地图暂时无法加载，请稍后重试");
    } finally { if (pending.get(key) === work) pending.delete(key); }
  }
  if (!res.destroyed) { res.writeHead(200, { "content-type": image.type, "content-length": image.bytes.length, "cache-control": "private, no-cache", "x-content-type-options": "nosniff" }); res.end(image.bytes); }
  return true;
};
