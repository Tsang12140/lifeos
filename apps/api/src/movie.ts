import type { MovieExternalIds } from "@lifeos/core";
import type { ApiConfig } from "./config.js";
import { readRuntimeMovieConfig } from "./movie-config.js";

export interface MovieCandidate {
  readonly type: "movie";
  readonly tmdbId: number;
  /** Stable UI key; it is the TMDb id in string form. */
  readonly id: string;
  /** Localized TMDb title, suitable for the movie entity's display name. */
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly originalTitle?: string;
  readonly releaseYear?: number;
  /** `/search/multi` 会把电影与剧集一起返回；候选上标明类型，界面才能显示「剧集」。 */
  readonly mediaType?: "movie" | "tv";
  readonly posterUrl?: string;
  readonly overview?: string;
  readonly externalIds: MovieExternalIds;
}

export interface MovieLookupRequest {
  readonly query?: string;
  readonly title?: string;
  readonly imdbId?: string;
  readonly tmdbId?: number | string;
  readonly doubanId?: number | string;
}

export interface MovieLookupResult {
  readonly candidates: readonly MovieCandidate[];
}

/** A safe, client-facing failure from the optional movie integration. */
export class MovieModuleError extends Error {
  public constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "MovieModuleError";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) throw new MovieModuleError(400, "movie_invalid_identifier", `${name} must be a positive integer`);
  return number;
}

function imdbIdentifier(value: unknown): string {
  const raw = text(value);
  const candidate = raw === undefined ? undefined : extractImdb(raw) ?? raw;
  if (candidate === undefined || !/^tt\d+$/i.test(candidate)) {
    throw new MovieModuleError(400, "movie_invalid_identifier", "imdbId must look like tt1234567");
  }
  return candidate.toLowerCase();
}

function doubanIdentifier(value: unknown): string {
  const raw = text(value);
  const candidate = raw === undefined ? undefined : extractDouban(raw) ?? raw;
  if (candidate === undefined || !/^\d+$/.test(candidate)) {
    throw new MovieModuleError(400, "movie_invalid_identifier", "doubanId must be a numeric subject id");
  }
  return candidate;
}

function extractImdb(value: string): string | undefined {
  return value.match(/(?:^|[^a-z0-9])((?:tt)\d+)(?:$|[^a-z0-9])/i)?.[1]?.toLowerCase();
}

function extractDouban(value: string): string | undefined {
  return value.match(/(?:movie\.)?douban\.com\/subject\/(\d+)/i)?.[1] ?? value.match(/(?:^|[^\d])(\d{5,})(?:$|[^\d])/)?.[1];
}

function extractTmdbUrl(value: string): number | undefined {
  const match = value.match(/(?:themoviedb\.org|tmdb\.org)\/movie\/(\d+)/i);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Converts a free-form query into explicit identifiers where possible. URLs
 * are parsed locally only; no IMDb or Douban page is fetched.
 */
export function parseMovieLookupRequest(input: MovieLookupRequest): MovieLookupRequest {
  const query = text(input.query);
  const title = text(input.title);
  const imdbId = input.imdbId === undefined ? extractImdb(query ?? "") : imdbIdentifier(input.imdbId);
  const doubanId = input.doubanId === undefined ? extractDouban(query ?? "") : doubanIdentifier(input.doubanId);
  const tmdbFromUrl = input.tmdbId === undefined ? extractTmdbUrl(query ?? "") : undefined;
  const tmdbId = input.tmdbId === undefined
    ? tmdbFromUrl
    : positiveInteger(input.tmdbId, "tmdbId");
  // Douban IDs are digits only, so interpolation into a word-boundary regexp
  // is safe and lets a query like "霸王别姬 1295644" search by title only.
  const doubanMarker = doubanId === undefined ? undefined : new RegExp(`\\b${doubanId}\\b`, "g");
  const strippedQuery = query
    ?.replace(/https?:\/\/[^\s]+/gi, " ")
    .replace(/\btt\d+\b/gi, " ")
    .replace(doubanMarker ?? /$^/, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    ...(strippedQuery === undefined || strippedQuery.length === 0 ? {} : { query: strippedQuery }),
    ...(title === undefined ? {} : { title }),
    ...(imdbId === undefined ? {} : { imdbId }),
    ...(tmdbId === undefined ? {} : { tmdbId }),
    ...(doubanId === undefined ? {} : { doubanId }),
  };
}

function posterUrl(path: unknown): string | undefined {
  const value = text(path);
  return value === undefined ? undefined : `https://image.tmdb.org/t/p/w500${value.startsWith("/") ? value : `/${value}`}`;
}

function releaseYear(value: unknown): number | undefined {
  const date = text(value);
  if (date === undefined) return undefined;
  const match = /^(\d{4})/.exec(date);
  return match === null ? undefined : Number(match[1]);
}

function candidateFromTmdb(raw: unknown, imdbId?: string, doubanId?: string): MovieCandidate | null {
  const value = objectValue(raw);
  const id = typeof value.id === "number" ? value.id : typeof value.id === "string" && /^\d+$/.test(value.id) ? Number(value.id) : NaN;
  const name = text(value.title) ?? text(value.name) ?? text(value.original_title);
  if (!Number.isSafeInteger(id) || id <= 0 || name === undefined) return null;
  const originalTitle = text(value.original_title);
  const aliases = originalTitle !== undefined && originalTitle !== name ? [originalTitle] : undefined;
  // `/search/multi` 的每条结果自带 `media_type`（人物已在 resolveMovies 里滤掉）。
  const mediaType = value.media_type === "tv" ? "tv" : "movie";
  // 剧集没有 `release_date`，得看 `first_air_date`。
  const year = releaseYear(value.release_date ?? value.first_air_date);
  const poster = posterUrl(value.poster_path);
  const overview = text(value.overview);
  const externalIds: MovieExternalIds = {
    tmdb: String(id),
    ...(imdbId === undefined ? {} : { imdb: imdbId }),
    ...(doubanId === undefined ? {} : { douban: doubanId }),
  };
  return {
    type: "movie",
    id: String(id),
    tmdbId: id,
    name,
    mediaType,
    ...(aliases === undefined ? {} : { aliases }),
    ...(originalTitle === undefined ? {} : { originalTitle }),
    ...(year === undefined ? {} : { releaseYear: year }),
    ...(poster === undefined ? {} : { posterUrl: poster }),
    ...(overview === undefined ? {} : { overview }),
    externalIds,
  };
}

function jsonObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MovieModuleError(502, "movie_tmdb_invalid_response", `${context} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

async function tmdbJson(config: ApiConfig, path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
  const runtime = readRuntimeMovieConfig(config);
  if (!runtime.enabled) throw new MovieModuleError(409, "movie_module_disabled", "观影模块未启用；请先在设置中启用");
  if (runtime.apiKey === undefined) throw new MovieModuleError(503, "movie_api_key_required", "请先配置 TMDb API Key，再进行影片识别");
  const url = new URL(`${runtime.apiBaseUrl}${path}`);
  url.searchParams.set("api_key", runtime.apiKey);
  url.searchParams.set("language", "zh-CN");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new MovieModuleError(502, "movie_tmdb_unavailable", error instanceof Error && error.name === "TimeoutError" ? "TMDb 请求超时（20 秒）" : "TMDb 暂时无法连接");
  }
  if (!response.ok) {
    throw new MovieModuleError(502, "movie_tmdb_rejected", `TMDb 返回 HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MovieModuleError(502, "movie_tmdb_invalid_response", "TMDb 返回了无法读取的数据");
  }
  return jsonObject(body, "TMDb");
}

