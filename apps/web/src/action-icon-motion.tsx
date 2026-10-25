import type { ReactNode } from "react";
import "./action-icon-motion.css";

/** Both glyphs stay mounted so a rapid reversal continues from the visible frame. */
export function ActionIconSwap({ active, idle, changed }: { active: boolean; idle: ReactNode; changed: ReactNode }) {
  return <span className="action-icon-swap" data-active={active} aria-hidden="true">
    <span className="action-icon-swap__idle">{idle}</span>
    <span className="action-icon-swap__changed">{changed}</span>
  </span>;
}

/** Local SVG artwork: clipboard success alone starts the ring and check strokes. */
export function CopyActionIcon({ copied }: { copied: boolean }) {
  return <svg className="copy-action-icon" data-copied={copied} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <g className="copy-action-icon__sheets"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></g>
    <g className="copy-action-icon__success"><circle className="copy-action-icon__ring" cx="12" cy="12" r="9" pathLength="1" /><path className="copy-action-icon__check" d="m8 12 2.5 2.5L16 9" pathLength="1" /></g>
  </svg>;
}
