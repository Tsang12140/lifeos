import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, CircleHelp, ListChecks, LoaderCircle, RotateCcw, Undo2, X } from "lucide-react";
import type { TaskStatus } from "@lifeos/core";
import type { RecordView, TaskRecordView } from "./api";
import { isTaskRecord, recordText, statusLabel } from "./app-meta";
import { lifeTimeDate, localDateToday, shiftDate, shortDate } from "./time";

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
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
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

  const completeTask = async (task: TaskRecordView) => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setCompletingTaskId(task.id);
    try {
      const [updated] = await Promise.all([
        onTaskStatus(task, "done"),
        new Promise<void>((resolve) => window.setTimeout(resolve, 420)),
      ]);
      if (updated === null || !isTaskRecord(updated)) {
        return;
      }
      setOptimisticDoneIds((current) => new Set(current).add(task.id));
      onTaskStateChange(updated);
      if (countPulseTimerRef.current !== null) window.clearTimeout(countPulseTimerRef.current);
      setCountPulse(true);
      countPulseTimerRef.current = window.setTimeout(() => { setCountPulse(false); countPulseTimerRef.current = null; }, 520);
      clearUndoTimer();
      setUndoEntry({ task: updated, previousStatus: task.task.status });
      undoTimerRef.current = window.setTimeout(() => { setUndoEntry(null); undoTimerRef.current = null; }, 5000);
    } finally {
      setCompletingTaskId(null);
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

  const summaryBusy = completingTaskId !== null || undoBusy;
  return <aside className="task-summary" aria-labelledby="task-summary-title" aria-busy={summaryBusy}>
    <div className="summary-heading"><div><h2 id="task-summary-title">接下来要做</h2></div><span className={`summary-badge ${countPulse ? "is-updated" : ""}`}>{activeTasks.length}</span></div>
    {loading ? <div className="summary-message"><LoaderCircle className="spin" size={17} aria-hidden="true" />正在读取</div> : null}
    {!loading && error ? <div className="summary-message summary-error"><CircleHelp size={17} aria-hidden="true" />暂时无法读取任务</div> : null}
    {!loading && !error && activeTasks.length === 0 ? <div className="summary-empty"><Check size={17} strokeWidth={1.8} aria-hidden="true" /><span>暂时没有待办任务</span></div> : null}
    {!loading && !error && activeTasks.length > 0 ? <ul className="task-list">{activeTasks.slice(0, 5).map((task) => <li className={`task-summary-item ${completingTaskId === task.id ? "is-completing" : ""}`} key={task.id}>
      <button className={`task-dot task-dot-button ${task.task.status === "in_progress" ? "is-progress" : ""}`} type="button" onClick={() => void completeTask(task)} disabled={summaryBusy} aria-label={`完成任务：${recordText(task)}`} title="标记为已完成"><span className="task-dot-indicator" aria-hidden="true"><Check size={12} strokeWidth={3} /></span></button>
      <span className="task-summary-copy">{recordText(task)}</span>
      {task.task.dueAt ? <time dateTime={task.task.dueAt.value} aria-label={`截止时间：${taskDueLabel(task)}`}>{taskDueLabel(task)}</time> : null}
    </li>)}</ul> : null}
    {undoEntry !== null ? <div className="task-undo" role="status" aria-live="polite"><span className="task-undo-copy"><Check size={14} strokeWidth={2} aria-hidden="true" /><span>任务已完成，可在 5 秒内撤销</span></span><button className="text-button task-undo-button" type="button" onClick={() => void undoCompletion()} disabled={undoBusy} aria-label={`撤销完成：${recordText(undoEntry.task)}`}>{undoBusy ? "恢复中…" : "撤销"}</button></div> : null}
  </aside>;
}
