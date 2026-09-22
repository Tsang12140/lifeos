import { CircleHelp, LoaderCircle, Sparkles } from "lucide-react";

export function LoadingState() {
  return <div className="timeline-state state-loading" role="status"><LoaderCircle className="spin" size={23} aria-hidden="true" /><span>正在读取时间轴……</span></div>;
}

export function DiagnosticsDrawer() {
  return null;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="timeline-state state-error" role="alert"><div className="state-icon state-icon-error"><CircleHelp size={21} strokeWidth={1.8} aria-hidden="true" /></div><div><strong>暂时无法读取记录</strong><p>{message}</p><button className="text-button" type="button" onClick={onRetry}>重试</button></div></div>;
}

export function EmptyState({ title, showDemo, creatingDemo, onDemo }: { title: string; showDemo: boolean; creatingDemo: boolean; onDemo: () => void }) {
  return <div className="timeline-state state-empty"><div><strong>{title}</strong>{showDemo ? <button className="secondary-button" type="button" onClick={onDemo} disabled={creatingDemo}>{creatingDemo ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />}<span>{creatingDemo ? "准备预置记录中" : "加入预置记录"}</span></button> : null}</div></div>;
}
