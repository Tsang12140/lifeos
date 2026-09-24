import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AI_REASONING_EFFORTS,
  publicAiConfig,
  saveRuntimeAiConfig,
  testRuntimeAiConfig,
} from "./ai-config.js";
import { answerLifeosAssistant, type AssistantHistoryItem } from "./assistant.js";
import {
  MovieModuleError,
  resolveMovies,
  testMovieConfig,
  type MovieCandidate,
} from "./movie.js";
import {
  publicMovieConfig,
  readRuntimeMovieConfig,
  saveRuntimeMovieConfig,
} from "./movie-config.js";
import {
  mergeMovie,
  movieInputEntity,
  movieMatch,
  moviePayload,
  } from "./movie-input.js";
import {
  listWeatherProfiles,
  publicWeatherConfig,
  assertWeatherCredentialTarget,
  readRuntimeWeatherConfig,
  readWeatherProfile,
  saveWeatherProfile,
} from "./weather-config.js";
import { clearWeatherCache } from "./weather.js";
import { HttpError, setJson, setEmpty } from "./http-kit.js";
import { weatherDeviceCookieHeader, weatherDeviceId, weatherLocationOverride } from "./http-cookies.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import {
  booleanField,
  boundedIntegerField,
  enumField,
  hasOnlyKeys,
  jsonObject,
  nowInstant,
  stringField,
  type JsonObject,
} from "./field-validate.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

