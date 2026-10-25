import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Copy, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import "./assistant-log.css";
import { errorMessage } from "./app-meta";
import { USER_TIME_ZONE, localDateToday } from "./time";
import {
  ATTEMPT_SOURCE_LABELS,
  ATTEMPT_STAGE_LABELS,
  buildAttemptLogText,
  clearAssistantAttemptLog,
  loadAssistantAttemptLog,
  type AssistantAttempt,
  type AssistantAttemptLog,
  type AssistantAttemptSource,
  type AssistantAttemptStage,
} from "./assistant-log-api";

/**
 * 设置 → 服务集成 → AI 调用记录.
 *
 * The reader of this page is another AI, not the owner: the copy button hands
 * over raw model output with no summarising or rewording. The owner's job is
 * only to pick a time window — hence the range presets and the click/shift-click
 * selection, since the app disables text selection everywhere else on purpose.
 *
 * 2026-10-20：日历里「AI 小结」的失败也并到这一页（`source='summary'`）。
 * 两种失败都是「一次模型调用没成功」，分开两个界面只会让主人排查时来回翻。
 */

const ATTEMPT_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: USER_TIME_ZONE,
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

type RangeId = "15m" | "1h" | "today" | "all";

const RANGES: readonly { readonly id: RangeId; readonly label: string }[] = [
  { id: "15m", label: "最近 15 分钟" },
  { id: "1h", label: "最近 1 小时" },
  { id: "today", label: "今天" },
  { id: "all", label: "保留窗口" },
];

function rangeSince(id: RangeId): string | null {
  const now = Date.now();
  if (id === "15m") return new Date(now - 15 * 60_000).toISOString();
  if (id === "1h") return new Date(now - 60 * 60_000).toISOString();
  if (id === "today") return new Date(`${localDateToday()}T00:00:00`).toISOString();
  // Null means "the server's whole retention window" — never a guessed number.
  return null;
}

function clockText(at: string): string {
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? at : ATTEMPT_TIME.format(value);
}

interface TurnGroup {
  readonly turnId: string;
  /** Oldest first, so the detail reads in the order the attempts actually ran. */
  readonly attempts: readonly AssistantAttempt[];
  readonly latest: AssistantAttempt;
  readonly stage: AssistantAttemptStage;
  readonly source: AssistantAttemptSource;
}

function groupByTurn(attempts: readonly AssistantAttempt[]): readonly TurnGroup[] {
  const groups: TurnGroup[] = [];
  const index = new Map<string, AssistantAttempt[]>();
  for (const attempt of attempts) {
    const existing = index.get(attempt.turnId);
    if (existing === undefined) {
      const created: AssistantAttempt[] = [attempt];
      index.set(attempt.turnId, created);
      groups.push({ turnId: attempt.turnId, attempts: created, latest: attempt, stage: attempt.stage, source: attempt.source });
      continue;
    }
    existing.push(attempt);
  }
  return groups.map((group) => {
    const ordered = [...group.attempts].sort((a, b) => a.attempt - b.attempt);
    return { ...group, attempts: ordered, latest: ordered[ordered.length - 1]!, stage: ordered[ordered.length - 1]!.stage, source: ordered[0]!.source };
  });
}

/** 对话行显示主人问的那句话；小结行没有消息可回填，显示「哪块界面 · 哪几天」。 */
function groupTitle(group: TurnGroup): string {
  if (group.source === "summary") return group.latest.subject ?? "（未记录日期）";
  return group.latest.userText ?? "（未记录问题）";
}

