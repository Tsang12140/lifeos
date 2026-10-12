import { createHash } from "node:crypto";
import type { BackfillChatAnswer, BackfillMaterial } from "@lifeos/core";
import { backfillMaterials } from "./assistant-backfill.js";
import { chatBackfill } from "./assistant-conversation.js";
import type { ApiConfig } from "./config.js";
import { booleanField, hasOnlyKeys, jsonObject, revisionField, stringField, type JsonObject } from "./field-validate.js";
import { HttpError } from "./http-kit.js";
import type { AssistantChatTurnRow, SqliteRecordRepository } from "./repository.js";

const inFlightByRepository = new WeakMap<SqliteRecordRepository, Map<string, Promise<BackfillChatAnswer>>>();
const WRITE_COMMANDS = new Set(["确认记录", "确认全部", "确认全部记录", "确认写入", "确认补记", "就这样写进去", "就这样写入", "就这样记进去", "可以写入", "可以写进去", "按这个写入", "没问题记进去"]);
const UNDO_COMMANDS = new Set(["撤销这次补记", "撤销本次补记", "撤销这批补记"]);

function inFlight(repository: SqliteRecordRepository): Map<string, Promise<BackfillChatAnswer>> {
  let turns = inFlightByRepository.get(repository);
  if (turns === undefined) {
    turns = new Map();
    inFlightByRepository.set(repository, turns);
  }
  return turns;
}

function turnKey(conversationId: string, turnId: string): string {
  return `${conversationId}/${turnId}`;
}

function parseMaterials(value: unknown, repository: SqliteRecordRepository): BackfillMaterial[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) throw new HttpError(400, "invalid_materials", "材料数量或格式不正确");
  for (const [index, raw] of value.entries()) {
    const item = jsonObject(raw, `materials[${index}]`);
    hasOnlyKeys(item, ["assetId", "imageData", "name", "text"]);
    if (item.imageData !== undefined && (typeof item.assetId !== "string" || item.assetId.trim().length === 0)) {
      throw new HttpError(400, "asset_required", "图片材料需要先保存为附件再发送");
    }
  }
  return value.length === 0 ? [] : backfillMaterials(value, repository);
}

function requestShape(input: JsonObject, materials: readonly BackfillMaterial[], boundBatchId: string | null, boundBatchRevision: number | null, requestedBatchId: string | null, requestedRevision: number | null): string {
  const normalizedMaterials = materials.map((material) => ({
    name: material.name,
    text: material.text,
    assetId: material.assetId ?? null,
    // A durable request always references images by asset id. Keep this digest
    // as a guard if a future material path accepts transient image data.
    imageDigest: material.assetId === undefined && material.imageData !== undefined
      ? createHash("sha256").update(material.imageData).digest("hex")
      : null,
  }));
  return createHash("sha256").update(JSON.stringify({
    conversationId: input.conversationId,
    message: input.message,
    materials: normalizedMaterials,
    boundBatchId,
    boundBatchRevision,
    requestedBatchId,
    requestedRevision,
  })).digest("hex");
}

function requestedBatchId(input: JsonObject): string | null {
  if (input.batchId === undefined || input.batchId === null) return null;
  return stringField(input.batchId, "batchId", { nonEmpty: true });
}

function requestedRevision(input: JsonObject): number | null {
  return input.revision === undefined || input.revision === null ? null : revisionField(input.revision);
}

function assertTurnIdentity(value: unknown, field: string): string {
  const id = stringField(value, field, { nonEmpty: true });
  if (id.length > 100 || !/^[A-Za-z0-9-]+$/.test(id)) throw new HttpError(400, "invalid_turn_id", `${field} 格式不正确`);
  return id;
}

function attachmentsFor(materials: readonly BackfillMaterial[]): readonly { readonly assetId: string; readonly name: string }[] {
  const seen = new Set<string>();
  const attachments: { assetId: string; name: string }[] = [];
  for (const material of materials) {
    if (material.assetId === undefined || seen.has(material.assetId)) continue;
    seen.add(material.assetId);
    attachments.push({ assetId: material.assetId, name: material.name });
  }
  return attachments;
}

function currentBatchRevision(repository: SqliteRecordRepository, batchId: string | null): number | null {
  if (batchId === null) return null;
  const batch = repository.assistantBatch(batchId);
  return batch?.revision ?? null;
}

function answerFromCompletedTurn(repository: SqliteRecordRepository, turn: AssistantChatTurnRow, conversationBatchId: string | null): BackfillChatAnswer {
  if (turn.result === null || typeof turn.result !== "object" || Array.isArray(turn.result)) {
    throw new HttpError(409, "turn_result_missing", "这轮对话已完成，但结果无法读取；请开始新一轮");
  }
  if (conversationBatchId !== turn.batchId) {
    throw new HttpError(409, "stale_turn_batch", "这轮对话关联的方案已改变，请查看当前方案后继续");
  }
  const saved = turn.result as BackfillChatAnswer;
  if (turn.batchId === null) {
    const { batch: _staleBatch, ...withoutBatch } = saved;
    return { ...withoutBatch, conversationId: turn.conversationId, turnId: turn.turnId };
  }
  const batch = repository.assistantBatch(turn.batchId);
  if (batch === null) throw new HttpError(409, "stale_turn_batch", "这轮对话关联的方案已不存在，请开始新一轮");
  return {
    ...saved,
    batch,
    conversationId: turn.conversationId,
    turnId: turn.turnId,
  };
}

