import { useMobileAssistantPage } from "./use-mobile-assistant-page";
import { assistantLogoPath } from "./assistant-logo-path";
import type { ComposerProps } from "./composer";
import type { Entity, UiCommand, UiTurnPlan } from "@lifeos/core";
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, History, MoreHorizontal, Settings2, X } from "lucide-react";
import { AssistantBackfill, type AssistantBackfillHandle } from "./assistant-backfill";
import type { AiStatus } from "./api";
import { gearFromStatus } from "./api";
import { scopedKey } from "./storage-scope";

interface AIAssistantProps { readonly photoInput: Pick<ComposerProps, "onUploadShot" | "onNotify" | "onShotsCleared">; readonly status: AiStatus; readonly onOpenSettings: () => void; readonly visible?: boolean; readonly desktopDocked?: boolean; readonly scope: string; readonly onOpenEntity: (entity: Entity) => void; readonly onChanged: () => void; readonly onViewRecords: (ids: readonly string[]) => void; readonly onUiPlan: (plan: UiTurnPlan) => void; readonly onUiCommand: (command: UiCommand) => void; readonly privacyRequest: { readonly reason: string } | null; readonly onPrivacyDecision: (decision: "once" | "session" | "never") => void; readonly privacyVisible?: boolean; }
interface LauncherPosition { readonly x: number; readonly y: number; }
const LAUNCHER_POSITION_KEY = scopedKey("lifeos.ai.launcher-position.v1");
const LAUNCHER_SIZE = 56;
const LAUNCHER_EDGE = 12;
function constrainLauncherPosition(x: number, y: number): LauncherPosition {
  const maxX = Math.max(LAUNCHER_EDGE, window.innerWidth - LAUNCHER_SIZE - LAUNCHER_EDGE);
  // On a phone the last 64px are the solid bottom navigation. Keep the
  // launcher 12px above that rail, whatever position a previous drag saved.
  const reservedBottom = window.matchMedia("(max-width: 900px)").matches
    ? (document.querySelector(".mobile-nav")?.getBoundingClientRect().height || 64) + LAUNCHER_EDGE
    : LAUNCHER_EDGE;
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
  return <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="ai-logo-svg"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#60A5FA" /><stop offset="100%" stopColor="#3370FF" /></linearGradient></defs><path d={assistantLogoPath} fill={`url(#${gradientId})`} /></svg>;
}


