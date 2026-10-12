import { randomUUID } from "node:crypto";
import {
  ASSISTANT_HISTORY_LIMITS,
  assistantHistoryPreview,
  type AssistantConversationDetail,
  type AssistantConversationSummary,
  type AssistantHistoryAttachment,
  type AssistantHistoryCurrent,
  type AssistantHistoryMessage,
  type AssistantHistoryPage,
} from "@lifeos/core";
import { setJson, HttpError } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { enumField, hasOnlyKeys, jsonObject, parseDateQuery, stringField } from "./field-validate.js";
import type { AssistantConversationCursor, AssistantConversationQuery, AssistantConversationRow, SqliteRecordRepository } from "./repository.js";
import type { RouteHandler } from "./route-context.js";

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const LIST_QUERY_KEYS = new Set(["q", "cursor", "from", "to"]);

/** Shanghai calendar day. A UTC slice would misfile anything written after 08:00. */
function dayKey(at: string): string {
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? "" : DAY_FORMAT.format(value);
}

function summaryOf(row: AssistantConversationRow, query = ""): AssistantConversationSummary {
  return {
    id: row.id,
    day: dayKey(row.startedAt),
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    messageCount: row.messageCount,
    preview: assistantHistoryPreview(row.preview, query),
  };
}

function assertQueryKeys(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.has(key)) throw new HttpError(400, "unknown_query", `Unsupported query parameter: ${key}`);
    if (url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "duplicate_query", `Query parameter ${key} must appear once`);
  }
}

function dateBoundary(day: string, addDay: boolean): string {
  const date = new Date(`${day}T00:00:00.000+08:00`);
  if (addDay) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function decodeCursor(raw: string): AssistantConversationCursor {
  if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new HttpError(400, "invalid_cursor", "历史列表游标格式不正确");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "invalid_cursor", "历史列表游标格式不正确"); }
  const object = jsonObject(value, "cursor");
  hasOnlyKeys(object, ["updatedAt", "id"]);
  const updatedAt = stringField(object.updatedAt, "cursor.updatedAt", { nonEmpty: true });
  const id = stringField(object.id, "cursor.id", { nonEmpty: true });
  if (!Number.isFinite(Date.parse(updatedAt)) || id.length > 200) throw new HttpError(400, "invalid_cursor", "历史列表游标格式不正确");
  return { updatedAt, id };
}

function encodeCursor(cursor: AssistantConversationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function listQuery(url: URL): { readonly query: string; readonly repositoryQuery: AssistantConversationQuery; readonly cursor?: string } {
  assertQueryKeys(url, LIST_QUERY_KEYS);
  const rawQuery = url.searchParams.get("q") ?? "";
  const query = rawQuery.trim();
  if (query.length > 200) throw new HttpError(400, "query_too_long", "搜索词不能超过 200 个字符");
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue === null ? undefined : decodeCursor(cursorValue);
  const from = parseDateQuery(url.searchParams.get("from"), "from");
  const to = parseDateQuery(url.searchParams.get("to"), "to");
  if (from !== undefined && to !== undefined && from > to) throw new HttpError(400, "invalid_date_range", "from 不能晚于 to");
  return {
    query,
    repositoryQuery: {
      limit: ASSISTANT_HISTORY_LIMITS.pageSize + 1,
      ...(query.length === 0 ? {} : { q: query }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(from === undefined ? {} : { fromAt: dateBoundary(from, false) }),
      ...(to === undefined ? {} : { toBefore: dateBoundary(to, true) }),
    },
    ...(cursorValue === null ? {} : { cursor: cursorValue }),
  };
}

function messagesPage(repository: SqliteRecordRepository, id: string, options: { readonly beforeSeq?: number; readonly afterSeq?: number } = {}): Pick<AssistantConversationDetail, "messages" | "hasMore" | "nextBeforeSeq"> {
  const page = repository.assistantMessagePage(id, {
    ...options,
    limit: ASSISTANT_HISTORY_LIMITS.maxConversationMessages,
  });
  const messages: readonly AssistantHistoryMessage[] = page.items.map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    text: row.text,
    at: row.createdAt,
    attachments: row.attachments,
    ...(row.ui === undefined ? {} : { ui: row.ui }),
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    ...(row.turnStatus === undefined ? {} : { turnStatus: row.turnStatus }),
    ...(row.retryable === undefined ? {} : { retryable: row.retryable }),
  }));
  return { messages, hasMore: page.hasMore, nextBeforeSeq: page.nextBeforeSeq };
}

function detailOf(repository: SqliteRecordRepository, row: AssistantConversationRow, options: { readonly beforeSeq?: number; readonly afterSeq?: number } = {}): AssistantConversationDetail {
  return {
    id: row.id,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    clearedAt: row.clearedAt,
    batchId: row.batchId,
    ...messagesPage(repository, row.id, options),
  };
}

function attachmentsField(value: unknown, repository: SqliteRecordRepository, index: number): readonly AssistantHistoryAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 9) throw new HttpError(400, "invalid_attachments", `messages[${index}].attachments 格式不正确`);
  return value.map((raw, attachmentIndex) => {
    const item = jsonObject(raw, `messages[${index}].attachments[${attachmentIndex}]`);
    hasOnlyKeys(item, ["assetId", "name"]);
    const assetId = stringField(item.assetId, "assetId", { nonEmpty: true });
    const name = stringField(item.name, "name", { nonEmpty: true });
    if (assetId.length > 100 || name.length > 200) throw new HttpError(400, "invalid_attachments", "附件名称或编号过长");
    if (repository.findAssetById(assetId) === null) throw new HttpError(400, "unknown_asset", "对话附件已不存在，请重新选入");
    return { assetId, name };
  });
}

