import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUMMARY_SYSTEM_PROMPT } from "@lifeos/core";
import type { ApiConfig } from "./config.js";

export const AI_REASONING_EFFORTS = ["low", "high", "max"] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];
export type AiPresetId = "quick" | "reflect" | "review" | "custom";

export interface RuntimeAiConfig {
  readonly enabled: boolean;
  readonly provider: "deepseek";
  readonly baseUrl: string;
  readonly model: string;
  readonly thinking: boolean;
  readonly reasoningEffort?: AiReasoningEffort;
  readonly preset: AiPresetId;
  readonly apiKey?: string;
  readonly source: "env" | "file" | "none";
  /**
   * The instruction the calendar sends when summarising days. Absent means the
   * built-in default is in force. It is part of the AI settings rather than a
   * constant so the wording can be tuned without a rebuild — and because it is
   * part of the provider's identity, editing it rewrites stale summaries.
   */
  readonly summaryPrompt?: string;
}

/** The prompt actually in force: the owner's wording, or the shipped default. */
export function effectiveSummaryPrompt(config: ApiConfig): string {
  return readRuntimeAiConfig(config).summaryPrompt ?? SUMMARY_SYSTEM_PROMPT;
}

interface StoredAiConfig {
  readonly enabled: boolean;
  readonly provider: "deepseek";
  readonly baseUrl: string;
  readonly model: string;
  /** Optional so configurations written before thinking modes existed remain valid. */
  readonly thinking?: boolean;
  readonly reasoningEffort?: AiReasoningEffort;
  readonly encryptedApiKey?: string;
  readonly apiKeyIv?: string;
  readonly apiKeyTag?: string;
  readonly summaryPrompt?: string;
}

const DEFAULT_AI_BASE_URL = "https://api.deepseek.com";

function configPath(config: ApiConfig): string {
  return join(config.dataDirectory, "ai-config.json");
}

function encryptionKey(config: ApiConfig): Buffer {
  const secret = process.env.LIFEOS_AI_CONFIG_SECRET?.trim() || process.env.LIFEOS_PASSWORD || `lifeos-local-ai:${config.dataDirectory}`;
  return scryptSync(secret, "lifeos-ai-config-v1", 32);
}

function encryptApiKey(config: ApiConfig, apiKey: string): Pick<StoredAiConfig, "encryptedApiKey" | "apiKeyIv" | "apiKeyTag"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return { encryptedApiKey: encrypted.toString("base64"), apiKeyIv: iv.toString("base64"), apiKeyTag: cipher.getAuthTag().toString("base64") };
}

