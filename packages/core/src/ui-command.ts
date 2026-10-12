import { entitySearchTerms, normalizeEntitySearchTerm } from "./mention.js";
import { createDateOnly, type EntityKind } from "./model.js";

/**
 * The vocabulary an AI turn may use to drive the interface.
 *
 * Two rules make this safe, and both are load-bearing:
 *
 *  1. The model never executes anything. It proposes; the server compiles a
 *     proposal into one of these commands (resolving names to ids, rejecting
 *     anything outside the whitelist); the client runs the compiled result.
 *  2. There is no write command in P0. Creating, updating and deleting stay
 *     behind the backfill draft/confirm flow, where a human clicks the button.
 *
 * `settings` is deliberately absent from `UI_VIEW_IDS`: the owner can be sent
 * to the pages they read, not to the pages that hold credentials.
 */
export const UI_VIEW_IDS = ["today", "timeline", "calendar", "tasks", "notes", "entities", "timemachine"] as const;
export type UiViewId = (typeof UI_VIEW_IDS)[number];

/** The same keys `SearchFilters` uses, so the client can assign them straight through. */
export interface UiSearchRecordsParams {
  readonly query?: string;
  readonly kinds?: readonly string[];
  readonly personIds?: readonly string[];
  readonly placeIds?: readonly string[];
  readonly entityIds?: readonly string[];
  readonly statuses?: readonly string[];
  readonly attachments?: readonly string[];
  readonly entityTypes?: readonly string[];
  readonly backfill?: "all" | "ai";
  readonly assisted?: boolean;
  readonly from?: string;
  readonly to?: string;
}

export interface UiPrivacyRequestParams {
  /** Shown to the owner verbatim. Written by the server, not by the model. */
  readonly reason: string;
  readonly scope: "once" | "session";
}

export type UiCommand =
  | { readonly type: "search.records"; readonly params: UiSearchRecordsParams }
  | { readonly type: "view.goto"; readonly params: { readonly view: UiViewId } }
  | { readonly type: "date.goto"; readonly params: { readonly date: string } }
  | { readonly type: "entity.open"; readonly params: { readonly entityId: string } }
  | { readonly type: "record.focus"; readonly params: { readonly recordId: string } }
  | { readonly type: "privacy.requestAccess"; readonly params: UiPrivacyRequestParams };

export type UiCommandType = UiCommand["type"];

/** A command the owner has to click, because the sentence was a question rather than an order. */
export interface UiOffer {
  readonly label: string;
  readonly command: UiCommand;
}

/**
 * Two people may both be called 姐姐 — that is a fact about language, not a data
 * error. When a term matches more than one entity we never guess: we ask, and we
 * make the candidates tellable apart (name plus whatever the log knows about
 * them). See `resolveUiEntity`.
 */
export interface UiClarifyCandidate {
  readonly entityId: string;
  readonly name: string;
  readonly hint?: string;
}

export interface UiClarify {
  /** The word the owner used, e.g. 姐姐. Echoed back so the question reads naturally. */
  readonly term: string;
  readonly question: string;
  readonly candidates: readonly UiClarifyCandidate[];
}

export interface UiTurnPlan {
  /** Compiled commands to run now. */
  readonly commands?: readonly UiCommand[];
  /** Commands held behind a button. */
  readonly offers?: readonly UiOffer[];
  /** Set instead of commands when the sentence was ambiguous. */
  readonly clarify?: UiClarify;
}

export interface UiCommandParamSpec {
  readonly name: string;
  readonly kind: "string" | "string[]" | "date" | "enum" | "boolean";
  readonly required: boolean;
  readonly values?: readonly string[];
  readonly describe: string;
}

export interface UiCommandSpec {
  readonly type: UiCommandType;
  readonly scope: "server" | "client";
  /**
   * Whether the model is told this command exists. `privacy.requestAccess` is
   * `false` on purpose: permission to read private records is asked for by the
   * app when it can see that records are being withheld, never by a model that
   * has no idea they are there. A model that could ask would also ask when it
   * had merely failed to find something.
   */
  readonly modelFacing: boolean;
  readonly describe: string;
  readonly params: readonly UiCommandParamSpec[];
}

