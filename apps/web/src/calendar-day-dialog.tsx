import type { PhotoPreviewHandler } from "./asset-preview-model";
import { useEffect, useState } from "react";
import { RecordPeekFrame } from "./record-peek";
import type { Asset, Entity } from "@lifeos/core";
import { apiRequest, type RecordsResponse, type RecordView } from "./api";
import { displayDate, USER_TIME_ZONE } from "./time";
import { TimelineItem } from "./timeline";
import { calendarTasksForDate, calendarTaskStatus } from "./calendar-tasks";

export function CalendarDayDialog({ date, tasks, assets, entities, onClose, onEnterDay, onPreview, onOpenEntity }: { date: string; tasks: readonly RecordView[]; assets: readonly Asset[]; entities: readonly Entity[]; onClose: () => void; onEnterDay: () => void; onPreview: PhotoPreviewHandler; onOpenEntity: (entity: Entity) => void }) {
  const [state, setState] = useState<{ date: string; records?: readonly RecordView[]; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setState(null);
    apiRequest<RecordsResponse>(`/api/records?date=${encodeURIComponent(date)}&timeZone=${encodeURIComponent(USER_TIME_ZONE)}`, { signal: controller.signal })
      .then(payload => { if (!controller.signal.aborted) setState({ date, records: payload.items.filter(r => r.kind !== "task").slice().reverse() }); })
      .catch(() => { if (!controller.signal.aborted) setState({ date, error: "当天记录暂时无法读取" }); });
    return () => controller.abort();
  }, [date, retry]);
  const reminders = calendarTasksForDate(tasks, date);
  const noop = () => {};
  return <RecordPeekFrame title={displayDate(date)} closeLabel="关闭当天浮卡" onClose={onClose} footer={<><button className="secondary-button" type="button" onClick={onEnterDay}>进入当天</button><button className="secondary-button" type="button" onClick={onClose}>关闭</button></>}>
      {reminders.length > 0 ? <section className="calendar-day-tasks" aria-label="当天待办"><h3>待办</h3><ul>{reminders.map(t => <li key={t.id}><span className={`calendar-task-circle ${t.kind === "task" && t.task.status === "done" ? "is-done" : ""}`} aria-hidden="true" /><div><span className="calendar-task-full-text">{t.body.edited ?? t.body.original}</span><small>{calendarTaskStatus(t)}</small></div></li>)}</ul></section> : null}
      <section className="calendar-day-records" aria-label="当天时间轴"><h3>记录</h3>
        {state?.date !== date ? <p role="status">正在读取当天记录…</p> : state.error ? <div><p role="alert">{state.error}</p><button type="button" className="secondary-button" onClick={() => setRetry(v => v + 1)}>重试</button></div> : state.records?.length === 0 ? <p className="muted">这一天没有留下记录</p> : state.records?.map(record => <TimelineItem key={record.id} record={record} assets={assets} entities={entities} movieEnabled={false} moviePromptHidden={true} onMovieAttachToRecord={noop} onMoviePromptSuppress={noop} onEdit={noop} onDelete={noop} onTaskStatus={noop} onPreviewAsset={onPreview} onOpenEntity={onOpenEntity} interactionDisabled={false} />)}
      </section>
  </RecordPeekFrame>;
}
