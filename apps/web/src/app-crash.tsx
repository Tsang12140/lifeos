import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { LAST_CRASH_STORAGE_KEY, copyRecentJson, logEvent } from "./diagnostics";
import { clearLocalCache } from "./local-cache";
import "./app-crash.css";

/**
 * A React tree that throws unmounts itself, and React leaves the root element empty.
 * The static startup screen in `index.html` is a child of that same root, so it goes
 * with it — which is why a rendering error used to be an unexplained white page with
 * no console to open on a phone. This boundary is the only thing standing between a
 * bad record and an owner who cannot tell "broken" from "loading".
 *
 * It is deliberately not a retry loop: a render error caused by stored data will
 * reproduce on every mount, so the screen offers a reload and a cache wipe instead.
 */

export interface CrashReport {
  readonly at: string;
  readonly message: string;
  readonly href: string;
  readonly stack?: string;
  readonly component?: string;
}

export function rememberCrash(error: Error, info?: ErrorInfo): CrashReport {
  const report: CrashReport = {
    at: new Date().toISOString(),
    message: error.message || "未知错误",
    href: window.location.href,
    ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
    ...(info?.componentStack ? { component: info.componentStack.slice(0, 4000) } : {}),
  };
  try { window.localStorage.setItem(LAST_CRASH_STORAGE_KEY, JSON.stringify(report)); } catch { /* private mode: the screen still shows it */ }
  return report;
}

export function lastCrashReport(): CrashReport | null {
  try {
    const raw = window.localStorage.getItem(LAST_CRASH_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    return typeof value.message === "string" && typeof value.at === "string"
      ? { at: value.at, message: value.message, href: typeof value.href === "string" ? value.href : "", ...(typeof value.stack === "string" ? { stack: value.stack } : {}) }
      : null;
  } catch {
    return null;
  }
}

const shortTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleString("zh-CN", { hour12: false }) : iso;
};

function CrashScreen({ error }: { error: Error }) {
  const [notice, setNotice] = useState<string | null>(null);
  const previous = lastCrashReport();
  return <main className="startup-screen" role="alert" aria-label="LifeOS 界面出错">
    <div className="startup-content">
      <div className="startup-brand"><img className="startup-brand-mark" src="/favicon.svg?v=3" width={40} height={40} alt="" /><span>LifeOS</span></div>
      <div className="startup-crash">
        <p className="startup-crash-title">界面没能显示出来</p>
        <p className="startup-crash-detail">{error.message || "未知错误"}</p>
        <p className="startup-crash-hint">多半是本地缓存或某条数据让页面卡住了。先重载；还是这样，就清一次本地缓存（草稿和输入框内容会保留）。</p>
        <div className="startup-crash-actions">
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
          <button type="button" onClick={() => { try { clearLocalCache(); } catch { /* nothing else to clear */ } window.location.reload(); }}>清理本地缓存并重载</button>
          <button type="button" onClick={() => { void copyRecentJson().then(ok => setNotice(ok ? "诊断信息已复制。" : "复制被拒绝，可以直接截这张图。")); }}>复制诊断信息</button>
        </div>
        {notice ? <p className="startup-crash-note" role="status">{notice}</p> : null}
        <p className="startup-crash-meta">{previous ? `上次异常：${shortTime(previous.at)}` : `时间：${shortTime(new Date().toISOString())}`}</p>
      </div>
    </div>
  </main>;
}

interface BoundaryState { readonly error: Error | null }

export class AppCrashBoundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const report = rememberCrash(error, info);
    logEvent("error", `界面崩溃：${report.message}`, report.component ?? report.stack ?? "");
  }

  render(): ReactNode {
    return this.state.error ? <CrashScreen error={this.state.error} /> : this.props.children;
  }
}
