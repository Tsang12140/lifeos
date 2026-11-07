import { isDreamRecord } from "@lifeos/core";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Asset, UiOffer } from "@lifeos/core";
import { X } from "lucide-react";
import { apiRequest, type RecordView } from "./api";
import { AssetPreview, assetContentUrl } from "./timeline";
import { sanitizeNoteHtml } from "./note-html";
import { lifeTimeDate } from "./time";
import { lockDialogScroll } from "./dialog-scroll-lock";
import { sourceNumber } from "./assistant-citations-model";
import "./assistant-source-reader.css";

interface Selection { offer: UiOffer; trigger: HTMLElement; host: HTMLElement }
interface PreviewData { id: string; kind: string; nature?: "dream"; revision: number; title: string; date: string; excerpt: string }
interface SourceData { record: RecordView; assets: readonly Asset[] }
const SourceContext = createContext<{ hover: (offer: UiOffer, trigger: HTMLElement) => void; leave: () => void; open: (offer: UiOffer, trigger: HTMLElement) => void; selected: UiOffer | null } | null>(null);
export const useAssistantSources = () => useContext(SourceContext);
const same = (a: UiOffer | null, b: UiOffer) => a?.command.type === "record.focus" && b.command.type === "record.focus" && a.command.params.recordId === b.command.params.recordId;
const sourcePath = (offer: UiOffer) => "/api/ai/assistant/sources/" + encodeURIComponent(offer.command.type === "record.focus" ? offer.command.params.recordId : "");
const sourceDate = (value: string) => value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, year: string, month: string, day: string) => `${year}年${Number(month)}月${Number(day)}日`);
const hostOf = (trigger: HTMLElement) => trigger.closest<HTMLDialogElement>("dialog[open]") ?? document.body;
const place = (node: HTMLElement, trigger: HTMLElement, reader = false) => {
  const r = trigger.getBoundingClientRect(), p = node.getBoundingClientRect(), edge = reader ? 16 : 12;
  // clientWidth/clientHeight 不含滚动条：用 innerWidth 会把面板右缘推到滚动条底下，看上去像被切掉一截。
  const viewWidth = document.documentElement.clientWidth, viewHeight = document.documentElement.clientHeight;
  const panel = trigger.closest(".ai-assistant-panel,.assistant-history-dialog")?.getBoundingClientRect() ?? r;
  let x = (reader ? panel.right : r.right) + (reader ? 16 : 8), y = reader ? panel.top : r.top - p.height - 8;
  if (!reader && x + p.width > viewWidth - edge) x = r.left - p.width - 8;
  if (!reader && y < edge) y = r.bottom + 8;
  node.style.left = `${Math.max(edge, Math.min(x, viewWidth - p.width - edge))}px`;
  node.style.top = `${Math.max(edge, Math.min(y, viewHeight - p.height - edge))}px`;
};

export function AssistantSourceProvider({ children, onEnter }: { children: ReactNode; onEnter?: ((record: RecordView) => void) | undefined }) {
  const [preview, setPreview] = useState<Selection | null>(null), [reading, setReading] = useState<Selection | null>(null);
  const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopTimers = () => { clearTimeout(opening.current); clearTimeout(closing.current); };
  const dismiss = () => { stopTimers(); setPreview(null); };
  const leave = () => { clearTimeout(opening.current); clearTimeout(closing.current); closing.current = setTimeout(() => setPreview(null), 200); };
  const open = (offer: UiOffer, trigger: HTMLElement) => { dismiss(); setReading({ offer, trigger, host: hostOf(trigger) }); };
  useEffect(() => {
    const selected = reading ?? preview; if (!selected) return;
    const check = () => { if (!selected.trigger.isConnected || (selected.host instanceof HTMLDialogElement && !selected.host.open) || selected.trigger.closest('[aria-hidden="true"],[inert]')) { dismiss(); setReading(null); } };
    const observer = new MutationObserver(check); observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "inert", "aria-hidden"] });
    return () => observer.disconnect();
  }, [reading, preview]);
  useEffect(() => {
    const scroll = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest(".assistant-source-hover,.assistant-source-reader")) dismiss(); };
    const close = () => { dismiss(); setReading(null); };
    addEventListener("scroll", scroll, true); addEventListener("hashchange", close); addEventListener("lifeos:close-ai", close); addEventListener("lifeos:private-ai-access", close);
    return () => { stopTimers(); removeEventListener("scroll", scroll, true); removeEventListener("hashchange", close); removeEventListener("lifeos:close-ai", close); removeEventListener("lifeos:private-ai-access", close); };
  }, []);
  return <SourceContext.Provider value={{ hover: (offer, trigger) => {
    if (reading || matchMedia("(max-width:900px),(hover:none)").matches) return;
    stopTimers(); opening.current = setTimeout(() => setPreview({ offer, trigger, host: hostOf(trigger) }), 110);
  }, leave, open, selected: reading?.offer ?? preview?.offer ?? null }}>
    {children}
    {preview ? <SourceHover key={sourcePath(preview.offer)} selection={preview} onKeep={() => clearTimeout(closing.current)} onLeave={leave} onDismiss={dismiss} onOpen={() => open(preview.offer, preview.trigger)} /> : null}
    {reading ? <SourceReader selection={reading} onClose={() => setReading(null)} onEnter={onEnter} /> : null}
  </SourceContext.Provider>;
}