export const handleAiMovieRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository, weatherArchiveScheduler, loginFailures, authenticated } = ctx;
  if (pathname === "/api/ai/status" && req.method === "GET") {
    setJson(res, 200, publicAiConfig(config));
    return true;
  }
  if (pathname === "/api/ai/config" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["enabled", "baseUrl", "model", "thinking", "reasoningEffort", "apiKey", "clearApiKey", "summaryPrompt"]);
    try {
      const status = saveRuntimeAiConfig(config, {
        enabled: input.enabled === undefined ? true : booleanField(input.enabled, "enabled"),
        baseUrl: stringField(input.baseUrl, "baseUrl", { nonEmpty: true }),
        model: stringField(input.model, "model", { nonEmpty: true }),
        ...(input.thinking === undefined ? {} : { thinking: booleanField(input.thinking, "thinking") }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort === null ? null : enumField(input.reasoningEffort, AI_REASONING_EFFORTS, "reasoningEffort") }),
        ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
        ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
        // `null` restores the shipped wording; omitting it leaves the current one alone.
        ...(input.summaryPrompt === undefined ? {} : { summaryPrompt: input.summaryPrompt === null ? null : stringField(input.summaryPrompt, "summaryPrompt") }),
      });
      setJson(res, 200, status);
    } catch (error) {
      throw new HttpError(400, "invalid_ai_config", error instanceof Error ? error.message : "AI 配置无效");
    }
    return true;
  }
  if (pathname === "/api/ai/config/test" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["baseUrl", "apiKey"]);
    try {
      const message = await testRuntimeAiConfig(config, {
        baseUrl: stringField(input.baseUrl, "baseUrl", { nonEmpty: true }),
        ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
      });
      setJson(res, 200, { ok: true, message });
    } catch (error) {
      throw new HttpError(502, "ai_config_test_failed", error instanceof Error ? error.message : "AI 服务连接失败");
    }
    return true;
  }
  const movieStatusPath = pathname === "/api/movie/status" || pathname === "/api/movies/status";
  const movieConfigPath = pathname === "/api/movie/config" || pathname === "/api/movies/config";
  const movieConfigTestPath = pathname === "/api/movie/config/test" || pathname === "/api/movies/config/test";
  const movieResolvePath = pathname === "/api/movie/resolve" || pathname === "/api/movies/resolve";
  const movieImportPath = pathname === "/api/movie/import" || pathname === "/api/movies/import";
  const movieUpsertPath = pathname === "/api/movie/upsert" || pathname === "/api/movies/upsert";
  if (movieStatusPath && req.method === "GET") {
    setJson(res, 200, publicMovieConfig(config));
    return true;
  }
  if (movieConfigPath && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["enabled", "apiKey", "clearApiKey"]);
    const current = readRuntimeMovieConfig(config);
    try {
      const status = saveRuntimeMovieConfig(config, {
        enabled: input.enabled === undefined ? current.enabled : booleanField(input.enabled, "enabled"),
        ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
        ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
      });
      setJson(res, 200, status);
    } catch (error) {
      throw new HttpError(400, "invalid_movie_config", error instanceof Error ? error.message : "观影配置无效");
    }
    return true;
  }
  if (movieConfigTestPath && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["apiKey"]);
    const message = await testMovieConfig(config, input.apiKey === undefined ? undefined : stringField(input.apiKey, "apiKey"));
    setJson(res, 200, { ok: true, message });
    return true;
  }
  if (movieResolvePath && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["query", "title", "imdbId", "tmdbId", "doubanId", "doubanUrl"]);
    const queryParts = [
      input.query === undefined ? undefined : stringField(input.query, "query"),
      input.doubanUrl === undefined ? undefined : stringField(input.doubanUrl, "doubanUrl"),
    ].filter((value): value is string => value !== undefined && value.trim().length > 0);
    const query = queryParts.length === 0 ? undefined : queryParts.join(" ");
    const result = await resolveMovies(config, {
      ...(query === undefined ? {} : { query }),
      ...(input.title === undefined ? {} : { title: stringField(input.title, "title") }),
      ...(input.imdbId === undefined ? {} : { imdbId: stringField(input.imdbId, "imdbId") }),
      ...(input.tmdbId === undefined ? {} : { tmdbId: typeof input.tmdbId === "number" ? input.tmdbId : stringField(input.tmdbId, "tmdbId") }),
      ...(input.doubanId === undefined ? {} : { doubanId: typeof input.doubanId === "number" ? input.doubanId : stringField(input.doubanId, "doubanId") }),
    });
    setJson(res, 200, result);
    return true;
  }
  if ((movieImportPath || movieUpsertPath) && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    if (!readRuntimeMovieConfig(config).enabled) throw new MovieModuleError(409, "movie_module_disabled", "观影模块未启用；请先在设置中启用");
    if (Object.hasOwn(input, "movie") || Object.hasOwn(input, "candidate")) hasOnlyKeys(input, ["movie", "candidate"]);
    let source = moviePayload(input);
    if (source.name === undefined && source.title === undefined) {
      const lookup: JsonObject = {};
      for (const key of ["query", "title", "imdbId", "tmdbId", "doubanId", "doubanUrl"] as const) {
        if (source[key] !== undefined) lookup[key] = source[key];
      }
      if (source.doubanUrl !== undefined) {
        const doubanUrl = stringField(source.doubanUrl, "doubanUrl");
        lookup.query = lookup.query === undefined ? doubanUrl : `${String(lookup.query)} ${doubanUrl}`;
      }
      const resolved = await resolveMovies(config, lookup);
      if (resolved.candidates.length === 0) throw new HttpError(404, "movie_not_found", "TMDb 没有找到影片");
      if (resolved.candidates.length > 1) throw new HttpError(409, "movie_candidate_required", "匹配到多部影片，请先选择候选项");
      source = { ...resolved.candidates[0], ...source };
    }
    const movie = movieInputEntity(source);
    const existing = movieMatch(repository, movie);
    if (existing === null) {
      repository.insertEntity(movie);
      setJson(res, 201, { created: true, entity: movie });
    } else {
      const updated = mergeMovie(existing, movie);
      repository.updateEntity(updated);
      setJson(res, 200, { created: false, entity: updated });
    }
    return true;
  }
  if (pathname === "/api/ai/assistant" && req.method === "POST") {
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["message", "history", "pageUrl"]);
    const message = stringField(input.message, "message", { nonEmpty: true });
    if (message.length > 2000) throw new HttpError(400, "invalid_field", "message is too long");
    const historyRaw = input.history === undefined ? [] : input.history;
    if (!Array.isArray(historyRaw)) throw new HttpError(400, "invalid_field", "history must be an array");
    const history: AssistantHistoryItem[] = historyRaw.slice(-8).map((item, index) => {
      const entry = jsonObject(item, `history[${index}]`);
      hasOnlyKeys(entry, ["role", "text"]);
      const role = enumField(entry.role, ["user", "assistant"] as const, `history[${index}].role`);
      const text = stringField(entry.text, `history[${index}].text`, { nonEmpty: true });
      return { role, text: text.slice(0, 1200) };
    });
    const pageUrl = input.pageUrl === undefined ? undefined : stringField(input.pageUrl, "pageUrl").slice(0, 500);
    setJson(res, 200, await answerLifeosAssistant(config, repository, { message, history, ...(pageUrl === undefined ? {} : { pageUrl }) }));
    return true;
  }
  if (pathname === "/api/weather/status" && req.method === "GET") {
    const deviceId = weatherDeviceId(req, res, config);
    const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
    setJson(res, 200, publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)));
    return true;
  }
  if (pathname === "/api/weather/profiles" && req.method === "GET") {
    const deviceId = weatherDeviceId(req, res, config);
    const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
    setJson(res, 200, { items: listWeatherProfiles(config), activeProfileId: deviceLocation?.profileId ?? null, status: publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)) });
    return true;
  }
  if (pathname === "/api/weather/profiles" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["id", "label", "locationId", "city", "apiHost", "apiKey", "clearApiKey", "activate"]);
    try {
      const deviceId = weatherDeviceId(req, res, config);
      const profile = saveWeatherProfile(config, {
        ...(input.id === undefined ? {} : { id: stringField(input.id, "id", { nonEmpty: true }) }),
        label: stringField(input.label, "label", { nonEmpty: true }),
        locationId: stringField(input.locationId ?? "", "locationId"),
        city: stringField(input.city ?? "", "city"),
        apiHost: stringField(input.apiHost ?? readRuntimeWeatherConfig(config).apiHost, "apiHost", { nonEmpty: true }),
        ...(input.apiKey === undefined ? {} : { apiKey: stringField(input.apiKey, "apiKey") }),
        ...(input.clearApiKey === undefined ? {} : { clearApiKey: booleanField(input.clearApiKey, "clearApiKey") }),
      });
      const activate = input.activate === undefined ? true : booleanField(input.activate, "activate");
      if (activate) repository.saveWeatherDeviceLocation(deviceId, profile.locationId, profile.city, JSON.stringify(nowInstant()), profile.id);
      clearWeatherCache();
      const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
      setJson(res, 200, { items: listWeatherProfiles(config), activeProfileId: deviceLocation?.profileId ?? null, status: publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)) });
    } catch (error) {
      throw new HttpError(400, "invalid_weather_profile", error instanceof Error ? error.message : "天气方案无效");
    }
    return true;
  }
  if (pathname === "/api/weather/profiles/activate" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["id"]);
    const profileId = stringField(input.id, "id", { nonEmpty: true });
    const profile = readWeatherProfile(config, profileId);
    if (profile === null) throw new HttpError(404, "weather_profile_not_found", "天气方案不存在");
    try {
      assertWeatherCredentialTarget(config, profile, profile.apiHost);
    } catch (error) {
      throw new HttpError(400, "invalid_weather_profile", error instanceof Error ? error.message : "天气方案无效");
    }
    const deviceId = weatherDeviceId(req, res, config);
    repository.saveWeatherDeviceLocation(deviceId, profile.locationId, profile.city, JSON.stringify(nowInstant()), profileId);
    clearWeatherCache();
    const deviceLocation = repository.getWeatherDeviceLocation(deviceId);
    setJson(res, 200, { items: listWeatherProfiles(config), activeProfileId: profileId, status: publicWeatherConfig(config, weatherLocationOverride(config, deviceLocation)) });
    return true;
  }

  return false;
};
