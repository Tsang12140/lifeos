import type { IncomingMessage, ServerResponse } from "node:http";
import {
  clearWeatherCache,
  decideForcedRefresh,
  fetchRealtimeWeather,
  fetchWeatherSnapshot,
  lookupWeatherLocationByCoordinates,
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

/**
 * A device asks the provider for its city at most once a minute. The row is
 * keyed by the tenant data directory as well as the device, because the same
 * browser cookie is presented to every space and each space has its own
 * repository. When the map grows past its cap it is dropped whole: this is a
 * throttle, not a record, and losing it only lets one lookup through early.
 */
const GEO_MIN_INTERVAL_MS = 60_000;
const lastGeoLookupAt = new Map<string, number>();
function geoLookupAllowed(key: string, now: number): boolean {
  if (lastGeoLookupAt.size > 2048) lastGeoLookupAt.clear();
  const previous = lastGeoLookupAt.get(key);
  if (previous !== undefined && now - previous < GEO_MIN_INTERVAL_MS) return false;
  lastGeoLookupAt.set(key, now);
  return true;
}

function coordinateField(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_field", `${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

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

  if (pathname === "/api/weather/device/location" && req.method === "POST") {
    // The welcome flow (and the settings picker) choose a city before any
    // weather config file exists. This writes only the device row: it must not
    // depend on a saved key, and it must never touch the space-wide default.
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["locationId", "city"]);
    const locationId = stringField(input.locationId ?? "", "locationId").trim();
    const city = stringField(input.city ?? "", "city").trim();
    if (!locationId && !city) throw new HttpError(400, "invalid_weather_location", "位置 ID 和城市名至少填写一个");
    const deviceId = weatherDeviceId(req, res, config);
    const deviceLocation = repository.saveWeatherDeviceLocation(deviceId, locationId, city, JSON.stringify(nowInstant()));
    clearWeatherCache();
    setJson(res, 200, { ...publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)), locationId: deviceLocation.locationId, city: deviceLocation.city, locationScope: "device" });
    return true;
  }
  if (pathname === "/api/weather/device/locate" && req.method === "POST") {
    // A phone reports where it is and the server names the city. The raw
    // coordinates are used once for the lookup and are never persisted: only
    // the resolved city id and label reach the repository.
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["latitude", "longitude"]);
    const latitude = coordinateField(input.latitude, "latitude", -90, 90);
    const longitude = coordinateField(input.longitude, "longitude", -180, 180);
    const deviceId = weatherDeviceId(req, res, config);
    const runtime = readRuntimeWeatherConfig(config);
    if (!runtime.apiKey) throw new HttpError(400, "weather_not_configured", "天气服务尚未配置，请联系空间管理员");
    const now = Date.now();
    // Being told to wait is not an error: answer with the city already in
    // force. A client that re-locates in a tight loop cannot spend the shared
    // provider quota, and the person still gets a coherent page.
    if (!geoLookupAllowed(`${config.dataDirectory}|${deviceId}`, now)) {
      const current = repository.getWeatherDeviceLocation(deviceId);
      setJson(res, 200, { ...publicWeatherConfig(config, weatherLocationOverride(config, current)), locationScope: "device", throttled: true });
      return true;
    }
    const location = await lookupWeatherLocationByCoordinates(runtime, longitude, latitude);
    if (location === null) throw new HttpError(502, "weather_location_failed", "暂时无法根据当前位置确定城市，请手动选择");
    const deviceLocation = repository.saveWeatherDeviceLocation(deviceId, location.id, location.name, JSON.stringify(nowInstant()));
    clearWeatherCache();
    setJson(res, 200, { ...publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)), locationId: deviceLocation.locationId, city: deviceLocation.city, locationScope: "device", location });
    return true;
  }

  return false;
};

