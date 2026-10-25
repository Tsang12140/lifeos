import { useEffect, useRef } from "react";

export interface TaskLocation {
  readonly recordId: string;
  readonly view: "today" | "tasks";
}

/** Start the cue after the destination is mounted and scrolling has settled. */
export function useTaskLocation(request: TaskLocation | null, ready: boolean) {
  const completed = useRef<TaskLocation | null>(null);
  useEffect(() => {
    if (!request || !ready || completed.current === request) return;
    const card = document.querySelector(`.content-column .timeline-task[data-record-id="${CSS.escape(request.recordId)}"] .timeline-content`);
    if (!(card instanceof HTMLElement)) return;
    card.dispatchEvent(new Event("lifeos:reveal-task"));
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stickyHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--weather-sticky-height")) || 0;
    const top = Math.max(0, stickyHeight) + 24;
    window.scrollTo({ top: window.scrollY + card.getBoundingClientRect().top - top, behavior: reducedMotion ? "instant" : "smooth" });
    let frame = 0;
    let animation: Animation | undefined;
    let previousY = window.scrollY;
    let previousTop = card.getBoundingClientRect().top;
    let stableFrames = 0;
    let corrected = false;
    const started = performance.now();
    const arrive = () => {
      const elapsed = performance.now() - started;
      const rect = card.getBoundingClientRect();
      stableFrames = Math.abs(window.scrollY - previousY) < .5 && Math.abs(rect.top - previousTop) < .5 ? stableFrames + 1 : 0;
      previousY = window.scrollY;
      previousTop = rect.top;
      const destination = Math.max(0, Math.min(window.scrollY + rect.top - top, document.documentElement.scrollHeight - window.innerHeight));
      const remaining = Math.abs(window.scrollY - destination);
      if (elapsed < 120 || ((stableFrames < 3 || remaining > 1) && elapsed < 1200)) {
        frame = requestAnimationFrame(arrive);
        return;
      }
      // A view change can interrupt native smooth scrolling or change page height.
      if (remaining > 1 && !corrected) {
        corrected = true;
        window.scrollTo({ top: destination, behavior: "instant" });
        frame = requestAnimationFrame(arrive);
        return;
      }
      if (!card.isConnected || rect.bottom <= top || rect.top >= window.innerHeight) return;
      completed.current = request;
      const base = getComputedStyle(card).backgroundColor;
      const peak = "rgb(231, 238, 255)";
      // clockin-b's navigation cue: a single 1.8s background breath, no geometry changes.
      animation = card.animate(reducedMotion
        ? [{ backgroundColor: peak }, { backgroundColor: peak }]
        : [{ backgroundColor: base, offset: 0 }, { backgroundColor: peak, offset: .45 }, { backgroundColor: base, offset: 1 }],
      { duration: 1800, easing: "ease-in-out" });
      animation.onfinish = () => animation?.cancel();
    };
    frame = requestAnimationFrame(arrive);
    return () => { cancelAnimationFrame(frame); animation?.cancel(); };
  }, [request, ready]);
}
