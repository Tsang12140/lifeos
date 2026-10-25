import { randomUUID } from "node:crypto";
import { writeApiLogEvent } from "./api-log.js";
import type { AssistantAttemptStage, SqliteRecordRepository } from "./repository.js";
import type { DaySummaryProviderFallback } from "./summary.js";

/**
 * Failure-only diagnostics for the assistant.
 *
 * This exists for exactly one workflow: the owner selects a time range in
 * 设置 → 服务集成 → AI 调用记录, copies the block, and hands it to an AI to
 * diagnose. So the payload stays raw on purpose — model output is kept
 * verbatim, error codes are the provider's own, and nothing is translated into
 * friendlier wording on the way in. `stage` is the only human-facing grouping,
 * and it exists so the page can filter without the reader knowing what
 * `invalid_ai_reply` means. Each value maps to a different remedy:
 *
 *   connection → retry, nothing else to do
 *   format     → the prompt or the model needs work
 *   service    → the provider or the credentials need attention
 */

/** Model output past this is kept head+tail: a truncated JSON always breaks at the end. */
export const ATTEMPT_RAW_LIMIT = 64_000;

/** Kept short on purpose: 30 days of failures is already far more than a diagnosis needs. */
export const ATTEMPT_RETAIN_DAYS = 30;

export interface AttemptDetail {
  readonly stage: AssistantAttemptStage;
  readonly errorCode: string;
  readonly errorDetail: string;
  readonly httpStatus?: number | null;
  readonly receivedChars: number;
  readonly rawText: string;
  /** Body-channel text only. This never contains reasoning or model commands. */
  readonly partialReply?: string;
}

export interface AttemptFailure extends AttemptDetail {
  readonly attempt: number;
  readonly model: string | null;
  readonly effort: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface AttemptRecorder {
  /** Successful body delivery with unusable optional metadata: diagnostic, not a failed turn. */
  diagnose?(detail: AttemptDetail): void;
  /**
   * Buffer one failed model call. Nothing is written yet: an attempt that the
   * built-in repair retry recovers from was never a failure the owner saw, and
   * logging it would fill the page with errors that did not happen.
   */
  fail(failure: AttemptFailure): void;
  /** Persist everything buffered. Called only once the turn itself has failed. */
  flush(): void;
}

export const NO_ATTEMPT_RECORDER: AttemptRecorder = { fail: () => {}, flush: () => {} };

/**
 * Clip raw model output to the storage budget. Head *and* tail are kept because
 * the interesting part of a broken reply is where it broke, which is the end.
 */
export function clipRawOutput(text: string): { readonly text: string | null; readonly chars: number; readonly truncated: boolean } {
  const chars = text.length;
  if (chars === 0) return { text: null, chars, truncated: false };
  if (chars <= ATTEMPT_RAW_LIMIT) return { text, chars, truncated: false };
  const half = ATTEMPT_RAW_LIMIT / 2;
  return {
    text: `${text.slice(0, half)}\n…[中间省略 ${chars - ATTEMPT_RAW_LIMIT} 字]…\n${text.slice(chars - half)}`,
    chars,
    truncated: true,
  };
}

/**
 * Diagnostics ride on the error object itself, never on `HttpError.details` —
 * that field is serialized straight into the client response, and raw model
 * output must not leave the machine.
 */
export function withAttemptDetail<T extends Error>(error: T, detail: AttemptDetail): T {
  (error as T & { attemptDetail?: AttemptDetail }).attemptDetail = detail;
  return error;
}

export function attemptDetailOf(error: unknown): AttemptDetail | undefined {
  return error instanceof Error ? (error as Error & { attemptDetail?: AttemptDetail }).attemptDetail : undefined;
}

/** A cancelled turn is not a failure, so nothing is recorded when the owner stops a reply. */
export function isCancellation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "turn_cancelled";
}

let prunedDay = "";

/**
 * Daily retention without a timer: this runs on the first recorded failure of
 * each UTC day, plus once at boot. A day with no failures has nothing new to
 * prune, so skipping it costs nothing — and no background process is added to
 * the 4-core box this is deployed on.
 */
export function pruneAssistantAttemptsOnceADay(repository: SqliteRecordRepository, now = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  if (prunedDay === day) return;
  prunedDay = day;
  try {
    repository.pruneAssistantAttempts(new Date(now.getTime() - ATTEMPT_RETAIN_DAYS * 86_400_000).toISOString());
  } catch (error) {
    prunedDay = ""; // Retry on the next write rather than losing the whole day.
    console.error("[assistant-attempt-log] prune failed:", error);
  }
}

export function repositoryAttemptRecorder(repository: SqliteRecordRepository, conversationId: string, turnId: string): AttemptRecorder {
  const buffered: AttemptFailure[] = [];
  const write = (failure: AttemptFailure): void => {
    try {
      const raw = clipRawOutput(failure.rawText);
      repository.recordAssistantAttempt({
        id: randomUUID(),
        conversationId,
        turnId,
        attempt: failure.attempt,
        stage: failure.stage,
        errorCode: failure.errorCode,
        errorDetail: failure.errorDetail,
        httpStatus: failure.httpStatus ?? null,
        model: failure.model,
        effort: failure.effort,
        receivedChars: failure.receivedChars,
        rawChars: raw.chars,
        rawTruncated: raw.truncated,
        rawText: raw.text,
        startedAt: failure.startedAt,
        finishedAt: failure.finishedAt,
        durationMs: failure.durationMs,
      });
    } catch (error) {
      // A diagnostic log must never be able to fail a turn.
      console.error("[assistant-attempt-log] write failed:", error);
    }
  };
  return {
    diagnose(detail) {
      const raw = clipRawOutput(detail.rawText);
      writeApiLogEvent("assistant_reply_diagnostic", { conversationId, turnId, code: detail.errorCode, detail: detail.errorDetail, receivedChars: detail.receivedChars, rawChars: raw.chars, rawText: raw.text, rawTruncated: raw.truncated });
    },
    fail(failure) { buffered.push(failure); },
    flush() {
      if (buffered.length === 0) return;
      const pending = buffered.splice(0, buffered.length);
      pruneAssistantAttemptsOnceADay(repository);
      for (const failure of pending) write(failure);
    },
  };
}

