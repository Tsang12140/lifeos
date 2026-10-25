import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { renderAssistantShareCanvas, type AssistantShareArtwork } from "./assistant-share-image";
import { shareMessageDisplayText, type ShareMessage, type ShareRedaction } from "./assistant-share-model";

interface Props {
  readonly messages: readonly ShareMessage[];
  readonly artwork: AssistantShareArtwork;
  readonly preview: string;
  readonly redactions: readonly ShareRedaction[];
  readonly imageCache: Map<string, Promise<HTMLImageElement | null>>;
  readonly locked: boolean;
  readonly saveHelp: boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly onApply: (masks: readonly ShareRedaction[], canvas: HTMLCanvasElement) => Promise<boolean>;
}

/** The selectable leaves use the very same positions and UTF-16 offsets as the canvas. */
export function AssistantSharePreview({ messages, artwork, preview, redactions, imageCache, locked, saveHelp, onEditingChange, onApply }: Props) {
  const stage = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null), canvasElement = useRef<HTMLCanvasElement>(null);
  const [candidate, setCandidate] = useState<ShareRedaction | null>(null);
  const [live, setLive] = useState<HTMLCanvasElement | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [undo, setUndo] = useState<readonly (readonly ShareRedaction[])[]>([]);
  const pointerDown = useRef(false), selectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), counter = useRef(0);
  const version = useRef(0), mounted = useRef(true), liveRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; clearTimeout(selectionTimer.current); if (liveRef.current) { liveRef.current.width = 1; liveRef.current.height = 1; } }; }, []);
  useEffect(() => { onEditingChange(Boolean(candidate) || busy); }, [candidate, busy, onEditingChange]);
  useLayoutEffect(() => {
    const node = stage.current; if (!node) return;
    const resize = () => node.style.setProperty("--share-scale", String(node.clientWidth / artwork.layout.width));
    resize(); const observer = new ResizeObserver(resize); observer.observe(node); return () => observer.disconnect();
  }, [artwork.layout.width]);
  useEffect(() => {
    if (!candidate) { if (liveRef.current) { liveRef.current.width = 1; liveRef.current.height = 1; liveRef.current = null; } setLive(null); return; }
    const token = ++version.current;
    setBusy(true); setError("");
    const timer = setTimeout(() => {
      const masks = [...redactions.filter(mask => mask.id !== candidate.id), candidate];
      void renderAssistantShareCanvas(messages, masks, new Date(artwork.generatedAt), imageCache).then(canvas => {
        if (!mounted.current || token !== version.current) { canvas.width = 1; canvas.height = 1; return; }
        if (liveRef.current) { liveRef.current.width = 1; liveRef.current.height = 1; }
        liveRef.current = canvas; setLive(canvas);
      }).catch(reason => { if (mounted.current && token === version.current) setError(reason instanceof Error ? reason.message : "遮挡预览生成失败"); })
        .finally(() => { if (mounted.current && token === version.current) setBusy(false); });
    }, 60);
    return () => { clearTimeout(timer); version.current++; };
  }, [candidate, messages, redactions, artwork.generatedAt, imageCache]);
  useLayoutEffect(() => {
    const target = canvasElement.current; if (!target || !live) return;
    target.width = live.width; target.height = live.height; target.getContext("2d")?.drawImage(live, 0, 0);
  }, [live]);
  useLayoutEffect(() => {
    if (!candidate || !toolbar.current || !stage.current) return;
    const place = () => {
      const leaf = [...stage.current!.querySelectorAll<HTMLElement>("[data-share-start]")].find(node => node.dataset.message === candidate.messageId && Number(node.dataset.shareEnd) > candidate.start && Number(node.dataset.shareStart) < candidate.end);
      if (!leaf) return;
      const range = document.createRange();
      range.setStart(leaf.firstChild!, Math.max(0, candidate.start - Number(leaf.dataset.shareStart)));
      range.setEnd(leaf.firstChild!, Math.min(leaf.textContent!.length, candidate.end - Number(leaf.dataset.shareStart)));
      const anchor = range.getBoundingClientRect(), panel = toolbar.current!.getBoundingClientRect();
      const dialog = stage.current!.closest("dialog")!.getBoundingClientRect();
      const left = Math.max(dialog.left + 12, Math.min(anchor.left, dialog.right - panel.width - 12));
      const below = anchor.bottom + 10, above = anchor.top - panel.height - 10;
      const top = Math.max(dialog.top + 60, Math.min(below + panel.height <= dialog.bottom - 85 ? below : above, dialog.bottom - panel.height - 85));
      setPosition({ left, top });
    };
    place(); const observer = new ResizeObserver(place); observer.observe(toolbar.current);
    window.addEventListener("resize", place); document.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [candidate]);
  const cancel = () => { version.current++; setCandidate(null); setLive(null); setBusy(false); setError(""); window.getSelection()?.removeAllRanges(); };
  useEffect(() => {
    if (!candidate) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !locked) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    document.addEventListener("keydown", escape, true); return () => document.removeEventListener("keydown", escape, true);
  }, [candidate, locked]);
  useEffect(() => {
    const select = () => {
      if (pointerDown.current || locked || saveHelp) return;
      const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      const leaf = (node: Node) => (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element)?.closest<HTMLElement>("[data-share-start]");
      const first = leaf(range.startContainer), last = leaf(range.endContainer);
      if (!first || !last || !stage.current?.contains(first) || !stage.current.contains(last)) return;
      if (first.dataset.message !== last.dataset.message) { setError("请在同一条消息内选择文字"); return; }
      const messageId = first.dataset.message!, message = messages.find(item => item.id === messageId); if (!message) return;
      const text = shareMessageDisplayText(message);
      // Browsers may place a boundary at the next span with offset 0 rather than
      // at the end of the previous text node. Count its actual prefix in both cases.
      const prefix = (element: HTMLElement, node: Node, offset: number) => {
        const portion = document.createRange(); portion.setStart(element, 0); portion.setEnd(node, offset); return portion.toString().length;
      };
      let start = Number(first.dataset.shareStart) + prefix(first, range.startContainer, range.startOffset);
      let end = Number(last.dataset.shareStart) + prefix(last, range.endContainer, range.endOffset);
      for (const { segment, index } of new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(text)) {
        if (index < start && start < index + segment.length) start = index;
        if (index < end && end < index + segment.length) end = index + segment.length;
      }
      for (const item of artwork.layout.items.filter(item => item.messageId === messageId && /^\[[1-6]\]$/.test(item.text))) {
        if (start < item.end && end > item.start) { start = Math.min(start, item.start); end = Math.max(end, item.end); }
      }
      if (end <= start || !text.slice(start, end).trim()) return;
      const existing = redactions.find(mask => mask.messageId === messageId && mask.start < end && mask.end > start);
      setCandidate(existing ?? { id: `share-inline-${++counter.current}`, messageId, start, end, mode: "blur", strength: 10 });
      selection.removeAllRanges();
    };
    const changed = () => { clearTimeout(selectionTimer.current); selectionTimer.current = setTimeout(select, 200); };
    const released = () => { pointerDown.current = false; changed(); };
    document.addEventListener("selectionchange", changed); document.addEventListener("pointerup", released); document.addEventListener("pointercancel", released);
    return () => { clearTimeout(selectionTimer.current); document.removeEventListener("selectionchange", changed); document.removeEventListener("pointerup", released); document.removeEventListener("pointercancel", released); };
  }, [messages, redactions, artwork.layout, locked, saveHelp]);
  const commit = async (next: readonly ShareRedaction[], remember = true) => {
    if (busy || locked) return;
    setBusy(true); setError("");
    let rendered: HTMLCanvasElement | null = null;
    try {
      // Render from the current masks, never from a possibly stale slider frame.
      rendered = await renderAssistantShareCanvas(messages, next, new Date(artwork.generatedAt), imageCache);
      const accepted = await onApply(next, rendered);
      if (!mounted.current) return;
      if (accepted) { if (remember) setUndo(items => [...items, redactions]); else setUndo(items => items.slice(0, -1)); setCandidate(null); setLive(null); }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "遮挡应用失败"); }
    finally { if (rendered) { rendered.width = 1; rendered.height = 1; } if (mounted.current) setBusy(false); }
  };
  const existing = Boolean(candidate && redactions.some(mask => mask.id === candidate.id));
  return <div className="assistant-share-preview-stage">
    <div className="assistant-share-preview-tools"><span>选中文字即可遮挡</span><button type="button" disabled={!undo.length || busy || locked || Boolean(candidate)} onClick={() => void commit(undo.at(-1)!, false)}>撤销</button></div>
    <div className="assistant-share-paper" ref={stage}>
      <img className="assistant-share-preview" src={preview} alt="选中对话的图片预览" draggable={false} />
      {candidate && live ? <canvas ref={canvasElement} className="assistant-share-live-preview" aria-label="遮挡效果实时预览" /> : null}
      {!saveHelp ? <div className="assistant-share-text-layer" aria-label="在图片正文中选择文字" onPointerDown={() => { pointerDown.current = true; }} onClick={event => {
        if (locked || busy || window.getSelection()?.toString()) return;
        const leaf = (event.target as HTMLElement).closest<HTMLElement>("[data-share-start]"); if (!leaf) return;
        const start = Number(leaf.dataset.shareStart), end = Number(leaf.dataset.shareEnd);
        for (const mask of redactions.filter(mask => mask.messageId === leaf.dataset.message && mask.start < end && mask.end > start)) {
          const range = document.createRange(); range.setStart(leaf.firstChild!, Math.max(0, mask.start - start)); range.setEnd(leaf.firstChild!, Math.min(end - start, mask.end - start));
          const r = range.getBoundingClientRect(); if (event.clientX >= r.left - 3 && event.clientX <= r.right + 3) { setCandidate(mask); break; }
        }
      }} onContextMenu={event => { if (window.getSelection()?.toString()) event.preventDefault(); }}>
        {artwork.layout.items.map((item, index) => <span key={index} data-message={item.messageId} data-share-start={item.start} data-share-end={item.end} className="assistant-share-text-leaf" style={{ left: item.x, top: item.y, width: item.width, height: Math.max(item.height, 16), font: item.font, letterSpacing: item.tracking, lineHeight: `${Math.max(item.height, 16)}px` }}>{item.text}</span>)}
      </div> : null}
    </div>
    {candidate ? <div ref={toolbar} className="assistant-share-mask-toolbar" role="group" aria-label="调整选中文字的遮挡" style={position as CSSProperties} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      <select aria-label="遮挡样式" value={candidate.mode} disabled={locked} onChange={event => setCandidate({ ...candidate, mode: event.target.value as ShareRedaction["mode"] })}><option value="blur">高斯模糊</option><option value="block">灰黑遮挡</option></select>
      {candidate.mode === "blur" ? <label className="assistant-share-blur-control"><input type="range" min="2" max="16" step="1" value={candidate.strength} aria-label="模糊程度" disabled={locked} onChange={event => setCandidate({ ...candidate, strength: Number(event.currentTarget.value) })} /><output>{candidate.strength}px</output></label> : null}
      <div className="assistant-share-mask-actions"><button type="button" disabled={busy || locked || Boolean(error)} className="is-primary" onClick={() => void commit([...redactions.filter(mask => mask.id !== candidate.id), candidate])}>应用</button>{existing ? <button type="button" disabled={busy || locked} onClick={() => void commit(redactions.filter(mask => mask.id !== candidate.id))}>移除</button> : null}<button type="button" disabled={locked} onClick={cancel}>取消</button></div>
    </div> : null}
    {error ? <p className="assistant-share-error" role="alert">{error}</p> : null}
  </div>;
}
