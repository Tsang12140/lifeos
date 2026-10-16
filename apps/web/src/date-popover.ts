import { useLayoutEffect, type RefObject } from "react";

/** Portal to body (or the owning modal) avoids scrolling-container clipping. */
export function useDatePopover(open: boolean, anchor: RefObject<HTMLDivElement | null>, panel: RefObject<HTMLDivElement | null>, wide: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current;
    const trigger = anchor.current;
    if (!element || !trigger) return;
    let frame = 0;
    const place = () => {
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const box = trigger.getBoundingClientRect();
      const panelWidth = Math.min(width - 24, wide && width > 700 ? 480 : 320);
      const above = Math.max(0, box.top - y - 20);
      const below = Math.max(0, y + height - box.bottom - 20);
      const direction = below >= above ? "below" : "above";
      const room = Math.max(above, below);
      // A very short/zoomed viewport uses the available screen, not a minimum
      // height that would put the header or last action outside the viewport.
      const maxHeight = Math.max(1, room < 260 ? height - 24 : room);
      element.style.width = `${Math.max(1, panelWidth)}px`;
      element.style.maxHeight = `${maxHeight}px`;
      const panelHeight = element.getBoundingClientRect().height;
      const left = Math.max(x + 12, Math.min(box.left, x + width - panelWidth - 12));
      const desiredTop = direction === "below" ? box.bottom + 8 : box.top - 8 - panelHeight;
      element.style.left = `${left}px`;
      element.style.top = `${Math.max(y + 12, Math.min(desiredTop, y + height - panelHeight - 12))}px`;
      element.dataset.placement = direction;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(trigger);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, anchor, panel, wide]);
}

/** Dismissing a floating picker must not also activate the control underneath. */
export function consumeDateOutsidePress(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    document.removeEventListener("click", click, true);
    document.removeEventListener("pointerup", released, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("pointerdown", cancel, true);
  };
  const click = (next: MouseEvent) => {
    if (Math.abs(next.clientX - event.clientX) <= 16 && Math.abs(next.clientY - event.clientY) <= 16) {
      next.preventDefault(); next.stopPropagation();
    }
    cancel();
  };
  const released = () => { timer = setTimeout(cancel, 500); };
  document.addEventListener("click", click, true);
  document.addEventListener("pointerup", released, { capture: true, once: true });
  document.addEventListener("pointercancel", cancel, { capture: true, once: true });
  document.addEventListener("pointerdown", cancel, { capture: true, once: true });
}
