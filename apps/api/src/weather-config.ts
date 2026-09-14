import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiConfig } from "./config.js";

export interface RuntimeWeatherConfig {
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly locationId: string;
  readonly city: string;
  readonly apiHost: string;
  readonly source: "env" | "file" | "none";
}

export interface WeatherConfigStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly hasKey: boolean;
  readonly source: RuntimeWeatherConfig["source"];
  readonly locationId: string;
  readonly city: string;
  readonly apiHost: string;
  readonly locationScope: "device" | "default";
}

export interface WeatherLocationOverride {
  readonly locationId: string;
  readonly city: string;
  readonly apiHost?: string;
  readonly apiKey?: string | null;
  readonly profileId?: string;
}

export interface WeatherProfileStatus {
  readonly id: string;
  readonly label: string;
  readonly locationId: string;
  readonly city: string;
  readonly apiHost: string;
  readonly hasKey: boolean;
}

export interface WeatherProfilesStatus {
  readonly items: readonly WeatherProfileStatus[];
  readonly activeProfileId: string | null;
}

interface StoredWeatherProfile {
  readonly id: string;
  readonly label: string;
  readonly locationId: string;
  readonly city: string;
  readonly apiHost: string;
  readonly encryptedApiKey?: string;
  readonly apiKeyIv?: string;
  readonly apiKeyTag?: string;
}

interface StoredWeatherConfig {
  readonly enabled: boolean;
  readonly locationId: string;
  readonly city: string;
  readonly apiHost: string;
  readonly encryptedApiKey?: string;
  readonly apiKeyIv?: string;
  readonly apiKeyTag?: string;
  readonly profiles?: readonly StoredWeatherProfile[];
}

function configPath(config: ApiConfig): string {
  return join(config.dataDirectory, "weather-config.json");
}

function encryptionKey(config: ApiConfig): Buffer {
  const secret = process.env.LIFEOS_WEATHER_CONFIG_SECRET?.trim() || process.env.LIFEOS_PASSWORD || `lifeos-local-weather:${config.dataDirectory}`;
  return scryptSync(secret, "lifeos-weather-config-v1", 32);
}