function historyMessages(value: unknown, repository: SqliteRecordRepository): readonly { readonly role: "user" | "assistant"; readonly text: string; readonly attachments: readonly AssistantHistoryAttachment[] }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ASSISTANT_HISTORY_LIMITS.maxBatch) {
    throw new HttpError(400, "invalid_history", "对话内容格式不正确");
  }
  return value.map((raw, index) => {
    const item = jsonObject(raw, `messages[${index}]`);
    hasOnlyKeys(item, ["role", "text", "attachments"]);
    const role = enumField(item.role, ["user", "assistant"] as const, `messages[${index}].role`);
    const text = stringField(item.text, `messages[${index}].text`);
    if (text.length > ASSISTANT_HISTORY_LIMITS.maxTextLength) throw new HttpError(400, "message_too_long", "单条对话过长");
    const attachments = attachmentsField(item.attachments, repository, index);
    if (!text.trim() && attachments.length === 0) throw new HttpError(400, "empty_message", "对话内容不能为空");
    return { role, text, attachments };
  });
}

function requireConversation(repository: SqliteRecordRepository, id: string): AssistantConversationRow {
  const row = repository.assistantConversation(id);
  if (row === null) throw new HttpError(404, "unknown_conversation", "找不到这段对话");
  return row;
}

function strictBeforeSeq(url: URL): number | undefined {
  assertQueryKeys(url, new Set(["beforeSeq"]));
  const raw = url.searchParams.get("beforeSeq");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_before_seq", "beforeSeq 必须是正整数");
  const seq = Number(raw);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new HttpError(400, "invalid_before_seq", "beforeSeq 必须是正整数");
  return seq;
}

/** The assistant archive. Browsing only reads stored rows and never calls a model. */
export const handleAssistantHistoryRoutes: RouteHandler = async (ctx, req, res, pathname, url) => {
  const { config, repository } = ctx;
  if (pathname === "/api/ai/assistant/history" && req.method === "GET") {
    const parsed = listQuery(url);
    const rows = repository.assistantConversations(parsed.repositoryQuery);
    const items = rows.slice(0, ASSISTANT_HISTORY_LIMITS.pageSize);
    const hasMore = rows.length > ASSISTANT_HISTORY_LIMITS.pageSize;
    const last = items.at(-1);
    const page: AssistantHistoryPage = {
      items: items.map((row) => summaryOf(row, parsed.query)),
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
      query: parsed.query,
    };
    setJson(res, 200, page); return true;
  }
  if (pathname === "/api/ai/assistant/history/current" && req.method === "GET") {
    assertQueryKeys(url, new Set());
    const row = repository.assistantCurrentConversation();
    const result: AssistantHistoryCurrent = {
      conversation: row === null ? null : detailOf(repository, row, { afterSeq: row.clearSeq }),
    };
    setJson(res, 200, result); return true;
  }
  if (pathname === "/api/ai/assistant/history" && req.method === "POST") {
    assertQueryKeys(url, new Set());
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["conversationId", "messages"]);
    const messages = historyMessages(input.messages, repository);
    const at = new Date().toISOString();
    const requested = input.conversationId === undefined ? "" : stringField(input.conversationId, "conversationId");
    const id = requested.length === 0 ? randomUUID() : requested;
    if (requested.length === 0) repository.createAssistantConversation(id, at);
    else requireConversation(repository, id);
    if (messages.length > 0) repository.appendAssistantMessages(id, messages, at);
    else repository.touchAssistantConversation(id, at);
    setJson(res, 200, { conversationId: id, appended: messages.length, at }); return true;
  }
  if (pathname === "/api/ai/assistant/history/new" && req.method === "POST") {
    assertQueryKeys(url, new Set());
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["batchId"]);
    const batchId = input.batchId === undefined || input.batchId === null ? null : stringField(input.batchId, "batchId", { nonEmpty: true });
    if (batchId !== null && repository.assistantBatch(batchId) === null) throw new HttpError(404, "unknown_batch", "找不到当前方案，请重新打开对话");
    const at = new Date().toISOString();
    const id = randomUUID();
    repository.atomic(() => {
      repository.createAssistantConversation(id, at, batchId);
      repository.setAssistantCurrentConversation(id);
    });
    setJson(res, 200, { conversationId: id, at }); return true;
  }
  const match = /^\/api\/ai\/assistant\/history\/([a-zA-Z0-9-]+)(?:\/(clear|continue))?$/.exec(pathname);
  if (!match) return false;
  const id = match[1]!;
  const row = requireConversation(repository, id);
  if (req.method === "GET" && match[2] === undefined) {
    const beforeSeq = strictBeforeSeq(url);
    setJson(res, 200, detailOf(repository, row, beforeSeq === undefined ? {} : { beforeSeq })); return true;
  }
  if (req.method === "POST" && match[2] === "clear") {
    assertQueryKeys(url, new Set());
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, []);
    const at = new Date().toISOString();
    repository.clearAssistantConversation(id, at);
    setJson(res, 200, { conversationId: id, clearedAt: at }); return true;
  }
  if (req.method === "POST" && match[2] === "continue") {
    assertQueryKeys(url, new Set());
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, []);
    const at = new Date().toISOString();
    repository.resumeAssistantConversation(id, at);
    setJson(res, 200, { conversationId: id, at }); return true;
  }
  return false;
};
