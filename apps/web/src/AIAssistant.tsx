import type { ComposerProps } from "./composer";
import type { Entity, UiCommand, UiTurnPlan } from "@lifeos/core";
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { History, MoreHorizontal, Settings2, X } from "lucide-react";
import { AssistantBackfill, type AssistantBackfillHandle } from "./assistant-backfill";
import type { AiStatus } from "./api";

interface AIAssistantProps { readonly photoInput: Pick<ComposerProps, "onUploadShot" | "onNotify" | "onShotsCleared">; readonly status: AiStatus; readonly onOpenSettings: () => void; readonly visible?: boolean; readonly desktopDocked?: boolean; readonly scope: string; readonly onOpenEntity: (entity: Entity) => void; readonly onChanged: () => void; readonly onViewRecords: (ids: readonly string[]) => void; readonly onUiPlan: (plan: UiTurnPlan) => void; readonly onUiCommand: (command: UiCommand) => void; readonly privacyRequest: { readonly reason: string } | null; readonly onPrivacyDecision: (decision: "once" | "session" | "never") => void; readonly privacyVisible?: boolean; }
interface LauncherPosition { readonly x: number; readonly y: number; }
const LAUNCHER_POSITION_KEY = "lifeos.ai.launcher-position.v1";
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
  return <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="ai-logo-svg"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#60A5FA" /><stop offset="100%" stopColor="#3370FF" /></linearGradient></defs><path d="M512 0c282.773333 0 512 229.226667 512 512S794.773333 1024 512 1024 0 794.773333 0 512 229.226667 0 512 0z m-0.021333 170.666667c-19.818667 0-39.829333 4.010667-58.773334 12.394666a141.866667 141.866667 0 0 0-65.344 58.026667l-197.973333 336.938667-1.237333 2.154666c-37.845333 67.029333-14.122667 151.786667 53.717333 190.272 68.565333 38.890667 156.245333 15.786667 195.818667-51.584l104.682666-178.176h0.106667l27.904-46.805333a75.157333 75.157333 0 0 1 63.744-41.130667 75.456 75.456 0 0 1 67.498667 34.88l1.152 1.877334 71.701333 122.026666 1.002667 1.770667c19.242667 35.456 6.08 79.509667-29.610667 99.136-35.690667 19.605333-80.789333 7.552-101.44-27.114667l-59.114667 33.536 1.28 2.133334c40.149333 65.706667 126.698667 87.893333 194.538667 49.408l2.154667-1.258667 2.282666-1.344 2.090667-1.322667 2.730667-1.792 1.962666-1.344 3.072-2.197333 1.258667-0.917333a141.653333 141.653333 0 0 0 11.626667-9.770667l4.224-4.117333a140.970667 140.970667 0 0 0 23.509333-31.829334l1.002667-1.856c1.045333-1.984 2.005333-3.989333 2.944-6.016l1.450666-3.242666c2.730667-6.378667 4.992-12.928 6.762667-19.626667l0.597333-2.325333 0.512-2.154667c0.426667-1.92 0.853333-3.882667 1.194667-5.824l0.682667-3.925333a137.472 137.472 0 0 0-5.802667-65.834667l-0.896-2.602667a142.293333 142.293333 0 0 0-10.901333-23.082666l-197.973334-336.917334-1.28-2.133333a141.866667 141.866667 0 0 0-64.085333-55.914667l-4.202667-1.792A144.64 144.64 0 0 0 511.978667 170.666667z m0.832 67.072c10.410667 0.128 20.693333 2.368 30.186666 6.592 14.293333 6.336 26.197333 16.938667 34.026667 30.293333l65.216 111.018667a144.661333 144.661333 0 0 0-75.626667 18.837333 141.504 141.504 0 0 0-57.045333 59.904l-0.512-0.298667-129.984 221.226667-1.066667 1.770667c-21.632 34.069333-67.050667 44.906667-102.165333 24.32a73.066667 73.066667 0 0 1-26.837333-99.84l197.973333-336.917334 1.066667-1.749333c6.506667-10.453333 15.573333-19.136 26.410666-25.258667l1.792-0.981333a76.586667 76.586667 0 0 1 36.565334-8.917333z" fill={`url(#${gradientId})`} /></svg>;
}


