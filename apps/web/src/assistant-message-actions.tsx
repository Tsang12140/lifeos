import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./assistant-message-actions.css";

export interface AssistantMessageActionsProps {
  /** The plain assistant response body. Attachments and timestamps stay outside this value. */
  readonly content: string;
  readonly className?: string;
  readonly onShare?: () => void;
}

type CopyFeedback = "copied" | "failed" | null;

/** Small, reusable copy control for an assistant response in live chat or history. */
export function AssistantMessageActions({ content, className = "", onShare }: AssistantMessageActionsProps) {
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
    {onShare ? <button className="assistant-message-actions__copy assistant-message-actions__share" type="button" aria-label="分享对话" title="分享对话" onClick={onShare}><svg width="17" height="14" viewBox="0 0 1236 1024" fill="currentColor" aria-hidden="true"><path d="M741.743 1018.343c-28.287 0-50.917-11.315-73.547-28.288-22.63-22.63-39.602-50.917-39.602-84.862V792.044c-124.464 0-328.133 33.945-435.624 181.039-16.973 28.287-56.575 45.26-90.52 50.917H85.478C28.903 1012.685-5.042 961.768 0.616 905.193c28.287-243.27 113.15-418.652 260.243-537.458 107.492-84.862 231.956-130.122 367.735-141.437V118.807c0-50.917 22.63-96.177 67.89-113.15C736.086-5.657 781.345 0 815.29 33.945l362.077 367.735c28.288 22.63 45.26 56.574 50.918 96.176 5.657 39.603-5.658 79.205-33.945 107.492-5.658 5.658-11.315 16.972-22.63 22.63l-350.762 356.42c-22.63 22.63-50.918 33.945-79.205 33.945z m-90.52-339.448h90.52v226.298l356.42-367.734 5.658-5.658c5.657-5.657 5.657-16.972 5.657-22.63 0-11.315-5.657-16.972-11.315-22.63l-5.657-5.657-356.42-362.077V333.79l-79.205 5.658c-118.806 0-231.956 39.602-328.132 113.149-113.15 90.519-186.696 237.613-209.326 429.967 141.436-175.382 390.364-203.669 531.8-203.669z" /></svg></button> : null}
    {feedback === null ? null : <span id={feedbackId} className={`assistant-message-actions__feedback is-${feedback}`} role="status" aria-live="polite" aria-atomic="true">
      {copied ? "已复制回答" : "复制失败，请手动选择回答文字或检查剪贴板权限"}
    </span>}
  </div>;
}