/**
 * One table, three jobs: it generates the prompt block the model reads, it is
 * the whitelist the server validates against, and it is the list the acceptance
 * script walks when measuring coverage. Adding a capability here is the only way
 * to teach the assistant about it.
 */
export const UI_COMMANDS: readonly UiCommandSpec[] = [
  {
    type: "search.records",
    scope: "server",
    modelFacing: true,
    describe: "按条件筛选记录，并把筛选结果显示在记录流里。用户问「有哪些 / 展示 / 找一下」时用它。",
    params: [
      { name: "query", kind: "string", required: false, describe: "正文关键词，用户给了明确词才填" },
      { name: "kinds", kind: "string[]", required: false, values: ["journal", "task", "event", "note", "photo", "file"], describe: "记录类型" },
      { name: "personIds", kind: "string[]", required: false, describe: "人物实体 id，必须来自 existingObjects" },
      { name: "placeIds", kind: "string[]", required: false, describe: "地点实体 id，必须来自 existingObjects" },
      { name: "entityIds", kind: "string[]", required: false, describe: "电影、项目、主题等其它实体 id" },
      { name: "statuses", kind: "string[]", required: false, values: ["todo", "in_progress", "done", "cancelled"], describe: "任务状态，仅当 kinds 含 task" },
      { name: "attachments", kind: "string[]", required: false, values: ["photo", "file"], describe: "带照片或附件" },
      { name: "entityTypes", kind: "string[]", required: false, describe: "关联对象类型" },
      { name: "backfill", kind: "enum", required: false, values: ["all", "ai"], describe: "补记 / 辅记" },
      { name: "assisted", kind: "boolean", required: false, describe: "只看辅记记录" },
      { name: "from", kind: "date", required: false, describe: "起始日期 YYYY-MM-DD，闭区间" },
      { name: "to", kind: "date", required: false, describe: "结束日期 YYYY-MM-DD，闭区间" },
    ],
  },
  {
    type: "view.goto",
    scope: "client",
    modelFacing: true,
    describe: "切换页面。只在用户明确要求去某个页面时用。",
    params: [{ name: "view", kind: "enum", required: true, values: UI_VIEW_IDS, describe: "目标页面" }],
  },
  {
    type: "date.goto",
    scope: "client",
    modelFacing: true,
    describe: "把浏览日期跳到某一天。不能跳到未来。",
    params: [{ name: "date", kind: "date", required: true, describe: "YYYY-MM-DD" }],
  },
  {
    type: "entity.open",
    scope: "client",
    modelFacing: true,
    describe: "打开某个人物、地点或对象的资料卡。",
    params: [{ name: "entityId", kind: "string", required: true, describe: "实体 id，必须来自 existingObjects" }],
  },
  {
    type: "record.focus",
    scope: "client",
    modelFacing: true,
    describe: "在记录流里滚到某一条记录并高亮它。",
    params: [{ name: "recordId", kind: "string", required: true, describe: "记录 id，必须来自 existingRecords" }],
  },
  {
    type: "privacy.requestAccess",
    scope: "client",
    modelFacing: false,
    describe: "隐私记录被总开关挡住、又确实可能答得上时，向用户申请这一次的查看许可。不要用它解释自己找不到东西。",
    params: [
      { name: "reason", kind: "string", required: true, describe: "给用户看的一句话，说明为什么需要" },
      { name: "scope", kind: "enum", required: true, values: ["once", "session"], describe: "授权范围" },
    ],
  },
];

export const UI_COMMAND_TYPES: readonly UiCommandType[] = UI_COMMANDS.map((spec) => spec.type);

/** The prompt block generated from the registry — never hand-written. */
export function describeUiCommands(): string {
  const lines = UI_COMMANDS.filter((spec) => spec.modelFacing).map((spec) => {
    const params = spec.params.map((param) => {
      const values = param.values === undefined ? "" : `（${param.values.join("|")}）`;
      return `${param.name}${param.required ? "" : "?"}:${param.kind}${values} ${param.describe}`;
    });
    return `- ${spec.type}：${spec.describe} 参数：${params.length === 0 ? "无" : params.join("；")}`;
  });
  return [
    "可用界面命令（只能从这里选，不得自创命令名或路径）：",
    ...lines,
    "只读与跳转可以直接下发 commands；拿不准要不要跳，放进 offers 让用户点；词指向多个实体时不要猜，返回 clarify。",
  ].join("\n");
}

