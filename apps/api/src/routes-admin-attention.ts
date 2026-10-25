import { SUMMARY_MAX_AUTO_ATTEMPTS } from "@lifeos/core";
import { readRuntimeAiConfig } from "./ai-config.js";
import { recordSummaryAttemptFailure } from "./assistant-attempt-log.js";
import { HttpError, setJson } from "./http-kit.js";
import { createDaySummaryProvider, resolveDaySummaries } from "./summary.js";
import { collectSummarisableRecords } from "./summary-routes.js";
import type { AssistantAttemptSource, AssistantAttemptStage, SqliteRecordRepository } from "./repository.js";
import type { RouteHandler } from "./route-context.js";

/**
 * 设置 → 管理员 → 待处理。
 *
 * This is the "emergency to-do list" the owner asked for: not a log viewer but a
 * short list of things that are broken right now and what to do about each one.
 * The rule for what belongs here is strict — an item must be (a) caused by
 * something failing repeatedly, (b) invisible until someone goes looking, and
 * (c) fixable from a settings page. Everything else stays in 服务集成 → AI 调用记录,
 * which is for diagnosis rather than for triage.
 *
 * Counts come from the same `assistant_turn_attempts` table that page reads, so
 * the two screens can never disagree about how many times something failed.
 */

const WINDOW_DAYS = 7;
/** More than a dozen distinct failures is a broken installation, not a list. */
const GROUP_LIMIT = 12;
/** One click retries one batch; the rest says how many days are left. */
const RETRY_LIMIT = 20;

const SOURCE_LABELS: Readonly<Record<AssistantAttemptSource, string>> = { chat: "AI 对话", summary: "AI 小结" };

/**
 * What the owner should do, in one sentence. These are the same three buckets the
 * log page filters by — the value of the bucket is that it maps to one remedy.
 */
const STAGE_REMEDY: Readonly<Record<AssistantAttemptStage, string>> = {
  connection: "网络或服务商抖动，自动重试还在继续；连续几天都这样再看。",
  format: "模型回的内容解析不了，通常是提示词或模型档位的问题。",
  service: "重试解决不了，多半是 Key 或模型名不对，去「AI 助手」改配置。",
};

export interface AttentionAction {
  readonly kind: "open-page" | "open-log" | "retry-summary";
  readonly label: string;
  readonly page?: string;
}

export interface AttentionItem {
  readonly id: string;
  readonly severity: "critical" | "warning" | "info";
  readonly title: string;
  readonly detail: string;
  /** The raw code, shown as a chip so it can be pasted into a search. */
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

const SEVERITY_ORDER: Readonly<Record<AttentionItem["severity"], number>> = { critical: 0, warning: 1, info: 2 };

const ATTENTION_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

function clockText(at: string | null): string {
  if (at === null) return "未知时间";
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? at : ATTENTION_TIME.format(value);
}

/** Shanghai day, because every date the calendar shows is in that zone. */
function shanghaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
}

