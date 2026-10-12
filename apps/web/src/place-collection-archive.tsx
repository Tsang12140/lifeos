import { useEffect, useState } from "react";
import type { PlaceCollectionArchive as Archive } from "@lifeos/core";
import { apiRequest } from "./api";

const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const statusText = { unrecorded: "历史地点未记录首次关联日记，无法确认来源", none: "尚未关联日记", private: "首次关联日记为隐私记录，开启隐私显示后可查看", unavailable: "首次关联日记已删除或解除关联" };

export function PlaceCollectionArchive({ id, includePrivate = false, onViewRecord }: { id: string; includePrivate?: boolean; onViewRecord: (id: string) => void }) {
  const [open, setOpen] = useState(false), [retry, setRetry] = useState(0);
  const [archive, setArchive] = useState<Archive | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    if (!open) { setArchive(null); return; }
    const controller = new AbortController(); setArchive(null); setError(false);
    apiRequest<Archive>(`/api/entities/${encodeURIComponent(id)}/collection${includePrivate ? "?includePrivate=1" : ""}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setArchive(value); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [open, id, includePrivate, retry]);
  const first = archive?.firstJournal;
  return <details className="place-collection-archive" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>收录档案</summary>
    {open ? <div className="place-collection-body">
      {error ? <><p role="status">收录档案暂时无法加载</p><button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>重试</button></> : !archive ? <p role="status">加载中…</p> : <>
        <div><small>首次收录时间（北京时间）</small><p className="place-archive-value">{archive.collectedAt ? clock.format(new Date(archive.collectedAt.value)) : "历史收录时间未记录"}</p></div>
        {first ? <details className="place-first-journal"><summary>首次关联日记</summary><div className="place-first-journal-body">
          <small>首次关联时间（北京时间）</small><time className="place-archive-value" dateTime={first.linkedAt.value}>{clock.format(new Date(first.linkedAt.value))}</time>
          <small>日记日期</small><time className="place-archive-value" dateTime={(first.occurredAt ?? first.createdAt).value}>{first.occurredAt && first.occurredAt.kind !== "instant" ? first.occurredAt.value : clock.format(new Date((first.occurredAt ?? first.createdAt).value))}</time>
          <button type="button" className="secondary-button" onClick={() => onViewRecord(first.id)}>查看首次日记</button>
        </div></details> : <p>{statusText[archive.firstJournalStatus as keyof typeof statusText] ?? "首次关联日记暂不可用"}</p>}
      </>}
    </div> : null}
  </details>;
}
