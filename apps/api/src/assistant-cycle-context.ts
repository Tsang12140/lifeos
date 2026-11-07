import { appLockRepositoryPolicy } from "./app-lock-context.js";
import type { SqliteRecordRepository } from "./repository.js";

/**
 * Cycle facts carry their subject, independently of who owns the space or asks.
 *
 * Every marker kind is returned here. Filtering `intimacy` / `fitness` out of this
 * payload is what made the assistant answer "you never recorded it" while the
 * calendar clearly showed a heart: to a model, an omitted field and an absent
 * marker read the same. Visibility is decided by the `cycle` app lock — the gate
 * that already protects `cycleIntimacyModule` — never by a boolean each caller
 * has to remember to pass.
 */
export function assistantCycleContext(repository: SqliteRecordRepository) {
  const module = repository.cycleIntimacyModule();
  // Read the policy, not the ambient lock state: `appTargetLocked` only answers inside a
  // proxied method call, so asking it here would always report "unlocked" while
  // `cycleIntimacyModule` had already returned the empty locked payload.
  const locked = appLockRepositoryPolicy(repository)?.locked("cycle") ?? false;
  const people = new Map(repository.listEntities().filter(entity => entity.type === "person").map(entity => [entity.id, entity.name]));
  const describe = (subjectId: string | undefined, cycleLength: number, periodLength: number, anchorStart: string | undefined, events: readonly { date: string; kind: string }[]) => {
    // Newest first is what "上一次" questions need; counts keep the full picture.
    const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date));
    const kinds = ["period_start", "period_end", "intimacy", "fitness"] as const;
    const counts = Object.fromEntries(kinds.map(kind => [kind, events.filter(event => event.kind === kind).length]));
    const latest = Object.fromEntries(kinds.flatMap(kind => {
      const hit = sorted.find(event => event.kind === kind);
      return hit ? [[kind, hit.date] as const] : [];
    }));
    return {
      subject: subjectId ? { personId: subjectId, name: people.get(subjectId) ?? "已移除的联系人" } : { self: true, name: "当前用户本人" },
      cycleLength,
      periodLength,
      ...(anchorStart ? { anchorStart } : {}),
      latest,
      counts,
      // A year of daily habit ticks is a few KB; the cap only guards pathological imports.
      events: sorted.slice(0, 400).map(event => ({ date: event.date, kind: event.kind })),
      ...(sorted.length > 400 ? { truncated: true } : {}),
    };
  };
  const other = Object.entries(module.config.otherSubjects ?? {}).map(([key, value]) => describe(key === "self" ? undefined : key, value.cycleLength, value.periodLength, value.anchorStart, value.events));
  return {
    ...(locked ? { locked: true } : {}),
    enabled: module.config.enabled,
    selectedSubject: module.config.subjectId ?? "self",
    cycles: [describe(module.config.subjectId, module.config.cycleLength, module.config.periodLength, module.config.anchorStart, module.events), ...other],
  };
}

/** The payload above is unreadable unless the model is told how to read an empty list. */
export const CYCLE_CONTEXT_RULE = "cycleContext 是周期模块的完整标记与周期参数：period_start／period_end 是经期边界，intimacy 是亲密标记，fitness 是习惯打卡；latest 给出每类标记最近一次的日期，counts 是各自数量，events 是全部标记（新到旧，最多 400 条）。问「上一次」「多久没」这类问题直接用 latest 或 events 回答，不要改去日记正文里搜同义词——标记和日记是两套来源，日记里没写不等于没记过。events 为空表示确实一条都没记；locked=true 表示模块被应用锁保护、本轮读不到，只能说「被锁住、需要先解锁」，不能说不存在。enabled=false 只表示模块入口已关闭，历史标记仍然有效。习惯打卡的日期就是 fitness 事件，习惯的名称与图标见 existingHabits。";
