/**
 * The AI assistant's chat transcript, kept so it can be read back later.
 *
 * The screen only ever shows the tail of the current conversation; the archive
 * keeps every exchange, including the ones the person cleared off the screen.
 * Nothing here is sent to a model by itself — reading history is a plain
 * database lookup, so browsing it costs no tokens.
 */

import { calendarToday } from "./day-policy.js";
import type { UiTurnPlan } from "./ui-command.js";

export interface AssistantHistoryMessage {
  /** Stable database identity, present for persisted messages. */
  readonly id?: string;
  /** Monotonic order within a conversation, present for persisted messages. */
  readonly seq?: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** ISO timestamp of when the message was stored. */
  readonly at: string;
  readonly attachments?: readonly AssistantHistoryAttachment[];
  /**
   * The interface commands this reply carried.
   *
   * Stored with the message rather than held in the tab, so reopening a
   * conversation redraws the same buttons — a clarify prompt whose candidates
   * vanished on reload would be asking a question nobody can answer by clicking.
   * These were compiled and validated server-side before they were written, and
   * replaying them only ever filters, scrolls or navigates.
   */
  readonly ui?: UiTurnPlan;
  /** Present for turns sent through the idempotent chat endpoint. */
  readonly turnId?: string;
  readonly turnStatus?: "running" | "failed" | "interrupted" | "completed";
  readonly retryable?: boolean;
}

export interface AssistantHistoryAttachment {
  readonly assetId: string;
  readonly name: string;
}

export interface AssistantConversationSummary {
  readonly id: string;
  /** Asia/Shanghai calendar day of the conversation's first message. */
  readonly day: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  /** Opening words normally; the matching message excerpt during a keyword search. */
  readonly preview: string;
}

export interface AssistantConversationDetail {
  readonly id: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** When the screen was last cleared; null means nothing was hidden. */
  readonly clearedAt: string | null;
  /** The pending/last batch bound to this conversation, if any. */
  readonly batchId?: string | null;
  readonly messages: readonly AssistantHistoryMessage[];
  /** Older messages exist before this page. */
  readonly hasMore?: boolean;
  /** Exclusive seq cursor for fetching the next older message page. */
  readonly nextBeforeSeq?: number | null;
}

export interface AssistantHistoryPage {
  readonly items: readonly AssistantConversationSummary[];
  /** True when older conversations exist beyond this page. */
  readonly hasMore: boolean;
  /** Opaque cursor for the next older page. */
  readonly nextCursor?: string | null;
  /** The keyword the list was filtered by, echoed back for the UI. */
  readonly query: string;
}

export interface AssistantHistoryCurrent {
  readonly conversation: AssistantConversationDetail | null;
}

export interface AssistantHistoryGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly AssistantConversationSummary[];
}

export interface AssistantHistorySegment {
  readonly text: string;
  readonly match: boolean;
}

export const ASSISTANT_HISTORY_LIMITS = {
  /** Longest single message the archive accepts, matching the chat endpoints. */
  maxTextLength: 12000,
  /** Messages accepted by one append call. */
  maxBatch: 20,
  /** Conversations returned by one page of the history list. */
  pageSize: 100,
  /** Messages returned when one conversation is opened. */
  maxConversationMessages: 100,
  /** Characters of the opening message kept for the list preview. */
  previewLength: 80,
} as const;

export function assistantHistoryPreview(text: string, query = ""): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const needle = query.replace(/\s+/g, " ").trim();
  const matchAt = needle ? flat.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  const start = matchAt < 0 ? 0 : Math.max(0, matchAt - 20);
  const length = Math.max(ASSISTANT_HISTORY_LIMITS.previewLength, needle.length + 20);
  const end = start + length;
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" });

function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** "2026-06-03" reads as 2026年6月3日; unknown days stay honest. */
export function assistantHistoryDayLabel(day: string): string {
  return isDayKey(day) ? DAY_LABEL_FORMAT.format(new Date(`${day}T12:00:00+08:00`)) : "日期未知";
}

function previousDay(day: string): string {
  const date = new Date(`${day}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() - 1);
  return DAY_FORMAT.format(date);
}

/**
 * Groups the archive the way the list reads it: 今天 and 昨天 stay pinned to the
 * top, then every older day gets its own heading, newest first.
 *
 * The day comes from the server and is already a Shanghai calendar day, so a
 * conversation continued today still sits under the day it started.
 */
export function groupConversationsByDay(items: readonly AssistantConversationSummary[], today = calendarToday()): readonly AssistantHistoryGroup[] {
  const yesterday = previousDay(today);
  const todayItems: AssistantConversationSummary[] = [];
  const yesterdayItems: AssistantConversationSummary[] = [];
  const older = new Map<string, AssistantConversationSummary[]>();
  for (const item of items) {
    if (item.day === today) todayItems.push(item);
    else if (item.day === yesterday) yesterdayItems.push(item);
    else {
      const list = older.get(item.day);
      if (list === undefined) older.set(item.day, [item]);
      else list.push(item);
    }
  }
  const groups: AssistantHistoryGroup[] = [];
  if (todayItems.length > 0) groups.push({ key: "today", label: "今天", items: todayItems });
  if (yesterdayItems.length > 0) groups.push({ key: "yesterday", label: "昨天", items: yesterdayItems });
  for (const day of [...older.keys()].sort((a, b) => b.localeCompare(a))) {
    groups.push({ key: `day:${day}`, label: assistantHistoryDayLabel(day), items: older.get(day) ?? [] });
  }
  return groups;
}

/**
 * Splits a message around every literal occurrence of the keyword, so the
 * dialog can mark the hits without injecting markup into the text.
 * Case is folded for matching but the returned text keeps its original casing.
 */
export function splitHistoryMatches(text: string, query: string): readonly AssistantHistorySegment[] {
  const needle = query.trim();
  if (needle.length === 0) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const segments: AssistantHistorySegment[] = [];
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(target, cursor);
    if (at < 0) break;
    if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false });
    segments.push({ text: text.slice(at, at + needle.length), match: true });
    cursor = at + needle.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length === 0 ? [{ text, match: false }] : segments;
}

/** How many times one message mentions the keyword. */
export function countHistoryMatches(text: string, query: string): number {
  return splitHistoryMatches(text, query).filter((segment) => segment.match).length;
}
