/**
 * Front-end diagnostics: a small ring buffer of everything that went wrong or
 * mattered, so a user can hand me a recent slice instead of a blank "它坏了".
 * The buffer holds 200 entries; the copy button exports only the most recent
 * 50 — enough to debug, short enough not to waste tokens.
 */

export interface DiagEntry {
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly detail?: string;
}

const CAPACITY = 200;
export const COPY_COUNT = 50;
/** Written by the crash boundary so the previous failure survives the reload that follows it. */
export const LAST_CRASH_STORAGE_KEY = "lifeos.lastCrash.v1";
const buffer: DiagEntry[] = [];
const listeners = new Set<() => void>();

export function logEvent(level: DiagEntry["level"], message: string, detail?: string): void {
  buffer.push({ at: new Date().toISOString(), level, message, detail });
  if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
  for (const listener of listeners) listener();
}

export function recentLogs(count: number = COPY_COUNT): readonly DiagEntry[] {
  return buffer.slice(-count);
}

export function exportRecentJson(count: number = COPY_COUNT): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), entries: recentLogs(count) }, null, 2);
}

export async function copyRecentJson(): Promise<boolean> {
  const text = exportRecentJson();
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard permission denied or unavailable: fall back to a selection copy.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearLogs(): void {
  buffer.length = 0;
  for (const listener of listeners) listener();
}

/** Wires the global capture; safe to call more than once. */
let installed = false;
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;
  // A crash before this ran left no buffer behind; the boundary's stored report is
  // the only record of it, so it becomes the first entry of the new session.
  try {
    const raw = window.localStorage.getItem(LAST_CRASH_STORAGE_KEY);
    const previous = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    if (previous && typeof previous.message === "string") logEvent("error", `上次启动崩溃（${String(previous.at)}）：${previous.message}`, typeof previous.component === "string" ? previous.component : undefined);
  } catch { /* unreadable or blocked storage is not itself worth reporting */ }
  window.addEventListener("error", (event) => {
    logEvent("error", `未捕获错误：${event.message}`, `${event.filename}:${event.lineno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    logEvent("error", "未处理的 Promise 拒绝", reason);
  });
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logEvent("error", args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    originalError(...args);
  };
}

/** API layer calls this for every non-2xx response. */
export function logApiFailure(path: string, status: number, summary: string): void {
  logEvent("warn", `请求失败 ${status} ${path}`, summary);
}
