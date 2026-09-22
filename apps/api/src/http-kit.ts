import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiConfig } from "./config.js";
import type { SqliteRecordRepository } from "./repository.js";
import { readWeatherProfile, type WeatherLocationOverride } from "./weather-config.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function backupHttpError(error: unknown): HttpError {
  return error instanceof HttpError
    ? error
    : new HttpError(502, "backup_failed", error instanceof Error ? error.message : "备份失败");
}

export function setJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function setEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "cache-control": "no-store", ...extraHeaders });
  res.end();
}

export const SESSION_COOKIE = "lifeos_session";
export const WEATHER_DEVICE_COOKIE = "lifeos_weather_device";

export function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function cookieHeader(value: string, config: ApiConfig, maxAge: number): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function weatherDeviceCookieHeader(value: string, config: ApiConfig): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${WEATHER_DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure}`;
}

export function weatherDeviceId(req: IncomingMessage, res: ServerResponse, config: ApiConfig): string {
  const existing = cookieValue(req, WEATHER_DEVICE_COOKIE);
  if (existing !== undefined && existing.length > 0) return existing;
  const id = randomUUID();
  res.setHeader("set-cookie", weatherDeviceCookieHeader(id, config));
  return id;
}

export function weatherLocationOverride(config: ApiConfig, deviceLocation: ReturnType<SqliteRecordRepository["getWeatherDeviceLocation"]>): WeatherLocationOverride | undefined {
  if (deviceLocation === null) return undefined;
  if (deviceLocation.profileId !== undefined) {
    const profile = readWeatherProfile(config, deviceLocation.profileId);
    if (profile !== null) return { profileId: deviceLocation.profileId, locationId: profile.locationId, city: profile.city, apiHost: profile.apiHost, apiKey: profile.apiKey ?? null };
  }
  return { locationId: deviceLocation.locationId, city: deviceLocation.city };
}



export function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