/**
 * 日历里「用 AI 生成小结」的失败。
 *
 * 它和对话失败是同一类东西（一次模型调用没成功、主人看得见、需要拿给 AI 排查），
 * 所以写进同一张 assistant_turn_attempts，只是 `source='summary'`；设置页那一个
 * 「AI 调用记录」因此能并排看到两种失败。三条边界：
 *
 *   - 对话行靠 `assistant_messages` 回填「用户问题」，小结没有消息可回填，所以
 *     自己带一行 `subject`（哪块界面 + 哪几天），否则列表里全是「（未记录问题）」。
 *   - `conversationId` 留空、`turnId` 每条一个 uuid：既不会和任何真实对话的
 *     turn 撞键，也不会把多次失败合并成「试了 N 次」。
 *   - 文件日志（`logs/api-*.log`）照旧写一份：它按天切文件、不占数据库，
 *     排查线上时仍然是最先被翻的地方。
 */
export function recordSummaryAttemptFailure(
  repository: SqliteRecordRepository,
  surface: SummaryFailureSurface,
  failure: DaySummaryProviderFallback,
  now = new Date(),
): void {
  try { writeApiLogEvent("day_summary_ai_fallback", { surface, ...failure }); } catch { /* 文件日志失败不影响请求 */ }
  try {
    pruneAssistantAttemptsOnceADay(repository, now);
    const at = now.toISOString();
    repository.recordAssistantAttempt({
      id: randomUUID(),
      source: "summary",
      conversationId: "",
      turnId: randomUUID(),
      attempt: 1,
      stage: summaryFailureStage(failure),
      errorCode: `day_summary_${failure.reason}`,
      errorDetail: summaryFailureDetail(failure),
      httpStatus: failure.httpStatus ?? null,
      model: failure.model ?? null,
      effort: null,
      receivedChars: 0,
      rawChars: 0,
      rawTruncated: false,
      rawText: null,
      subject: `${SUMMARY_SURFACE_LABELS[surface] ?? surface} · ${summaryDatesText(failure.dates)}`,
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
    });
  } catch (error) {
    // 诊断日志永远不能让一次读日历失败。
    console.error("[assistant-attempt-log] summary write failed:", error);
  }
}

export type SummaryFailureSurface = "calendar_read" | "calendar_regenerate" | "calendar_scheduler" | "admin_attention";

export const SUMMARY_SURFACE_LABELS: Readonly<Record<string, string>> = {
  calendar_read: "翻看日历",
  calendar_regenerate: "手动重新生成",
  calendar_scheduler: "后台预生成",
  admin_attention: "管理员页手动重试",
};

const SUMMARY_REASON_LABELS: Readonly<Record<DaySummaryProviderFallback["reason"], string>> = {
  http_error: "服务商返回错误",
  timeout: "等待超时",
  invalid_json: "返回的不是 JSON",
  invalid_response: "返回里没有正文",
  network_error: "网络不通",
  provider_error: "调用失败",
  missing_date: "返回里少了这几天",
};

/**
 * 同一个失败原因在两种界面上的补救方式是一样的，所以分类共用一套语义：
 * 重试能好的算 `connection`，提示词/模型要改的算 `format`，凭据或服务商要处理的算 `service`。
 */
export function summaryFailureStage(failure: Pick<DaySummaryProviderFallback, "reason" | "httpStatus">): AssistantAttemptStage {
  if (failure.reason === "timeout" || failure.reason === "network_error") return "connection";
  if (failure.reason === "invalid_json" || failure.reason === "invalid_response" || failure.reason === "missing_date") return "format";
  if (failure.reason === "http_error") {
    // 429 是「等一下再来」，不是凭据问题；其余 4xx 才是主人要去改配置的。
    if (failure.httpStatus === 429) return "connection";
    if (failure.httpStatus !== undefined && failure.httpStatus >= 400 && failure.httpStatus < 500) return "service";
    return "connection";
  }
  return "service";
}

function summaryDatesText(dates: readonly string[]): string {
  if (dates.length === 0) return "（没有日期）";
  if (dates.length <= 3) return dates.join("、");
  return `${dates[0]} 等 ${dates.length} 天`;
}

function summaryFailureDetail(failure: DaySummaryProviderFallback): string {
  const status = failure.httpStatus === undefined ? "" : ` · HTTP ${failure.httpStatus}`;
  const code = failure.networkCode === undefined ? "" : ` · ${failure.networkCode}`;
  return `AI 小结没有生成（${SUMMARY_REASON_LABELS[failure.reason]}${status}${code}），已退回离线规则小结。涉及日期：${failure.dates.join("、") || "（无）"}`;
}
