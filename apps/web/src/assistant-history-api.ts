import type {
  AssistantConversationDetail,
  AssistantConversationSummary,
  AssistantHistoryCurrent,
  AssistantHistoryMessage,
  AssistantHistoryPage,
  BackfillChatAnswer,
  BackfillMaterial,
} from "@lifeos/core";
import { apiRequest } from "./api";

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
}

export type AssistantChatTurnAnswer = BackfillChatAnswer & {
  readonly conversationId: string;
  readonly turnId: string;
};

export function sendAssistantChatTurn(turn: AssistantChatTurnRequest): Promise<AssistantChatTurnAnswer> {
  return apiRequest<AssistantChatTurnAnswer>("/api/ai/backfill/chat", {
    method: "POST",
    body: JSON.stringify(turn),
  });
}
