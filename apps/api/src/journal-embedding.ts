import { createHash } from "node:crypto";

export interface JournalEmbeddingConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
}

/** Explicit env input keeps tests and tenant instances independent of process.env. */
export function readJournalEmbeddingConfig(env: NodeJS.ProcessEnv): JournalEmbeddingConfig | undefined {
  if (["0", "false"].includes(env.LIFEOS_EMBEDDING_ENABLED?.trim().toLowerCase() ?? "")) return;
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return;
  const baseUrl = (env.LIFEOS_EMBEDDING_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const parsed = new URL(baseUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)))) throw new Error("Invalid LIFEOS_EMBEDDING_BASE_URL");
  const dimensions = Number(env.LIFEOS_EMBEDDING_DIMENSIONS?.trim() || "1024");
  if (![64, 128, 256, 512, 768, 1024, 1536, 2048].includes(dimensions)) throw new Error("Invalid LIFEOS_EMBEDDING_DIMENSIONS");
  return { apiKey, baseUrl, model: env.LIFEOS_EMBEDDING_MODEL?.trim() || "text-embedding-v4", dimensions };
}

export function embeddingIdentity(config: JournalEmbeddingConfig): string {
  return createHash("sha256").update(JSON.stringify(["journal-body-v1", config.baseUrl, config.model, config.dimensions])).digest("hex");
}

export function normalizedVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || !value.every(item => typeof item === "number" && Number.isFinite(item))) throw new Error("Invalid embedding vector");
  const norm = Math.hypot(...value as number[]);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Invalid embedding norm");
  return (value as number[]).map(item => item / norm);
}

/** No raw provider errors, source text, key, or vectors enter logs. No redirects. */
export async function embedJournalTexts(config: JournalEmbeddingConfig, texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]> {
  if (texts.length === 0 || texts.length > 10 || texts.some(text => !text.trim() || Array.from(text).length > 2400)) throw new Error("Invalid embedding batch");
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, input: texts, dimensions: config.dimensions, encoding_format: "float" }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Embedding HTTP ${response.status}`); }
  const payload = await response.json() as { data?: { index: number; embedding: unknown }[]; usage?: { total_tokens?: number } };
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error("Invalid embedding response");
  const vectors: number[][] = [];
  for (const item of payload.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || vectors[item.index]) throw new Error("Invalid embedding index");
    vectors[item.index] = normalizedVector(item.embedding, config.dimensions);
  }
  console.log(`[embedding-usage] inputs=${texts.length} tokens=${Number.isSafeInteger(payload.usage?.total_tokens) ? payload.usage!.total_tokens : "unknown"}`);
  return vectors;
}

