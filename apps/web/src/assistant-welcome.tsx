import { useEffect, useRef, useState } from "react";
import type { WelcomeSelection } from "@lifeos/core";
import { apiRequest } from "./api";
import "./assistant-welcome.css";

export function AssistantWelcome({ onPick, disabled, hasDraft = false }: { readonly onPick: (text: string) => void | Promise<void>; readonly disabled: boolean; readonly hasDraft?: boolean }) {
  const [selection, setSelection] = useState<WelcomeSelection | null>(null);
  const [error, setError] = useState(false), [retry, setRetry] = useState(0), [picking, setPicking] = useState(false);
  const root = useRef<HTMLElement>(null), clicked = useRef(false);
  const impression = useRef<Promise<unknown> | null>(null), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setError(false); impression.current = null;
    void apiRequest<WelcomeSelection>("/api/ai/assistant/welcome").then(value => { if (active) setSelection(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [retry]);
  const recordImpression = () => {
    if (!selection?.selectionId) return Promise.resolve();
    const element = root.current;
    // IntersectionObserver v1 alone does not account for inert/hidden panels or modal occlusion.
    if (!element || document.visibilityState !== "visible" || element.closest('[inert], [aria-hidden="true"]') || getComputedStyle(element).visibility !== "visible") return Promise.resolve();
    const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!rect.width || !rect.height || !hit || !element.contains(hit)) return Promise.resolve();
    if (impression.current === null) {
      impression.current = apiRequest("/api/ai/assistant/welcome/events", { method: "POST", body: JSON.stringify({ selectionId: selection.selectionId, type: "impression" }) }).catch(() => { impression.current = null; });
    }
    return impression.current;
  };
  useEffect(() => {
    const element = root.current;
    if (!element || !selection?.prompts.length || disabled) return;
    let visible = false, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      if (visible && document.visibilityState === "visible") timer = setTimeout(() => { void recordImpression(); }, 300);
    };
    const observer = new IntersectionObserver(entries => { visible = (entries[0]?.intersectionRatio ?? 0) >= .6; refresh(); }, { threshold: .6 });
    const panel = element.closest(".ai-assistant-panel"), mutations = new MutationObserver(refresh);
    if (panel) mutations.observe(panel, { attributes: true, attributeFilter: ["inert", "aria-hidden", "class"] });
    observer.observe(element); document.addEventListener("visibilitychange", refresh);
    return () => { observer.disconnect(); mutations.disconnect(); clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [selection, disabled]);
  const pick = (item: WelcomeSelection["prompts"][number]) => {
    if (disabled || clicked.current) return;
    clicked.current = true; setPicking(true);
    // Statistics cannot delay or prevent chatting. Sequence view -> click even on a fast tap.
    void recordImpression().then(() => selection?.selectionId ? apiRequest("/api/ai/assistant/welcome/events", { method: "POST", body: JSON.stringify({ selectionId: selection.selectionId, type: "click", promptId: item.id }) }) : undefined).catch(() => { /* non-blocking telemetry */ });
    void Promise.resolve(onPick(item.text)).finally(() => { clicked.current = false; if (mounted.current) setPicking(false); });
  };
  return <section ref={root} className="assistant-welcome" aria-label="开始聊天"><h2>今天想从哪件事聊起？</h2><div className="assistant-welcome-prompts">{selection?.prompts.map(item => <button type="button" data-prompt-id={item.id} key={item.id} disabled={disabled || picking} title={hasDraft ? "添加到现有草稿" : "发送这个问题"} onClick={() => pick(item)}>{item.text}</button>)}</div>{error ? <p className="assistant-welcome-status" role="status">开场问题暂时未加载。<button className="secondary-button" type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p> : selection === null ? <p className="assistant-welcome-status" role="status">正在挑选开场问题…</p> : null}</section>;
}
