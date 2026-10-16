import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { loadAssistantConversation } from "./assistant-history-api";
import { initialShareSelection, mergeShareMessages, needsEarlierShareWindow, type ShareMessage } from "./assistant-share-model";
import { createAssistantShareArtwork, type AssistantShareArtwork } from "./assistant-share-image";
import { copyShareImage, mobileImageSave, saveShareImage } from "./assistant-share-output";
import { lockDialogScroll } from "./dialog-scroll-lock";
import "./assistant-share.css";

export interface AssistantShareRequest {
  readonly messages: readonly ShareMessage[];
  readonly initialIndex: number;
  readonly conversationId: string | null;
}

export function AssistantShareDialog({ request, onClose }: { readonly request: AssistantShareRequest; readonly onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [messages, setMessages] = useState(request.messages);
  const [selected, setSelected] = useState(() => initialShareSelection(request.messages, request.initialIndex));
  const [busy, setBusy] = useState(false), [olderBusy, setOlderBusy] = useState(false), [error, setError] = useState("");
  const [hasOlder, setHasOlder] = useState(Boolean(request.conversationId && request.messages[0]?.seq && request.messages[0].seq > 1));
  const [preview, setPreview] = useState<string | null>(null);
  const [artwork, setArtwork] = useState<AssistantShareArtwork | null>(null);
  const [mobile, setMobile] = useState(mobileImageSave), [outputBusy, setOutputBusy] = useState(false);
  const [status, setStatus] = useState(""), [saveHelp, setSaveHelp] = useState(false);
  const [initialLoading, setInitialLoading] = useState(Boolean(hasOlder && needsEarlierShareWindow(request.messages, request.messages[request.initialIndex]?.id ?? "")));
  const alive = useRef(true), generation = useRef(0);
  useLayoutEffect(() => { alive.current = true; if (ref.current && !ref.current.open) ref.current.showModal(); const unlock = lockDialogScroll(); return () => { alive.current = false; generation.current++; unlock(); }; }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    const queries = [matchMedia("(pointer: coarse)"), matchMedia("(max-width: 900px)")];
    const update = () => setMobile(mobileImageSave()); update();
    queries.forEach(query => query.addEventListener("change", update));
    return () => queries.forEach(query => query.removeEventListener("change", update));
  }, []);
  const anchorId = request.messages[request.initialIndex]?.id ?? "";
  // Read-only pagination finishes before choosing a window or claiming "all".
  const readEarlier = async (items: readonly ShareMessage[], more: boolean, mode: "window" | "all" | "one", current: number) => {
    while (more && request.conversationId && (mode !== "window" || needsEarlierShareWindow(items, anchorId))) {
      const before = items[0]?.seq;
      if (!before) throw new Error("无法确定历史消息位置，请关闭后重试");
      const page = await loadAssistantConversation(request.conversationId, before);
      if (!alive.current || generation.current !== current) return null;
      const merged = mergeShareMessages(page.messages, items);
      more = page.hasMore;
      if (more && (!merged[0]?.seq || merged[0].seq >= before)) throw new Error("历史消息加载未完成，请重试");
      items = merged;
      if (mode === "one") break;
    }
    return { items, more };
  };
  useEffect(() => {
    if (!hasOlder || !needsEarlierShareWindow(request.messages, anchorId)) return;
    let cancelled = false;
    const current = generation.current;
    setInitialLoading(true);
    void readEarlier(request.messages, true, "window", current).then(result => {
      if (!result || cancelled) return;
      setMessages(result.items); setHasOlder(result.more);
      setSelected(initialShareSelection(result.items, result.items.findIndex(message => message.id === anchorId)));
    }).catch(e => { if (!cancelled && alive.current) setError(e instanceof Error ? e.message : "读取更早消息失败"); })
      .finally(() => { if (!cancelled && alive.current) setInitialLoading(false); });
    return () => { cancelled = true; };
    // The opening snapshot is immutable; manual selection never re-runs defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const chosen = messages.filter(message => selected.has(message.id));
  const locked = busy || olderBusy || initialLoading || outputBusy;
  const allSelected = !hasOlder && messages.length > 0 && chosen.length === messages.length;
  const close = () => { generation.current++; onClose(); };
  const generate = async () => {
    if (locked || !chosen.length) return;
    const current = ++generation.current; setBusy(true); setError(""); setStatus(""); setSaveHelp(false);
    try {
      const image = await createAssistantShareArtwork(chosen);
      if (!alive.current || generation.current !== current) return;
      setArtwork(image); setPreview(URL.createObjectURL(image.jpeg));
    } catch (e) { if (alive.current && generation.current === current) setError(e instanceof Error ? e.message : "生成图片失败，请重试"); }
    finally { if (alive.current && generation.current === current) setBusy(false); }
  };
  const loadOlder = async () => {
    if (!request.conversationId || locked || !messages[0]?.seq) return;
    const current = generation.current; setOlderBusy(true); setError("");
    try {
      const result = await readEarlier(messages, hasOlder, "one", current);
      if (!result) return;
      setMessages(result.items); setHasOlder(result.more);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "读取更早消息失败"); }
    finally { if (alive.current) setOlderBusy(false); }
  };
  const toggleAll = async () => {
    if (locked) return;
    if (allSelected) { setSelected(new Set()); return; }
    const current = generation.current; setOlderBusy(true); setError("");
    try {
      const result = await readEarlier(messages, hasOlder, "all", current);
      if (!result) return;
      setMessages(result.items); setHasOlder(result.more); setSelected(new Set(result.items.map(message => message.id)));
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "全选未完成，请重试"); }
    finally { if (alive.current) setOlderBusy(false); }
  };
  const output = async (kind: "copy" | "save") => {
    if (locked || !artwork || !preview) return;
    const current = generation.current; setOutputBusy(true); setError(""); setStatus(""); setSaveHelp(false);
    try {
      if (kind === "copy") {
        await copyShareImage(artwork.png);
        if (alive.current && generation.current === current) setStatus("图片已复制");
      } else {
        const result = await saveShareImage(artwork.jpeg, preview, artwork.generatedAt, mobileImageSave());
        if (!alive.current || generation.current !== current) return;
        if (result === "long-press") setSaveHelp(true);
        if (result === "shared") setStatus("已打开系统分享，请选择保存图片。");
      }
    } catch (e) {
      if (alive.current && generation.current === current) setError(e instanceof Error && e.name !== "NotAllowedError" ? e.message : "未能复制图片，请允许剪贴板权限或保存图片");
    } finally { if (alive.current) setOutputBusy(false); }
  };
  return createPortal(<dialog ref={ref} className="modal-dialog assistant-share-dialog" aria-labelledby="assistant-share-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <header className="assistant-share-header"><h2 id="assistant-share-title">{preview ? "图片预览" : "分享对话"}</h2><button className="icon-button" type="button" aria-label="关闭对话分享" onClick={close}><X size={18} /></button></header>
    <div className="assistant-share-body" aria-busy={locked}>
      {preview ? <img className="assistant-share-preview" src={preview} alt="选中对话的图片预览" /> : <>
        <p className="assistant-share-hint">{initialLoading ? "正在读取半小时内的对话…" : "默认勾选此前半小时的对话，可自由调整。"}</p>
        <div className="assistant-share-selection-tools"><button className="secondary-button assistant-share-toggle-all" type="button" disabled={locked} onClick={() => void toggleAll()}>{allSelected ? "取消全选" : "全选"}</button>
        {hasOlder ? <button className="secondary-button assistant-share-older" type="button" disabled={locked} onClick={() => void loadOlder()}>{olderBusy ? "正在加载…" : "加载更早消息"}</button> : null}</div>
        <div className="assistant-share-messages">{messages.map((message, index) => <label key={message.id} className={`assistant-share-choice is-${message.role}${selected.has(message.id) ? " is-selected" : ""}`}>
          <input type="checkbox" aria-label={`选择第${index + 1}条${message.role === "user" ? "我的消息" : "AI回答"}`} checked={selected.has(message.id)} disabled={locked} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })} />
          <span className="assistant-share-choice-content"><small>{message.role === "user" ? "我" : "AI管家"}</small><span className="assistant-share-choice-copy">{message.text}</span>{message.attachments?.map(attachment => <span className="assistant-share-attachment" key={attachment.assetId}>{attachment.name}</span>)}</span>
        </label>)}</div>
      </>}
    </div>
    {error || status || saveHelp ? <div className="assistant-share-feedback">
      {error ? <p role="alert" className="assistant-share-error">{error}</p> : null}
      {status ? <p role="status" className="assistant-share-status">{status}</p> : null}
      {saveHelp ? <p className="assistant-share-save-help" role="status">长按上方图片，选择存储图像或保存到相册。</p> : null}
    </div> : null}
    <footer className="assistant-share-footer"><span aria-live="polite">已选 {chosen.length} 条</span><div className="assistant-share-operations">
      {preview ? <><button className="secondary-button" type="button" disabled={locked} onClick={() => { setPreview(null); setArtwork(null); setStatus(""); setError(""); setSaveHelp(false); }}>重新选择</button><button className="secondary-button assistant-share-copy-image" type="button" disabled={locked} onClick={() => void output("copy")}>复制图片</button><button className="primary-button assistant-share-save-image" type="button" disabled={locked} onClick={() => void output("save")}>{mobile ? "保存图片" : "下载图片"}</button></> : <><button className="secondary-button" type="button" onClick={close}>取消</button><button className="primary-button" type="button" disabled={locked || !chosen.length} onClick={() => void generate()}>{busy ? "正在生成…" : "预览图片"}</button></>}
    </div></footer>
  </dialog>, document.body);
}
