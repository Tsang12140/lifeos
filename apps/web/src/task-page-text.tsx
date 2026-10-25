import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Keep the complete text mounted so copying and mentions retain the original body.
 * `compact` is the two-line task list: the row is clamped to one line by CSS, so
 * measuring for an overflow toggle would only offer a button that cannot fit.
 */
export function TaskPageText({ contentKey, disabled, compact = false, children }: { contentKey: string; disabled: boolean; compact?: boolean; children: ReactNode }) {
  const id = useId();
  const text = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const node = text.current;
    if (!node) return;
    setExpanded(false);
    if (compact) { setOverflow(false); return; }
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(node).lineHeight);
      setOverflow(Number.isFinite(line) && node.scrollHeight > line * 6 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const card = node.closest(".timeline-content");
    const reveal = () => setExpanded(true);
    card?.addEventListener("lifeos:reveal-task", reveal);
    return () => { observer.disconnect(); card?.removeEventListener("lifeos:reveal-task", reveal); };
  }, [contentKey, compact]);

  return <div className="task-page-text">
    <span ref={text} id={id} className="task-record-copy task-page-text-content" data-expanded={expanded}>{children}</span>
    {overflow && !compact ? <button type="button" className="task-page-text-toggle" aria-expanded={expanded} aria-controls={id} disabled={disabled} onClick={() => setExpanded(value => !value)}>{expanded ? "收起全文" : "展开全文"}</button> : null}
  </div>;
}
