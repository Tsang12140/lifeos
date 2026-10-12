import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { ApiConfig } from "./config.js";

interface Stored { enabled: boolean; encrypted?: string; iv?: string; tag?: string }
const pathFor = (config: ApiConfig) => join(config.dataDirectory, "amap-config.json");
function stored(config: ApiConfig): Stored {
  if (!existsSync(pathFor(config))) return { enabled: false };
  const value = JSON.parse(readFileSync(pathFor(config), "utf8")) as Stored;
  if (typeof value.enabled !== "boolean") throw new Error("高德配置无法读取，请检查配置文件");
  return value;
}
function keyFor(config: ApiConfig): Buffer {
  return scryptSync(config.tenantConfigSecrets?.weather || process.env.LIFEOS_AMAP_CONFIG_SECRET?.trim() || process.env.LIFEOS_WEATHER_CONFIG_SECRET?.trim() || process.env.LIFEOS_PASSWORD || `lifeos-local-weather:${config.dataDirectory}`, "lifeos-amap-config-v1", 32);
}
export function readAmapConfig(config: ApiConfig): { enabled: boolean; apiKey?: string; hasStoredKey: boolean } {
  const value = stored(config);
  let apiKey: string | undefined;
  if (value.encrypted && value.iv && value.tag) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", keyFor(config), Buffer.from(value.iv, "base64"));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      apiKey = Buffer.concat([decipher.update(Buffer.from(value.encrypted, "base64")), decipher.final()]).toString("utf8");
    } catch { /* Preserve unreadable ciphertext; a blank save must never erase it. */ }
  }
  return { enabled: value.enabled, ...(apiKey ? { apiKey } : {}), hasStoredKey: Boolean(value.encrypted || value.iv || value.tag) };
}
export function publicAmapConfig(config: ApiConfig) {
  const value = readAmapConfig(config);
  return { enabled: value.enabled, hasKey: Boolean(value.apiKey), keyUnreadable: value.hasStoredKey && !value.apiKey };
}
export function saveAmapConfig(config: ApiConfig, input: { enabled: boolean; apiKey?: string; clearApiKey?: boolean }) {
  const previous = stored(config);
  const value: Stored = { ...previous, enabled: input.enabled };
  if (input.clearApiKey) { delete value.encrypted; delete value.iv; delete value.tag; }
  else if (input.apiKey?.trim()) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyFor(config), iv);
    value.encrypted = Buffer.concat([cipher.update(input.apiKey.trim(), "utf8"), cipher.final()]).toString("base64");
    value.iv = iv.toString("base64"); value.tag = cipher.getAuthTag().toString("base64");
  }
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(pathFor(config), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  for (const key of cache.keys()) if (key.startsWith(`${config.dataDirectory}|`)) cache.delete(key);
  return publicAmapConfig(config);
}

export function publicIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a = 0, b = 0] = value.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
}
/** Trust X-Real-IP only behind an explicitly trusted, loopback reverse proxy. */
export function locationClientIp(req: IncomingMessage): string | null {
  const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (publicIpv4(remote)) return remote;
  if (process.env.LIFEOS_TRUST_PROXY !== "1" || !["127.0.0.1", "::1"].includes(remote)) return null;
  const real = req.headers["x-real-ip"];
  return typeof real === "string" && publicIpv4(real.trim()) ? real.trim() : null;
}

const cache = new Map<string, { expires: number; pending: Promise<{ longitude: number; latitude: number }> }>();
export async function lookupAmapIp(config: ApiConfig, ip: string): Promise<{ longitude: number; latitude: number }> {
  const runtime = readAmapConfig(config);
  if (!runtime.enabled || !runtime.apiKey) throw new Error("高德备用定位尚未启用或未配置 Key");
  const cacheKey = `${config.dataDirectory}|${ip}`;
  const previous = cache.get(cacheKey);
  if (previous && previous.expires > Date.now()) return previous.pending;
  if (cache.size > 2048) cache.clear();
  const pending = (async () => {
    const url = new URL("https://restapi.amap.com/v3/ip");
    url.searchParams.set("key", runtime.apiKey!); url.searchParams.set("ip", ip);
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000) });
    const data = await response.json() as { status?: string; rectangle?: unknown; city?: unknown };
    if (!response.ok || data.status !== "1" || typeof data.city !== "string" || !data.city || typeof data.rectangle !== "string") throw new Error("网络定位暂时无法确定城市，请重试或手动选择");
    const points = data.rectangle.split(/[;,]/).map(Number);
    if (points.length !== 4 || points.some(n => !Number.isFinite(n)) || Math.abs(points[0]!) > 180 || Math.abs(points[2]!) > 180 || Math.abs(points[1]!) > 90 || Math.abs(points[3]!) > 90) throw new Error("网络定位返回了无效位置");
    return { longitude: (points[0]! + points[2]!) / 2, latitude: (points[1]! + points[3]!) / 2 };
  })();
  cache.set(cacheKey, { expires: Date.now() + 15 * 60_000, pending });
  try { return await pending; } catch (error) { cache.delete(cacheKey); throw error; }
}
