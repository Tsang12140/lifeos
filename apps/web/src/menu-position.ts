/** Keep a fixed-position context menu inside the visible viewport. */
export function clampFixedMenuPosition(
  pointerX: number,
  pointerY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(pointerX, Math.max(margin, viewportWidth - menuWidth - margin))),
    y: Math.max(margin, Math.min(pointerY, Math.max(margin, viewportHeight - menuHeight - margin))),
  };
}
