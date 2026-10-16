import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, Share2 } from "lucide-react";
import { useActionMenu } from "./action-menu";
import { clampFixedMenuPosition } from "./menu-position";
import { assistantMessageTime } from "./assistant-message-time";
import "./assistant-message-meta.css";

export function AssistantMessageTime({ at }: { readonly at?: string }) {
  const label = assistantMessageTime(at);
  return label ? <time className="assistant-message-time" dateTime={at}>{label}</time> : null;
}

export function useAssistantMessageInfo() {
  const [info, setInfo] = useState<{ x: number; y: number; at?: string; text: string; onShare: () => void; host: Element } | null>(null);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useActionMenu(ref, info !== null, () => setInfo(null));
  useLayoutEffect(() => {
    if (!ref.current || !info) return;
    const rect = ref.current.getBoundingClientRect();
    const position = clampFixedMenuPosition(info.x, info.y, rect.width, rect.height, innerWidth, innerHeight);
    ref.current.style.left = `${position.x}px`; ref.current.style.top = `${position.y}px`;
  }, [info]);
  const openMessageInfo = (event: MouseEvent, at: string | undefined, text: string, onShare: () => void) => {
    event.preventDefault(); event.stopPropagation(); setError("");
    setInfo({ x: event.clientX, y: event.clientY, at, text, onShare, host: (event.target as Element).closest("dialog") ?? document.body });
  };
  const messageInfo = info ? createPortal(<div className="ai-assistant-menu assistant-message-info" ref={ref} role="menu" aria-label="消息操作" style={{ position: "fixed", left: info.x, top: info.y }} onContextMenu={event => event.preventDefault()}>
    {info.at ? <p className="assistant-message-info-time">{assistantMessageTime(info.at)}</p> : null}
    <button type="button" role="menuitem" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(info.text)).then(() => setInfo(null)).catch(() => setError("复制失败，请选择正文后手动复制")); }}><Copy size={14} /><span>复制文字</span></button>
    <button type="button" role="menuitem" onClick={() => { setInfo(null); info.onShare(); }}><Share2 size={14} /><span>分享对话</span></button>
    {error ? <p role="status">{error}</p> : null}
  </div>, info.host) : null;
  return { openMessageInfo, messageInfo, closeMessageInfo: () => setInfo(null) };
}
