import type { PhotoPreviewHandler } from "./asset-preview-model";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Asset, Entity } from "@lifeos/core";
import { apiRequest, type RecordsResponse, type RecordView } from "./api";
import { displayDate, lifeTimeDate } from "./time";
import { TimelineItem } from "./timeline";
import type { SearchFilters } from "./search-filters";
import { lockDialogScroll } from "./dialog-scroll-lock";
import "./record-peek.css";

/** Shared with the calendar: reading stays local until an explicit enter action. */
export function RecordPeekFrame({ title, closeLabel = "关闭记录预览", className = "", onClose, children, footer }: { title: string; closeLabel?: string; className?: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useLayoutEffect(() => {
    const trigger = document.activeElement, dialog = ref.current;
    dialog?.showModal(); const unlock = lockDialogScroll();
    return () => { dialog?.close(); unlock(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`modal-dialog calendar-day-dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClose={event => { event.stopPropagation(); onClose(); }}>
    <div className="dialog-header"><h2 id={titleId} className="calendar-day-dialog-title">{title}</h2><button type="button" className="icon-button compact-icon-button" aria-label={closeLabel} onClick={onClose}><X size={17} aria-hidden="true" /></button></div>
    <div className="dialog-body calendar-day-dialog-body">{children}</div>
    <div className="calendar-day-dialog-footer">{footer}</div>
  </dialog>;
}

export interface RecordPeekRequest {
  title: string;
  path: string;
  recordId?: string;
  recordIds?: readonly string[];
  filters?: SearchFilters;
}

export function RecordPeekDialog({ request, assets, entities, includePrivate, hideDemo, onClose, onEnter, onEnterRecord, onPreview, onOpenEntity }: { request: RecordPeekRequest; assets: readonly Asset[]; entities: readonly Entity[]; includePrivate: boolean; hideDemo: boolean; onClose: () => void; onEnter: () => void; onEnterRecord: (record: RecordView) => void; onPreview: PhotoPreviewHandler; onOpenEntity: (entity: Entity) => void }) {
  const [state, setState] = useState<{ request: RecordPeekRequest; items?: readonly RecordView[]; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setState(null);
    apiRequest<RecordsResponse | RecordView>(request.path, { signal: controller.signal })
      .then(payload => { if (!controller.signal.aborted) setState({ request, items: "items" in payload ? payload.items : [payload] }); })
      .catch(() => { if (!controller.signal.aborted) setState({ request, error: "记录暂时无法读取，可能已删除或暂时不可用" }); });
    return () => controller.abort();
  }, [request, retry]);
  const items = state?.request === request ? state.items?.filter(record => (includePrivate || record.isPrivate !== true) && (!hideDemo || record.isDemo !== true) && (!request.recordIds || request.recordIds.includes(record.id))) : undefined;
  const groups = new Map<string, RecordView[]>();
  for (const record of items ?? []) { const date = lifeTimeDate(record.occurredAt ?? record.createdAt) ?? ""; groups.set(date, [...(groups.get(date) ?? []), record]); }
  const noop = () => {};
  return <RecordPeekFrame title={request.title} className="record-peek-dialog" onClose={onClose} footer={<>{request.filters ? <button type="button" className="secondary-button" onClick={onEnter} disabled={!items?.length}>进入时间轴</button> : null}<button type="button" className="secondary-button" onClick={onClose}>关闭</button></>}>
    {state?.request !== request ? <p role="status">正在读取记录…</p> : state.error ? <div><p role="alert">{state.error}</p><button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>重试</button></div> : items?.length === 0 ? <p className="muted">暂无可显示的关联记录</p> : <>
      <p className="record-peek-count">{items?.length} 条记录</p>
      <div className="timeline-list">{[...groups].map(([date, records]) => <section className="timeline-group" key={date}><h3 className="timeline-group-title">{displayDate(date)}</h3>{records.map(record => <div className="record-peek-entry" key={record.id}>
        <TimelineItem record={record} assets={assets} entities={entities} movieEnabled={false} moviePromptHidden={true} onMovieAttachToRecord={noop} onMoviePromptSuppress={noop} onEdit={noop} onDelete={noop} onTaskStatus={noop} onPreviewAsset={(ids, index, owner) => onPreview(ids, index, owner, items ?? [])} onOpenEntity={onOpenEntity} interactionDisabled={false} />
        <div className="record-peek-jump"><button type="button" className="secondary-button" onClick={() => onEnterRecord(record)}>进入原记录</button></div>
      </div>)}</section>)}</div>
    </>}
  </RecordPeekFrame>;
}
