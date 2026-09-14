import type { RecordView } from "./api";

interface ModelContextTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly untrustedContentHint?: boolean };
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
}

interface ModelContext {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputString(input: unknown, key: string): string {
  if (!isRecord(input) || typeof input[key] !== "string") {
    throw new Error(`${key} 必须是字符串`);
  }
  return input[key] as string;
}

export function registerWebMcp(input: {
  readRecords: (query: { readonly q?: string }) => readonly RecordView[];
  navigateTo: (view: "today" | "timeline" | "tasks" | "notes") => void;
}): () => void {
  const context = (document as Document & { modelContext?: ModelContext }).modelContext;
  if (!context?.registerTool) return () => undefined;
  const lifecycle = new AbortController();
  const register = (tool: ModelContextTool) => {
    try {
      void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
    } catch {
      // Unsupported or unavailable registration must never affect the visible app.
    }
  };

  register({
    name: "read_lifeos_records",
    title: "读取 LifeOS 记录",
    description: "读取当前已经加载在 LifeOS 时间轴中的记录。只读，不改变页面或数据。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: () => ({ items: input.readRecords({}) }),
  });

  register({
    name: "search_lifeos_records",
    title: "搜索 LifeOS 记录",
    description: "按关键词搜索当前已经加载在 LifeOS 页面中的记录。只读，不改变页面或数据。",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", minLength: 1 } },
      required: ["q"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: (rawInput) => ({ items: input.readRecords({ q: inputString(rawInput, "q") }) }),
  });

  register({
    name: "show_lifeos_view",
    title: "打开 LifeOS 页面",
    description: "打开 LifeOS 的今天、时间轴、任务或笔记页面。只改变当前页面视图。",
    inputSchema: {
      type: "object",
      properties: { view: { type: "string", enum: ["today", "timeline", "tasks", "notes"] } },
      required: ["view"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: (rawInput) => {
      const view = inputString(rawInput, "view");
      if (view !== "today" && view !== "timeline" && view !== "tasks" && view !== "notes") {
        throw new Error("view 不受支持");
      }
      input.navigateTo(view);
      return { view };
    },
  });

  return () => lifecycle.abort();
}
