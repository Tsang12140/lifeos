import { useLayoutEffect, useRef, type RefObject } from "react";
import { lockDialogScroll } from "./dialog-scroll-lock";

/** Page geometry only: no modal focus trap, inert siblings, or launcher choreography. */
export function useMobileAssistantPage(open: boolean, panelRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const pageOpen = useRef(open); pageOpen.current = open;
  const readingPosition = useRef<number | null>(null);
  useLayoutEffect(() => {
    const scroll = panelRef.current?.querySelector<HTMLElement>(".backfill-workspace-scroll");
    if (!scroll) return;
    const remember = () => { if (pageOpen.current || matchMedia("(min-width: 901px)").matches) readingPosition.current = scroll.scrollTop; };
    scroll.addEventListener("scroll", remember, { passive: true });
    return () => scroll.removeEventListener("scroll", remember);
  }, [panelRef]);
  useLayoutEffect(() => {
    const panel = panelRef.current, shell = panel?.closest<HTMLElement>(".app-shell");
    if (!open || !panel || !shell) return;
    const viewport = window.visualViewport;
    const scroll = panel.querySelector<HTMLElement>(".backfill-workspace-scroll"), savedPosition = readingPosition.current;
    const restoreFrame = requestAnimationFrame(() => { if (scroll && savedPosition !== null) scroll.scrollTop = savedPosition; });
    let frame = 0;
    let restingHeight = window.innerHeight, restingWidth = window.innerWidth, editorUsed = false;
    const update = () => {
      const height = viewport?.height ?? window.innerHeight;
      const focused = document.activeElement;
      const editing = focused instanceof HTMLElement && panel.contains(focused) && focused.matches("textarea,input,[contenteditable=true]");
      if (Math.abs(window.innerWidth - restingWidth) > 80) { restingWidth = window.innerWidth; restingHeight = window.innerHeight; }
      if (!editing && !editorUsed) restingHeight = window.innerHeight;
      if (editing) editorUsed = true;
      const gap = Math.max(restingHeight, window.innerHeight) - height;
      const keyboard = editorUsed && Math.abs((viewport?.scale ?? 1) - 1) < .05 && gap > 120;
      if (!editing && gap < 60) { editorUsed = false; restingHeight = window.innerHeight; }
      shell.dataset.assistantKeyboard = String(keyboard);
      shell.style.setProperty("--assistant-page-top", (viewport?.offsetTop ?? 0) + "px");
      shell.style.setProperty("--assistant-page-left", (viewport?.offsetLeft ?? 0) + "px");
      shell.style.setProperty("--assistant-page-width", (viewport?.width ?? window.innerWidth) + "px");
      shell.style.setProperty("--assistant-page-height", height + "px");
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    viewport?.addEventListener("resize", schedule); viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule); document.addEventListener("focusin", schedule); document.addEventListener("focusout", schedule);
    const unlock = lockDialogScroll();
    panel.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector("dialog[open], [role=menu]")) return;
      event.preventDefault();
      if (shell.dataset.assistantKeyboard === "true" && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      else closeRef.current();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(restoreFrame); unlock();
      viewport?.removeEventListener("resize", schedule); viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule); document.removeEventListener("focusin", schedule); document.removeEventListener("focusout", schedule); window.removeEventListener("keydown", keydown);
      delete shell.dataset.assistantKeyboard;
      for (const name of ["top", "left", "width", "height"]) shell.style.removeProperty("--assistant-page-" + name);
      if (panel.contains(document.activeElement) && !document.querySelector("dialog[open]")) document.querySelector<HTMLButtonElement>('.mobile-nav [aria-current="page"]')?.focus({ preventScroll: true });
    };
  }, [open, panelRef]);
}
