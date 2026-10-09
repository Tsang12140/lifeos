import { useEffect, useState } from "react";
import { apiRequest, type RecordView } from "./api";
import { lifeTimeDate } from "./time";

export function calendarTaskDate(record: RecordView): string | undefined {
  return record.kind === "task" && record.task.dueAt ? lifeTimeDate(record.task.dueAt) : undefined;
}
export function calendarTasksForDate(tasks: readonly RecordView[], date: string): readonly RecordView[] {
  return tasks.filter(t => t.kind === "task" && t.isPrivate !== true && t.task.status !== "cancelled" && calendarTaskDate(t) === date)
    .sort((a, b) => Number(a.kind === "task" && a.task.status === "done") - Number(b.kind === "task" && b.task.status === "done") || a.createdAt.value.localeCompare(b.createdAt.value) || a.id.localeCompare(b.id));
}
export function calendarTaskStatus(record: RecordView): string {
  return record.kind !== "task" ? "" : record.task.status === "done" ? "已完成" : record.task.status === "in_progress" ? "进行中" : "待办";
}
const sourceText = (r: RecordView) => (r.body.edited ?? r.body.original).replace(/\s+/gu, " ").trim();
export function useCalendarTaskLabels(tasks: readonly RecordView[], from: string, to: string, timeZone: string, enabled: boolean): ReadonlyMap<string, { text: string; source: string }> {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 560px)").matches);
  const [labels, setLabels] = useState<ReadonlyMap<string, { text: string; source: string }>>(() => new Map());
  const signature = JSON.stringify(tasks.filter(t => { const d = calendarTaskDate(t); return d && d >= from && d <= to && t.isPrivate !== true; }).map(t => [t.id, sourceText(t), calendarTaskDate(t), t.kind === "task" ? t.task.status : ""]).sort());
  useEffect(() => { const media = window.matchMedia("(max-width: 560px)"); const update = () => setNarrow(media.matches); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  useEffect(() => {
    if (!enabled || narrow || signature === "[]") return;
    const controller = new AbortController();
    const sources = new Map(tasks.map(t => [t.id, sourceText(t)]));
    apiRequest<{ items: Array<{ taskId: string; text: string }> }>("/api/calendar/tasks/labels", { method: "POST", signal: controller.signal, body: JSON.stringify({ from, to, timeZone }) })
      .then(payload => { if (!controller.signal.aborted) setLabels(new Map(payload.items.map(item => [item.taskId, { text: item.text, source: sources.get(item.taskId) ?? "" }]))); })
      .catch(() => { /* Keep the full local reminder; never auto-retry on render. */ });
    return () => controller.abort();
  }, [enabled, narrow, from, to, timeZone, signature]);
  return labels;
}
export function calendarTaskText(record: RecordView, labels: ReadonlyMap<string, { text: string; source: string }>): string {
  const source = sourceText(record), cached = labels.get(record.id);
  return cached?.source === source ? cached.text : source;
}
