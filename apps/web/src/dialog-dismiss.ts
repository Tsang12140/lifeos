/** Backdrop dismissal uses each dialog's existing cancel path, including busy/draft guards. */
export function isBackdropDismiss(event: Event): boolean {
  return event instanceof CustomEvent && event.detail?.source === "dialog-backdrop";
}

export function installDialogDismiss(): () => void {
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };
  type Gesture = { dialog: HTMLDialogElement; pointerId: number; x: number; y: number; endedAt?: number };
  let gesture: Gesture | null = null;
  const outside = (event: MouseEvent): HTMLDialogElement | null => {
    const dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement) || !dialog.matches(":modal")) return null;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom ? dialog : null;
  };
  const reset = () => { gesture = null; };
  document.addEventListener("pointerdown", event => {
    const dialog = outside(event);
    gesture = dialog && event.isPrimary && event.button === 0 ? { dialog, pointerId: event.pointerId, x: event.clientX, y: event.clientY } : null;
  }, options);
  document.addEventListener("pointermove", event => {
    if (gesture && (event.pointerId !== gesture.pointerId || outside(event) !== gesture.dialog || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6)) reset();
  }, options);
  document.addEventListener("pointerup", event => {
    if (gesture && event.isPrimary && event.button === 0 && event.pointerId === gesture.pointerId && outside(event) === gesture.dialog && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 6) gesture.endedAt = performance.now();
    else reset();
  }, options);
  document.addEventListener("pointercancel", reset, options);
  document.addEventListener("wheel", reset, options);
  document.addEventListener("click", event => {
    const completed = gesture;
    reset();
    if (!completed || completed.endedAt === undefined || event.detail === 0 || event.button !== 0 || performance.now() - completed.endedAt > 500 || outside(event) !== completed.dialog) return;
    const pointerId = (event as PointerEvent).pointerId;
    if (typeof pointerId === "number" && pointerId !== completed.pointerId) return;
    // Consume the gesture so older per-dialog backdrop handlers cannot close a second layer.
    event.preventDefault();
    event.stopPropagation();
    const cancel = new CustomEvent("cancel", { cancelable: true, detail: { source: "dialog-backdrop" } });
    if (completed.dialog.dispatchEvent(cancel) && completed.dialog.open) completed.dialog.close();
  }, options);
  return () => { reset(); controller.abort(); };
}
