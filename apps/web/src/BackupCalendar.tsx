import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Cloud, HardDrive } from "lucide-react";
import { apiRequest, type BackupRun } from "./api";
import { monthGridDates, monthTitle, shiftMonth } from "./time";

const DOW_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
const TIME_ZONE = "Asia/Shanghai";

function shanghaiDateKey(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function shanghaiTodayKey(): string {
  return shanghaiDateKey(new Date().toISOString());
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatBytes(size: number | undefined): string {
  if (size === undefined) return "";
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

type ProviderState = "success" | "failed" | "skipped" | "empty";

function providerState(runs: readonly BackupRun[], provider: BackupRun["provider"]): ProviderState {
  const latest = runs.find((run) => run.provider === provider);
  if (latest === undefined) return "empty";
  return latest.status;
}

function providerLabel(provider: BackupRun["provider"]): string {
  return provider === "local" ? "本地 SQLite" : "对象存储";
}

export function BackupCalendar({ initialRuns = [] }: { readonly initialRuns?: readonly BackupRun[] }) {
  const [month, setMonth] = useState(() => shanghaiTodayKey().slice(0, 7) + "-15");
  const [runs, setRuns] = useState<readonly BackupRun[]>(initialRuns);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grid = useMemo(() => monthGridDates(month), [month]);
  const currentMonth = shanghaiTodayKey().slice(0, 7);

  useEffect(() => setRuns(initialRuns), [initialRuns]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiRequest<{ readonly items: readonly BackupRun[] }>(`/api/backup/runs?from=${encodeURIComponent(grid[0]!)}&to=${encodeURIComponent(grid[grid.length - 1]!)}`, { signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) setRuns(payload.items); })
      .catch(() => { if (!controller.signal.aborted) setError("备份记录暂时无法读取"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [grid]);

  const dayMap = useMemo(() => {
    const map = new Map<string, BackupRun[]>();
    for (const run of runs) {
      const key = shanghaiDateKey(run.startedAt);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(run);
      map.set(key, list);
    }
    return map;
  }, [runs]);

  const selectedRuns = selectedDay === null ? [] : (dayMap.get(selectedDay) ?? []);
  const previousMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);
  const canNext = nextMonth.slice(0, 7) <= currentMonth;

  const moveMonth = (value: string) => {
    setMonth(value);
    setSelectedDay(null);
  };

  return <section className="backup-calendar" aria-label="备份日历" data-backup-calendar>
    <div className="backup-calendar-header">
      <div>
        <span className="backup-calendar-kicker">BACKUP CALENDAR</span>
        <h4 data-backup-month>{monthTitle(month)}</h4>
      </div>
      <div className="backup-calendar-nav" aria-label="切换月份">
        <button type="button" aria-label="上个月" onClick={() => moveMonth(previousMonth)}><ChevronLeft size={16} aria-hidden="true" /></button>
        <button type="button" aria-label="下个月" onClick={() => moveMonth(nextMonth)} disabled={!canNext}><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="backup-calendar-subline">
      <span>每天记录本地与对象存储结果</span>
      <span aria-live="polite">{loading ? "读取中…" : error ?? "Asia/Shanghai"}</span>
    </div>
    <div className="backup-calendar-weekdays" aria-hidden="true">{DOW_LABELS.map((label, index) => <span className={index >= 5 ? "is-weekend" : ""} key={label}>{label}</span>)}</div>
    <div className="backup-calendar-grid">
      {grid.map((day) => {
        const inMonth = day.slice(0, 7) === month.slice(0, 7);
        const dayRuns = dayMap.get(day) ?? [];
        const local = providerState(dayRuns, "local");
        const s3 = providerState(dayRuns, "s3");
        const isToday = day === shanghaiTodayKey();
        const isSelected = day === selectedDay;
        const title = `${day}：本地 ${local === "empty" ? "无记录" : local === "success" ? "成功" : "失败"}；对象存储 ${s3 === "empty" ? "无记录" : s3 === "success" ? "成功" : s3 === "skipped" ? "跳过" : "失败"}`;
        return <button
          key={day}
          type="button"
          className={`backup-calendar-day ${inMonth ? "" : "is-outside"} ${isToday ? "is-today" : ""} ${isSelected ? "is-selected" : ""}`}
          data-backup-day={day}
          aria-label={title}
          title={title}
          onClick={() => setSelectedDay(isSelected ? null : day)}
        >
          <span className="backup-calendar-day-number">{Number(day.slice(8, 10))}</span>
          <span className="backup-calendar-markers" aria-hidden="true">
            <span className={`backup-calendar-marker is-local is-${local}`} />
            <span className={`backup-calendar-marker is-s3 is-${s3}`} />
          </span>
        </button>;
      })}
    </div>
    <div className="backup-calendar-legend">
      <span><i className="is-local is-success" />本地成功</span>
      <span><i className="is-s3 is-success" />对象成功</span>
      <span><i className="is-failed" />失败</span>
      <span><i className="is-skipped" />跳过</span>
    </div>
    {selectedDay !== null ? <div className="backup-calendar-detail" data-backup-detail>
      <div className="backup-calendar-detail-heading"><strong>{selectedDay}</strong><span>{selectedRuns.length ? `${selectedRuns.length} 条记录` : "当天无备份记录"}</span></div>
      {selectedRuns.length === 0 ? <p className="backup-calendar-empty">尚未记录本地或对象存储结果。</p> : <div className="backup-calendar-runs">
        {selectedRuns.map((run) => <div className="backup-calendar-run" key={run.id}>
          <span className={`backup-calendar-run-dot is-${run.status}`} />
          <span className="backup-calendar-run-icon">{run.provider === "local" ? <HardDrive size={14} aria-hidden="true" /> : <Cloud size={14} aria-hidden="true" />}</span>
          <span className="backup-calendar-run-copy"><strong>{providerLabel(run.provider)}</strong><small>{run.status === "success" ? `${formatTime(run.startedAt)}${formatBytes(run.sizeBytes) ? ` · ${formatBytes(run.sizeBytes)}` : ""}` : run.status === "skipped" ? `已跳过：${run.error ?? "未配置"}` : `失败：${run.error ?? "未知错误"}`}</small></span>
          {run.kind === "scheduled" ? <em>定时</em> : null}
        </div>)}
      </div>}
    </div> : null}
  </section>;
}