function SourceHover({ selection, onKeep, onLeave, onDismiss, onOpen }: { selection: Selection; onKeep: () => void; onLeave: () => void; onDismiss: () => void; onOpen: () => void }) {
  const ref = useRef<HTMLDivElement>(null), [data, setData] = useState<PreviewData | null>(null), [error, setError] = useState(false);
  useEffect(() => { const controller = new AbortController(); apiRequest<PreviewData>(sourcePath(selection.offer) + "?preview=1", { signal: controller.signal }).then(setData).catch(() => { if (!controller.signal.aborted) setError(true); }); return () => controller.abort(); }, [selection.offer]);
  useLayoutEffect(() => { const node = ref.current!; node.showPopover(); place(node, selection.trigger); const reposition = () => place(node, selection.trigger); addEventListener("resize", reposition); const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onDismiss(); } }; document.addEventListener("keydown", key, true); return () => { removeEventListener("resize", reposition); document.removeEventListener("keydown", key, true); }; }, []);
  useLayoutEffect(() => { if (ref.current) place(ref.current, selection.trigger); }, [data, error]);
  const quote = data && data.revision === selection.offer.source?.revision ? selection.offer.source.excerpt : data?.excerpt;
  return createPortal(<div ref={ref} popover="manual" className="assistant-source-hover" role="dialog" aria-label="引用原文预览" onPointerEnter={onKeep} onPointerLeave={onLeave} onContextMenu={event => event.stopPropagation()}>
    <button type="button" className="assistant-source-hover-open" onClick={onOpen} disabled={error}>
      {error ? <span role="status">这条来源已删除或暂时不可查看</span> : !data ? <span role="status">正在读取原文…</span> : <><span className="assistant-source-meta">{sourceDate(data.date)} {data.nature === "dream" ? "梦境" : data.kind === "note" ? "笔记" : "日记"}</span>{data.title ? <span className="assistant-source-preview-title">{data.title}</span> : null}<span className="assistant-source-excerpt">{quote || "这条记录包含照片，点击查看全文"}</span></>}
    </button>
  </div>, selection.host);
}