/** Structural view of an entity — `Entity` satisfies it, and so does a projection. */
export interface UiEntityLike {
  readonly id: string;
  readonly type: EntityKind;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
}

export type UiEntityResolution =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly entityId: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly UiClarifyCandidate[] };

/**
 * Resolve a word the owner used (姐姐) to an entity id.
 *
 * Aliases are deliberately **not** unique. Two people can both carry 姐姐, and
 * forbidding that would be wrong: 姐姐 is a role from the speaker's side, not an
 * identifier. So a term that matches two entities is a normal outcome, and the
 * caller must ask rather than pick. An exact name match beats an alias match, so
 * a person actually named 姐姐 still resolves in one step.
 */
export function resolveUiEntity(term: string, entities: readonly UiEntityLike[]): UiEntityResolution {
  const needle = normalizeEntitySearchTerm(term);
  if (!needle) return { kind: "none" };
  const byName = entities.filter((entity) => normalizeEntitySearchTerm(entity.name) === needle);
  const matches = byName.length > 0 ? byName : entities.filter((entity) => entitySearchTerms(entity).some((candidate) => normalizeEntitySearchTerm(candidate) === needle));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", entityId: matches[0]!.id };
  return {
    kind: "ambiguous",
    candidates: matches
      .map((entity) => ({
        entityId: entity.id,
        name: entity.name,
        ...(entity.description?.trim() ? { hint: entity.description.trim().slice(0, 40) } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN")),
  };
}

/** Which `SearchFilters` bucket an entity type belongs in — the mapping the UI already uses. */
export function entityFilterKey(type: EntityKind): "personIds" | "placeIds" | "entityIds" {
  return type === "person" ? "personIds" : type === "place" ? "placeIds" : "entityIds";
}

export interface UiValidationContext {
  readonly entityIds: ReadonlySet<string>;
  readonly recordIds: ReadonlySet<string>;
  /** Today in Asia/Shanghai. The single source for "is this date in the future". */
  readonly today: string;
}

export type UiCommandValidation =
  | { readonly ok: true; readonly command: UiCommand }
  | { readonly ok: false; readonly reason: string };

const SEARCH_STRING_ARRAY_KEYS = ["kinds", "personIds", "placeIds", "entityIds", "statuses", "attachments", "entityTypes"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  return value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200) ? value as readonly string[] : undefined;
}

function dateOnly(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { createDateOnly(value); } catch { return undefined; }
  return value;
}

function checkSearchParams(raw: unknown, context: UiValidationContext): UiSearchRecordsParams | string {
  if (!isRecord(raw)) return "search.records 参数必须是对象";
  const params: Record<string, unknown> = {};
  if (raw["query"] !== undefined) {
    if (typeof raw["query"] !== "string" || raw["query"].length > 200) return "query 不合法";
    if (raw["query"].trim()) params["query"] = raw["query"].trim();
  }
  for (const key of SEARCH_STRING_ARRAY_KEYS) {
    if (raw[key] === undefined) continue;
    const values = stringArray(raw[key]);
    if (values === undefined) return `${key} 必须是字符串数组`;
    if (values.length > 0) params[key] = values;
  }
  for (const key of ["from", "to"] as const) {
    if (raw[key] === undefined) continue;
    const date = dateOnly(raw[key]);
    if (date === undefined) return `${key} 必须是 YYYY-MM-DD`;
    params[key] = date;
  }
  if (raw["backfill"] !== undefined) {
    if (raw["backfill"] !== "all" && raw["backfill"] !== "ai") return "backfill 只能是 all 或 ai";
    params["backfill"] = raw["backfill"];
  }
  if (raw["assisted"] !== undefined) {
    if (typeof raw["assisted"] !== "boolean") return "assisted 必须是布尔值";
    params["assisted"] = raw["assisted"];
  }
  const from = params["from"] as string | undefined;
  const to = params["to"] as string | undefined;
  if (from !== undefined && to !== undefined && from > to) return "from 不能晚于 to";
  if (to !== undefined && to > context.today) return "to 不能是未来日期";
  if (Object.keys(params).length === 0) return "search.records 至少要有一个筛选条件";
  for (const key of ["personIds", "placeIds", "entityIds"] as const) {
    const values = params[key] as readonly string[] | undefined;
    if (values === undefined) continue;
    const unknown = values.filter((id) => !context.entityIds.has(id));
    if (unknown.length > 0) return `${key} 含未知实体 id：${unknown.join("、")}`;
  }
  return params as UiSearchRecordsParams;
}

/**
 * Validate one command. Invalid commands are dropped by `validateUiTurnPlan`,
 * never repaired: a model that invents an entity id or a future date loses that
 * command and nothing else.
 */
export function validateUiCommand(raw: unknown, context: UiValidationContext): UiCommandValidation {
  if (!isRecord(raw)) return { ok: false, reason: "命令必须是对象" };
  const type = raw["type"];
  if (typeof type !== "string" || !UI_COMMAND_TYPES.includes(type as UiCommandType)) return { ok: false, reason: `未知命令：${String(type)}` };
  const params = raw["params"] ?? {};
  if (!isRecord(params)) return { ok: false, reason: "params 必须是对象" };
  switch (type as UiCommandType) {
    case "search.records": {
      const checked = checkSearchParams(params, context);
      return typeof checked === "string" ? { ok: false, reason: checked } : { ok: true, command: { type: "search.records", params: checked } };
    }
    case "view.goto": {
      const view = params["view"];
      if (typeof view !== "string" || !UI_VIEW_IDS.includes(view as UiViewId)) return { ok: false, reason: `不支持的页面：${String(view)}` };
      return { ok: true, command: { type: "view.goto", params: { view: view as UiViewId } } };
    }
    case "date.goto": {
      const date = dateOnly(params["date"]);
      if (date === undefined) return { ok: false, reason: "date 必须是 YYYY-MM-DD" };
      if (date > context.today) return { ok: false, reason: "不能跳到未来日期" };
      return { ok: true, command: { type: "date.goto", params: { date } } };
    }
    case "entity.open": {
      const entityId = params["entityId"];
      if (typeof entityId !== "string" || !context.entityIds.has(entityId)) return { ok: false, reason: "entityId 不是已知实体" };
      return { ok: true, command: { type: "entity.open", params: { entityId } } };
    }
    case "record.focus": {
      const recordId = params["recordId"];
      if (typeof recordId !== "string" || !context.recordIds.has(recordId)) return { ok: false, reason: "recordId 不是已知记录" };
      return { ok: true, command: { type: "record.focus", params: { recordId } } };
    }
    case "privacy.requestAccess": {
      const reason = params["reason"];
      const scope = params["scope"];
      if (typeof reason !== "string" || !reason.trim() || reason.length > 200) return { ok: false, reason: "reason 不合法" };
      if (scope !== "once" && scope !== "session") return { ok: false, reason: "scope 只能是 once 或 session" };
      return { ok: true, command: { type: "privacy.requestAccess", params: { reason: reason.trim(), scope } } };
    }
  }
}

export interface UiTurnPlanValidation {
  readonly plan: UiTurnPlan;
  /** Reasons for commands that were thrown away — logged, never shown as success. */
  readonly rejected: readonly string[];
}

/**
 * Validate a whole turn. Anything invalid is dropped and reported; the turn
 * itself survives, so one bad command cannot turn a useful answer into an error.
 *
 * `clarify` and `commands` are mutually exclusive on purpose: when the owner's
 * word was ambiguous, running a guess and asking a question in the same breath is
 * how a confident wrong filter gets applied.
 */
export function validateUiTurnPlan(raw: unknown, context: UiValidationContext): UiTurnPlanValidation {
  if (raw === undefined || raw === null) return { plan: {}, rejected: [] };
  if (!isRecord(raw)) return { plan: {}, rejected: ["turn plan 必须是对象"] };
  const rejected: string[] = [];
  const commands: UiCommand[] = [];
  for (const item of Array.isArray(raw["commands"]) ? raw["commands"] : []) {
    const checked = validateUiCommand(item, context);
    if (checked.ok) commands.push(checked.command); else rejected.push(checked.reason);
  }
  const offers: UiOffer[] = [];
  for (const item of Array.isArray(raw["offers"]) ? raw["offers"] : []) {
    if (!isRecord(item) || typeof item["label"] !== "string" || !item["label"].trim()) { rejected.push("offer 缺少 label"); continue; }
    const checked = validateUiCommand(item["command"], context);
    if (checked.ok) offers.push({ label: item["label"].trim().slice(0, 30), command: checked.command }); else rejected.push(checked.reason);
  }
  const clarifyRaw = raw["clarify"];
  let clarify: UiClarify | undefined;
  if (clarifyRaw !== undefined) {
    if (!isRecord(clarifyRaw) || !Array.isArray(clarifyRaw["candidates"])) rejected.push("clarify 结构不正确");
    else if (clarifyRaw["candidates"].length <= 1) rejected.push("clarify 候选不足两个");
    else {
      const candidates = clarifyRaw["candidates"].slice(0, 8).flatMap((item) => {
        if (!isRecord(item) || typeof item["entityId"] !== "string" || !context.entityIds.has(item["entityId"]) || typeof item["name"] !== "string" || !item["name"].trim()) return [];
        const hint = typeof item["hint"] === "string" && item["hint"].trim() ? item["hint"].trim().slice(0, 40) : undefined;
        return [{ entityId: item["entityId"], name: item["name"].trim(), ...(hint === undefined ? {} : { hint }) }];
      });
      if (candidates.length > 1) {
        const term = typeof clarifyRaw["term"] === "string" && clarifyRaw["term"].trim() ? clarifyRaw["term"].trim().slice(0, 40) : "这个词";
        const question = typeof clarifyRaw["question"] === "string" && clarifyRaw["question"].trim() ? clarifyRaw["question"].trim().slice(0, 120) : `你说的「${term}」对应哪一位？`;
        clarify = { term, question, candidates };
      } else rejected.push("clarify 可用候选不足两个");
    }
  }
  const plan: UiTurnPlan = {
    ...(commands.length === 0 ? {} : { commands }),
    ...(offers.length === 0 ? {} : { offers }),
    ...(clarify === undefined ? {} : { clarify }),
  };
  if (clarify !== undefined) return { plan: { clarify, ...(offers.length === 0 ? {} : { offers }) }, rejected };
  return { plan, rejected };
}

export interface UiCompileContext extends UiValidationContext {
  readonly entities: readonly UiEntityLike[];
  /**
   * One short line that tells two same-named people apart — "上次一起出现在 2 天前".
   * Lives here as a callback because only the caller has the records.
   */
  readonly entityHint?: (entityId: string) => string | undefined;
}

interface CompiledCommand {
  readonly command?: Record<string, unknown>;
  readonly clarify?: UiClarify;
  readonly reason?: string;
}

function clarifyFor(term: string, candidates: readonly UiClarifyCandidate[], context: UiCompileContext): UiClarify {
  return {
    term,
    question: `你说的「${term}」对应哪一位？`,
    candidates: candidates.map((candidate) => {
      const hint = context.entityHint?.(candidate.entityId) ?? candidate.hint;
      return hint === undefined ? candidate : { ...candidate, hint };
    }),
  };
}

/**
 * Turn whatever the model wrote into something runnable.
 *
 * The model is allowed to write a name or a nickname where an id belongs —
 * 「姐姐」, not `ent_7f3a`. Resolving that here, on the server, is the whole
 * point: the model cannot see the entity table, so it cannot pick between two
 * people who share a nickname, and it must not try.
 *
 * A term that matches nothing kills its command outright. Silently dropping an
 * unresolved filter would *widen* the result — the owner asks for 姐姐's entries
 * and gets everybody's — which is worse than doing nothing.
 */
function compileOneCommand(raw: unknown, context: UiCompileContext): CompiledCommand {
  if (!isRecord(raw)) return { reason: "命令必须是对象" };
  const type = raw["type"];
  if (typeof type !== "string") return { reason: "命令缺少 type" };
  const params: Record<string, unknown> = isRecord(raw["params"]) ? { ...raw["params"] } : {};
  if (type === "entity.open") {
    const term = params["entityId"];
    if (typeof term !== "string" || !term.trim()) return { reason: "entity.open 缺少 entityId" };
    const trimmed = term.trim();
    if (context.entityIds.has(trimmed)) return { command: { type, params: { entityId: trimmed } } };
    const resolved = resolveUiEntity(trimmed, context.entities);
    if (resolved.kind === "none") return { reason: `认不出对象「${trimmed}」` };
    if (resolved.kind === "ambiguous") return { clarify: clarifyFor(trimmed, resolved.candidates, context) };
    return { command: { type, params: { entityId: resolved.entityId } } };
  }
  if (type === "search.records") {
    const terms: string[] = [];
    for (const key of ["personIds", "placeIds", "entityIds"] as const) {
      const value = params[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) return { reason: `${key} 必须是数组` };
      for (const item of value) {
        if (typeof item !== "string" || !item.trim()) return { reason: `${key} 里有空值` };
        terms.push(item.trim());
      }
      delete params[key];
    }
    const buckets: Record<string, string[]> = {};
    for (const term of terms) {
      const direct = context.entities.find((entity) => entity.id === term);
      if (direct !== undefined) {
        const key = entityFilterKey(direct.type);
        (buckets[key] ??= []).push(direct.id);
        continue;
      }
      const resolved = resolveUiEntity(term, context.entities);
      if (resolved.kind === "none") return { reason: `认不出对象「${term}」，这条筛选已丢弃（不猜，也不放宽）` };
      if (resolved.kind === "ambiguous") return { clarify: clarifyFor(term, resolved.candidates, context) };
      const entity = context.entities.find((item) => item.id === resolved.entityId);
      if (entity === undefined) return { reason: `认不出对象「${term}」` };
      const key = entityFilterKey(entity.type);
      (buckets[key] ??= []).push(resolved.entityId);
    }
    for (const [key, ids] of Object.entries(buckets)) params[key] = [...new Set(ids)];
    return { command: { type, params } };
  }
  return { command: { type, params } };
}

/**
 * Compile a model turn into a runnable plan, then validate it.
 *
 * Ambiguity wins over everything: if any term is ambiguous, every command in the
 * turn is held back and the owner is asked. Asking and acting in the same breath
 * is how a wrong filter gets applied with full confidence.
 */
export function compileUiTurnPlan(raw: unknown, context: UiCompileContext): UiTurnPlanValidation {
  if (raw === undefined || raw === null) return { plan: {}, rejected: [] };
  if (!isRecord(raw)) return { plan: {}, rejected: ["turn plan 必须是对象"] };
  const rejected: string[] = [];
  let clarify: UiClarify | undefined;
  const commands: unknown[] = [];
  for (const item of Array.isArray(raw["commands"]) ? raw["commands"] : []) {
    const one = compileOneCommand(item, context);
    if (one.clarify !== undefined) clarify ??= one.clarify;
    else if (one.command !== undefined) commands.push(one.command);
    else rejected.push(one.reason ?? "命令无法编译");
  }
  const offers: unknown[] = [];
  for (const item of Array.isArray(raw["offers"]) ? raw["offers"] : []) {
    if (!isRecord(item)) { rejected.push("offer 结构不正确"); continue; }
    const one = compileOneCommand(item["command"], context);
    if (one.clarify !== undefined) clarify ??= one.clarify;
    else if (one.command !== undefined) offers.push({ label: item["label"], command: one.command });
    else rejected.push(one.reason ?? "offer 无法编译");
  }
  if (clarify !== undefined && commands.length > 0) rejected.push("词有歧义，已取消本次跳转与筛选");
  const assembled = clarify === undefined ? { commands, offers } : { clarify: clarify as unknown, offers };
  const validated = validateUiTurnPlan(assembled, context);
  return { plan: validated.plan, rejected: [...rejected, ...validated.rejected] };
}