export function AIAssistant({ photoInput, status, onOpenSettings, visible = true, desktopDocked = false, scope, onChanged, onViewRecords, onOpenEntity, onUiPlan, onUiCommand, privacyRequest, onPrivacyDecision, privacyVisible = false }: AIAssistantProps) {
  const backfillRef = useRef<AssistantBackfillHandle>(null);
  const panelRef = useRef<HTMLElement>(null);
  const mobileBackRef = useRef<HTMLButtonElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [inputFocusRequested, setInputFocusRequested] = useState(false);
  useEffect(() => setInputFocusRequested(false), [scope]);
  const [desktopLayout, setDesktopLayout] = useState(() => window.matchMedia("(min-width: 901px)").matches);
  const docked = desktopDocked && desktopLayout;
  const expanded = docked || open;
  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const update = () => setDesktopLayout(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [launcherPosition, setLauncherPosition] = useState<LauncherPosition | null>(restoreLauncherPosition);
  const [draggingLauncher, setDraggingLauncher] = useState(false);
  const launcherDragRef = useRef<{ readonly pointerId: number; readonly offsetX: number; readonly offsetY: number; readonly startX: number; readonly startY: number; moved: boolean } | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const openingClickCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => openingClickCleanupRef.current?.(), [scope, visible]);
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


  const close = () => { setOpen(false); setInputFocusRequested(false); };
  const openAssistant = () => setOpen(true);
  const mobilePageOpen = visible && expanded && !desktopLayout;
  useMobileAssistantPage(mobilePageOpen, panelRef, mobileBackRef, launcherRef, close);
  const beginLauncherDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // Touch drags may never emit the synthetic click that normally consumes
    // this flag. A new gesture must still be able to open the assistant.
    if (!desktopLayout) suppressLauncherClickRef.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    launcherDragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (desktopLayout) setDraggingLauncher(true);
  };
  const moveLauncher = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = launcherDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 4 || Math.abs(event.clientY - drag.startY) > 4) drag.moved = true;
    if (!drag.moved && !desktopLayout) return;
    setDraggingLauncher(true);
    if (!desktopLayout) event.currentTarget.style.setProperty("--ai-launcher-lift", "0px");
    setLauncherPosition(constrainLauncherPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY));
  };
  const endLauncherDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = launcherDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved) suppressLauncherClickRef.current = true;
    // Captured touch pointers are not guaranteed to produce a compatibility
    // click. Complete a stationary tap here; any later click is idempotent.
    if (!desktopLayout && !drag.moved && event.pointerType === "touch" && event.type === "pointerup") {
      // A fullscreen page replaces the button under this finger. Consume only
      // this gesture's compatibility click so it cannot focus the new textarea.
      openingClickCleanupRef.current?.();
      const x = event.clientX, y = event.clientY;
      const cleanup = () => {
        document.removeEventListener("mousedown", swallowClick, true);
        document.removeEventListener("click", swallowClick, true);
        document.removeEventListener("pointerdown", cleanup, true);
        window.clearTimeout(timer);
        if (openingClickCleanupRef.current === cleanup) openingClickCleanupRef.current = null;
      };
      const swallowClick = (click: MouseEvent) => {
        if (!click.isTrusted || Math.hypot(click.clientX - x, click.clientY - y) > 16) return;
        click.preventDefault(); click.stopImmediatePropagation();
        if (click.type === "click") cleanup();
      };
      const timer = window.setTimeout(cleanup, 700);
      openingClickCleanupRef.current = cleanup;
      // Focus is the mousedown default action, which precedes click.
      document.addEventListener("mousedown", swallowClick, true);
      document.addEventListener("click", swallowClick, true);
      // A fresh gesture is intentional, even if the browser sent no old click.
      document.addEventListener("pointerdown", cleanup, { capture: true, once: true });
      openAssistant();
    }
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
  /**
   * The assistant's own commands must not shut the assistant.
   *
   * Desktop search keeps the docked rail. On a narrow window the same event
   * keeps the floating conversation, clarification and offer buttons open
   * while the assistant applies a filter or navigates.
   */
  useEffect(() => {
    const keepInFront = (event: Event) => {
      openAssistant();
      if (event instanceof CustomEvent && event.detail?.focusInput === true) setInputFocusRequested(true);
    };
    window.addEventListener("lifeos:open-ai", keepInFront);
    return () => window.removeEventListener("lifeos:open-ai", keepInFront);
  }, []);


  if (!visible) return null;
  return <>
    {open && !docked ? <button className="ai-assistant-backdrop" type="button" aria-label="关闭 AI 助手背景" onClick={close} /> : null}
    <section ref={panelRef} role={mobilePageOpen ? "dialog" : undefined} aria-modal={mobilePageOpen ? true : undefined} className={`ai-assistant-panel has-backfill ${expanded ? "is-open" : ""} ${docked ? "is-docked" : ""}`} aria-hidden={!expanded} inert={!expanded} aria-label="AI 助手">
      <header className="ai-assistant-header" onContextMenu={(event) => { event.preventDefault(); backfillRef.current?.openMenu(event.clientX, event.clientY); }}><button className="ai-header-icon ai-mobile-back" type="button" ref={mobileBackRef} onClick={close} aria-label="返回记录页面"><ArrowLeft size={20} aria-hidden="true" /></button><div className="ai-assistant-title"><span className="ai-assistant-logo"><AssistantLogo /></span><div><strong>AI管家</strong></div></div><div className="ai-assistant-actions"><button className="ai-header-icon" type="button" onClick={() => backfillRef.current?.openHistory()} aria-label="聊天记录"><History size={17} aria-hidden="true" /></button>{!docked ? <button className="ai-header-icon" type="button" aria-haspopup="menu" aria-label="更多操作" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); backfillRef.current?.openMenu(rect.right - 12, rect.bottom + 6); }}><MoreHorizontal size={17} aria-hidden="true" /></button> : null}{!status.configured ? <button className="ai-header-icon" type="button" onClick={onOpenSettings} aria-label="AI 助手设置"><Settings2 size={17} aria-hidden="true" /></button> : null}{!docked ? <button className="ai-header-icon ai-desktop-close" type="button" onClick={close} aria-label="关闭 AI 助手"><X size={17} aria-hidden="true" /></button> : null}</div></header>
      <AssistantBackfill ref={backfillRef} photoInput={photoInput} key={scope} scope={scope} configured={status.configured} defaultGear={gearFromStatus(status)} onChanged={onChanged} onViewRecords={onViewRecords} onOpenEntity={onOpenEntity} onOpenSettings={onOpenSettings} onUiPlan={onUiPlan} onUiCommand={onUiCommand} privacyRequest={privacyRequest} onPrivacyDecision={onPrivacyDecision} privacyVisible={privacyVisible} focusRequested={inputFocusRequested} onFocusHandled={() => setInputFocusRequested(false)} />
    </section>
    <button ref={launcherRef} className={`ai-assistant-launcher ${expanded ? "is-hidden" : ""} ${draggingLauncher ? "is-dragging" : ""}`} type="button" aria-hidden={expanded} tabIndex={expanded ? -1 : 0} style={launcherPosition === null ? undefined : { left: `${launcherPosition.x}px`, top: `${launcherPosition.y}px`, right: "auto", bottom: "auto" }} onPointerDown={beginLauncherDrag} onPointerMove={moveLauncher} onPointerUp={endLauncherDrag} onPointerCancel={endLauncherDrag} onClick={activateLauncher} aria-label="打开 AI 助手，可拖拽移动"><AssistantLogo /></button>
  </>;
}