function validateRequest(input: JsonObject, repository: SqliteRecordRepository): {
  conversationId: string;
  turnId: string;
  message: string;
  materials: BackfillMaterial[];
  requestedBatchId: string | null;
  requestedRevision: number | null;
  privacyVisible: boolean;
} {
  hasOnlyKeys(input, ["conversationId", "turnId", "message", "materials", "history", "batchId", "revision", "privacyVisible"]);
  const conversationId = assertTurnIdentity(input.conversationId, "conversationId");
  const turnId = assertTurnIdentity(input.turnId, "turnId");
  const message = input.message === undefined ? "" : stringField(input.message, "message").trim();
  if (message.length > 12000) throw new HttpError(400, "message_too_long", "消息过长，请分次发送");
  const materials = parseMaterials(input.materials, repository);
  if (!message && materials.length === 0) throw new HttpError(400, "empty_message", "请输入消息或选入材料");
  return {
    conversationId,
    turnId,
    message,
    materials,
    requestedBatchId: requestedBatchId(input),
    requestedRevision: requestedRevision(input),
    privacyVisible: input.privacyVisible === undefined ? false : booleanField(input.privacyVisible, "privacyVisible"),
  };
}

function stableHash(input: JsonObject, message: string, materials: readonly BackfillMaterial[], boundBatchId: string | null, boundBatchRevision: number | null, batchId: string | null, revision: number | null): string {
  return requestShape({ ...input, conversationId: input.conversationId, message }, materials, boundBatchId, boundBatchRevision, batchId, revision);
}

function canRetryAfterFailure(error: unknown, repository: SqliteRecordRepository, batchBefore: ReturnType<SqliteRecordRepository["assistantBatch"]>, batchId: string | null, message: string): boolean {
  if (error instanceof HttpError && error.status >= 400 && error.status < 500) return false;
  const command = message.replace(/[\s，,。.!！]/g, "");
  if (WRITE_COMMANDS.has(command) || UNDO_COMMANDS.has(command)) return false;
  const batchAfter = batchId === null ? null : repository.assistantBatch(batchId);
  if (batchBefore !== null && batchAfter !== null && (batchBefore.revision !== batchAfter.revision || batchBefore.status !== batchAfter.status)) return false;
  if (batchBefore !== null && batchAfter === null) return false;
  return true;
}

async function runTurn(
  config: ApiConfig,
  repository: SqliteRecordRepository,
  identity: ReturnType<typeof validateRequest>,
  turn: AssistantChatTurnRow,
): Promise<BackfillChatAnswer> {
  const batchBefore = turn.boundBatchId === null ? null : repository.assistantBatch(turn.boundBatchId);
  try {
    const answer = await chatBackfill(config, repository, {
      message: identity.message,
      materials: identity.materials,
      history: turn.context,
      privacyVisible: identity.privacyVisible,
      ...(turn.boundBatchId === null ? {} : { batchId: turn.boundBatchId }),
      ...(turn.boundBatchRevision === null ? {} : { revision: turn.boundBatchRevision }),
    });
    const durableAnswer: BackfillChatAnswer = { ...answer, conversationId: identity.conversationId, turnId: identity.turnId };
    const answerBatch = durableAnswer.batch;
    if (!repository.completeAssistantChatTurn(identity.conversationId, identity.turnId, durableAnswer, answerBatch?.id ?? null, answerBatch?.revision ?? null, new Date().toISOString())) {
      throw new HttpError(409, "turn_completion_conflict", "这轮对话状态已改变，请刷新后查看");
    }
    return durableAnswer;
  } catch (error) {
    const retryable = canRetryAfterFailure(error, repository, batchBefore, turn.boundBatchId, identity.message);
    const code = error instanceof HttpError ? error.code : "chat_failed";
    repository.failAssistantChatTurn(identity.conversationId, identity.turnId, code, retryable, new Date().toISOString());
    throw error;
  }
}

