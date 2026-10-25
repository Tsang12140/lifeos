interface DraftMessage {
  readonly role: "user" | "assistant";
  readonly at?: string;
  readonly draftBatchId?: string;
}

/** Insert after the creating reply. Older archives fall back to creation time,
 * never updatedAt (saving or confirming must not move a card to the chat tail). */
export function assistantDraftPosition(messages: readonly DraftMessage[], batch: { readonly id: string; readonly createdAt: string }): number {
  const explicit = messages.findIndex(message => message.role === "assistant" && message.draftBatchId === batch.id);
  if (explicit !== -1) return explicit;
  const createdAt = Date.parse(batch.createdAt);
  const next = messages.findIndex(message => Number.isFinite(Date.parse(message.at ?? "")) && Date.parse(message.at!) >= createdAt);
  if (next !== -1) return messages[next]!.role === "assistant" ? next : next - 1;
  return messages.length - 1;
}
