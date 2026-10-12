import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, CircleHelp, LoaderCircle } from "lucide-react";
import type { TaskStatus } from "@lifeos/core";
import type { RecordView, TaskRecordView } from "./api";
import { isTaskRecord, recordText, statusLabel } from "./app-meta";
import { lifeTimeDate, localDateToday, shiftDate, shortDate } from "./time";
import { TaskNotificationIcon } from "./task-notification-icon";

export interface TaskUndoEntry {
  readonly task: TaskRecordView;
  readonly previousStatus: TaskStatus;
}

export function taskDueLabel(task: TaskRecordView): string {
  const date = lifeTimeDate(task.task.dueAt);
  if (date === undefined) return "";
  if (date === localDateToday()) return "今天";
  if (date === shiftDate(localDateToday(), 1)) return "明天";
  return shortDate(date);
}

export function TaskSummary({ tasks, loading, error, onTaskStatus, onTaskStateChange }: { tasks: readonly RecordView[] | null; loading: boolean; error: string | null; onTaskStatus: (record: TaskRecordView, status: TaskStatus) => Promise<RecordView | null>; onTaskStateChange: (record: RecordView) => void }) {
  const [optimisticDoneIds, setOptimisticDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [undoEntry, setUndoEntry] = useState<TaskUndoEntry | null>(null);
  const [completion, setCompletion] = useState<{ task: TaskRecordView; index: number; phase: "saving" | "checked" | "leaving"; height: number } | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [countPulse, setCountPulse] = useState(false);
  const actionBusyRef = useRef(false);
  const undoTimerRef = useRef<number | null>(null);
  const countPulseTimerRef = useRef<number | null>(null);

  const clearUndoTimer = useCallback(() => {
    if (undoTimerRef.current === null) return;
    window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
  }, []);

  useEffect(() => () => clearUndoTimer(), [clearUndoTimer]);
  useEffect(() => () => { if (countPulseTimerRef.current !== null) window.clearTimeout(countPulseTimerRef.current); }, []);

  // Parent state changes are authoritative after a PATCH. Once they contain the
  // new status, the local marker is no longer needed.
  useEffect(() => {
    if (tasks === null) return;
    const taskById = new Map(tasks.filter(isTaskRecord).map((task) => [task.id, task]));
    setOptimisticDoneIds((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const id of current) {
        const task = taskById.get(id);
        if (task === undefined || task.task.status === "done" || task.task.status === "cancelled") next.delete(id);
      }
      return next.size === current.size ? current : next;
    });
    if (undoEntry !== null && !taskById.has(undoEntry.task.id) && !loading) {
      clearUndoTimer();
      setUndoEntry(null);
    }
  }, [clearUndoTimer, loading, tasks, undoEntry]);

  const activeTasks = (tasks ?? []).filter((task): task is TaskRecordView => task.isPrivate !== true && isTaskRecord(task) && task.task.status !== "done" && task.task.status !== "cancelled" && !optimisticDoneIds.has(task.id));
  // A background refresh can already contain the saved status. Keep this row
  // in place until the success feedback finishes, rather than cutting it short.
  if (completion !== null) {
    const index = activeTasks.findIndex(task => task.id === completion.task.id);
    if (index !== -1) activeTasks.splice(index, 1);
    activeTasks.splice(Math.min(completion.index, activeTasks.length), 0, completion.task);
  }

  const completeTask = async (task: TaskRecordView, row: HTMLElement | null) => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setCompletion({ task, index: activeTasks.findIndex(item => item.id === task.id), phase: "saving", height: row?.getBoundingClientRect().height ?? 0 });
    try {
      const updated = await onTaskStatus(task, "done");
      if (updated === null || !isTaskRecord(updated)) {
        return;
      }
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setCompletion(current => current === null ? null : { ...current, phase: "checked" });
      if (!reducedMotion) await new Promise<void>(resolve => window.setTimeout(resolve, 380));
      setCompletion(current => current === null ? null : { ...current, phase: "leaving", height: row?.getBoundingClientRect().height ?? current.height });
      if (!reducedMotion) await new Promise<void>(resolve => window.setTimeout(resolve, 180));
      setOptimisticDoneIds((current) => new Set(current).add(task.id));
      setExpandedTaskId(current => current === task.id ? null : current);
      onTaskStateChange(updated);
      if (countPulseTimerRef.current !== null) window.clearTimeout(countPulseTimerRef.current);
      setCountPulse(true);
      countPulseTimerRef.current = window.setTimeout(() => { setCountPulse(false); countPulseTimerRef.current = null; }, 520);
      clearUndoTimer();
      setUndoEntry({ task: updated, previousStatus: task.task.status });
      undoTimerRef.current = window.setTimeout(() => { setUndoEntry(null); undoTimerRef.current = null; }, 5000);
    } finally {
      setCompletion(null);
      actionBusyRef.current = false;
    }
  };

  const undoCompletion = async () => {
    if (undoEntry === null || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setUndoBusy(true);
    try {
      const restored = await onTaskStatus(undoEntry.task, undoEntry.previousStatus);
      if (restored === null) return;
      clearUndoTimer();
      setUndoEntry(null);
      setOptimisticDoneIds((current) => { const next = new Set(current); next.delete(undoEntry.task.id); return next; });
      onTaskStateChange(restored);
    } finally {
      setUndoBusy(false);
      actionBusyRef.current = false;
    }
  };

  const summaryBusy = completion !== null || undoBusy;
  return <aside className="task-summary" aria-labelledby="task-summary-title" aria-busy={summaryBusy}>
    <div className="summary-heading"><div className="task-summary-heading-label"><TaskNotificationIcon hasNotifications={!loading && !error && activeTasks.length > 0} /><h2 id="task-summary-title">接下来要做</h2></div><span className={`summary-badge ${countPulse ? "is-updated" : ""}`}>{activeTasks.length}</span></div>
    {loading ? <div className="summary-message"><LoaderCircle className="spin" size={17} aria-hidden="true" />正在读取</div> : null}
    {!loading && error ? <div className="summary-message summary-error"><CircleHelp size={17} aria-hidden="true" />暂时无法读取任务</div> : null}
    {!loading && !error && activeTasks.length === 0 ? <div className="summary-empty"><Check size={17} strokeWidth={1.8} aria-hidden="true" /><span>暂时没有待办任务</span></div> : null}
    {!loading && !error && activeTasks.length > 0 ? <ul className="task-list">{activeTasks.slice(0, 5).map((task) => <li className={`task-summary-item ${completion?.task.id === task.id ? completion.phase === "saving" ? "is-saving" : `is-completing ${completion.phase === "leaving" ? "is-leaving" : ""}` : ""}`} style={completion?.task.id === task.id ? { "--task-completion-height": `${completion.height}px` } as CSSProperties : undefined} key={task.id}>
      <button className={`task-dot task-dot-button ${task.task.status === "in_progress" ? "is-progress" : ""}`} type="button" onClick={event => void completeTask(task, event.currentTarget.closest("li"))} disabled={summaryBusy} aria-label={`完成任务：${recordText(task)}`} title="标记为已完成"><span className="task-dot-indicator" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" pathLength="1" /></svg></span></button>
      <button className="task-summary-open" type="button" aria-expanded={expandedTaskId === task.id} aria-label={`${expandedTaskId === task.id ? "收起" : "展开"}任务全文：${recordText(task)}`} disabled={completion?.task.id === task.id} onClick={() => setExpandedTaskId(current => current === task.id ? null : task.id)}><span className="task-summary-copy">{recordText(task)}</span></button>
      {task.task.dueAt ? <time dateTime={task.task.dueAt.value} aria-label={`截止时间：${taskDueLabel(task)}`}>{taskDueLabel(task)}</time> : null}
    </li>)}</ul> : null}
    {undoEntry !== null ? <div className="task-undo" role="status" aria-live="polite"><span className="task-undo-copy"><Check size={14} strokeWidth={2} aria-hidden="true" /><span>任务已完成，可在 5 秒内撤销</span></span><button className="text-button task-undo-button" type="button" onClick={() => void undoCompletion()} disabled={undoBusy} aria-label={`撤销完成：${recordText(undoEntry.task)}`}>{undoBusy ? "恢复中…" : "撤销"}</button></div> : null}
  </aside>;
}