function SourceReader({ selection, onClose, onEnter }: { selection: Selection; onClose: () => void; onEnter?: ((record: RecordView) => void) | undefined }) {
  const ref = useRef<HTMLDialogElement | HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), [data, setData] = useState<SourceData | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0), [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width:900px)").matches);
  const latest = useRef(selection); latest.current = selection;
  useEffect(() => { const query = matchMedia("(max-width:900px)"), change = () => setMobile(query.matches); query.addEventListener("change", change); return () => query.removeEventListener("change", change); }, []);
  useEffect(() => {
    setData(null); setError(false); setPhotoIndex(null); const controller = new AbortController();
    apiRequest<SourceData>(sourcePath(selection.offer), { signal: controller.signal }).then(setData).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [selection.offer, retry]);
  useLayoutEffect(() => {
    const node = ref.current!;
    const resize = () => {
      if (node instanceof HTMLDialogElement) { node.style.width = `${Math.min(680, innerWidth)}px`; node.style.maxWidth = `${innerWidth}px`; }
      else place(node, latest.current.trigger, true);
    };
    let observer: ResizeObserver | undefined;
    if (node instanceof HTMLDialogElement) { resize(); node.showModal(); }
    // 面板高度现在跟着内容走：正文、照片陆续到达会改高，位置要跟着重算，否则会被夹在屏幕外。
    else { node.showPopover(); resize(); observer = new ResizeObserver(resize); observer.observe(node); }
    const unlock = lockDialogScroll(); node.querySelector<HTMLButtonElement>(".assistant-source-close")?.focus({ preventScroll: true });
    addEventListener("resize", resize);
    return () => { observer?.disconnect(); removeEventListener("resize", resize); if (node instanceof HTMLDialogElement) node.close(); unlock(); if (latest.current.trigger.isConnected) latest.current.trigger.focus({ preventScroll: true }); };
  }, [mobile, selection.host]);
  useEffect(() => {
    let outside = false;
    const isOtherModal = (target: EventTarget | null) => target instanceof Element && !!target.closest("dialog:modal") && !ref.current?.contains(target) && target.closest("dialog:modal") !== selection.host;
    const down = (event: PointerEvent) => { outside = !ref.current?.contains(event.target as Node) && !isOtherModal(event.target); };
    const click = (event: MouseEvent) => {
      if (mobile || !outside || isOtherModal(event.target) || ref.current?.contains(event.target as Node) || (event.target instanceof Element && event.target.closest(".assistant-citation"))) return;
      event.preventDefault(); event.stopPropagation(); onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || mobile || document.querySelector(".asset-preview") || (document.activeElement && isOtherModal(document.activeElement))) return;
      event.preventDefault(); event.stopPropagation(); onClose();
    };
    document.addEventListener("pointerdown", down, true); document.addEventListener("click", click, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); };
  }, [mobile, onClose, selection.host]);
  const record = data?.record, text = record ? record.body.edited ?? record.body.original : "";
  const quote = record && selection.offer.source && record.revision === selection.offer.source.revision ? selection.offer.source.excerpt : "";
  const html = useMemo(() => record?.kind === "note" && record.note?.html ? sanitizeNoteHtml(record.note.html) : null, [record]);
  useLayoutEffect(() => {
    const root = body.current; if (!root || !record) return;
    if (quote && html) {
      // Mark only original text nodes; never parse a model string as markup.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes: Text[] = []; let node;
      while ((node = walker.nextNode())) nodes.push(node as Text);
      const combined = nodes.map(n => n.data).join("");
      const positions: number[] = []; let compact = "";
      for (let i = 0; i < combined.length; i++) if (!/\s/.test(combined[i]!)) { compact += combined[i]; positions.push(i); }
      const needle = quote.replace(/\s/g, ""), found = needle ? compact.indexOf(needle) : -1;
      const start = found < 0 ? -1 : positions[found]!, end = found < 0 ? -1 : positions[found + needle.length - 1]! + 1; let offset = 0;
      if (start >= 0) for (const n of nodes) {
        const from = Math.max(0, start - offset), to = Math.min(n.length, end - offset); offset += n.length;
        if (to <= from) continue;
        const range = document.createRange(); range.setStart(n, from); range.setEnd(n, to); const mark = document.createElement("mark"); mark.className = "assistant-source-highlight"; range.surroundContents(mark);
      }
    }
    const marked = root.querySelector<HTMLElement>(".assistant-source-highlight"), scroll = root.closest<HTMLElement>(".assistant-source-scroll");
    if (marked && scroll) scroll.scrollTop = Math.max(0, marked.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 24);
  }, [record, quote, html]);
  const photos = data?.assets.filter(asset => asset.kind === "photo") ?? [];
  const gallery = photos.filter(photo => !html || (!html.includes(photo.id) && !html.includes(encodeURIComponent(photo.id))));
  const content = <>
    <header className="assistant-source-header"><div className="assistant-source-heading"><h2>引用原文</h2><span className="assistant-source-number" aria-label={`引用编号 ${sourceNumber(selection.offer)}`}>{sourceNumber(selection.offer)}</span></div><button type="button" className="assistant-source-close" aria-label="关闭引用原文" onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <div className="assistant-source-scroll">
      {error ? <div role="alert"><p>这条来源已删除或当前不可查看。</p><button className="secondary-button" type="button" onClick={() => setRetry(v => v + 1)}>重试</button></div> : !record ? <p role="status">正在读取原文…</p> : <>
        <p className="assistant-source-meta">{sourceDate(lifeTimeDate(record.occurredAt ?? record.createdAt) ?? "")} {isDreamRecord(record) ? "梦境" : record.kind === "note" ? "笔记" : "日记"}</p>
        {record.kind === "note" && record.note?.title ? <h3 className="assistant-source-title">{record.note.title}</h3> : null}
        {selection.offer.source && record.revision !== selection.offer.source.revision ? <p className="assistant-source-updated">原记录已更新，当前显示最新内容。</p> : null}
        <div ref={body} className="assistant-source-body" onClick={event => { if (event.target instanceof HTMLImageElement) { const i = photos.findIndex(a => event.target instanceof HTMLImageElement && event.target.src.includes(encodeURIComponent(a.id))); if (i >= 0) setPhotoIndex(i); } }}>
          {html ? <div className="assistant-source-rich" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="assistant-source-copy">{quote && text.includes(quote) ? <>{text.slice(0, text.indexOf(quote))}<mark className="assistant-source-highlight">{quote}</mark>{text.slice(text.indexOf(quote) + quote.length)}</> : text}</p>}
        </div>
        {gallery.length ? <div className="assistant-source-photos" data-count={Math.min(3, gallery.length)}>{gallery.slice(0, 3).map((photo, index) => { const rest = gallery.length - 3, folded = index === 2 && rest > 0, position = photos.indexOf(photo); return <button type="button" key={photo.id} aria-label={folded ? `查看全部照片，另有 ${rest} 张` : `查看照片 ${position + 1}`} onClick={() => setPhotoIndex(position)}><img src={assetContentUrl(photo.id)} alt={`原文照片 ${position + 1}`} loading="lazy" />{folded ? <span className="assistant-source-photos-more" aria-hidden="true">+{rest}</span> : null}</button>; })}</div> : null}
      </>}
    </div>
    <footer className="assistant-source-footer"><button className="secondary-button" type="button" onClick={onClose}>返回对话</button><button className="primary-button assistant-source-enter" type="button" disabled={!record || !onEnter} onClick={() => { if (record) { onClose(); onEnter?.(record); } }}>打开原记录</button></footer>
  </>;
  return <>{createPortal(mobile ? <dialog ref={node => { ref.current = node; }} className="assistant-source-reader is-mobile" aria-label="引用原文" onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>{content}</dialog> : <div ref={node => { ref.current = node; }} popover="manual" role="dialog" className="assistant-source-reader" aria-label="引用原文">{content}</div>, selection.host)}{photoIndex !== null && data ? createPortal(<AssetPreview assetIds={photos.map(p => p.id)} assets={data.assets} index={photoIndex} onIndexChange={setPhotoIndex} onClose={() => setPhotoIndex(null)} />, document.body) : null}</>;
}

export function SourceNumber({ offer, disabled = false }: { offer: UiOffer; disabled?: boolean }) {
  const context = useAssistantSources();
  return <button type="button" className="assistant-citation" aria-label={`查看来源 ${sourceNumber(offer)}`} aria-haspopup="dialog" aria-expanded={same(context?.selected ?? null, offer)} disabled={disabled || !context} onPointerEnter={event => { if (event.pointerType !== "touch") context?.hover(offer, event.currentTarget); }} onPointerLeave={() => context?.leave()} onFocus={event => { if (event.currentTarget.matches(":focus-visible")) context?.hover(offer, event.currentTarget); }} onBlur={() => context?.leave()} onClick={event => context?.open(offer, event.currentTarget)}>{sourceNumber(offer)}</button>;
}
