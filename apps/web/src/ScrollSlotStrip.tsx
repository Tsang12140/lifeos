import { useEffect, useRef, type ReactNode } from "react";

/**
 * A strip of equal-width slots that keeps itself centred on one of them.
 *
 * Two axes, two jobs, and conflating them was a real bug: passing "-1 for no
 * index" to mean "do not pin horizontally" also meant "do not centre
 * vertically", so the hour column opened with its selected hour flush against
 * the bottom edge and the next hour below the fold.
 *
 * - Horizontally: `activeIndex` names the slot to hold under the cursor. The
 *   day strip uses this, because a strip of dates that shifts under the pointer
 *   between two clicks is how a fast pair of taps lands on the wrong day. -1
 *   turns it off.
 * - Vertically: a column whose slots are all the same height centres the one
 *   marked `is-selected` in the DOM. The hour and minute columns use this, and
 *   they find their own selected slot, so there is nothing to pass in.
 *
 * Both are deferred a frame, because on the opening render the strip has not
 * been laid out yet and `clientHeight` is still 0 — the centring sum then
 * resolves to the slot's raw offset and the strip scrolls nowhere.
 */
export function ScrollSlotStrip({ className, children, scrollKey, activeIndex = -1, onScrollEnd }: { readonly className?: string; readonly children: ReactNode; readonly scrollKey: string; readonly activeIndex?: number; readonly onScrollEnd?: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastIndexRef = useRef(activeIndex);
  lastIndexRef.current = activeIndex;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const strip = ref.current;
      if (strip === null || strip.clientHeight === 0) return;
      // The selected slot is whichever one the caller marked; the horizontal
      // case names it by index instead, since the day strip has no single
      // "selected" class it can rely on before the first paint.
      const slot = activeIndex >= 0
        ? strip.children[activeIndex]
        : strip.querySelector(".is-selected");
      if (!(slot instanceof HTMLElement)) return;
      strip.scrollTop = slot.offsetTop - strip.clientHeight / 2 + slot.offsetHeight / 2;
      if (activeIndex < 0) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      strip.scrollLeft = slot.offsetLeft - strip.clientWidth / 2 + slot.offsetWidth / 2;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollKey, activeIndex]);

  useEffect(() => {
    const strip = ref.current;
    if (strip === null) return undefined;
    // A genuine relayout (the field narrows on a phone) can move the slots out
    // from under the pointer, so the pin is re-applied rather than trusted.
    const pin = () => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const slot = activeIndex >= 0 ? strip.children[activeIndex] : strip.querySelector(".is-selected");
      if (!(slot instanceof HTMLElement)) return;
      const target = slot.offsetLeft - strip.clientWidth / 2 + slot.offsetWidth / 2;
      if (Math.abs(strip.scrollLeft - target) < 0.5) return;
      strip.scrollLeft = target;
    };
    const observer = new ResizeObserver(pin);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeIndex]);

  return <div
    ref={ref}
    className={className}
    data-scroll-key={scrollKey}
    data-active-index={activeIndex}
    onScroll={(event) => {
      if (onScrollEnd === undefined) return;
      const strip = event.currentTarget;
      if (strip.scrollWidth <= strip.clientWidth) return;
      const centre = strip.scrollLeft + strip.clientWidth / 2;
      let nearest = activeIndex;
      let distance = Number.POSITIVE_INFINITY;
      Array.from(strip.children).forEach((child, index) => {
        if (!(child instanceof HTMLElement)) return;
        const before = strip.scrollLeft + child.offsetLeft;
        const after = before + child.offsetWidth;
        // Both edges matter: an off-centre slot is exactly what the strip
        // dragging too far looks like, and the nearest middle picks it up.
        const middle = (before + after) / 2;
        const gap = Math.abs(middle - centre);
        if (gap < distance) {
          distance = gap;
          nearest = index;
        }
      });
      onScrollEnd(nearest);
    }}
  >{children}</div>;
}
