import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, Check, ChevronLeft, ClipboardCopy, History, LoaderCircle, Settings2, Square, X } from "lucide-react";
import type { AiStatus, AssistantReply } from "./api";

interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly mode?: "ai" | "rules";
}

interface StoredChat {
  readonly savedAt: number;
  readonly messages: readonly ChatMessage[];
}

interface AIAssistantProps {
  readonly status: AiStatus;
  readonly onOpenSettings: () => void;
}

interface LauncherPosition { readonly x: number; readonly y: number; }

const STORAGE_KEY = "lifeos.ai.chat";
const LAUNCHER_POSITION_KEY = "lifeos.ai.launcher-position.v1";
const CHAT_SESSION_TTL_MS = 30 * 60 * 1000;
const QUICK_PROMPTS = ["今天有什么记录？", "最近有哪些任务？", "这周主要发生了什么？"] as const;
const LAUNCHER_SIZE = 56;
const LAUNCHER_EDGE = 12;

function constrainLauncherPosition(x: number, y: number): LauncherPosition {
  const maxX = Math.max(LAUNCHER_EDGE, window.innerWidth - LAUNCHER_SIZE - LAUNCHER_EDGE);
  // On a phone the last 64px are the solid bottom navigation. Keep the
  // launcher 12px above that rail, whatever position a previous drag saved.
  const reservedBottom = window.matchMedia("(max-width: 900px)").matches ? 76 : LAUNCHER_EDGE;
  const maxY = Math.max(LAUNCHER_EDGE, window.innerHeight - LAUNCHER_SIZE - reservedBottom);
  return { x: Math.min(maxX, Math.max(LAUNCHER_EDGE, x)), y: Math.min(maxY, Math.max(LAUNCHER_EDGE, y)) };
}

function restoreLauncherPosition(): LauncherPosition | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAUNCHER_POSITION_KEY) ?? "null") as Partial<LauncherPosition> | null;
    const x = value?.x;
    const y = value?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return constrainLauncherPosition(x, y);
  } catch {
    return null;
  }
}

function AssistantLogo() {
  const gradientId = `lifeos-ai-logo-${useId().replace(/:/g, "")}`;
  return <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="ai-logo-svg"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#60A5FA" /><stop offset="100%" stopColor="#3370FF" /></linearGradient></defs><path d="M512 0c282.773333 0 512 229.226667 512 512S794.773333 1024 512 1024 0 794.773333 0 512 229.226667 0 512 0z m-0.021333 170.666667c-19.818667 0-39.829333 4.010667-58.773334 12.394666a141.866667 141.866667 0 0 0-65.344 58.026667l-197.973333 336.938667-1.237333 2.154666c-37.845333 67.029333-14.122667 151.786667 53.717333 190.272 68.565333 38.890667 156.245333 15.786667 195.818667-51.584l104.682666-178.176h0.106667l27.904-46.805333a75.157333 75.157333 0 0 1 63.744-41.130667 75.456 75.456 0 0 1 67.498667 34.88l1.152 1.877334 71.701333 122.026666 1.002667 1.770667c19.242667 35.456 6.08 79.509667-29.610667 99.136-35.690667 19.605333-80.789333 7.552-101.44-27.114667l-59.114667 33.536 1.28 2.133334c40.149333 65.706667 126.698667 87.893333 194.538667 49.408l2.154667-1.258667 2.282666-1.344 2.090667-1.322667 2.730667-1.792 1.962666-1.344 3.072-2.197333 1.258667-0.917333a141.653333 141.653333 0 0 0 11.626667-9.770667l4.224-4.117333a140.970667 140.970667 0 0 0 23.509333-31.829334l1.002667-1.856c1.045333-1.984 2.005333-3.989333 2.944-6.016l1.450666-3.242666c2.730667-6.378667 4.992-12.928 6.762667-19.626667l0.597333-2.325333 0.512-2.154667c0.426667-1.92 0.853333-3.882667 1.194667-5.824l0.682667-3.925333a137.472 137.472 0 0 0-5.802667-65.834667l-0.896-2.602667a142.293333 142.293333 0 0 0-10.901333-23.082666l-197.973334-336.917334-1.28-2.133333a141.866667 141.866667 0 0 0-64.085333-55.914667l-4.202667-1.792A144.64 144.64 0 0 0 511.978667 170.666667z m0.832 67.072c10.410667 0.128 20.693333 2.368 30.186666 6.592 14.293333 6.336 26.197333 16.938667 34.026667 30.293333l65.216 111.018667a144.661333 144.661333 0 0 0-75.626667 18.837333 141.504 141.504 0 0 0-57.045333 59.904l-0.512-0.298667-129.984 221.226667-1.066667 1.770667c-21.632 34.069333-67.050667 44.906667-102.165333 24.32a73.066667 73.066667 0 0 1-26.837333-99.84l197.973333-336.917334 1.066667-1.749333c6.506667-10.453333 15.573333-19.136 26.410666-25.258667l1.792-0.981333a76.586667 76.586667 0 0 1 36.565334-8.917333z" fill={`url(#${gradientId})`} /></svg>;
}

