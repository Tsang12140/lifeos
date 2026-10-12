import { useEffect, useRef, useState, type MouseEvent } from "react";
import "./back-to-top.css";

const GAP = 12;
// The existing launcher lifts 1px on hover; allow its transition to finish
// without briefly closing the minimum clearance.
const MOTION_CLEARANCE = 2;
const VISIBILITY_HEIGHT = 400;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Escape", " "]);

function visibleRect(element: Element): DOMRect | null {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** Page navigation only: never changes the selected date, filters or drafts. */
export function BackToTop() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const animationRef = useRef<number | null>(null);
  const [placement, setPlacement] = useState({ visible: false, bottom: 24 });

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    let tick: number | null = null;
    const cancel = () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
    const update = () => {
      tick = null;
      const mobile = window.matchMedia("(max-width: 900px)").matches;
      const buttonRect = button.getBoundingClientRect();
      const size = buttonRect.width;
      const nav = document.querySelector(".mobile-nav");
      const navRect = nav ? visibleRect(nav) : null;
      let bottom = navRect ? window.innerHeight - navRect.top + 16 : mobile ? 80 : 24;
      // Fixed positioning excludes a classic scrollbar (and reserved gutter).
      const left = buttonRect.left;
      const inputFocused = document.activeElement?.matches("input:not([type=button]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]") ?? false;
      const modalOpen = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].some(element => visibleRect(element) !== null);
      const assistantOpen = document.querySelector('.ai-assistant-panel.is-open:not(.is-docked)[aria-hidden="false"]') !== null;
      // The launcher can be dragged and restored anywhere, so measure it rather
      // than assuming its default corner. Toasts also reserve their real space.
      const obstacles = [...document.querySelectorAll(mobile ? ".action-toast" : ".ai-assistant-launcher:not(.is-hidden), .action-toast")]
        .map(visibleRect).filter((rect): rect is DOMRect => rect !== null)
        .filter(rect => rect.right > left - GAP && rect.left < left + size + GAP)
        .sort((a, b) => b.top - a.top);
      for (const rect of obstacles) {
        const top = window.innerHeight - bottom - size;
        if (top < rect.bottom + GAP + MOTION_CLEARANCE && top + size > rect.top - GAP - MOTION_CLEARANCE) bottom = window.innerHeight - rect.top + GAP + MOTION_CLEARANCE;
      }
      const fits = left >= GAP && window.innerHeight - bottom - size >= GAP;
      const visible = window.scrollY > VISIBILITY_HEIGHT && fits && !modalOpen && !assistantOpen && !(mobile && inputFocused);
      // On phones the top button owns the lower slot. Lift the assistant from
      // its resting layout position, never its animated rectangle, so repeated
      // measurements cannot feed the lift back into itself. Dragging is free;
      // release settles above this slot only when the two would overlap.
      const launcher = document.querySelector<HTMLElement>(".ai-assistant-launcher");
      if (launcher) {
        let lift = 0;
        if (mobile && visible && !launcher.matches(".is-hidden, .is-dragging")) {
          const rect = launcher.getBoundingClientRect();
          const top = window.innerHeight - bottom - size;
          const restingTop = launcher.offsetTop;
          if (rect.right > left - GAP && rect.left < left + size + GAP &&
              restingTop < top + size + GAP && restingTop + launcher.offsetHeight > top - GAP) {
            lift = Math.min(restingTop - GAP, restingTop + launcher.offsetHeight + GAP - top);
          }
        }
        const value = `${-Math.max(0, lift)}px`;
        if (mobile) {
          const delay = lift > 0 ? "0ms" : "180ms";
          if (launcher.style.getPropertyValue("--ai-launcher-motion-delay") !== delay) launcher.style.setProperty("--ai-launcher-motion-delay", delay);
          if (launcher.style.getPropertyValue("--ai-launcher-lift") !== value) launcher.style.setProperty("--ai-launcher-lift", value);
        } else {
          if (launcher.style.getPropertyValue("--ai-launcher-lift")) launcher.style.removeProperty("--ai-launcher-lift");
          if (launcher.style.getPropertyValue("--ai-launcher-motion-delay")) launcher.style.removeProperty("--ai-launcher-motion-delay");
        }
      }
      if (modalOpen || assistantOpen || (mobile && inputFocused) || !fits) cancel();
      setPlacement(current => current.visible === visible && Math.abs(current.bottom - bottom) < .5 ? current : { visible, bottom });
    };
    const schedule = () => { if (tick === null) tick = requestAnimationFrame(update); };
    const pointerDown = (event: PointerEvent) => { if (!button.contains(event.target as Node)) cancel(); };
    const keyDown = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key)) cancel(); };
    const transitionEnded = (event: TransitionEvent) => {
      if (event.target instanceof Element && event.target.matches(".ai-assistant-launcher, .action-toast, .mobile-nav")) schedule();
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = () => { if (reducedMotion.matches) cancel(); };
    // React owns this button. Ignore its own visibility/style mutations to
    // avoid a measuring/rendering loop; other UI changes are batched per frame.
    const observer = new MutationObserver(changes => {
      if (changes.some(change => !button.contains(change.target))) schedule();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "open", "aria-hidden", "aria-modal"] });
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("pointerdown", pointerDown, { passive: true });
    window.addEventListener("keydown", keyDown);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    document.addEventListener("transitionend", transitionEnded);
    window.visualViewport?.addEventListener("resize", schedule);
    reducedMotion.addEventListener("change", motionChanged);
    update();
    return () => {
      cancel();
      if (tick !== null) cancelAnimationFrame(tick);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("keydown", keyDown);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      document.removeEventListener("transitionend", transitionEnded);
      window.visualViewport?.removeEventListener("resize", schedule);
      reducedMotion.removeEventListener("change", motionChanged);
      document.querySelector<HTMLElement>(".ai-assistant-launcher")?.style.removeProperty("--ai-launcher-lift");
      document.querySelector<HTMLElement>(".ai-assistant-launcher")?.style.removeProperty("--ai-launcher-motion-delay");
    };
  }, []);

  const returnToTop = (event: MouseEvent<HTMLButtonElement>) => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    const keyboard = event.detail === 0;
    const start = window.scrollY;
    const duration = Math.max(420, Math.min(700, start * .3));
    const finish = () => {
      animationRef.current = null;
      window.scrollTo({ top: 0, behavior: "instant" });
      if (keyboard) {
        // Return keyboard focus to an existing control at the page top, so the
        // next Tab does not jump back into the record at the old scroll offset.
        document.querySelector<HTMLElement>(".topbar button:not(:disabled), .topbar input:not(:disabled)")?.focus({ preventScroll: true });
      } else buttonRef.current?.blur();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || start <= 1) { finish(); return; }
    let started: number | null = null;
    const step = (time: number) => {
      if (started === null) started = time;
      const progress = Math.min(1, (time - started) / duration);
      window.scrollTo({ top: start * Math.pow(1 - progress, 3), behavior: "instant" });
      if (progress < 1) animationRef.current = requestAnimationFrame(step);
      else finish();
    };
    animationRef.current = requestAnimationFrame(step);
  };

  return <button ref={buttonRef} className={`back-to-top ${placement.visible ? "is-visible" : ""}`} style={{ bottom: placement.bottom }} type="button" aria-label="回到顶部" title="回到顶部" aria-hidden={!placement.visible} inert={!placement.visible} tabIndex={placement.visible ? 0 : -1} onClick={returnToTop}>
    {/* Exact SVG supplied and selected by the owner; do not substitute an icon. */}
    <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M832 165.76H192c-26.24 0-48 21.76-48 48s21.76 48 48 48h640c26.24 0 48-21.76 48-48s-21.76-48-48-48zM551.04 376.96A58.688 58.688 0 0 0 512 360.32c-12.8 0-29.44 7.04-38.4 16L254.08 595.84c-18.56 18.56-18.56 49.28 0 67.84s49.28 18.56 67.84 0l142.08-142.08v348.16c0 26.24 21.76 48 48 48s48-21.76 48-48V521.6l142.08 142.08c9.6 9.6 21.76 14.08 33.92 14.08s24.32-4.48 33.92-14.08c18.56-18.56 18.56-49.28 0-67.84L551.04 376.96z" /></svg>
  </button>;
}
