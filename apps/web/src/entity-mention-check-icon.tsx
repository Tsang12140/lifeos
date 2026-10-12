// Keep the user's check silhouette; draw the frame separately so the empty state stays complete.
export function MentionCheckIcon({ state }: { state: "all" | "mixed" | "none" }) {
  return <svg className="mention-review-check-icon" viewBox="0 0 1024 1024" width={32} height={32} aria-hidden="true">
    <rect className="mention-review-check-frame" x={95.36} y={221.35} width={653.14} height={677.42} rx={97.95} fill="none" stroke="currentColor" strokeWidth={80} />
    {state === "all" ? <path className="mention-review-check-shape" fill="currentColor" d="M907.863 125.67C678.209 266.491 511.556 444.153 436.664 533.3L253.293 389.627l-80.978 65.277L489.193 777.16c54.526-139.694 227.24-412.687 438.113-606.653l-19.443-44.837z" /> : null}
    {state === "mixed" ? <path className="mention-review-check-mixed" d="M270 560H575" fill="none" stroke="currentColor" strokeWidth={95} strokeLinecap="round" /> : null}
  </svg>;
}
