import type { IncomingMessage, ServerResponse } from "node:http";
import {
  clearWeatherCache,
  decideForcedRefresh,
  fetchRealtimeWeather,
  fetchWeatherSnapshot,
  recordWeatherObservation,
  verifyWeatherLocation,
  WEATHER_OBSERVATION_TIME_ZONE,
} from "./weather.js";
import { readRuntimeWeatherConfig, saveRuntimeWeatherConfig } from "./weather-config.js";
import {
  listWeatherProfiles,
  publicWeatherConfig,
  readWeatherProfile,
  saveWeatherProfile,
} from "./weather-config.js";
import { WEATHER_ARCHIVE_TIME_ZONE } from "./weather-archive-scheduler.js";
import { selectDayObservations } from "./weather-selection.js";
import { HttpError, setJson, setEmpty } from "./http-kit.js";
import { weatherDeviceCookieHeader, weatherDeviceId, weatherLocationOverride } from "./http-cookies.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { booleanField, hasOnlyKeys, jsonObject, nowInstant, parseDateQuery, stringField } from "./field-validate.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

export const handleWeatherRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository, weatherArchiveScheduler, loginFailures, authenticated } = ctx;
  if (pathname === "/api/weather" && req.method === "GET") {
    // Same three-tier day-key rule as every other date endpoint: the regex
    // alone would let 2026-02-30 through, and this value is used as a cache key.
    const requestedDate = parseDateQuery(url.searchParams.get("date"), "date") ?? null;
    const deviceId = weatherDeviceId(req, res, config);
    const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
    const override = weatherLocationOverride(config, deviceLocation);
    // A manual refresh is rate-limited, but being told to wait is not an
    // error: answer 200 with the cached snapshot and say how long.
    const wantsForce = url.searchParams.get("force") === "1";
    const escalated = url.searchParams.get("escalate") === "1";
    let force = false;
    let throttle: { readonly retryAfterMs: number } | null = null;
    if (wantsForce) {
      const key = `${deviceLocation?.locationId ?? readRuntimeWeatherConfig(config).locationId}:${readRuntimeWeatherConfig(config).apiHost}`;
      const decision = decideForcedRefresh(key, Date.now(), escalated);
      if (decision.allowed) force = true;
      else throttle = { retryAfterMs: decision.retryAfterMs };
    }
    const result = await fetchWeatherSnapshot(config, requestedDate, override, repository, { force });
    setJson(res, 200, {
      weatherSnapshot: result.snapshot,
      location: result.location,
      ...(throttle === null ? {} : { throttled: true, retryAfterMs: throttle.retryAfterMs }),
    });
    return true;
  }
  if (pathname === "/api/weather/current" && req.method === "POST") {
    requireJsonContentType(req, true);
    const deviceId = weatherDeviceId(req, res, config);
    const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
    const result = await fetchRealtimeWeather(config, weatherLocationOverride(config, deviceLocation));
    if (result === null) throw new HttpError(502, "weather_current_failed", "实时天气暂时不可用，请检查天气配置");
    // The owner pressed the button, so this reading is worth keeping: it is
    // the one that means "I was outside right then".
    recordWeatherObservation(repository, { weather: result.weather, location: result.location, source: "manual" });
    setJson(res, 200, result);
    return true;
  }
  if (pathname === "/api/weather/config" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["enabled", "locationId", "city", "apiHost", "apiKey", "clearApiKey"]);
    try {
      const deviceId = weatherDeviceId(req, res, config);
      const locationId = stringField(input.locationId ?? "", "locationId").trim();
      const city = stringField(input.city ?? "", "city").trim();
      const status = saveRuntimeWeatherConfig(config, {
        enabled: input.enabled === undefined ? true : booleanField(input.enabled, "enabled"),
        locationId,
        city,
        apiHost: stringField(input.apiHost ?? "devapi.qweather.com", "apiHost", { nonEmpty: true }),
        ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
        ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
      });
      const deviceLocation = repository.saveWeatherDeviceLocation(deviceId, locationId, city, JSON.stringify(nowInstant()));
      clearWeatherCache();
      setJson(res, 200, { ...status, locationId: deviceLocation.locationId, city: deviceLocation.city, locationScope: "device" });
    } catch (error) {
      throw new HttpError(400, "invalid_weather_config", error instanceof Error ? error.message : "天气配置无效");
    }
    return true;
  }
  if (pathname === "/api/weather/config/test" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["locationId", "apiHost", "apiKey"]);
    try {
      weatherDeviceId(req, res, config);
      const result = await verifyWeatherLocation(config, {
        locationId: stringField(input.locationId, "locationId", { nonEmpty: true }),
        ...(input.apiHost === undefined ? {} : { apiHost: stringField(input.apiHost, "apiHost") }),
        ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
      });
      setJson(res, 200, { ok: true, message: "天气 API 连接成功", location: result.location });
    } catch (error) {
      throw new HttpError(502, "weather_config_test_failed", error instanceof Error ? error.message : "天气 API 连接失败");
    }
    return true;
  }
  if (pathname === "/api/weather/archive" && req.method === "GET") {
    const from = parseDateQuery(url.searchParams.get("from"), "from");
    const to = parseDateQuery(url.searchParams.get("to"), "to");
    if (from === undefined || to === undefined) throw new HttpError(400, "invalid_range", "from and to are required");
    if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || (end - start) / 86_400_000 > 62) {
      throw new HttpError(400, "invalid_range", "天气归档最多查询 63 天");
    }
    const deviceId = weatherDeviceId(req, res, config);
    const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
    // Read only the currently active device/profile location. Do not union
    // stale device keys with the profile key: a same-day row from another
    // city must never leak into this device's month view.
    const activeOverride = deviceLocation === null ? undefined : weatherLocationOverride(config, deviceLocation);
    const runtime = activeOverride === undefined ? readRuntimeWeatherConfig(config) : activeOverride;
    const locationKeys = new Set<string>();
    if (runtime.locationId) locationKeys.add(runtime.locationId);
    if (runtime.city) locationKeys.add(runtime.city);
    const rows = [...locationKeys].flatMap((locationKey) => repository.listWeatherDayCache(from, to, locationKey));
    const unique = new Map(rows.map((row) => [`${row.date}|${row.locationKey}`, row]));
    setJson(res, 200, { from, to, timeZone: WEATHER_ARCHIVE_TIME_ZONE, items: [...unique.values()].sort((left, right) => left.date.localeCompare(right.date) || left.locationKey.localeCompare(right.locationKey)) });
    return true;
  }
  if (pathname === "/api/weather/observations" && req.method === "GET") {
    const date = parseDateQuery(url.searchParams.get("date"), "date");
    if (date === undefined) throw new HttpError(400, "invalid_date", "date is required");
    const deviceId = weatherDeviceId(req, res, config);
    const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
    const activeOverride = deviceLocation === null ? undefined : weatherLocationOverride(config, deviceLocation);
    const runtime = activeOverride === undefined ? readRuntimeWeatherConfig(config) : activeOverride;
    const locationKey = runtime.locationId || runtime.city;
    const all = repository.listWeatherObservations(date, locationKey || undefined);
    // A day can overflow with routine ticks. What the owner gets back is the
    // day's kept history, not every raw row that was ever written.
    setJson(res, 200, {
      date,
      timeZone: WEATHER_OBSERVATION_TIME_ZONE,
      total: all.length,
      items: selectDayObservations(all),
    });
    return true;
  }

  return false;
};

