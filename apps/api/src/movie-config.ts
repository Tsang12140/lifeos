import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiConfig } from "./config.js";

/** Runtime values are private to the API process. Never return this object to a client. */
export interface RuntimeMovieConfig {
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly apiBaseUrl: string;
  readonly source: "env" | "file" | "none";
}

/** Safe status shape; it deliberately contains no key or encrypted material. */
export interface MovieConfigStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly hasKey: boolean;
  readonly source: RuntimeMovieConfig["source"];
  readonly apiBaseUrl: string;
}

interface StoredMovieConfig {
  readonly enabled: boolean;
  readonly encryptedApiKey?: string;
  readonly apiKeyIv?: string;
  readonly apiKeyTag?: string;
}

export const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";

function configPath(config: ApiConfig): string {
  return join(config.dataDirectory, "movie-config.json");
}

function encryptionKey(config: ApiConfig): Buffer {
  const secret = config.tenantConfigSecrets?.movie || process.env.LIFEOS_MOVIE_CONFIG_SECRET?.trim() || process.env.LIFEOS_PASSWORD || `lifeos-local-movie:${config.dataDirectory}`;
  return scryptSync(secret, "lifeos-movie-config-v1", 32);
}

function encrypt(config: ApiConfig, apiKey: string): { readonly encrypted: string; readonly iv: string; readonly tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(config: ApiConfig, encrypted: string | undefined, iv: string | undefined, tag: string | undefined): string | undefined {
  if (!encrypted || !iv || !tag) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const value = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readStored(config: ApiConfig): StoredMovieConfig | undefined {
  const path = configPath(config);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredMovieConfig>;
    if (typeof value.enabled !== "boolean") return undefined;
    if (value.encryptedApiKey !== undefined && typeof value.encryptedApiKey !== "string") return undefined;
    if (value.apiKeyIv !== undefined && typeof value.apiKeyIv !== "string") return undefined;
    if (value.apiKeyTag !== undefined && typeof value.apiKeyTag !== "string") return undefined;
    return value as StoredMovieConfig;
  } catch {
    return undefined;
  }
}

function fromEnv(config: ApiConfig): RuntimeMovieConfig {
  return {
    enabled: false,
    ...(config.tmdbApiKey === undefined ? {} : { apiKey: config.tmdbApiKey }),
    apiBaseUrl: TMDB_API_BASE_URL,
    source: config.tmdbApiKey === undefined ? "none" : "env",
  };
}

export function readRuntimeMovieConfig(config: ApiConfig): RuntimeMovieConfig {
  const stored = readStored(config);
  if (stored !== undefined) {
    const apiKey = decrypt(config, stored.encryptedApiKey, stored.apiKeyIv, stored.apiKeyTag);
    return {
      enabled: stored.enabled,
      ...(apiKey === undefined ? {} : { apiKey }),
      apiBaseUrl: TMDB_API_BASE_URL,
      source: apiKey === undefined ? "none" : "file",
    };
  }
  return fromEnv(config);
}

export function publicMovieConfig(config: ApiConfig): MovieConfigStatus {
  const runtime = readRuntimeMovieConfig(config);
  return {
    enabled: runtime.enabled,
    configured: runtime.enabled && runtime.apiKey !== undefined,
    hasKey: runtime.apiKey !== undefined,
    source: runtime.source,
    apiBaseUrl: runtime.apiBaseUrl,
  };
}

export function saveRuntimeMovieConfig(
  config: ApiConfig,
  input: { readonly enabled: boolean; readonly apiKey?: string; readonly clearApiKey?: boolean },
): MovieConfigStatus {
  const current = readRuntimeMovieConfig(config);
  const apiKey = input.clearApiKey ? undefined : input.apiKey?.trim() || current.apiKey;
  const encrypted = apiKey === undefined ? undefined : encrypt(config, apiKey);
  const stored: StoredMovieConfig = {
    enabled: input.enabled,
    ...(encrypted === undefined ? {} : { encryptedApiKey: encrypted.encrypted, apiKeyIv: encrypted.iv, apiKeyTag: encrypted.tag }),
  };
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(configPath(config), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return publicMovieConfig(config);
}

/**
 * Returns the server-side key or a safe, actionable error. This keeps missing
 * configuration out of the generic 500 handler and avoids ever echoing keys.
 */
export function requireMovieApiKey(config: ApiConfig): RuntimeMovieConfig {
  const runtime = readRuntimeMovieConfig(config);
  if (!runtime.enabled) throw new Error("movie_module_disabled");
  if (runtime.apiKey === undefined) throw new Error("movie_api_key_required");
  return runtime;
}