export function AssistantAttemptLogCard() {
  const [range, setRange] = useState<RangeId>("all");
  const [stage, setStage] = useState<AssistantAttemptStage | null>(null);
  const [source, setSource] = useState<AssistantAttemptSource | null>(null);
  const [log, setLog] = useState<AssistantAttemptLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const lastClicked = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadAssistantAttemptLog(rangeSince(range), stage, source)
      .then((payload) => { if (!controller.signal.aborted) { setLog(payload); setError(null); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause, "调用记录暂不可用")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, stage, source, reload]);

  const groups = useMemo(() => groupByTurn(log?.attempts ?? []), [log]);
  const selectedAttempts = useMemo(() => {
    const picked = new Set(selected);
    return groups
      .filter((group) => picked.has(group.turnId))
      .flatMap((group) => group.attempts)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attempt - b.attempt);
  }, [groups, selected]);

  const counts = log?.counts ?? { connection: 0, format: 0, service: 0, total: 0 };
  const sources = log?.sources ?? { chat: 0, summary: 0 };
  // 小结行没有对话（conversationId 为空），别让它把「涉及对话」算多一段。
  const conversations = new Set((log?.attempts ?? []).filter((attempt) => attempt.source === "chat" && attempt.conversationId.length > 0).map((attempt) => attempt.conversationId)).size;

  const toggle = (turnId: string, position: number, extend: boolean) => {
    setSelected((current) => {
      const anchor = extend ? lastClicked.current : null;
      if (anchor === null) {
        lastClicked.current = position;
        return current.includes(turnId) ? current.filter((id) => id !== turnId) : [...current, turnId];
      }
      const from = Math.min(anchor, position);
      const to = Math.max(anchor, position);
      const span = groups.slice(from, to + 1).map((group) => group.turnId);
      return [...new Set([...current, ...span])];
    });
  };

  const selectAll = () => { setSelected(groups.map((group) => group.turnId)); lastClicked.current = null; };
  const clearSelection = () => { setSelected([]); lastClicked.current = null; };

  const copy = async () => {
    if (selectedAttempts.length === 0) return;
    setMessage(null);
    setError(null);
    const text = buildAttemptLogText(selectedAttempts, log?.generatedAt ?? new Date().toISOString());
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`已复制 ${selectedAttempts.length} 条尝试的原始记录，共 ${Math.round(text.length / 1024)} KB。直接粘贴给 AI 即可。`);
    } catch {
      setError("复制失败，请检查浏览器剪贴板权限后重试。");
    }
  };

  // Same two-step as deleting photos: the first click only arms.
  const clearAll = async () => {
    if (busy) return;
    if (!armed) { setArmed(true); setMessage(null); return; }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const cleared = await clearAssistantAttemptLog();
      setArmed(false);
      setSelected([]);
      setExpanded(null);
      setReload((current) => current + 1);
      setMessage(cleared.cleared === 0 ? "本来就没有记录。" : `已清空 ${cleared.cleared} 条记录。`);
    } catch (cause) {
      setError(errorMessage(cause, "清空失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="settings-log-card" data-assistant-log>
    <div className="settings-log-head">
      <div className="settings-card-copy">
        <strong>AI 调用记录</strong>
        <small>AI 对话和日历里的 AI 小结，失败都记在这里；成功的不留痕。选中一段时间后一键复制，直接粘给 AI 排查。</small>
      </div>
      <button className="icon-text-button" type="button" data-assistant-log-refresh onClick={() => setReload((current) => current + 1)} disabled={loading}>
        {loading ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}
        <span>{loading ? "读取中" : "刷新"}</span>
      </button>
    </div>

    <div className="settings-log-stats">
      <div><small>范围内失败</small><strong data-assistant-log-total>{counts.total} 次</strong></div>
      <div><small>其中对话</small><strong data-assistant-log-chat>{sources.chat} 次 · {conversations} 段</strong></div>
      <div><small>其中小结</small><strong data-assistant-log-summary>{sources.summary} 次</strong></div>
      <div><small>保留</small><strong data-assistant-log-retention>{log?.retentionDays ?? 30} 天</strong></div>
    </div>

    <div className="settings-log-ranges" role="group" aria-label="来源">
      <button className={`settings-log-chip ${source === null ? "is-on" : ""}`} type="button" data-assistant-log-source="all" aria-pressed={source === null} onClick={() => { setSource(null); setSelected([]); lastClicked.current = null; }}>全部来源</button>
      {(["chat", "summary"] as const).map((value) => <button key={value} className={`settings-log-chip ${source === value ? "is-on" : ""}`} type="button" data-assistant-log-source={value} aria-pressed={source === value} onClick={() => { setSource(value); setSelected([]); lastClicked.current = null; }}>{value === "chat" ? "AI 对话" : "AI 小结"} {sources[value]}</button>)}
    </div>

    <div className="settings-log-ranges" role="group" aria-label="时间范围">
      {RANGES.map((item) => <button key={item.id} className={`settings-log-chip ${item.id === range ? "is-on" : ""}`} type="button" data-assistant-log-range={item.id} aria-pressed={item.id === range} onClick={() => { setRange(item.id); setSelected([]); lastClicked.current = null; }}>{item.label}</button>)}
    </div>

    <div className="settings-log-ranges" role="group" aria-label="失败原因">
      <button className={`settings-log-chip ${stage === null ? "is-on" : ""}`} type="button" data-assistant-log-stage="all" aria-pressed={stage === null} onClick={() => setStage(null)}>全部 {counts.total}</button>
      {(["connection", "format", "service"] as const).map((value) => <button key={value} className={`settings-log-chip stage-${value} ${stage === value ? "is-on" : ""}`} type="button" data-assistant-log-stage={value} aria-pressed={stage === value} onClick={() => setStage(value)}>{ATTEMPT_STAGE_LABELS[value]} {counts[value]}</button>)}
    </div>

    <div className="settings-log-actions">
      <button className="secondary-button" type="button" data-assistant-log-select-all disabled={groups.length === 0} onClick={selectAll}>全选 {groups.length} 轮</button>
      <button className="secondary-button" type="button" data-assistant-log-select-none disabled={selected.length === 0} onClick={clearSelection}>清空选择</button>
      <button className="primary-button" type="button" data-assistant-log-copy disabled={selectedAttempts.length === 0} onClick={() => void copy()}><Copy size={15} aria-hidden="true" /><span>复制给 AI（{selectedAttempts.length} 条）</span></button>
      <button className={`danger-button settings-log-purge ${armed ? "is-armed" : ""}`} type="button" data-assistant-log-clear disabled={busy || counts.total === 0} onClick={() => void clearAll()}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}<span>{armed ? "再点一次清空" : "清空记录"}</span></button>
    </div>

    {log === null ? null : <p className="settings-log-note">复制的内容是原文：包含每次尝试的错误码、耗时、收到多少字，以及模型说了一半的原始输出。界面上的「连接被中断 / 回答格式不完整 / 服务暂时不可用」只是给你筛选用，不进复制内容。小结那条会写明是哪块界面、涉及哪几天。</p>}

    {groups.length === 0 && !loading ? <p className="settings-log-empty" data-assistant-log-empty>这个范围里没有失败记录。</p> : null}

    <div className="settings-log-list">
      {groups.map((group, position) => {
        const isSelected = selected.includes(group.turnId);
        const isOpen = expanded === group.turnId;
        return <div className={`settings-log-row ${isSelected ? "is-selected" : ""}`} key={group.turnId} data-assistant-log-turn={group.turnId}>
          <div className="settings-log-row-main">
            <button className="settings-log-check" type="button" role="checkbox" aria-checked={isSelected} data-assistant-log-pick={group.turnId} aria-label={`选择这一轮：${group.latest.userText ?? "无正文"}`} onClick={(event) => toggle(group.turnId, position, event.shiftKey)}>{isSelected ? <Check size={13} aria-hidden="true" /> : null}</button>
            <button className="settings-log-summary" type="button" data-assistant-log-expand={group.turnId} aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : group.turnId)}>
              <span className={`settings-log-source source-${group.source}`} data-assistant-log-source-label={group.source}>{ATTEMPT_SOURCE_LABELS[group.source]}</span>
              <span className={`settings-log-stage stage-${group.stage}`} data-assistant-log-stage-label>{ATTEMPT_STAGE_LABELS[group.stage]}</span>
              <span className="settings-log-time">{clockText(group.latest.finishedAt)}</span>
              <span className="settings-log-question">{groupTitle(group)}</span>
              <span className="settings-log-tries">{group.source === "chat" ? `试了 ${group.attempts.length} 次` : ""}</span>
            </button>
          </div>
          {isOpen ? <div className="settings-log-detail" data-assistant-log-detail={group.turnId}>
            {group.attempts.map((attempt) => {
              // 小结没有「第几次尝试 / 耗时 / 收到多少字」：一次读日历只发一次请求，失败就直接退回离线小结。
              const head = attempt.source === "summary"
                ? `小结生成 · ${clockText(attempt.startedAt)}`
                : `第 ${attempt.attempt} 次 · ${clockText(attempt.startedAt)} · 耗时 ${attempt.durationMs}ms · 收到 ${attempt.receivedChars} 字`;
              return <div className="settings-log-attempt" key={attempt.id}>
                <p className="settings-log-attempt-line">{head} · <code>{attempt.errorCode}</code>{attempt.httpStatus === null ? "" : ` · HTTP ${attempt.httpStatus}`}</p>
                <p className="settings-log-attempt-detail">{attempt.errorDetail}</p>
                {attempt.source === "summary" ? null : attempt.rawText === null || attempt.rawText.length === 0 ? <p className="settings-log-attempt-detail">模型没有返回任何正文。</p> : <pre className="settings-log-raw" data-assistant-log-raw>{attempt.rawText.length > 4000 ? `${attempt.rawText.slice(0, 4000)}\n…（这里只预览前 4000 字，复制时是完整的 ${attempt.rawChars} 字）` : attempt.rawText}</pre>}
              </div>;
            })}
          </div> : null}
        </div>;
      })}
    </div>

    {log?.truncated ? <p className="settings-log-note" role="status"><AlertCircle size={13} aria-hidden="true" /> 这个范围里的记录超过 {log.limit} 条，只列出了最新的 {log.limit} 条。缩小时间范围可以看全。</p> : null}
    {message !== null ? <p className="settings-inline-success" role="status">{message}</p> : null}
    {error !== null ? <p className="settings-inline-error" role="alert">{error}</p> : null}
  </div>;
}