function decryptApiKey(config: ApiConfig, stored: StoredAiConfig): string | undefined {
  if (!stored.encryptedApiKey || !stored.apiKeyIv || !stored.apiKeyTag) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config), Buffer.from(stored.apiKeyIv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.apiKeyTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(stored.encryptedApiKey, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function readStored(config: ApiConfig): StoredAiConfig | undefined {
  const path = configPath(config);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAiConfig>;
    if (typeof value.enabled !== "boolean" || value.provider !== "deepseek" || typeof value.baseUrl !== "string" || typeof value.model !== "string") return undefined;
    if (value.thinking !== undefined && typeof value.thinking !== "boolean") return undefined;
    if (value.reasoningEffort !== undefined && !isAiReasoningEffort(value.reasoningEffort)) return undefined;
    if (value.summaryPrompt !== undefined && typeof value.summaryPrompt !== "string") return undefined;
    return value as StoredAiConfig;
  } catch {
    return undefined;
  }
}

function isAiReasoningEffort(value: unknown): value is AiReasoningEffort {
  return typeof value === "string" && (AI_REASONING_EFFORTS as readonly string[]).includes(value);
}

function presetForAiConfig(baseUrl: string, model: string, thinking: boolean, reasoningEffort: AiReasoningEffort | undefined): AiPresetId {
  if (baseUrl !== DEFAULT_AI_BASE_URL) return "custom";
  if (!thinking && reasoningEffort === undefined && model === "deepseek-flash") return "quick";
  if (thinking && reasoningEffort === "high" && model === "deepseek-flash") return "reflect";
  if (thinking && reasoningEffort === "high" && model === "deepseek-v4-pro") return "review";
  return "custom";
}

function runtimeConfig(values: { readonly enabled: boolean; readonly baseUrl: string; readonly model: string; readonly thinking: boolean; readonly reasoningEffort?: AiReasoningEffort; readonly apiKey?: string; readonly source: RuntimeAiConfig["source"]; readonly summaryPrompt?: string }): RuntimeAiConfig {
  return {
    enabled: values.enabled,
    provider: "deepseek",
    baseUrl: values.baseUrl,
    model: values.model,
    thinking: values.thinking,
    ...(values.thinking && values.reasoningEffort !== undefined ? { reasoningEffort: values.reasoningEffort } : {}),
    preset: presetForAiConfig(values.baseUrl, values.model, values.thinking, values.reasoningEffort),
    ...(values.apiKey === undefined ? {} : { apiKey: values.apiKey }),
    ...(values.summaryPrompt === undefined ? {} : { summaryPrompt: values.summaryPrompt }),
    source: values.source,
  };
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("AI Base URL 仅支持 http 或 https");
  if (url.username || url.password || url.search || url.hash) throw new Error("AI Base URL 格式不正确");
  return baseUrl;
}

export function readRuntimeAiConfig(config: ApiConfig): RuntimeAiConfig {
  const stored = readStored(config);
  if (stored !== undefined) {
    const decryptedKey = decryptApiKey(config, stored);
    const apiKey = decryptedKey ?? (stored.encryptedApiKey === undefined ? config.deepseekApiKey : undefined);
    const source = decryptedKey !== undefined ? "file" : apiKey === undefined ? "none" : "env";
    const baseUrl = normalizeBaseUrl(stored.baseUrl);
    const thinking = stored.thinking ?? false;
    const reasoningEffort = thinking ? stored.reasoningEffort ?? "high" : undefined;
    return runtimeConfig({ enabled: stored.enabled, baseUrl, model: stored.model, thinking, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(apiKey === undefined ? {} : { apiKey }), ...(stored.summaryPrompt === undefined ? {} : { summaryPrompt: stored.summaryPrompt }), source });
  }
  const thinking = false;
  return runtimeConfig({ enabled: true, baseUrl: config.deepseekBaseUrl, model: config.deepseekModel, thinking, ...(config.deepseekApiKey ? { apiKey: config.deepseekApiKey } : {}), source: config.deepseekApiKey === undefined ? "none" : "env" });
}

export function publicAiConfig(config: ApiConfig): { readonly enabled: boolean; readonly configured: boolean; readonly keyConfigured: boolean; readonly provider: "deepseek"; readonly model: string; readonly baseUrl: string; readonly thinking: boolean; readonly reasoningEffort: AiReasoningEffort | null; readonly preset: AiPresetId; readonly keySource: RuntimeAiConfig["source"]; readonly summaryPrompt: string; readonly summaryPromptCustom: boolean } {
  const runtime = readRuntimeAiConfig(config);
  return { enabled: runtime.enabled, configured: runtime.enabled && runtime.apiKey !== undefined, keyConfigured: runtime.apiKey !== undefined, provider: runtime.provider, model: runtime.model, baseUrl: runtime.baseUrl, thinking: runtime.thinking, reasoningEffort: runtime.reasoningEffort ?? null, preset: runtime.preset, keySource: runtime.source, summaryPrompt: runtime.summaryPrompt ?? SUMMARY_SYSTEM_PROMPT, summaryPromptCustom: runtime.summaryPrompt !== undefined };
}

export function saveRuntimeAiConfig(config: ApiConfig, input: { readonly enabled: boolean; readonly baseUrl: string; readonly model: string; readonly thinking?: boolean; readonly reasoningEffort?: AiReasoningEffort | null; readonly apiKey?: string; readonly clearApiKey?: boolean; readonly summaryPrompt?: string | null }): ReturnType<typeof publicAiConfig> {
  const current = readRuntimeAiConfig(config);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = input.model.trim();
  if (!model) throw new Error("AI 模型不能为空");
  if (input.thinking !== undefined && typeof input.thinking !== "boolean") throw new Error("AI 思考开关必须是布尔值");
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== null && !isAiReasoningEffort(input.reasoningEffort)) throw new Error("推理强度必须是 low、high 或 max");
  const thinking = input.thinking ?? current.thinking;
  const reasoningEffort = !thinking
    ? undefined
    : input.reasoningEffort === undefined || input.reasoningEffort === null
      ? current.reasoningEffort ?? "high"
      : input.reasoningEffort;
  const nextKey = input.clearApiKey ? undefined : input.apiKey?.trim() || current.apiKey;
  // `null` means "go back to the shipped wording", so it clears the field rather
  // than storing the default text — a later change to the constant then flows
  // through. An omitted field leaves the current wording untouched.
  const requestedPrompt = input.summaryPrompt === undefined ? current.summaryPrompt : input.summaryPrompt?.trim() || undefined;
  const stored: StoredAiConfig = { enabled: input.enabled, provider: "deepseek", baseUrl, model, thinking, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(nextKey ? encryptApiKey(config, nextKey) : {}), ...(requestedPrompt === undefined ? {} : { summaryPrompt: requestedPrompt }) };
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(configPath(config), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return publicAiConfig(config);
}

export async function testRuntimeAiConfig(config: ApiConfig, input: { readonly baseUrl: string; readonly apiKey?: string }): Promise<string> {
  const current = readRuntimeAiConfig(config);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey?.trim() || current.apiKey;
  if (!apiKey) throw new Error("请先填写 AI API Key");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new Error(`AI 服务连接失败：${error instanceof Error && error.name === "TimeoutError" ? "请求超时（20 秒）" : "网络连接失败"}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AI 服务返回 HTTP ${response.status}${body ? `：${body.slice(0, 160)}` : ""}`);
  }
  return "AI 服务连接成功";
}

export function aiConfigFingerprint(config: ApiConfig): string {
  const runtime = readRuntimeAiConfig(config);
  return createHash("sha256").update(`${runtime.baseUrl}|${runtime.model}|${runtime.thinking ? "enabled" : "disabled"}|${runtime.reasoningEffort ?? "none"}|${runtime.apiKey ? "configured" : "empty"}`).digest("hex").slice(0, 12);
}
