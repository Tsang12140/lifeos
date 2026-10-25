import { useEffect, useId, useRef, useState } from "react";
import { CopyActionIcon } from "./action-icon-motion";
import "./assistant-message-actions.css";

export interface AssistantMessageActionsProps {
  /** The plain assistant response body. Attachments and timestamps stay outside this value. */
  readonly content: string;
  readonly className?: string;
  readonly onShare?: () => void;
  readonly disabled?: boolean;
  readonly copyLabel?: string;
  readonly copiedLabel?: string;
  readonly copiedMessage?: string;
  readonly failedMessage?: string;
}

type CopyFeedback = "copied" | "failed" | null;

/** Small, reusable copy control for an assistant response in live chat or history. */
export function AssistantMessageActions({ content, className = "", onShare, disabled = false, copyLabel = "复制 AI 回答", copiedLabel = "已复制 AI 回答", copiedMessage = "已复制回答", failedMessage = "复制失败，请手动选择回答文字或检查剪贴板权限" }: AssistantMessageActionsProps) {
  const [feedback, setFeedback] = useState<CopyFeedback>(null);
  const [copying, setCopying] = useState(false);
  const feedbackId = useId();
  const resetTimer = useRef<number | null>(null);
  const request = useRef(0);
  const copyingRef = useRef(false);

  useEffect(() => {
    ++request.current;
    copyingRef.current = false;
    setCopying(false);
    setFeedback(null);
    return () => {
      ++request.current;
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, [content]);

  const copy = async () => {
    if (disabled || !content || copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    setFeedback(null);
    const current = ++request.current;
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(content);
      if (current !== request.current) return;
      setFeedback("copied");
      resetTimer.current = window.setTimeout(() => setFeedback(null), 2400);
    } catch {
      if (current !== request.current) return;
      setFeedback("failed");
      resetTimer.current = window.setTimeout(() => setFeedback(null), 5000);
    } finally {
      if (current === request.current) { copyingRef.current = false; setCopying(false); }
    }
  };

  const copied = feedback === "copied";
  const label = copied ? copiedLabel : copyLabel;
  const extraClass = className.trim().length > 0 ? ` ${className.trim()}` : "";

  return <div className={`assistant-message-actions${extraClass}`} data-testid="assistant-message-actions">
    {/* A pending writeText must not disable the button: Chrome drops the hover
        chip and dims the icon while disabled, which reads as a flicker under
        the cursor. `copyingRef` already keeps a second click out. */}
    <button
      className="assistant-message-actions__copy"
      type="button"
      data-testid="assistant-message-copy"
      aria-label={label}
      title={label}
      aria-describedby={feedback === null ? undefined : feedbackId}
      disabled={disabled || content.length === 0}
      aria-busy={copying || undefined}
      onClick={() => void copy()}
    >
      <CopyActionIcon copied={copied} />
    </button>
    {onShare ? <button className="assistant-message-actions__copy assistant-message-actions__share" type="button" aria-label="分享对话" title="分享对话" onClick={onShare}><svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path d="M883.3 489.4c-24.7 0-44.7-20-44.7-44.7V224.1c0-19.6-15.9-35.5-35.5-35.5H581.5c-24.7 0-44.7-20-44.7-44.7s20-44.7 44.7-44.7h221.7c68.9 0 124.9 56 124.9 124.9v220.5c-0.1 24.7-20.1 44.8-44.8 44.8z" /><path d="M515.1 557.6c-11.4 0-22.9-4.4-31.6-13.1-17.5-17.4-17.5-45.8 0-63.2l344.9-344.9c17.5-17.5 45.7-17.5 63.2 0 17.5 17.4 17.5 45.8 0 63.2L546.7 544.5c-8.7 8.8-20.2 13.1-31.6 13.1z" /><path d="M741.4 926.1H227.6c-69.7 0-126.5-56.7-126.5-126.5V285.8c0-69.7 56.7-126.5 126.5-126.5h147.2c24.7 0 44.7 20 44.7 44.7s-20 44.7-44.7 44.7H227.6c-20.4 0-37.1 16.6-37.1 37.1v513.8c0 20.4 16.6 37.1 37.1 37.1h513.8c20.4 0 37.1-16.6 37.1-37.1V652.9c0-24.7 20-44.7 44.7-44.7 24.7 0 44.7 20 44.7 44.7v146.7c0 69.8-56.7 126.5-126.5 126.5z" /></svg></button> : null}
    {feedback === null ? null : <span id={feedbackId} className={`assistant-message-actions__feedback is-${feedback}`} role="status" aria-live="polite" aria-atomic="true">
      {copied ? copiedMessage : failedMessage}
    </span>}
  </div>;
}
