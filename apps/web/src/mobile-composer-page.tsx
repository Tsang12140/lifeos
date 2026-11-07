import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { lockDialogScroll } from "./dialog-scroll-lock";

/** Native modal keeps the source page and its scroll position intact. */
export function MobileComposerPage({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    const unlock = lockDialogScroll();
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    const viewport = window.visualViewport;
    const update = () => {
      dialog.style.setProperty("--compose-height", `${viewport?.height ?? innerHeight}px`);
      dialog.style.setProperty("--compose-top", `${viewport?.offsetTop ?? 0}px`);
    };
    update(); viewport?.addEventListener("resize", update); viewport?.addEventListener("scroll", update);
    // An explicit history entry makes the phone's Back gesture close the editor.
    const source = location.href, sourceState = history.state;
    history.pushState({ ...history.state, lifeosComposer: true }, "", "#compose");
    const back = () => {
      const nested = dialog.querySelector<HTMLDialogElement>(".mobile-field-sheet[open]");
      const date = dialog.querySelector("[data-mobile-sheet=true]");
      if (busyRef.current || nested || date) {
        history.pushState({ ...sourceState, lifeosComposer: true }, "", "#compose");
        if (!busyRef.current && nested) nested.dispatchEvent(new Event("cancel", { cancelable: true }));
        else if (!busyRef.current && date) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else closeRef.current();
    };
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("popstate", back);
      if (location.hash === "#compose") history.replaceState(sourceState, "", source);
      viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update);
      dialog.close(); unlock();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className="mobile-composer-page" tabIndex={-1} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="mobile-composer-header"><button type="button" onClick={onClose} disabled={busy} aria-label="返回并保留草稿"><ArrowLeft size={20} strokeWidth={1.8} /><span>返回</span></button><h1>{title}</h1><span aria-hidden="true" /></header>
    {children}
  </dialog>;
}
