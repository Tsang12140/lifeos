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
  readonly source: "env" | "file" | "shared" | "none";
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
  /** Explicitly entered in this tenant after shared-key support was added. */
  readonly ownApiKey?: boolean;
  readonly apiKeyIv?: string;
  readonly apiKeyTag?: string;
  readonly summaryPrompt?: string;
}

const DEFAULT_AI_BASE_URL = "https://api.deepseek.com";

function configPath(config: ApiConfig): string {
  return join(config.dataDirectory, "ai-config.json");
}

function encryptionKey(config: ApiConfig): Buffer {
  const secret = config.tenantConfigSecrets?.ai || process.env.LIFEOS_AI_CONFIG_SECRET?.trim() || process.env.LIFEOS_PASSWORD || `lifeos-local-ai:${config.dataDirectory}`;
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
    const hasStoredKeyMaterial = stored.encryptedApiKey !== undefined || stored.apiKeyIv !== undefined || stored.apiKeyTag !== undefined;
    // Older account-mode builds could persist an inherited key without source
    // metadata. Treat those ciphertexts as untrusted until a member re-enters
    // their own key; never send an unknown legacy value to a custom endpoint.
    const trustedStoredKey = config.sharedIntegrations === undefined || stored.ownApiKey === true;
    const decryptedKey = trustedStoredKey ? decryptApiKey(config, stored) : undefined;
    const hasTrustedStoredKeyMaterial = trustedStoredKey && hasStoredKeyMaterial;
    const shared = decryptedKey === undefined && !hasTrustedStoredKeyMaterial && config.deepseekApiKey === undefined ? config.sharedIntegrations?.ai?.() : undefined;
    const apiKey = decryptedKey ?? (hasTrustedStoredKeyMaterial ? undefined : config.deepseekApiKey ?? shared?.apiKey);
    const source = decryptedKey !== undefined ? "file" : config.deepseekApiKey !== undefined && !hasTrustedStoredKeyMaterial ? "env" : shared !== undefined && apiKey !== undefined ? "shared" : "none";
    const baseUrl = normalizeBaseUrl(source === "shared" && shared !== undefined ? shared.baseUrl : stored.baseUrl);
    const thinking = stored.thinking ?? false;
    const reasoningEffort = thinking ? stored.reasoningEffort ?? "high" : undefined;
    return runtimeConfig({ enabled: stored.enabled, baseUrl, model: stored.model, thinking, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(apiKey === undefined ? {} : { apiKey }), ...(stored.summaryPrompt === undefined ? {} : { summaryPrompt: stored.summaryPrompt }), source });
  }
  const thinking = false;
  const shared = config.deepseekApiKey === undefined ? config.sharedIntegrations?.ai?.() : undefined;
  const apiKey = config.deepseekApiKey ?? shared?.apiKey;
  return runtimeConfig({ enabled: true, baseUrl: shared?.baseUrl ?? config.deepseekBaseUrl, model: shared?.model ?? config.deepseekModel, thinking, ...(apiKey === undefined ? {} : { apiKey }), source: config.deepseekApiKey !== undefined ? "env" : shared?.apiKey === undefined ? "none" : "shared" });
}

/** Refuse to send an inherited owner key anywhere except its current approved endpoint. */
export function assertAiCredentialTarget(config: ApiConfig, runtime: Pick<RuntimeAiConfig, "source" | "apiKey" | "baseUrl">): void {
  if (runtime.source !== "shared") return;
  const shared = config.sharedIntegrations?.ai?.();
  if (shared === undefined || runtime.apiKey !== shared.apiKey || normalizeBaseUrl(runtime.baseUrl) !== normalizeBaseUrl(shared.baseUrl)) {
    throw new Error("共享 AI Key 仅能用于管理员批准的服务地址");
  }
}

/**
 * The key fields to write. Spelled out — instead of inlined — because of the
 * third rule, which is the whole point:
 *   · a key typed into the form always replaces what is on disk;
 *   · `clearApiKey` is the only way to drop it;
 *   · otherwise whatever is on disk is copied back **verbatim**, even when it
 *     cannot be decrypted (the encryption secret changed, or the file was
 *     hand-edited). Re-encrypting from the decrypted value is impossible then,
 *     and simply omitting the fields would destroy the owner's key without a
 *     word — that is exactly the "I set it once, why is it gone again" report.
 *     A key that came from the environment is deliberately **not** copied into
 *     the file: `.env` stays the single source of truth for it, and a later
 *     `.env` edit keeps working instead of being shadowed by a stale copy.
 */
function nextKeyFields(config: ApiConfig, input: { readonly apiKey?: string; readonly clearApiKey?: boolean }, existing: StoredAiConfig | undefined): Pick<StoredAiConfig, "encryptedApiKey" | "apiKeyIv" | "apiKeyTag"> | Record<string, never> {
  if (input.clearApiKey === true) return {};
  const typed = input.apiKey?.trim();
  if (typed !== undefined && typed !== "") return encryptApiKey(config, typed);
  if (existing !== undefined && existing.encryptedApiKey !== undefined && existing.apiKeyIv !== undefined && existing.apiKeyTag !== undefined) {
    return { encryptedApiKey: existing.encryptedApiKey, apiKeyIv: existing.apiKeyIv, apiKeyTag: existing.apiKeyTag };
  }
  return {};
}