function encrypt(config: ApiConfig, value: string): { encrypted: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(config: ApiConfig, encrypted: string | undefined, iv: string | undefined, tag: string | undefined): string | undefined {
  if (!encrypted || !iv || !tag) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!trimmed || /[/?#\s]/.test(trimmed)) throw new Error("天气 API Host 格式不正确");
  return trimmed;
}

function readStored(config: ApiConfig): StoredWeatherConfig | undefined {
  const path = configPath(config);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredWeatherConfig>;
    if (typeof value.enabled !== "boolean" || typeof value.locationId !== "string" || typeof value.city !== "string" || typeof value.apiHost !== "string") return undefined;
    if (value.profiles !== undefined && (!Array.isArray(value.profiles) || value.profiles.some((profile) => typeof profile !== "object" || profile === null || typeof profile.id !== "string" || typeof profile.label !== "string" || typeof profile.locationId !== "string" || typeof profile.city !== "string" || typeof profile.apiHost !== "string"))) return undefined;
    return value as StoredWeatherConfig;
  } catch {
    return undefined;
  }
}

function fromEnv(config: ApiConfig): RuntimeWeatherConfig {
  return {
    enabled: true,
    ...(config.qweatherApiKey ? { apiKey: config.qweatherApiKey } : {}),
    locationId: config.qweatherLocation ?? "",
    city: config.qweatherCity ?? "",
    apiHost: normalizeHost(config.qweatherHost),
    source: config.qweatherApiKey ? "env" : "none",
  };
}

export function readRuntimeWeatherConfig(config: ApiConfig): RuntimeWeatherConfig {
  const stored = readStored(config);
  if (stored !== undefined) {
    const apiKey = decrypt(config, stored.encryptedApiKey, stored.apiKeyIv, stored.apiKeyTag);
    return {
      enabled: stored.enabled,
      ...(apiKey ? { apiKey } : {}),
      locationId: stored.locationId.trim(),
      city: stored.city.trim(),
      apiHost: normalizeHost(stored.apiHost),
      source: apiKey ? "file" : "none",
    };
  }
  return fromEnv(config);
}

export function runtimeWeatherConfigForLocation(config: ApiConfig, override?: WeatherLocationOverride): RuntimeWeatherConfig {
  const runtime = readRuntimeWeatherConfig(config);
  if (override === undefined) return runtime;
  const base = override.apiKey === undefined
    ? runtime
    : (() => {
      const { apiKey: _globalApiKey, ...withoutGlobalKey } = runtime;
      return { ...withoutGlobalKey, ...(override.apiKey === null || override.apiKey.length === 0 ? {} : { apiKey: override.apiKey }) };
    })();
  return { ...base, locationId: override.locationId.trim(), city: override.city.trim(), ...(override.apiHost ? { apiHost: normalizeHost(override.apiHost) } : {}) };
}

export function publicWeatherConfig(config: ApiConfig, override?: WeatherLocationOverride): WeatherConfigStatus {
  const runtime = runtimeWeatherConfigForLocation(config, override);
  return {
    enabled: runtime.enabled,
    configured: runtime.enabled && Boolean(runtime.apiKey && (runtime.locationId || runtime.city)),
    hasKey: Boolean(runtime.apiKey),
    source: runtime.source,
    locationId: runtime.locationId,
    city: runtime.city,
    apiHost: runtime.apiHost,
    locationScope: override === undefined ? "default" : "device",
  };
}

export function saveRuntimeWeatherConfig(
  config: ApiConfig,
  input: { readonly enabled: boolean; readonly locationId: string; readonly city: string; readonly apiHost: string; readonly apiKey?: string; readonly clearApiKey?: boolean },
): WeatherConfigStatus {
  const current = readRuntimeWeatherConfig(config);
  const locationId = input.locationId.trim();
  const city = input.city.trim();
  if (!locationId && !city) throw new Error("位置 ID 和城市名至少填写一个");
  const apiHost = normalizeHost(input.apiHost);
  const apiKey = input.clearApiKey ? undefined : input.apiKey?.trim() || current.apiKey;
  const encrypted = apiKey ? encrypt(config, apiKey) : undefined;
  const previous = readStored(config);
  const stored: StoredWeatherConfig = {
    enabled: input.enabled,
    locationId,
    city,
    apiHost,
    ...(encrypted ? { encryptedApiKey: encrypted.encrypted, apiKeyIv: encrypted.iv, apiKeyTag: encrypted.tag } : {}),
    ...(previous?.profiles === undefined ? {} : { profiles: previous.profiles }),
  };
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(configPath(config), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return publicWeatherConfig(config);
}

function profileRuntime(config: ApiConfig, profile: StoredWeatherProfile): RuntimeWeatherConfig {
  const apiKey = decrypt(config, profile.encryptedApiKey, profile.apiKeyIv, profile.apiKeyTag);
  return {
    enabled: true,
    ...(apiKey ? { apiKey } : {}),
    locationId: profile.locationId,
    city: profile.city,
    apiHost: normalizeHost(profile.apiHost),
    source: apiKey ? "file" : "none",
  };
}

function profileStatus(config: ApiConfig, profile: StoredWeatherProfile): WeatherProfileStatus {
  return {
    id: profile.id,
    label: profile.label,
    locationId: profile.locationId,
    city: profile.city,
    apiHost: normalizeHost(profile.apiHost),
    hasKey: Boolean(decrypt(config, profile.encryptedApiKey, profile.apiKeyIv, profile.apiKeyTag)),
  };
}

export function listWeatherProfiles(config: ApiConfig): readonly WeatherProfileStatus[] {
  const stored = readStored(config);
  return (stored?.profiles ?? []).map((profile) => profileStatus(config, profile));
}

export function readWeatherProfile(config: ApiConfig, id: string): RuntimeWeatherConfig | null {
  const profile = readStored(config)?.profiles?.find((candidate) => candidate.id === id);
  return profile === undefined ? null : profileRuntime(config, profile);
}

export function saveWeatherProfile(
  config: ApiConfig,
  input: { readonly id?: string; readonly label: string; readonly locationId: string; readonly city: string; readonly apiHost: string; readonly apiKey?: string; readonly clearApiKey?: boolean },
): WeatherProfileStatus {
  const label = input.label.trim();
  const locationId = input.locationId.trim();
  const city = input.city.trim();
  if (!label) throw new Error("方案名称不能为空");
  if (!locationId && !city) throw new Error("位置 ID 和城市名至少填写一个");
  const apiHost = normalizeHost(input.apiHost);
  const previous = readStored(config);
  const existing = input.id === undefined ? undefined : previous?.profiles?.find((profile) => profile.id === input.id);
  const currentKey = existing === undefined ? readRuntimeWeatherConfig(config).apiKey : decrypt(config, existing.encryptedApiKey, existing.apiKeyIv, existing.apiKeyTag);
  const apiKey = input.clearApiKey ? undefined : input.apiKey?.trim() || currentKey;
  if (!apiKey) throw new Error("方案需要 API Key");
  const encrypted = encrypt(config, apiKey);
  const profile: StoredWeatherProfile = {
    id: existing?.id ?? input.id ?? randomUUID(),
    label,
    locationId,
    city,
    apiHost,
    encryptedApiKey: encrypted.encrypted,
    apiKeyIv: encrypted.iv,
    apiKeyTag: encrypted.tag,
  };
  const profiles = [...(previous?.profiles ?? []).filter((candidate) => candidate.id !== profile.id), profile];
  const current = readRuntimeWeatherConfig(config);
  const globalEncrypted = previous?.encryptedApiKey !== undefined && previous.apiKeyIv !== undefined && previous.apiKeyTag !== undefined
    ? { encryptedApiKey: previous.encryptedApiKey, apiKeyIv: previous.apiKeyIv, apiKeyTag: previous.apiKeyTag }
    : current.apiKey === undefined
      ? {}
      : (() => {
        const encryptedGlobal = encrypt(config, current.apiKey!);
        return { encryptedApiKey: encryptedGlobal.encrypted, apiKeyIv: encryptedGlobal.iv, apiKeyTag: encryptedGlobal.tag };
      })();
  const stored: StoredWeatherConfig = {
    enabled: previous?.enabled ?? current.enabled,
    locationId: previous?.locationId ?? current.locationId,
    city: previous?.city ?? current.city,
    apiHost: previous?.apiHost ?? current.apiHost,
    ...globalEncrypted,
    profiles,
  };
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(configPath(config), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return profileStatus(config, profile);
}
