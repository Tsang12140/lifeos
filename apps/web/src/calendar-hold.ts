import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent } from "react";

/** Touch/pen shortcut; native scrolling and the existing horizontal swipe win on movement. */
export function useCalendarHold(scope: string, onHold: (date: string, x: number, y: number) => void) {
  const callback = useRef(onHold);
  const gesture = useRef<{ pointerId: number; source: HTMLElement; date: string; x: number; y: number; consumed: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressContextUntil = useRef(0);
  const clearTimer = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const reset = () => { clearTimer(); gesture.current = null; };
  useLayoutEffect(() => { callback.current = onHold; });
  useLayoutEffect(() => {
    reset();
    const cancel = () => { clearTimer(); if (!gesture.current?.consumed) gesture.current = null; };
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      reset(); window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("blur", cancel); document.removeEventListener("visibilitychange", cancel);
    };
  }, [scope]);
  const activate = () => {
    const current = gesture.current;
    if (!current || current.consumed) return;
    if (!current.source.isConnected) { reset(); return; }
    clearTimer(); current.consumed = true;
    suppressContextUntil.current = Date.now() + 1500;
    // The compatibility mouse gesture may focus the date again on touch release.
    // Record that same date as the menu's origin so Escape/arrows still work.
    current.source.focus({ preventScroll: true });
    callback.current(current.date, current.x, current.y);
  };
  return {
    get consumed() { return gesture.current?.consumed === true; },
    begin(event: PointerEvent<HTMLElement>) {
      if (!event.isPrimary) { reset(); return; }
      reset();
      suppressContextUntil.current = 0;
      if (event.pointerType === "mouse" || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const cell = target?.closest<HTMLElement>(".month-cell[data-date], .week-card[data-date]");
      if (!cell || cell.getAttribute("aria-disabled") === "true" || cell.classList.contains("is-editing") || cell.classList.contains("is-outside")) return;
      if (target?.closest("input, textarea, select, a, [contenteditable=true]")) return;
      gesture.current = { pointerId: event.pointerId, source: cell, date: cell.dataset.date!, x: event.clientX, y: event.clientY, consumed: false };
      timer.current = setTimeout(activate, 500);
    },
    move(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId || current.consumed) return;
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) reset();
    },
    end(event: PointerEvent<HTMLElement>) {
      if (gesture.current?.pointerId !== event.pointerId) return;
      clearTimer(); if (!gesture.current.consumed) gesture.current = null;
    },
    cancel() { clearTimer(); if (!gesture.current?.consumed) gesture.current = null; },
    consumeClick(event: MouseEvent): boolean {
      if (!gesture.current?.consumed) return false;
      const target = event.target instanceof Element ? event.target : null;
      const pointerType = (event.nativeEvent as globalThis.PointerEvent).pointerType;
      if (target?.closest(".calendar-hold-menu, .calendar-cycle-popover") || (event.detail === 0 && pointerType !== "touch" && pointerType !== "pen")) {
        reset(); return false;
      }
      event.preventDefault(); event.stopPropagation(); reset(); return true;
    },
    contextMenu(event: MouseEvent): boolean {
      if (!gesture.current) {
        if (Date.now() >= suppressContextUntil.current) return false;
        event.preventDefault(); event.stopPropagation(); return true;
      }
      event.preventDefault(); event.stopPropagation(); activate(); return true;
    },
  };
}
