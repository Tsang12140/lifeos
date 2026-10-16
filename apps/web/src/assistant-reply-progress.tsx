import { useEffect, useState } from "react";

/** Waiting feedback and real elapsed time; never invent a completion percentage. */
export function AssistantReplyProgress({ thinking }: { readonly thinking: boolean }) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div className="assistant-reply-progress" role="status" aria-live="polite">
    <span className="assistant-reply-dots" aria-hidden="true"><i /><i /><i /></span>
    <span>{elapsed >= 20 ? "仍在处理中" : thinking ? "正在思考" : "正在回复"}</span>
    <time aria-hidden="true">{elapsed}秒</time>
  </div>;
}