export function AIAssistant({ photoInput, status, onOpenSettings, visible = true, desktopDocked = false, scope, onChanged, onViewRecords, onOpenEntity, onUiPlan, onUiCommand, privacyRequest, onPrivacyDecision, privacyVisible = false }: AIAssistantProps) {
  const backfillRef = useRef<AssistantBackfillHandle>(null);
  const [open, setOpen] = useState(false);
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


  const close = () => setOpen(false);
  const openAssistant = () => setOpen(true);
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
    if (!desktopLayout && !drag.moved && event.pointerType === "touch" && event.type === "pointerup") openAssistant();
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
    const keepInFront = () => openAssistant();
    window.addEventListener("lifeos:open-ai", keepInFront);
    return () => window.removeEventListener("lifeos:open-ai", keepInFront);
  }, []);


  if (!visible) return null;
  return <>
    {open && !docked ? <button className="ai-assistant-backdrop" type="button" aria-label="关闭 AI 助手背景" onClick={close} /> : null}
    <section className={`ai-assistant-panel has-backfill ${expanded ? "is-open" : ""} ${docked ? "is-docked" : ""}`} aria-hidden={!expanded} inert={!expanded} aria-label="AI 助手">
      <header className="ai-assistant-header" onContextMenu={(event) => { event.preventDefault(); backfillRef.current?.openMenu(event.clientX, event.clientY); }}><div className="ai-assistant-title"><span className="ai-assistant-logo"><AssistantLogo /></span><div><strong>AI管家</strong></div></div><div className="ai-assistant-actions"><button className="ai-header-icon" type="button" onClick={() => backfillRef.current?.openHistory()} aria-label="聊天记录"><History size={17} aria-hidden="true" /></button>{!docked ? <button className="ai-header-icon" type="button" aria-haspopup="menu" aria-label="更多操作" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); backfillRef.current?.openMenu(rect.right - 12, rect.bottom + 6); }}><MoreHorizontal size={17} aria-hidden="true" /></button> : null}{!status.configured ? <button className="ai-header-icon" type="button" onClick={onOpenSettings} aria-label="AI 助手设置"><Settings2 size={17} aria-hidden="true" /></button> : null}{!docked ? <button className="ai-header-icon" type="button" onClick={close} aria-label="关闭 AI 助手"><X size={17} aria-hidden="true" /></button> : null}</div></header>
      <AssistantBackfill ref={backfillRef} photoInput={photoInput} key={scope} scope={scope} configured={status.configured} onChanged={onChanged} onViewRecords={onViewRecords} onOpenEntity={onOpenEntity} onOpenSettings={onOpenSettings} onUiPlan={onUiPlan} onUiCommand={onUiCommand} privacyRequest={privacyRequest} onPrivacyDecision={onPrivacyDecision} privacyVisible={privacyVisible} />
    </section>
    <button className={`ai-assistant-launcher ${expanded ? "is-hidden" : ""} ${draggingLauncher ? "is-dragging" : ""}`} type="button" aria-hidden={expanded} tabIndex={expanded ? -1 : 0} style={launcherPosition === null ? undefined : { left: `${launcherPosition.x}px`, top: `${launcherPosition.y}px`, right: "auto", bottom: "auto" }} onPointerDown={beginLauncherDrag} onPointerMove={moveLauncher} onPointerUp={endLauncherDrag} onPointerCancel={endLauncherDrag} onClick={activateLauncher} aria-label="打开 AI 助手，可拖拽移动"><AssistantLogo /></button>
  </>;
}
