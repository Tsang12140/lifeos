import { useLayoutEffect, useRef, type RefObject } from "react";

/** Shared keyboard, outside-press and focus behavior for the three action menus. */
export function useActionMenu(ref: RefObject<HTMLDivElement | null>, active: boolean, onClose: () => void, onCloseSubmenu?: () => void, options?: { allowOutside?: (target: Element) => boolean; passthrough?: boolean; followViewport?: boolean }): void {
  const callbacks = useRef({ onClose, onCloseSubmenu, options });
  useLayoutEffect(() => { callbacks.current = { onClose, onCloseSubmenu, options }; });
  useLayoutEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = (menu: Element) => Array.from(menu.querySelectorAll<HTMLButtonElement>("button"))
      .filter(button => button.closest('[role="menu"]') === menu && button.getClientRects().length > 0 && !button.disabled && button.getAttribute("aria-disabled") !== "true");
    const focus = (element: HTMLElement | undefined) => {
      if (!element) return;
      element.focus({ preventScroll: true });
      const menu = element.closest('[role="menu"]');
      if (!(menu instanceof HTMLElement) || menu.scrollHeight <= menu.clientHeight) return;
      const row = element.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
      if (row.bottom > bounds.bottom - 7) menu.scrollTop += row.bottom - bounds.bottom + 7;
      else if (row.top < bounds.top + 7) menu.scrollTop -= bounds.top + 7 - row.top;
    };
    root.tabIndex = -1;
    focus(items(root)[0] ?? root);
    let frame = 0;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.contains(event.target)) return;
      if (event.target instanceof Element && callbacks.current.options?.allowOutside?.(event.target)) return;
      if (callbacks.current.options?.passthrough) { callbacks.current.onClose(); return; }
      // Consume the dismissing gesture so it cannot also operate the page underneath.
      event.preventDefault();
      event.stopPropagation();
      // Cancel the ensuing click too: pointerdown.preventDefault alone does not cancel it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        clearTimeout(timer);
        document.removeEventListener("click", consumeClick, true);
        document.removeEventListener("pointerup", released, true);
        document.removeEventListener("pointercancel", cancel, true);
        document.removeEventListener("pointerdown", cancel, true);
      };
      const consumeClick = (click: MouseEvent) => {
        if (Math.abs(click.clientX - event.clientX) <= 16 && Math.abs(click.clientY - event.clientY) <= 16) {
          click.preventDefault(); click.stopPropagation();
        }
        cancel();
      };
      const released = () => { timer = setTimeout(cancel, 500); };
      document.addEventListener("click", consumeClick, true);
      document.addEventListener("pointerup", released, { capture: true, once: true });
      document.addEventListener("pointercancel", cancel, { capture: true, once: true });
      document.addEventListener("pointerdown", cancel, { capture: true, once: true });
      callbacks.current.onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (!root.contains(document.activeElement)) {
        // Disabling the pressed item during a save can leave focus on body.
        if (document.activeElement !== document.body && document.activeElement !== origin && !(document.activeElement instanceof Element && callbacks.current.options?.allowOutside?.(document.activeElement))) return;
        if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"].includes(event.key)) return;
        focus(items(root)[0] ?? root);
      }
      const current = document.activeElement as HTMLElement;
      const menu = current.closest('[role="menu"]') ?? root;
      const list = items(menu);
      const index = list.indexOf(current as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 :
          index < 0 ? (event.key === "ArrowDown" ? 0 : list.length - 1) :
          (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        focus(list[next]);
      } else if (event.key === "ArrowRight" && current.getAttribute("aria-haspopup") === "menu") {
        event.preventDefault(); event.stopPropagation(); current.click();
        frame = requestAnimationFrame(() => {
          const sub = current.parentElement?.querySelector('[role="menu"]');
          if (sub) focus(items(sub)[0]);
        });
      } else if ((event.key === "ArrowLeft" || event.key === "Escape") && menu !== root) {
        event.preventDefault(); event.stopPropagation();
        focus(menu.parentElement?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') ?? undefined);
        callbacks.current.onCloseSubmenu?.();
      } else if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault(); event.stopPropagation(); callbacks.current.onClose();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    const dismiss = (event: Event) => {
      if (callbacks.current.options?.followViewport) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      callbacks.current.onClose();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      cancelAnimationFrame(frame);
      const returnFocus = root.contains(document.activeElement) || document.activeElement === document.body;
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      if (returnFocus && origin?.isConnected) queueMicrotask(() => {
        if (document.activeElement === document.body || root.contains(document.activeElement)) origin.focus({ preventScroll: true });
      });
    };
  }, [ref, active]);
}