function requireSearchTitle(request: MovieLookupRequest): string {
  const title = text(request.title) ?? text(request.query);
  if (title === undefined) {
    if (request.doubanId !== undefined) throw new MovieModuleError(400, "douban_title_required", "只有豆瓣 subject ID 时无法读取资料；请同时提供影片名");
    throw new MovieModuleError(400, "movie_query_required", "请提供 IMDb、TMDb ID 或影片名");
  }
  if (title.length > 200) throw new MovieModuleError(400, "movie_query_too_long", "影片名过长");
  return title;
}

/** Resolve an identifier/title into zero or more explicit candidates. */
export async function resolveMovies(config: ApiConfig, input: MovieLookupRequest): Promise<MovieLookupResult> {
  const request = parseMovieLookupRequest(input);
  if (request.imdbId !== undefined) {
    const body = await tmdbJson(config, `/find/${encodeURIComponent(request.imdbId)}`, { external_source: "imdb_id" });
    const results = Array.isArray(body.movie_results) ? body.movie_results : [];
    const doubanId = request.doubanId === undefined ? undefined : String(request.doubanId);
    return { candidates: results.map((item) => candidateFromTmdb(item, request.imdbId, doubanId)).filter((item): item is MovieCandidate => item !== null) };
  }
  if (request.tmdbId !== undefined) {
    const body = await tmdbJson(config, `/movie/${encodeURIComponent(String(request.tmdbId))}`, {});
    const doubanId = request.doubanId === undefined ? undefined : String(request.doubanId);
    const candidate = candidateFromTmdb(body, undefined, doubanId);
    return { candidates: candidate === null ? [] : [candidate] };
  }
  const title = requireSearchTitle(request);
  // 用 `/search/multi` 而不是 `/search/movie`：一次同时返回电影与剧集。
  // `/search/movie` 只搜电影，剧集永远搜不到 —— 实测搜「行尸走肉」只会得到
  // 9 部 1936 / 1973 年的同名老片，2010 那部剧集根本不在候选里。
  const body = await tmdbJson(config, "/search/multi", { query: title, include_adult: "false", page: "1" });
  const results = Array.isArray(body.results) ? body.results : [];
  const doubanId = request.doubanId === undefined ? undefined : String(request.doubanId);
  return {
    // multi 会把人物一起返回，这里只收电影与剧集。
    candidates: results
      .filter((item) => { const kind = objectValue(item).media_type; return kind === "movie" || kind === "tv"; })
      .map((item) => candidateFromTmdb(item, undefined, doubanId))
      .filter((item): item is MovieCandidate => item !== null),
  };
}

/** Test the configured TMDb key without creating or changing any movie. */
export async function testMovieConfig(config: ApiConfig, apiKey?: string): Promise<string> {
  const runtime = readRuntimeMovieConfig(config);
  const key = apiKey?.trim() || runtime.apiKey;
  if (key === undefined) throw new MovieModuleError(503, "movie_api_key_required", "请先填写 TMDb API Key");
  const url = new URL(`${runtime.apiBaseUrl}/configuration`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "zh-CN");
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new MovieModuleError(502, "movie_tmdb_unavailable", error instanceof Error && error.name === "TimeoutError" ? "TMDb 请求超时（20 秒）" : "TMDb 暂时无法连接");
  }
  if (!response.ok) throw new MovieModuleError(502, "movie_config_test_failed", `TMDb 返回 HTTP ${response.status}`);
  return "TMDb API 连接成功";
}
