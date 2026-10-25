import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, Eraser, MessageSquarePlus, Share2 } from "lucide-react";
import { useActionMenu } from "./action-menu";
import { clampFixedMenuPosition } from "./menu-position";
import { assistantMessageTime } from "./assistant-message-time";
import { AssistantPrivacyMenuItems } from "./assistant-privacy-menu";
import type { PrivacyAccessState } from "./privacy-access-control";
import "./assistant-message-meta.css";

export function AssistantMessageTime({ at }: { readonly at?: string }) {
  const label = assistantMessageTime(at);
  return label ? <time className="assistant-message-time" dateTime={at}>{label}</time> : null;
}

/**
 * The conversation-wide actions, so that a right-click anywhere in the assistant
 * — including on a message — offers the same set. Optional on purpose: the
 * history dialog opens this menu too, and it has no "current conversation" to
 * clear, so it keeps the read-only two items.
 */
export interface AssistantMenuExtras {
  readonly onClearScreen: () => void;
  readonly onNewConversation: () => void;
  readonly actionsDisabled: boolean;
  /** 正文上右键走的是这份菜单（消息区自己 stopPropagation），所以「检索私密」也得挂在这里。 */
  readonly privacyAccess?: PrivacyAccessState;
  readonly privacyDisabled?: boolean;
}

export function useAssistantMessageInfo(extras?: AssistantMenuExtras) {
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
    {extras ? <hr className="ai-assistant-menu-divider" /> : null}
    {extras ? <button type="button" role="menuitem" disabled={extras.actionsDisabled} onClick={() => { setInfo(null); extras.onClearScreen(); }}><Eraser size={14} aria-hidden="true" /><span>清屏</span></button> : null}
    {extras ? <button type="button" role="menuitem" disabled={extras.actionsDisabled} onClick={() => { setInfo(null); extras.onNewConversation(); }}><MessageSquarePlus size={14} aria-hidden="true" /><span>新对话</span></button> : null}
    {extras?.privacyAccess ? <hr className="ai-assistant-menu-divider" /> : null}
    {extras?.privacyAccess ? <AssistantPrivacyMenuItems access={extras.privacyAccess} disabled={extras.privacyDisabled} onBeforeUnlock={() => setInfo(null)} /> : null}
    {error ? <p role="status">{error}</p> : null}
  </div>, info.host) : null;
  return { openMessageInfo, messageInfo, closeMessageInfo: () => setInfo(null) };
}
