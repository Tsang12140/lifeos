import test from "node:test";
import assert from "node:assert/strict";
import {
  clearPendingAssistantTurn,
  pendingAssistantTurnKey,
  pendingTurnRecoveryStatus,
  readPendingAssistantTurn,
  writePendingAssistantTurn,
  assistantMessageLengthError,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  type PendingAssistantTurn,
  type StringStorage,
} from "../src/assistant-pending-turn.ts";

function memoryStorage(): StringStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

test("pending turn recovery stores stable references, never transient image data", () => {
  const storage = memoryStorage();
  const expanded = {
    conversationId: "conversation-a",
    turnId: "turn-a",
    batchId: "batch-a",
    revision: 7,
    message: "这张照片是什么？",
    materials: [{ name: "照片 1", text: "需要查看的照片", assetId: "asset-a", imageData: "data:image/jpeg;base64,PRIVATE_BYTES" }],
    startedAt: "2026-10-10T08:00:00.000Z",
    status: "unconfirmed",
  } as unknown as PendingAssistantTurn;

  writePendingAssistantTurn("tenant/a", expanded, storage);
  const serialized = storage.values.get(pendingAssistantTurnKey("tenant/a")) ?? "";
  assert.equal(serialized.includes("PRIVATE_BYTES"), false);
  assert.equal(serialized.includes("imageData"), false);
  assert.deepEqual(readPendingAssistantTurn("tenant/a", storage), {
    conversationId: "conversation-a",
    turnId: "turn-a",
    batchId: "batch-a",
    revision: 7,
    message: "这张照片是什么？",
    materials: [{ name: "照片 1", text: "需要查看的照片", assetId: "asset-a" }],
    startedAt: "2026-10-10T08:00:00.000Z",
    status: "unconfirmed",
  });
});

test("pending turns are isolated by account scope and can be explicitly cleared", () => {
  const storage = memoryStorage();
  const turn: PendingAssistantTurn = {
    conversationId: "conversation-a", turnId: "turn-a", batchId: null, revision: null, message: "保留这条消息",
    materials: [], startedAt: "2026-10-10T08:00:00.000Z", status: "unconfirmed",
  };
  writePendingAssistantTurn("account-one", turn, storage);
  assert.equal(readPendingAssistantTurn("account-two", storage), null);
  assert.equal(readPendingAssistantTurn("account-one", storage)?.turnId, "turn-a");
  clearPendingAssistantTurn("account-one", storage);
  assert.equal(readPendingAssistantTurn("account-one", storage), null);
});

test("a pending retry keeps the exact batch binding and revision", () => {
  const storage = memoryStorage();
  const turn: PendingAssistantTurn = {
    conversationId: "conversation-a", turnId: "turn-a", batchId: "batch-a", revision: 12,
    message: "确认草稿", materials: [], startedAt: "2026-10-10T08:00:00.000Z", status: "unconfirmed",
  };
  writePendingAssistantTurn("account", turn, storage);
  assert.deepEqual(readPendingAssistantTurn("account", storage), turn);
});

test("malformed pending metadata is ignored instead of becoming a retry payload", () => {
  const storage = memoryStorage();
  storage.setItem(pendingAssistantTurnKey("tenant"), JSON.stringify({ conversationId: "c", turnId: "t", materials: [{}] }));
  assert.equal(readPendingAssistantTurn("tenant", storage), null);
});

test("server-owned turn status clears completed work and blocks unsafe interrupted replays", () => {
  const turn: PendingAssistantTurn = {
    conversationId: "conversation-a", turnId: "turn-a", batchId: null, revision: null, message: "确认今天的记录",
    materials: [], startedAt: "2026-10-10T08:00:00.000Z", status: "unconfirmed",
  };
  assert.equal(pendingTurnRecoveryStatus(turn, [
    { role: "user", turnId: "turn-a", turnStatus: "completed", retryable: false },
    { role: "assistant" },
  ]), "completed");
  assert.equal(pendingTurnRecoveryStatus(turn, [
    { role: "user", turnId: "turn-a", turnStatus: "interrupted", retryable: false },
  ]), "blocked");
  assert.equal(pendingTurnRecoveryStatus(turn, [
    { role: "user", turnId: "turn-a", turnStatus: "failed", retryable: true },
  ]), "retry");
  assert.equal(pendingTurnRecoveryStatus({ ...turn, retryBlocked: true }, []), "blocked");
  assert.equal(pendingTurnRecoveryStatus(turn, [
    { role: "user", turnId: "turn-a", turnStatus: "running", retryable: false },
  ]), "retry", "a same-ID retry joins a still-running request after reload");
  assert.equal(pendingTurnRecoveryStatus({ ...turn, retryBlocked: true }, [
    { role: "user", turnId: "turn-a", turnStatus: "running", retryable: false },
  ]), "blocked", "explicit local rejection is never bypassed");
});

test("chat length validation matches the trimmed durable endpoint boundary", () => {
  assert.equal(assistantMessageLengthError("  " + "a".repeat(MAX_ASSISTANT_MESSAGE_LENGTH) + "  "), null);
  assert.match(assistantMessageLengthError("a".repeat(MAX_ASSISTANT_MESSAGE_LENGTH + 1)) ?? "", /12,000/);
});
