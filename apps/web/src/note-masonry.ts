import { useLayoutEffect, useRef } from "react";

/** Keep chronological DOM/tab order while placing each paper in the shortest column. */
export function useNoteMasonry(items: readonly unknown[], enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!enabled || !grid) return;
    const cards = [...grid.querySelectorAll<HTMLElement>(":scope > .note-card")];
    let active = true, frame = 0;
    const update = () => {
      const width = grid.clientWidth;
      if (!active || width <= 0) return;
      const gap = Number.parseFloat(getComputedStyle(grid).gap) || 20;
      const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const columns = Math.max(1, Math.min(3, Math.floor((width + gap) / (16.25 * rootSize + gap))));
      const cardWidth = (width - gap * (columns - 1)) / columns;
      grid.classList.add("is-masonry");
      grid.style.setProperty("--note-card-width", `${cardWidth}px`);
      const heights = Array<number>(columns).fill(0);
      for (const card of cards) {
        const column = heights.indexOf(Math.min(...heights));
        card.style.left = `${column * (cardWidth + gap)}px`;
        card.style.top = `${heights[column]}px`;
        heights[column]! += card.getBoundingClientRect().height + gap;
      }
      grid.style.height = `${Math.max(0, Math.max(...heights) - gap)}px`;
      grid.dataset.masonryColumns = String(columns);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(grid);
    cards.forEach(card => observer.observe(card));
    window.addEventListener("resize", schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    void document.fonts.ready.then(() => { if (active) schedule(); });
    return () => {
      active = false; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.fonts.removeEventListener("loadingdone", schedule);
      // Keep geometry between consecutive effects. Removing the wall height
      // here briefly collapses the document and clamps a scrolled viewport to
      // the top, even when the next layout effect immediately restores it.
      // This grid is unmounted whenever masonry is disabled.
    };
  }, [items, enabled]);
  return ref;
}
