import { useEffect, useRef, type RefObject } from "react";

/** One mounted conversation becomes a phone page; no second chat or draft store. */
export function useMobileAssistantPage(open: boolean, panelRef: RefObject<HTMLElement | null>, backRef: RefObject<HTMLButtonElement | null>, launcherRef: RefObject<HTMLButtonElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      panel.style.setProperty("--assistant-vv-top", `${viewport?.offsetTop ?? 0}px`);
      panel.style.setProperty("--assistant-vv-left", `${viewport?.offsetLeft ?? 0}px`);
      panel.style.setProperty("--assistant-vv-width", `${viewport?.width ?? window.innerWidth}px`);
      panel.style.setProperty("--assistant-vv-height", `${viewport?.height ?? window.innerHeight}px`);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);

    // Lock siblings along the ancestor path, never an ancestor of this chat.
    // Toast undo and subsequently opened native dialogs remain usable.
    const background = new Set<HTMLElement>();
    let branch: HTMLElement = panel;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.inert || sibling.matches(".action-toast, script, style, link")) continue;
        sibling.inert = true;
        background.add(sibling);
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus a navigation control, not the input: opening must not summon a keyboard.
    backRef.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector("dialog[open], [role=menu]")) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const selector = "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex='0']";
      const focusable = [...panel.querySelectorAll<HTMLElement>(selector), ...document.querySelectorAll<HTMLElement>(".action-toast button")].filter(element => element.getBoundingClientRect().width > 0 && !element.closest("[inert]"));
      const first = focusable[0], last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus({ preventScroll: true }); }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("keydown", keydown);
      for (const element of background) element.inert = false;
      document.body.style.overflow = previousOverflow;
      for (const name of ["top", "left", "width", "height"]) panel.style.removeProperty(`--assistant-vv-${name}`);
      if (window.matchMedia("(max-width: 900px)").matches) launcherRef.current?.focus({ preventScroll: true });
    };
  }, [open, panelRef, backRef, launcherRef]);
}
