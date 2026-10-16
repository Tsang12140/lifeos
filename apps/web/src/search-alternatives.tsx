import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Entity } from "@lifeos/core";
import { apiRequest, type RecordView } from "./api";
import { errorMessage } from "./app-meta";
import type { SearchFilters } from "./search-filters";
import { SearchAssistantHint } from "./search-assistant-hint";
import "./search-alternatives.css";

interface Match { recordId: string; matched: number; total: number; missing: { entityId: string; entityType: string }[]; }
interface NearResponse { items: RecordView[]; matches: Match[]; total: number; nextOffset: number | null; }
interface Props {
  queryPath: string; filters: SearchFilters; entities: readonly Entity[];
  privacyShown: boolean; hideDemo: boolean;
  exactCount: number | null; ready: boolean; exactContent: ReactNode;
  renderRecord: (record: RecordView) => ReactNode;
  onApply: (filters: SearchFilters) => void; onAskAssistant: () => void;
}

// Mounted with the search/visibility/version key: stale pages and responses
// cannot carry across a new query, privacy setting, account or record mutation.
export function SearchAlternatives({ queryPath, filters, entities, privacyShown, hideDemo, exactCount, ready, exactContent, renderRecord, onApply, onAskAssistant }: Props) {
  const [near, setNear] = useState(false), [page, setPage] = useState<NearResponse | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState({ offset: 0, retry: 0 });
  const activeRequest = useRef(0);
  const capsuleCount = filters.personIds.length + filters.placeIds.length + filters.entityIds.length;
  const available = capsuleCount > 1;
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController(), id = ++activeRequest.current;
    const params = new URLSearchParams(queryPath.split("?")[1]);
    params.set("entityMatch", "near"); params.set("limit", "20"); params.set("offset", String(request.offset));
    if (privacyShown) params.set("includePrivate", "1");
    if (hideDemo) params.set("hideDemo", "1");
    setLoading(true); setError(null);
    apiRequest<NearResponse>(`/api/records?${params}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || id !== activeRequest.current) return;
      setPage(previous => request.offset === 0 || !previous ? result : {
        ...result,
        items: [...previous.items, ...result.items.filter(item => !previous.items.some(old => old.id === item.id))],
        matches: [...previous.matches, ...result.matches.filter(item => !previous.matches.some(old => old.recordId === item.recordId))],
      });
    }).catch(cause => {
      if (!controller.signal.aborted && id === activeRequest.current) setError(errorMessage(cause, "接近结果暂时无法读取"));
    }).finally(() => {
      if (!controller.signal.aborted && id === activeRequest.current) setLoading(false);
    });
    return () => controller.abort();
  }, [queryPath, privacyShown, hideDemo, available, request]);
  const relax = (missing: Match["missing"]) => onApply({ ...filters,
    personIds: filters.personIds.filter(id => !missing.some(item => item.entityId === id && item.entityType === "person")),
    placeIds: filters.placeIds.filter(id => !missing.some(item => item.entityId === id && item.entityType === "place")),
    entityIds: filters.entityIds.filter(id => !missing.some(item => item.entityId === id && item.entityType === "")),
  });
  const showHint = ready && (near ? page !== null && !loading && !error && page.total < 3 : exactCount !== null && exactCount < 3);
  const hint = showHint ? <SearchAssistantHint onAskAssistant={onAskAssistant} /> : null;
  return <div className="search-results-view">
    {available ? <div className="search-result-modes" role="group" aria-label="搜索结果范围">
      <button type="button" aria-pressed={!near} onClick={() => setNear(false)}>全部符合{ready && exactCount !== null ? ` ${exactCount}` : ""}</button>
      <button type="button" aria-pressed={near} onClick={() => setNear(true)}>接近结果{page ? ` ${page.total}` : loading ? "…" : ""}</button>
    </div> : null}
    {near ? <section className="search-near-results" aria-label="接近结果" aria-busy={loading || undefined}>
      <p className="search-near-explanation">按符合条件的数量排序，同分时较新的记录在前。</p>
      {loading ? <p role="status">正在查找接近结果…</p> : null}
      {error ? <div className="search-near-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRequest(previous => ({ ...previous, retry: previous.retry + 1 }))}>重试</button></div> : null}
      {page?.items.map(record => {
        const score = page.matches.find(item => item.recordId === record.id)!;
        const names = score.missing.map(item => entities.find(entity => entity.id === item.entityId)?.name ?? "已删除的对象").join("、");
        return <div className="search-near-item" key={record.id} data-record-id={record.id} data-matched={score.matched} data-total={score.total}>
          <div className="search-near-match"><span>符合 {score.matched}/{score.total}，缺少 {names}</span><button type="button" disabled={loading} onClick={() => relax(score.missing)}>{score.missing.length === 1 ? `不限定 ${names}` : "移除缺少的条件"}</button></div>
          {renderRecord(record)}
        </div>;
      })}
      {page && page.total === 0 && !loading && !error ? <p className="search-near-empty">暂时没有部分符合这些条件的记录</p> : null}
      {page?.nextOffset !== null && page?.nextOffset !== undefined ? <div className="search-near-more"><button type="button" disabled={loading} onClick={() => setRequest({ offset: page.nextOffset!, retry: 0 })}>查看更多</button></div> : null}
    </section> : exactContent}
    {hint}
  </div>;
}