function buildReport(repository: SqliteRecordRepository, config: Parameters<typeof readRuntimeAiConfig>[0], now = new Date()): AttentionReport {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const items: AttentionItem[] = [];

  for (const group of repository.assistantAttemptDigest(since, GROUP_LIMIT)) {
    const severity = group.stage === "service" ? "critical" : "warning";
    const where = group.lastSubject === null ? "" : `（${group.lastSubject}）`;
    items.push({
      id: `attempt:${group.source}:${group.stage}:${group.errorCode}`,
      severity,
      title: `${SOURCE_LABELS[group.source]}失败 ${group.count} 次`,
      detail: `最近一次 ${clockText(group.lastAt)}${where}：${group.lastDetail === "" ? group.errorCode : group.lastDetail} ${STAGE_REMEDY[group.stage]}`,
      code: group.errorCode,
      count: group.count,
      firstAt: group.firstAt,
      lastAt: group.lastAt,
      action: group.stage === "service"
        ? { kind: "open-page", page: "integrations/ai", label: "去检查 AI 配置" }
        : { kind: "open-log", label: "查看调用记录" },
    });
  }

  const attention = repository.daySummaryAttention(SUMMARY_MAX_AUTO_ATTEMPTS);
  if (attention.stuck.length > 0) {
    const newest = attention.stuck[0]!;
    const oldest = attention.stuck[attention.stuck.length - 1]!;
    items.push({
      id: "summary:stuck",
      severity: "critical",
      title: `${attention.stuck.length} 天的小结补不上`,
      detail: `已经自动试过 ${SUMMARY_MAX_AUTO_ATTEMPTS} 次，现在停手等你了（${oldest.date} 到 ${newest.date}）。点一下立刻重试最老的 ${Math.min(attention.stuck.length, RETRY_LIMIT)} 天。`,
      code: "day_summary_fallback",
      count: attention.stuck.length,
      firstAt: newest.generatedAt,
      lastAt: newest.generatedAt,
      action: { kind: "retry-summary", label: "立即重试" },
    });
  } else if (attention.retrying > 0) {
    items.push({
      id: "summary:retrying",
      severity: "info",
      title: `${attention.retrying} 天的小结在自动重试中`,
      detail: "这些天暂时显示离线规则小结，退避到点后会自己再问一次，不用管。",
      code: null,
      count: attention.retrying,
      firstAt: null,
      lastAt: null,
      action: null,
    });
  }

  const runtime = readRuntimeAiConfig(config);
  const configured = runtime.apiKey !== undefined;
  if (!runtime.enabled || !configured) {
    items.push({
      id: "ai:unavailable",
      severity: "info",
      title: runtime.enabled ? "AI 还没配置 Key" : "AI 已被关闭",
      detail: "AI 管家和日历小结现在走离线规则。配置好之后，之前攒下的离线小结会自己补成 AI 的。",
      code: null,
      count: 0,
      firstAt: null,
      lastAt: null,
      action: { kind: "open-page", page: "integrations/ai", label: "去配置" },
    });
  }

  const latestBackup = repository.listBackupRuns(1)[0];
  if (latestBackup !== undefined && latestBackup.status === "failed") {
    items.push({
      id: "backup:failed",
      severity: "critical",
      title: "最近一次备份失败",
      detail: `${clockText(latestBackup.finishedAt ?? latestBackup.startedAt)} 的${latestBackup.kind === "scheduled" ? "自动" : "手动"}备份没有完成：${latestBackup.error ?? "没有留下原因"}`,
      code: "backup_failed",
      count: 1,
      firstAt: latestBackup.startedAt,
      lastAt: latestBackup.finishedAt ?? latestBackup.startedAt,
      action: { kind: "open-page", page: "data/backup", label: "查看备份" },
    });
  }

  items.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || (right.lastAt ?? "").localeCompare(left.lastAt ?? ""));

  return {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    items,
    ai: { configured, enabled: runtime.enabled, model: configured ? runtime.model : null },
    summary: { stuck: attention.stuck.length, retrying: attention.retrying, fallbackTotal: attention.fallbackTotal },
    maxAutoAttempts: SUMMARY_MAX_AUTO_ATTEMPTS,
  };
}

export const handleAdminAttentionRoutes: RouteHandler = async (ctx, req, res, pathname, url) => {
  const root = "/api/admin/attention";
  if (pathname !== root && pathname !== `${root}/summary-retry`) return false;
  if (!ctx.poolAdmin) throw new HttpError(403, "owner_required", "仅管理员可查看待处理事项");
  if (url.search) throw new HttpError(400, "unknown_query", "不支持此查询参数");

  if (pathname === root) {
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    setJson(res, 200, buildReport(ctx.repository, ctx.config), { "cache-control": "no-store" });
    return true;
  }

  if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
  // Retrying is a write that costs money, so it is an explicit click every time —
  // never something a page load or a timer can trigger.
  const stuck = ctx.repository.daySummaryAttention(SUMMARY_MAX_AUTO_ATTEMPTS).stuck;
  const dates = stuck.slice(0, RETRY_LIMIT).map((day) => day.date);
  if (dates.length === 0) {
    setJson(res, 200, { retried: 0, recovered: 0, remaining: 0 });
    return true;
  }
  const byDate = collectSummarisableRecords(ctx.repository, "Asia/Shanghai");
  const provider = createDaySummaryProvider(ctx.config);
  const items = await resolveDaySummaries({
    dates,
    recordsForDate: (date) => byDate.get(date) ?? [],
    cache: ctx.repository,
    provider,
    // Forcing is the whole point: these days are inside no backoff window, they
    // have simply used up their automatic attempts.
    force: true,
    today: shanghaiToday(),
    latestRecordsForDate: (date) => collectSummarisableRecords(ctx.repository, "Asia/Shanghai").get(date) ?? [],
    onProviderFallback: (failure) => recordSummaryAttemptFailure(ctx.repository, "admin_attention", failure),
  });
  const recovered = items.filter((item) => item.status === "generated").length;
  setJson(res, 200, {
    retried: dates.length,
    recovered,
    remaining: ctx.repository.daySummaryAttention(SUMMARY_MAX_AUTO_ATTEMPTS).stuck.length,
  });
  return true;
};
