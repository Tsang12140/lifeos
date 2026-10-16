import type {
  AssistantConversationDetail,
  AssistantConversationSummary,
  AssistantHistoryCurrent,
  AssistantHistoryMessage,
  AssistantHistoryPage,
  BackfillChatAnswer,
  BackfillMaterial,
} from "@lifeos/core";
import { apiRequest, apiResponse, type AiGear, type ApiError } from "./api";

export interface AssistantHistoryAttachment {
  readonly assetId: string;
  readonly name: string;
}

/** Message metadata returned by the paged archive endpoints. */
export interface AssistantArchiveMessage extends AssistantHistoryMessage {
  readonly id: string;
  readonly seq: number;
  readonly attachments?: readonly AssistantHistoryAttachment[];
  readonly turnId?: string;
  readonly turnStatus?: "running" | "failed" | "interrupted" | "completed";
  readonly retryable?: boolean;
}

/** The most recent message page is always returned oldest-to-newest. */
export interface AssistantConversationView extends Omit<AssistantConversationDetail, "messages"> {
  readonly batchId: string | null;
  readonly messages: readonly AssistantArchiveMessage[];
  readonly hasMore: boolean;
  readonly nextBeforeSeq: number | null;
}

export interface AssistantCurrentView extends Omit<AssistantHistoryCurrent, "conversation"> {
  readonly conversation: AssistantConversationView | null;
}

export interface AssistantHistoryListPage extends Omit<AssistantHistoryPage, "items"> {
  readonly items: readonly AssistantConversationSummary[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export function loadCurrentConversation(): Promise<AssistantCurrentView> {
  return apiRequest<AssistantCurrentView>("/api/ai/assistant/history/current");
}

export function listAssistantConversations(query: string, cursor: string | null = null, range: { readonly from?: string; readonly to?: string } = {}): Promise<AssistantHistoryListPage> {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed.length > 0) params.set("q", trimmed);
  if (cursor !== null) params.set("cursor", cursor);
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return apiRequest<AssistantHistoryListPage>(`/api/ai/assistant/history${suffix}`);
}

export function loadAssistantConversation(id: string, beforeSeq?: number | null): Promise<AssistantConversationView> {
  const suffix = beforeSeq === undefined || beforeSeq === null ? "" : `?beforeSeq=${encodeURIComponent(String(beforeSeq))}`;
  return apiRequest<AssistantConversationView>(`/api/ai/assistant/history/${encodeURIComponent(id)}${suffix}`);
}

export function clearAssistantConversation(id: string): Promise<{ readonly conversationId: string; readonly clearedAt: string }> {
  return apiRequest(`/api/ai/assistant/history/${encodeURIComponent(id)}/clear`, { method: "POST" });
}

export function continueAssistantConversation(id: string): Promise<{ readonly conversationId: string }> {
  return apiRequest(`/api/ai/assistant/history/${encodeURIComponent(id)}/continue`, { method: "POST" });
}

export function startAssistantConversation(batchId?: string | null): Promise<{ readonly conversationId: string; readonly at?: string }> {
  return apiRequest("/api/ai/assistant/history/new", {
    method: "POST",
    body: JSON.stringify(batchId ? { batchId } : {}),
  });
}

export interface AssistantChatTurnRequest {
  readonly conversationId: string;
  readonly turnId: string;
  readonly batchId: string | null;
  readonly revision: number | null;
  readonly message: string;
  readonly materials: readonly BackfillMaterial[];
  /**
   * Whether the owner can see private records on screen right now.
   *
   * Private bodies are never sent to the model; this only lets the assistant tell
   * "you can look at them in the list" apart from "they are hidden from you too".
   */
  readonly privacyVisible?: boolean;
  /** Answer gear chosen beside the composer for this conversation; absent = stored default. */
  readonly effort?: AiGear;
}

export type AssistantChatTurnAnswer = BackfillChatAnswer & {
  readonly conversationId: string;
  readonly turnId: string;
};

export async function sendAssistantChatTurn(turn: AssistantChatTurnRequest, onReply?: (text: string) => void): Promise<AssistantChatTurnAnswer> {
  const response = await apiResponse("/api/ai/backfill/chat", {
    method: "POST",
    headers: { Accept: "application/x-ndjson" },
    body: JSON.stringify(turn),
  });
  // Older servers and providers that buffer remain usable during rolling updates.
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) return await response.json() as AssistantChatTurnAnswer;
  if (!response.body) throw new Error("回复连接中断，原消息已保留，请重试");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; text?: string; answer?: AssistantChatTurnAnswer; status?: number; code?: string; message?: string };
        if (event.type === "reply" && typeof event.text === "string") onReply?.(event.text);
        if (event.type === "done" && event.answer) return event.answer;
        if (event.type === "error") {
          const error = new Error(event.message ?? "回复未能完成，请重试") as ApiError;
          Object.defineProperties(error, { status: { value: event.status }, code: { value: event.code } });
          throw error;
        }
      }
      if (chunk.done) break;
      if (buffer.length > 2_000_000) throw new Error("回复内容异常，请重试");
    }
    throw new Error("回复连接中断，原消息已保留，请重试");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Stop the durable server task rather than just its browser stream. */
export function stopAssistantChatTurn(conversationId: string, turnId: string): Promise<{ readonly status: string }> {
  return apiRequest("/api/ai/backfill/chat/stop", { method: "POST", body: JSON.stringify({ conversationId, turnId }) });
}