export async function chatBackfillWithHistory(config: ApiConfig, repository: SqliteRecordRepository, input: JsonObject): Promise<BackfillChatAnswer> {
  const identity = validateRequest(input, repository);
  const conversation = repository.assistantConversation(identity.conversationId);
  if (conversation === null) throw new HttpError(404, "unknown_conversation", "找不到这段对话");
  const requestedBatch = identity.requestedBatchId;
  const requestedRev = identity.requestedRevision;
  const turns = inFlight(repository);
  const key = turnKey(identity.conversationId, identity.turnId);
  const existing = repository.assistantChatTurn(identity.conversationId, identity.turnId);

  if (existing !== null) {
    if (requestedBatch !== null && requestedBatch !== existing.boundBatchId) throw new HttpError(409, "turn_request_conflict", "这轮对话的方案已改变，请开始新一轮");
    const hash = stableHash(input, identity.message, identity.materials, existing.boundBatchId, existing.boundBatchRevision, requestedBatch, requestedRev);
    if (hash !== existing.requestHash) throw new HttpError(409, "turn_request_conflict", "相同轮次不能更改消息或材料，请开始新一轮");
    if (existing.status === "completed") return answerFromCompletedTurn(repository, existing, conversation.batchId);
    if (existing.status === "interrupted") throw new HttpError(409, "turn_interrupted", "服务重启时这轮对话仍未完成，不能重复执行；请开始新一轮");
    if (existing.status === "running") {
      const active = turns.get(key);
      if (active !== undefined) return active;
      repository.interruptAssistantChatTurn(identity.conversationId, identity.turnId, new Date().toISOString());
      throw new HttpError(409, "turn_interrupted", "这轮对话没有可恢复的服务任务，请开始新一轮");
    }
    if (!existing.retryable) throw new HttpError(409, "turn_failed", "这轮对话失败且不能安全重试，请开始新一轮");
    const concurrent = repository.assistantRunningChatTurn(identity.conversationId);
    if (concurrent !== null) {
      if (!turns.has(turnKey(identity.conversationId, concurrent.turnId))) {
        repository.interruptAssistantChatTurn(identity.conversationId, concurrent.turnId, new Date().toISOString());
      }
      throw new HttpError(409, "conversation_turn_running", "这段对话已有另一轮未完成，请等它结束后重试");
    }
    if (conversation.batchId !== existing.boundBatchId || currentBatchRevision(repository, existing.boundBatchId) !== existing.boundBatchRevision) {
      throw new HttpError(409, "stale_turn_batch", "关联方案已改变，请查看当前方案后开始新一轮");
    }
    if (requestedRev !== null && requestedRev !== existing.boundBatchRevision) throw new HttpError(409, "turn_request_conflict", "这轮对话的方案版本已改变，请开始新一轮");
    if (!repository.retryAssistantChatTurn(identity.conversationId, identity.turnId, new Date().toISOString())) {
      throw new HttpError(409, "turn_state_conflict", "这轮对话状态已改变，请刷新后重试");
    }
    const retrying = repository.assistantChatTurn(identity.conversationId, identity.turnId);
    if (retrying === null) throw new HttpError(409, "turn_state_conflict", "这轮对话已不存在");
    const promise = runTurn(config, repository, identity, retrying);
    turns.set(key, promise);
    try { return await promise; }
    finally { if (turns.get(key) === promise) turns.delete(key); }
  }

  const activeTurn = repository.assistantRunningChatTurn(identity.conversationId);
  if (activeTurn !== null) {
    if (!turns.has(turnKey(identity.conversationId, activeTurn.turnId))) {
      repository.interruptAssistantChatTurn(identity.conversationId, activeTurn.turnId, new Date().toISOString());
    }
    throw new HttpError(409, "conversation_turn_running", "这段对话仍有一轮未完成，请等它结束或开始新对话");
  }

  if (requestedBatch !== null && requestedBatch !== conversation.batchId) throw new HttpError(409, "conversation_batch_mismatch", "当前对话关联的方案已改变，请重新打开对话");
  const batch = conversation.batchId === null ? null : repository.assistantBatch(conversation.batchId);
  if (conversation.batchId !== null && batch === null) throw new HttpError(409, "conversation_batch_missing", "当前对话关联的方案已不存在，请开始新对话");
  if (requestedRev !== null && (batch === null || requestedRev !== batch.revision)) throw new HttpError(409, "stale_draft", "当前方案已在另一处改变，请刷新后重试");

  const boundBatchId = conversation.batchId;
  const boundBatchRevision = batch?.revision ?? null;
  const requestHash = stableHash(input, identity.message, identity.materials, boundBatchId, boundBatchRevision, requestedBatch, requestedRev);
  const page = repository.assistantMessagePage(identity.conversationId, { afterSeq: conversation.clearSeq, limit: 100 });
  const context = page.items.slice(-20).map(({ role, text }) => ({ role, text }));
  const attachments = attachmentsFor(identity.materials);
  const turn = repository.beginAssistantChatTurn({
    conversationId: identity.conversationId,
    turnId: identity.turnId,
    requestHash,
    userText: identity.message,
    attachments,
    context,
    batchId: boundBatchId,
    batchRevision: boundBatchRevision,
    at: new Date().toISOString(),
  });
  const promise = runTurn(config, repository, identity, turn);
  turns.set(key, promise);
  try { return await promise; }
  finally { if (turns.get(key) === promise) turns.delete(key); }
}