export function publicAiConfig(config: ApiConfig): { readonly enabled: boolean; readonly configured: boolean; readonly keyConfigured: boolean; readonly keyUnreadable: boolean; readonly provider: "deepseek"; readonly model: string; readonly baseUrl: string; readonly thinking: boolean; readonly reasoningEffort: AiReasoningEffort | null; readonly preset: AiPresetId; readonly keySource: RuntimeAiConfig["source"]; readonly summaryPrompt: string; readonly summaryPromptCustom: boolean } {
  const runtime = readRuntimeAiConfig(config);
  const existing = readStored(config);
  /** 密文还在、却解不开（换过加密种子 / 文件被手改坏）。
   *  这时只报 `keyConfigured:false` 会让界面显示「未配置」——主人既不知道自己
   *  的钥匙其实还躺在文件里，也想不到「重新填一次」就能救。所以要单独说出来。 */
  const keyUnreadable = existing !== undefined && existing.encryptedApiKey !== undefined && (config.sharedIntegrations === undefined || existing.ownApiKey === true) && decryptApiKey(config, existing) === undefined;
  return { enabled: runtime.enabled, configured: runtime.enabled && runtime.apiKey !== undefined, keyConfigured: runtime.apiKey !== undefined, keyUnreadable, provider: runtime.provider, model: runtime.model, baseUrl: runtime.baseUrl, thinking: runtime.thinking, reasoningEffort: runtime.reasoningEffort ?? null, preset: runtime.preset, keySource: runtime.source, summaryPrompt: runtime.summaryPrompt ?? SUMMARY_SYSTEM_PROMPT, summaryPromptCustom: runtime.summaryPrompt !== undefined };
}

export function saveRuntimeAiConfig(config: ApiConfig, input: { readonly enabled: boolean; readonly baseUrl: string; readonly model: string; readonly thinking?: boolean; readonly reasoningEffort?: AiReasoningEffort | null; readonly apiKey?: string; readonly clearApiKey?: boolean; readonly summaryPrompt?: string | null }): ReturnType<typeof publicAiConfig> {
  const current = readRuntimeAiConfig(config);
  const existing = readStored(config);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const typedApiKey = input.apiKey?.trim();
  const hasExistingKeyMaterial = existing !== undefined && (existing.encryptedApiKey !== undefined || existing.apiKeyIv !== undefined || existing.apiKeyTag !== undefined);
  const trustedExistingKey = existing !== undefined && (config.sharedIntegrations === undefined || existing.ownApiKey === true);
  const hasTrustedExistingKeyMaterial = trustedExistingKey && hasExistingKeyMaterial;
  const sharedNow = config.sharedIntegrations?.ai?.();
  if (typedApiKey && typedApiKey === sharedNow?.apiKey) throw new Error("管理员共享 AI Key 不能保存到个人配置");
  const hasUsableOwnKey = !input.clearApiKey && (Boolean(typedApiKey) || (hasTrustedExistingKeyMaterial && decryptApiKey(config, existing!) !== undefined));
  const inherited = !hasUsableOwnKey && (!hasTrustedExistingKeyMaterial || input.clearApiKey === true) ? sharedNow : undefined;
  if (inherited !== undefined) assertAiCredentialTarget(config, { source: "shared", apiKey: inherited.apiKey, baseUrl });
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
  // `null` means "go back to the shipped wording", so it clears the field rather
  // than storing the default text — a later change to the constant then flows
  // through. An omitted field leaves the current wording untouched.
  const requestedPrompt = input.summaryPrompt === undefined ? current.summaryPrompt : input.summaryPrompt?.trim() || undefined;
  const stored: StoredAiConfig = { enabled: input.enabled, provider: "deepseek", baseUrl, model, thinking, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...nextKeyFields(config, input, existing), ...(!input.clearApiKey && (Boolean(typedApiKey) || existing?.ownApiKey === true) ? { ownApiKey: true } : {}), ...(requestedPrompt === undefined ? {} : { summaryPrompt: requestedPrompt }) };
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(configPath(config), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return publicAiConfig(config);
}

export async function testRuntimeAiConfig(config: ApiConfig, input: { readonly baseUrl: string; readonly apiKey?: string }): Promise<string> {
  const current = readRuntimeAiConfig(config);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const suppliedKey = input.apiKey?.trim();
  const apiKey = suppliedKey || current.apiKey;
  if (!apiKey) throw new Error("请先填写 AI API Key");
  if (!suppliedKey || suppliedKey === current.apiKey) assertAiCredentialTarget(config, { source: current.source, apiKey, baseUrl });
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
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
