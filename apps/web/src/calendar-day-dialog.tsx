import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Asset, Entity } from "@lifeos/core";
import { apiRequest, type RecordsResponse, type RecordView } from "./api";
import { displayDate, USER_TIME_ZONE } from "./time";
import { TimelineItem } from "./timeline";
import { calendarTasksForDate, calendarTaskStatus } from "./calendar-tasks";

export function CalendarDayDialog({ date, tasks, assets, entities, onClose, onEnterDay, onPreview, onOpenEntity }: { date: string; tasks: readonly RecordView[]; assets: readonly Asset[]; entities: readonly Entity[]; onClose: () => void; onEnterDay: () => void; onPreview: (ids: readonly string[], index: number) => void; onOpenEntity: (entity: Entity) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const closeOnClick = useRef(false);
  const [state, setState] = useState<{ date: string; records?: readonly RecordView[]; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    const trigger = document.activeElement, dialog = ref.current, previous = document.body.style.overflow;
    dialog?.showModal(); document.body.style.overflow = "hidden";
    return () => { dialog?.close(); document.body.style.overflow = previous; if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setState(null);
    apiRequest<RecordsResponse>(`/api/records?date=${encodeURIComponent(date)}&timeZone=${encodeURIComponent(USER_TIME_ZONE)}`, { signal: controller.signal })
      .then(payload => { if (!controller.signal.aborted) setState({ date, records: payload.items.filter(r => r.kind !== "task").slice().reverse() }); })
      .catch(() => { if (!controller.signal.aborted) setState({ date, error: "当天记录暂时无法读取" }); });
    return () => controller.abort();
  }, [date, retry]);
  const reminders = calendarTasksForDate(tasks, date);
  const outside = (e: { clientX: number; clientY: number; target: EventTarget; currentTarget: EventTarget }) => {
    const r = ref.current?.getBoundingClientRect(); return r !== undefined && e.target === e.currentTarget && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  const noop = () => {};
  return <dialog ref={ref} className="modal-dialog calendar-day-dialog" aria-labelledby="calendar-day-dialog-title" onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }}
    onPointerDown={e => { e.stopPropagation(); closeOnClick.current = false; start.current = e.isPrimary && e.button === 0 && outside(e) ? { x: e.clientX, y: e.clientY, pointerId: e.pointerId } : null; }}
    onPointerMove={e => { const s = start.current; if (s && (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6 || !outside(e))) start.current = null; }}
    onPointerUp={e => { const s = start.current; start.current = null; closeOnClick.current = Boolean(s && e.isPrimary && e.button === 0 && s.pointerId === e.pointerId && outside(e) && Math.hypot(e.clientX - s.x, e.clientY - s.y) <= 6); }} onPointerCancel={() => { start.current = null; closeOnClick.current = false; }}
    onClick={e => { e.stopPropagation(); if (closeOnClick.current && outside(e)) { closeOnClick.current = false; onClose(); } }}>
    <div className="dialog-header"><h2 id="calendar-day-dialog-title">{displayDate(date)}</h2><button type="button" className="icon-button compact-icon-button" aria-label="关闭当天浮卡" onClick={onClose}><X size={17} /></button></div>
    <div className="dialog-body calendar-day-dialog-body">
      {reminders.length > 0 ? <section className="calendar-day-tasks" aria-label="当天待办"><h3>待办</h3><ul>{reminders.map(t => <li key={t.id}><span className={`calendar-task-circle ${t.kind === "task" && t.task.status === "done" ? "is-done" : ""}`} aria-hidden="true" /><div><span className="calendar-task-full-text">{t.body.edited ?? t.body.original}</span><small>{calendarTaskStatus(t)}</small></div></li>)}</ul></section> : null}
      <section className="calendar-day-records" aria-label="当天时间轴"><h3>记录</h3>
        {state?.date !== date ? <p role="status">正在读取当天记录…</p> : state.error ? <div><p role="alert">{state.error}</p><button type="button" className="secondary-button" onClick={() => setRetry(v => v + 1)}>重试</button></div> : state.records?.length === 0 ? <p className="muted">这一天没有留下记录</p> : state.records?.map(record => <TimelineItem key={record.id} record={record} assets={assets} entities={entities} movieEnabled={false} moviePromptHidden={true} onMovieAttachToRecord={noop} onMoviePromptSuppress={noop} onEdit={noop} onDelete={noop} onTaskStatus={noop} onPreviewAsset={onPreview} onOpenEntity={onOpenEntity} interactionDisabled={false} />)}
      </section>
    </div>
    <div className="calendar-day-dialog-footer"><button className="secondary-button" type="button" onClick={onEnterDay}>进入当天</button><button className="secondary-button" type="button" onClick={onClose}>关闭</button></div>
  </dialog>;
}