function welcomeMessage(configured: boolean): ChatMessage {
  return { id: "welcome", role: "assistant", mode: "rules", text: configured ? "可以问我今天的记录、任务和生活主题。隐私记录不会被发送。" : "我可以先帮你查看记录和任务。配置 AI 服务后，还能做更完整的自然语言分析。" };
}

function restoreMessages(configured: boolean): readonly ChatMessage[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as StoredChat | null;
    if (stored === null || !Number.isFinite(stored.savedAt) || Date.now() - stored.savedAt > CHAT_SESSION_TTL_MS || !Array.isArray(stored.messages)) return [welcomeMessage(configured)];
    const messages = stored.messages.filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.text === "string");
    return messages.length > 0 ? messages : [welcomeMessage(configured)];
  } catch {
    return [welcomeMessage(configured)];
  }
}

export function AIAssistant({ status, onOpenSettings }: AIAssistantProps) {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [messages, setMessages] = useState<readonly ChatMessage[]>(() => restoreMessages(status.configured));
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [launcherPosition, setLauncherPosition] = useState<LauncherPosition | null>(restoreLauncherPosition);
  const [draggingLauncher, setDraggingLauncher] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const launcherDragRef = useRef<{ readonly pointerId: number; readonly offsetX: number; readonly offsetY: number; readonly startX: number; readonly startY: number; moved: boolean } | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const history = useMemo(() => messages.filter((message) => message.id !== "welcome").slice(-8).map((message) => ({ role: message.role, text: message.text })), [messages]);

  useEffect(() => { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), messages } satisfies StoredChat)); }, [messages]);
  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, showHistory]);
  useEffect(() => {
    try {
      if (launcherPosition === null) window.localStorage.removeItem(LAUNCHER_POSITION_KEY);
      else window.localStorage.setItem(LAUNCHER_POSITION_KEY, JSON.stringify(launcherPosition));
    } catch { /* storage is an optional convenience */ }
  }, [launcherPosition]);
  useEffect(() => {
    if (launcherPosition === null) return;
    const keepInBounds = () => setLauncherPosition((current) => current === null ? null : constrainLauncherPosition(current.x, current.y));
    window.addEventListener("resize", keepInBounds);
    return () => window.removeEventListener("resize", keepInBounds);
  }, [launcherPosition]);

  const copyMessage = async (message: ChatMessage) => {
    try { await navigator.clipboard.writeText(message.text); setCopiedId(message.id); window.setTimeout(() => setCopiedId(null), 1600); } catch { /* clipboard permissions are optional */ }
  };

  const ask = async (value: string) => {
    const message = value.trim();
    if (!message || loading) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text: message }]);
    setInput("");
    setLoading(true);
    try {
      const response = await fetch("/api/ai/assistant", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ message, history, pageUrl: window.location.pathname }), signal: controller.signal });
      const payload = await response.json() as Partial<AssistantReply> & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "AI 助手暂时不可用，请稍后再试。");
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", mode: payload.mode, text: payload.reply ?? "暂时没有得到回答。" }]);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", mode: "rules", text: error instanceof Error ? error.message : "查询出错了，请稍后再试。" }]);
    } finally { abortControllerRef.current = null; setLoading(false); }
  };

  const stopAsk = () => abortControllerRef.current?.abort();
  const clear = () => { setMessages([welcomeMessage(status.configured)]); setShowHistory(false); setInput(""); };
  const close = () => { setOpen(false); setShowHistory(false); setShowSetupGuide(false); };
  const openAssistant = () => { setOpen(true); setShowSetupGuide(!status.configured); };
  const beginLauncherDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    launcherDragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingLauncher(true);
  };
  const moveLauncher = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = launcherDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 4 || Math.abs(event.clientY - drag.startY) > 4) drag.moved = true;
    setLauncherPosition(constrainLauncherPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY));
  };
  const endLauncherDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = launcherDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved) suppressLauncherClickRef.current = true;
    launcherDragRef.current = null;
    setDraggingLauncher(false);
  };
  const activateLauncher = () => {
    if (suppressLauncherClickRef.current) {
      suppressLauncherClickRef.current = false;
      return;
    }
    openAssistant();
  };
  useEffect(() => {
    const closeForSettings = () => close();
    window.addEventListener("lifeos:close-ai", closeForSettings);
    return () => window.removeEventListener("lifeos:close-ai", closeForSettings);
  }, []);

  return <>
    {open ? <button className="ai-assistant-backdrop" type="button" aria-label="关闭 AI 助手背景" onClick={close} /> : null}
    <section className={`ai-assistant-panel ${open ? "is-open" : ""}`} aria-hidden={!open} inert={!open} aria-label="AI 助手">
      <header className="ai-assistant-header"><div className="ai-assistant-title"><span className="ai-assistant-logo"><AssistantLogo /></span><div><strong>AI管家</strong><small>用一句话回顾你的生活</small></div></div><div className="ai-assistant-actions">{showHistory ? <button className="ai-header-pill" type="button" onClick={() => setShowHistory(false)}><ChevronLeft size={13} aria-hidden="true" />返回</button> : <button className="ai-header-pill" type="button" onClick={() => setShowHistory(true)}><History size={13} aria-hidden="true" />历史</button>}<button className="ai-header-icon" type="button" onClick={close} aria-label="关闭 AI 助手"><X size={17} aria-hidden="true" /></button></div></header>
      {showSetupGuide && !status.configured ? <div className="ai-setup-guide"><span className="ai-setup-icon"><Settings2 size={18} aria-hidden="true" /></span><strong>配置 AI 助手</strong><p>配置 DeepSeek API Key 后，可以根据 LifeOS 的记录、任务和关联对象做更完整的回顾。隐私记录不会发送。</p><button className="ai-setup-button" type="button" onClick={onOpenSettings}>去设置查看 <ArrowRight size={16} aria-hidden="true" /></button><button className="ai-setup-secondary" type="button" onClick={() => setShowSetupGuide(false)}>先使用本地模式</button></div> : null}
      {showHistory ? <div className="ai-assistant-history"><div className="ai-history-note">最近 30 分钟的本地对话</div>{messages.filter((message) => message.id !== "welcome").length === 0 ? <div className="ai-empty-history">还没有历史对话</div> : messages.filter((message) => message.id !== "welcome").map((message) => <div className="ai-history-item" key={message.id}><small>{message.role === "user" ? "我" : "AI"}</small><span>{message.text}</span></div>)}</div> : <div className="ai-assistant-messages">{messages.map((message) => <div className={`ai-message-row ${message.role === "user" ? "is-user" : "is-assistant"}`} key={message.id}>{message.role === "user" ? <div className="ai-user-message"><span>{message.text}</span><button className="ai-copy-button" type="button" onClick={() => void copyMessage(message)} aria-label="复制问题">{copiedId === message.id ? <Check size={11} aria-hidden="true" /> : <ClipboardCopy size={11} aria-hidden="true" />}</button></div> : <div className="ai-assistant-message"><span>{message.text}</span><div className="ai-message-tools"><button className="ai-copy-button" type="button" onClick={() => void copyMessage(message)} aria-label="复制回答">{copiedId === message.id ? <Check size={11} aria-hidden="true" /> : <ClipboardCopy size={11} aria-hidden="true" />}</button>{message.mode === "ai" ? <em>AI</em> : null}</div></div>}</div>)}{loading ? <div className="ai-message-row is-assistant"><div className="ai-loading"><LoaderCircle className="spin" size={14} aria-hidden="true" /><span>正在整理你的 LifeOS…</span></div></div> : null}<div ref={chatBottomRef} /></div>}
      {!showHistory ? <div className="ai-assistant-footer"><div className="ai-quick-prompts">{QUICK_PROMPTS.map((prompt) => <button type="button" key={prompt} onClick={() => void ask(prompt)} disabled={loading}>{prompt}</button>)}</div><form className="ai-assistant-composer" onSubmit={(event) => { event.preventDefault(); void ask(input); }}><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(input); } }} placeholder="输入你想了解的内容" rows={1} aria-label="询问 AI 助手" />{loading ? <button className="ai-send-button is-stop" type="button" onClick={stopAsk} aria-label="停止"><Square size={15} fill="currentColor" strokeWidth={0} /></button> : <button className="ai-send-button" type="submit" disabled={!input.trim()} aria-label="发送">发送</button>}<button className="ai-collapse-button" type="button" onClick={close} aria-label="收起 AI 助手"><AssistantLogo /></button></form></div> : null}
    </section>
    <button className={`ai-assistant-launcher ${open ? "is-hidden" : ""} ${draggingLauncher ? "is-dragging" : ""}`} type="button" style={launcherPosition === null ? undefined : { left: `${launcherPosition.x}px`, top: `${launcherPosition.y}px`, right: "auto", bottom: "auto" }} onPointerDown={beginLauncherDrag} onPointerMove={moveLauncher} onPointerUp={endLauncherDrag} onPointerCancel={endLauncherDrag} onClick={activateLauncher} aria-label="打开 AI 助手，可拖拽移动"><AssistantLogo /></button>
  </>;
}
