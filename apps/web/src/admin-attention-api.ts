import { apiRequest } from "./api";

/**
 * 设置 → 管理员 → 待处理 的数据形状。
 *
 * 与 `apps/api/src/routes-admin-attention.ts` 一一对应。这里刻意不引入 core 类型：
 * 这份报告是「给主人看的三句话」，不是领域模型，改它不该牵动记录/日历的契约。
 */

export type AttentionSeverity = "critical" | "warning" | "info";

export interface AttentionAction {
  readonly kind: "open-page" | "open-log" | "retry-summary";
  readonly label: string;
  readonly page?: string;
}

export interface AttentionItem {
  readonly id: string;
  readonly severity: AttentionSeverity;
  readonly title: string;
  readonly detail: string;
  readonly code: string | null;
  readonly count: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly action: AttentionAction | null;
}

export interface AttentionReport {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly items: readonly AttentionItem[];
  readonly ai: { readonly configured: boolean; readonly enabled: boolean; readonly model: string | null };
  readonly summary: { readonly stuck: number; readonly retrying: number; readonly fallbackTotal: number };
  readonly maxAutoAttempts: number;
}

export interface SummaryRetryResult {
  readonly retried: number;
  readonly recovered: number;
  readonly remaining: number;
}

export function loadAttentionReport(): Promise<AttentionReport> {
  return apiRequest<AttentionReport>("/api/admin/attention");
}

export function retryStuckSummaries(): Promise<SummaryRetryResult> {
  return apiRequest<SummaryRetryResult>("/api/admin/attention/summary-retry", { method: "POST", body: "{}" });
}

export const SEVERITY_LABELS: Readonly<Record<AttentionSeverity, string>> = {
  critical: "要处理",
  warning: "在出错",
  info: "提醒",
};
