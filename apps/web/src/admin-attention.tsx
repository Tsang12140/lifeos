import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import "./admin-attention.css";
import { errorMessage } from "./app-meta";
import type { SettingsPageId } from "./app-types";
import {
  SEVERITY_LABELS,
  loadAttentionReport,
  retryStuckSummaries,
  type AttentionItem,
  type AttentionReport,
  type AttentionSeverity,
} from "./admin-attention-api";

/**
 * 设置 → 管理员 → 待处理.
 *
 * The owner asked for "an emergency to-do list": the things that are broken and
 * that nobody would notice otherwise. So this page deliberately shows only what
 * has already failed more than once and can be acted on from here — it is not a
 * second log viewer. Each row answers three questions in order: how bad, how many
 * times, and what to do. The log page stays the place for raw detail.
 *
 * Everything is read on demand; nothing here polls. The retry button is the only
 * thing that spends money, so it is always an explicit click.
 */

const SEVERITY_ICON: Readonly<Record<AttentionSeverity, typeof Info>> = {
  critical: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
};

const ATTENTION_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

function clockText(at: string | null): string {
  if (at === null) return "";
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? at : ATTENTION_TIME.format(value);
}

export function AdminAttentionPanel({ onNavigatePage }: { readonly onNavigatePage: (page: SettingsPageId) => void }) {
  const [report, setReport] = useState<AttentionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadAttentionReport()
      .then((value) => { if (active) { setReport(value); setError(null); } })
      .catch((cause) => { if (active) setError(errorMessage(cause, "待处理事项暂时读不出来")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  const run = useCallback(async (item: AttentionItem) => {
    if (item.action === null || busy !== null) return;
    if (item.action.kind === "open-log") { onNavigatePage("integrations/ai-log"); return; }
    if (item.action.kind === "open-page") { onNavigatePage(item.action.page as SettingsPageId); return; }
    setBusy(item.id); setError(null); setNotice(null);
    try {
      const result = await retryStuckSummaries();
      setNotice(result.retried === 0
        ? "没有需要重试的日期了。"
        : `重试了 ${result.retried} 天，补上 ${result.recovered} 天${result.remaining > 0 ? `，还剩 ${result.remaining} 天` : ""}。`);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause, "重试没有成功"));
    } finally {
      setBusy(null);
    }
  }, [busy, onNavigatePage]);

  const items = report?.items ?? [];
  const actionable = items.filter((item) => item.severity !== "info").length;

  return <section className="attention" aria-label="待处理事项">
    <div className="attention-toolbar">
      <p data-attention-summary>
        {loading && report === null
          ? "正在检查…"
          : actionable === 0
            ? "没有要你处理的事。"
            : `${actionable} 件要处理${items.length > actionable ? `，另有 ${items.length - actionable} 条提醒` : ""}。`}
      </p>
      <button className="secondary-button" type="button" disabled={loading || busy !== null} onClick={() => { setNotice(null); setReload((value) => value + 1); }}>
        {loading ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
        <span>{loading ? "检查中" : "重新检查"}</span>
      </button>
    </div>

    {error === null ? null : <p className="settings-inline-error" role="alert">{error}</p>}
    {notice === null ? null : <p className="settings-inline-notice" role="status">{notice}</p>}

    {loading && report === null ? null : items.length === 0 ? <div className="attention-empty" data-attention-empty>
      <CheckCircle2 size={20} aria-hidden="true" />
      <div>
        <strong>都正常</strong>
        <small>近 {report?.windowDays ?? 7} 天没有反复失败的 AI 调用，也没有卡住的小结和备份。</small>
      </div>
    </div> : <ul className="attention-list">
      {items.map((item) => {
        const Icon = SEVERITY_ICON[item.severity];
        const running = busy === item.id;
        return <li className={`attention-item is-${item.severity}`} key={item.id} data-attention-item={item.id} data-attention-severity={item.severity}>
          <span className="attention-icon" aria-hidden="true"><Icon size={16} /></span>
          <div className="attention-copy">
            <p className="attention-title">
              <span className="attention-severity">{SEVERITY_LABELS[item.severity]}</span>
              <strong data-attention-title>{item.title}</strong>
            </p>
            <p className="attention-detail">{item.detail}</p>
            <p className="attention-meta">
              {item.code === null ? null : <code data-attention-code>{item.code}</code>}
              {item.count > 1 ? <span data-attention-count>{item.count} 次</span> : null}
              {item.lastAt === null ? null : <span>最近 {clockText(item.lastAt)}</span>}
            </p>
          </div>
          {item.action === null ? null : <button
            className={`secondary-button attention-action ${item.action.kind === "retry-summary" ? "is-retry" : ""}`}
            type="button"
            disabled={busy !== null}
            data-attention-action={item.action.kind}
            onClick={() => void run(item)}
          >
            {running ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : item.action.kind === "retry-summary" ? <RotateCcw size={15} aria-hidden="true" /> : null}
            <span>{running ? "重试中" : item.action.label}</span>
          </button>}
        </li>;
      })}
    </ul>}

    <p className="attention-note">
      只统计近 {report?.windowDays ?? 7} 天内反复出现的失败。单次失败会自己重试，不打扰你；细节和原始报错在「服务集成 → AI 调用记录」。
      {report?.ai.configured ? ` 当前模型 ${report.ai.model ?? "未知"}。` : ""}
      {report?.summary.fallbackTotal === 0 ? "" : ` 目前有 ${report?.summary.fallbackTotal ?? 0} 天在用离线规则小结。`}
    </p>
  </section>;
}
