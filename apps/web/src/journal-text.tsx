import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A journal keeps its complete text in the DOM so the browser can lay it out
 * naturally, while CSS shows the first six lines until the reader expands it.
 * Overflow is measured with the same native line clamp used for display, so a
 * resize or a late font load can change whether the toggle is needed.
 */
export function JournalText({ contentKey, children }: { readonly contentKey: string; readonly children: ReactNode }) {
  const bodyRef = useRef<HTMLSpanElement>(null);
  const shouldRestoreBody = useRef(false);
  const reactId = useId();
  const bodyId = `journal-text-${reactId.replace(/:/g, "")}`;
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measureOverflow = useCallback(() => {
    const body = bodyRef.current;
    if (body === null || body.clientWidth === 0 || body.getClientRects().length === 0) return;

    // When expanded, briefly restore the exact display clamp and measure that
    // layout. This synchronous class change is removed before the browser paints.
    body.classList.add("is-measuring-clamp");
    const nextOverflows = body.scrollHeight > body.clientHeight + 1;
    body.classList.remove("is-measuring-clamp");

    setOverflows((current) => current === nextOverflows ? current : nextOverflows);
    if (!nextOverflows) setExpanded(false);
  }, []);

  useLayoutEffect(() => {
    setExpanded(false);
    measureOverflow();
  }, [contentKey, measureOverflow]);

  useLayoutEffect(() => {
    if (expanded || !shouldRestoreBody.current) return;
    shouldRestoreBody.current = false;
    const body = bodyRef.current;
    if (body === null) return;
    const rect = body.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) body.scrollIntoView({ block: "start", behavior: "auto" });
  }, [expanded]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    observer?.observe(body);
    window.addEventListener("resize", measureOverflow, { passive: true });

    const fontSet = document.fonts;
    void fontSet?.ready.then(measureOverflow);
    fontSet?.addEventListener("loadingdone", measureOverflow);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureOverflow);
      fontSet?.removeEventListener("loadingdone", measureOverflow);
    };
  }, [measureOverflow]);

  return <div className="journal-text" data-journal-text data-expanded={expanded ? "true" : "false"}>
    <span ref={bodyRef} id={bodyId} className={`journal-text-body${expanded ? " is-expanded" : ""}`}>{children}</span>
    {overflows ? <button className="journal-text-toggle" type="button" aria-controls={bodyId} aria-expanded={expanded} onClick={() => {
      if (expanded) {
        shouldRestoreBody.current = true;
        setExpanded(false);
      } else {
        setExpanded(true);
      }
    }}>{expanded ? "收起" : "全文"}</button> : null}
  </div>;
}
