import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./assistant-message-actions.css";

export interface AssistantMessageActionsProps {
  /** The plain assistant response body. Attachments and timestamps stay outside this value. */
  readonly content: string;
  readonly className?: string;
}

type CopyFeedback = "copied" | "failed" | null;

/** Small, reusable copy control for an assistant response in live chat or history. */
export function AssistantMessageActions({ content, className = "" }: AssistantMessageActionsProps) {
  const [feedback, setFeedback] = useState<CopyFeedback>(null);
  const feedbackId = useId();
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(content);
      setFeedback("copied");
      resetTimer.current = window.setTimeout(() => setFeedback(null), 2400);
    } catch {
      setFeedback("failed");
      resetTimer.current = window.setTimeout(() => setFeedback(null), 5000);
    }
  };

  const copied = feedback === "copied";
  const label = copied ? "已复制 AI 回答" : "复制 AI 回答";
  const extraClass = className.trim().length > 0 ? ` ${className.trim()}` : "";

  return <div className={`assistant-message-actions${extraClass}`} data-testid="assistant-message-actions">
    <button
      className="assistant-message-actions__copy"
      type="button"
      data-testid="assistant-message-copy"
      aria-label={label}
      title={label}
      aria-describedby={feedback === null ? undefined : feedbackId}
      disabled={content.length === 0}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
    {feedback === null ? null : <span id={feedbackId} className={`assistant-message-actions__feedback is-${feedback}`} role="status" aria-live="polite" aria-atomic="true">
      {copied ? "已复制回答" : "复制失败，请手动选择回答文字或检查剪贴板权限"}
    </span>}
  </div>;
}
