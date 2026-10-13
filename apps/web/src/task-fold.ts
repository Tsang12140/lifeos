import { useLayoutEffect, useRef, useState } from "react";

/** Animate only the changing card, with no frame loop or persistent layer.
 * Keep the full body until the crop finishes so it cannot flash into one line.
 */
export function useTaskFold(collapsed: boolean, scope: string, disabled: boolean) {
  const [folded, setFolded] = useState(collapsed);
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const interruptedHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const outer = frame.current, inner = content.current;
    if (!outer || !inner) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    if (disabled || reducedMotion.matches) {
      interruptedHeight.current = null;
      setFolded(collapsed);
      return;
    }
    if (!collapsed && folded) {
      interruptedHeight.current ??= outer.getBoundingClientRect().height;
      setFolded(false);
      return;
    }
    const from = interruptedHeight.current ?? outer.getBoundingClientRect().height;
    interruptedHeight.current = null;
    if (collapsed === folded && collapsed) return;
    // Measure the final one-line layout once; restore full prose before paint.
    inner.dataset.folded = String(collapsed);
    const to = inner.getBoundingClientRect().height;
    inner.dataset.folded = String(folded);
    if (Math.abs(from - to) < .5) { setFolded(collapsed); return; }
    outer.classList.add("is-folding");
    const animation = outer.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 240, easing: "cubic-bezier(.22, .68, .25, 1)", fill: "both",
    });
    let settled = false, resizeFrame = 0;
    const clear = () => {
      cancelAnimationFrame(resizeFrame);
      observer.disconnect(); reducedMotion.removeEventListener("change", finish);
      animation.cancel(); outer.classList.remove("is-folding");
    };
    const finish = () => {
      settled = true;
      if (collapsed) setFolded(true);
      else clear();
    };
    const width = inner.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      if (!resizeFrame && Math.abs(inner.getBoundingClientRect().width - width) > .5) {
        // A resize callback must not synchronously write observed layout.
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0; settled = true; clear(); setFolded(collapsed);
        });
      }
    });
    observer.observe(inner);
    reducedMotion.addEventListener("change", finish);
    animation.onfinish = finish;
    return () => {
      if (!settled) interruptedHeight.current = outer.getBoundingClientRect().height;
      clear();
    };
  }, [collapsed, folded, scope, disabled]);
  return { folded, frame, content };
}
