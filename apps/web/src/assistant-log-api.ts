import { apiRequest } from "./api";

/** Mirrors `AssistantAttemptStage` in the API. Each value maps to a different remedy. */
export type AssistantAttemptStage = "connection" | "format" | "service";

/** 同一页里的两种 AI 失败：AI 管家的一轮对话，和日历里 AI 生成的那一天小结。 */
export type AssistantAttemptSource = "chat" | "summary";

export interface AssistantAttempt {
  readonly id: string;
  readonly source: AssistantAttemptSource;
  readonly conversationId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly stage: AssistantAttemptStage;
  readonly errorCode: string;
  readonly errorDetail: string;
  readonly httpStatus: number | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly receivedChars: number;
  readonly rawChars: number;
  readonly rawTruncated: boolean;
  readonly rawText: string | null;
  readonly userText: string | null;
  /** 小结行自带的一行「哪块界面 · 哪几天」；对话行没有，靠 userText。 */
  readonly subject: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface AssistantAttemptLog {
  readonly generatedAt: string;
  readonly since: string;
  readonly retentionDays: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly counts: Readonly<Record<AssistantAttemptStage, number>> & { readonly total: number };
  readonly sources: Readonly<Record<AssistantAttemptSource, number>>;
  readonly attempts: readonly AssistantAttempt[];
}

export const ATTEMPT_STAGE_LABELS: Readonly<Record<AssistantAttemptStage, string>> = {
  connection: "连接被中断",
  format: "回答格式不完整",
  service: "服务暂时不可用",
};

export const ATTEMPT_SOURCE_LABELS: Readonly<Record<AssistantAttemptSource, string>> = {
  chat: "对话",
  summary: "小结",
};

/** `since: null` asks the server for its whole retention window, whatever that is. */
export function loadAssistantAttemptLog(since: string | null, stage: AssistantAttemptStage | null = null, source: AssistantAttemptSource | null = null): Promise<AssistantAttemptLog> {
  const params = new URLSearchParams();
  if (since !== null) params.set("since", since);
  if (stage !== null) params.set("stage", stage);
  if (source !== null) params.set("source", source);
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  return apiRequest<AssistantAttemptLog>(`/api/ai/assistant/log${suffix}`);
}

export function clearAssistantAttemptLog(): Promise<{ readonly cleared: number; readonly at: string }> {
  return apiRequest("/api/ai/assistant/log/clear", { method: "POST" });
}

/**
 * The clipboard payload. Deliberately plain, labelled, and lossless: this text
 * is pasted into another AI to be diagnosed, not read by a person, so nothing is
 * summarised, reworded, or dropped. Raw model output is fenced with explicit
 * markers and its true length so a reader can tell truncation from an empty reply.
 */
export function buildAttemptLogText(attempts: readonly AssistantAttempt[], generatedAt: string): string {
  const lines: string[] = [
    "LifeOS · AI 调用失败记录（原文导出，未改写）",
    `导出时间：${generatedAt}`,
    `条数：${attempts.length}`,
    "",
  ];
  attempts.forEach((attempt, index) => {
    lines.push(
      `[${index + 1}/${attempts.length}]`,
      `来源：${attempt.source === "summary" ? "AI 小结（日历）" : "AI 对话"}`,
      `时间：${attempt.finishedAt}（耗时 ${attempt.durationMs}ms，开始于 ${attempt.startedAt}）`,
      `分类：${attempt.stage} / ${ATTEMPT_STAGE_LABELS[attempt.stage]}`,
      `错误码：${attempt.errorCode}`,
      `错误说明：${attempt.errorDetail}`,
      `模型：${attempt.model ?? "未知"}    档位：${attempt.effort ?? "未知"}    HTTP：${attempt.httpStatus === null ? "无" : attempt.httpStatus}`,
      `收到字符数：${attempt.receivedChars}（原始 ${attempt.rawChars}，${attempt.rawTruncated ? "已按头尾截断" : "未截断"}）`,
    );
    if (attempt.source === "summary") {
      lines.push(`对象：${attempt.subject ?? "（未记录）"}`);
    } else {
      lines.push(`对话：${attempt.conversationId}    轮次：${attempt.turnId}    第 ${attempt.attempt} 次尝试`, `用户问题：${attempt.userText ?? "（未记录）"}`);
    }
    if (attempt.rawText === null || attempt.rawText.length === 0) {
      lines.push("模型原始输出：无（服务商未返回正文）");
    } else {
      lines.push("模型原始输出：", "-----BEGIN RAW-----", attempt.rawText, "-----END RAW-----");
    }
    lines.push("");
  });
  return lines.join("\n");
}
