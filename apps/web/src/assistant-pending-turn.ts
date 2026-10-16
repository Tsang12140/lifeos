export interface PendingAssistantMaterial {
  readonly name: string;
  readonly text: string;
  readonly assetId?: string;
}

/** Only stable references are persisted. Image data URIs are rebuilt for a retry. */
export interface PendingAssistantTurn {
  readonly conversationId: string;
  readonly turnId: string;
  /** Binding captured when this turn was first sent; retries must not drift. */
  readonly batchId: string | null;
  readonly revision: number | null;
  readonly message: string;
  readonly materials: readonly PendingAssistantMaterial[];
  readonly startedAt: string;
  readonly status: "unconfirmed";
  readonly retryBlocked?: boolean;
}

export interface PendingTurnMessageState {
  readonly role: "user" | "assistant";
  readonly turnId?: string;
  readonly turnStatus?: "running" | "failed" | "interrupted" | "completed";
  readonly retryable?: boolean;
}

export type PendingTurnRecoveryStatus = "retry" | "completed" | "blocked";

/** Resolves a browser's outstanding marker against server-owned turn status. */
export function pendingTurnRecoveryStatus(turn: PendingAssistantTurn, messages: readonly PendingTurnMessageState[]): PendingTurnRecoveryStatus {
  const userMessage = messages.find((message) => message.role === "user" && message.turnId === turn.turnId);
  if (userMessage?.turnStatus === "completed") return "completed";
  if (turn.retryBlocked) return "blocked";
  // Running turns reject a second generation, but same-ID retry joins the
  // existing operation. retryable=false only blocks a terminal failed turn.
  if (userMessage?.turnStatus === "running") return "retry";
  if (userMessage?.turnStatus === "interrupted" || userMessage?.retryable === false) return "blocked";
  return "retry";
}

export const MAX_ASSISTANT_MESSAGE_LENGTH = 12_000;

/** Match the durable chat API's trim-before-limit rule before any request is made. */
export function assistantMessageLengthError(message: string): string | null {
  return message.trim().length > MAX_ASSISTANT_MESSAGE_LENGTH
    ? `消息超过 ${MAX_ASSISTANT_MESSAGE_LENGTH.toLocaleString("zh-CN")} 字符，请缩短后再发送`
    : null;
}

export interface StringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PENDING_PREFIX = "lifeos.assistant.pending-turn:";

export function pendingAssistantTurnKey(scope: string): string {
  return `${PENDING_PREFIX}${encodeURIComponent(scope)}`;
}

/** Parse a whitelist of stable fields; transient model payloads are discarded. */
export function parsePendingAssistantTurn(value: unknown): PendingAssistantTurn | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  // Pending markers written before stable batch metadata existed can still be
  // restored; a mismatch is rejected safely by the durable endpoint.
  const batchId = candidate.batchId === undefined ? null : candidate.batchId;
  const revision = candidate.revision === undefined ? null : candidate.revision;
  if (typeof candidate.conversationId !== "string" || candidate.conversationId.length === 0
    || typeof candidate.turnId !== "string" || candidate.turnId.length === 0
    || (batchId !== null && typeof batchId !== "string")
    || (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0))
    || typeof candidate.message !== "string"
    || typeof candidate.startedAt !== "string"
    || candidate.status !== "unconfirmed"
    || (candidate.retryBlocked !== undefined && typeof candidate.retryBlocked !== "boolean")
    || !Array.isArray(candidate.materials)) return null;
  const materials: PendingAssistantMaterial[] = [];
  for (const item of candidate.materials) {
    if (typeof item !== "object" || item === null) return null;
    const material = item as Record<string, unknown>;
    if (typeof material.name !== "string" || typeof material.text !== "string") return null;
    if (material.assetId !== undefined && typeof material.assetId !== "string") return null;
    materials.push({
      name: material.name,
      text: material.text,
      ...(typeof material.assetId === "string" ? { assetId: material.assetId } : {}),
    });
  }
  return {
    conversationId: candidate.conversationId,
    turnId: candidate.turnId,
    batchId: batchId as string | null,
    revision: revision as number | null,
    message: candidate.message,
    materials,
    startedAt: candidate.startedAt,
    status: "unconfirmed",
    ...(candidate.retryBlocked === true ? { retryBlocked: true } : {}),
  };
}

export function readPendingAssistantTurn(scope: string, storage: StringStorage): PendingAssistantTurn | null {
  try {
    const serialized = storage.getItem(pendingAssistantTurnKey(scope));
    return serialized === null ? null : parsePendingAssistantTurn(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export function writePendingAssistantTurn(scope: string, turn: PendingAssistantTurn, storage: StringStorage): void {
  // Rebuild from the whitelist before serializing, even if a caller passes an
  // expanded object that also contains a temporary data URI.
  const stable = parsePendingAssistantTurn(turn);
  if (stable === null) throw new Error("待确认消息格式无效");
  storage.setItem(pendingAssistantTurnKey(scope), JSON.stringify(stable));
}

export function clearPendingAssistantTurn(scope: string, storage: StringStorage): void {
  try { storage.removeItem(pendingAssistantTurnKey(scope)); } catch { /* storage is optional */ }
}
