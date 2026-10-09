import { calendarToday, createDateOnly, CYCLE_INTIMACY_EVENT_KINDS, HABIT_ICON_IDS, periodEndSpan, type BackfillAction, type CycleIntimacyModuleData } from "@lifeos/core";
import { randomUUID } from "node:crypto";
import { booleanField, enumField, jsonObject, stringField } from "./field-validate.js";
import { HttpError } from "./http-kit.js";
import type { SqliteRecordRepository } from "./repository.js";

export function validateAssistantActions(raw: unknown, repository: SqliteRecordRepository): BackfillAction[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) throw new HttpError(400, "invalid_actions", "标记方案格式不正确");
  return raw.map(value => {
    const a = jsonObject(value, "标记方案");
    const str = (key: string, max = 200) => { const value = a[key] === undefined ? "" : stringField(a[key], key); if (value.length > max) throw new HttpError(400, "invalid_actions", "标记内容过长"); return value; };
    const type = enumField(a.type, ["cycle", "habit"] as const, "type");
    const common = { key: str("key", 100), type, date: str("date", 10), selected: a.selected === undefined ? true : booleanField(a.selected, "selected"), marked: a.marked === undefined ? true : booleanField(a.marked, "marked"), evidence: str("evidence", 2000), questions: str("questions", 2000) };
    if (common.date) { try { createDateOnly(common.date); } catch { throw new HttpError(400, "invalid_date", "标记日期格式不正确"); } }
    if (!common.key) throw new HttpError(400, "invalid_actions", "标记需要编号");
    if (type === "cycle") return { ...common, cycleKind: enumField(a.cycleKind, CYCLE_INTIMACY_EVENT_KINDS, "cycleKind") };
    const habitId = str("habitId", 100);
    const habit = (repository.cycleIntimacyModule().config.habits ?? []).find(item => item.id === habitId);
    if (habitId && !habit) throw new HttpError(400, "unknown_habit", "习惯不存在，请重新选择");
    const name = (habit?.name ?? str("name", 40)).trim(), icon = habit?.icon ?? (str("icon", 100) || "BookOpen");
    if (!name || !HABIT_ICON_IDS.has(icon)) throw new HttpError(400, "invalid_habit", "习惯需要名称和图标库中的图标");
    return { ...common, name, icon, ...(habit ? { habitId: habit.id } : {}) };
  });
}

export function applyAssistantActions(repository: SqliteRecordRepository, actions: readonly BackfillAction[], snapshot?: CycleIntimacyModuleData): CycleIntimacyModuleData {
  let module = repository.cycleIntimacyModule();
  if (snapshot && JSON.stringify(module) !== JSON.stringify(snapshot)) throw new HttpError(409, "cycle_conflict", "周期或习惯已改变，请重新核对方案");
  for (const a of actions) {
    if (a.questions.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(a.date) || a.date > calendarToday()) throw new HttpError(400, "unresolved_action", "请核对日期；未来日期不能标记完成");
    if (a.type === "cycle") {
      let events = [...module.events];
      if (!a.marked) events = events.filter(e => e.date !== a.date || e.kind !== a.cycleKind);
      else if (!events.some(e => e.date === a.date && e.kind === a.cycleKind)) {
        const span = a.cycleKind === "period_end" ? periodEndSpan(events, a.date) : undefined;
        if (span) events = events.filter(e => e.kind !== "period_end" || (span.from !== undefined && e.date < span.from) || (span.until !== undefined && e.date >= span.until));
        events.push({ id: randomUUID(), date: a.date, kind: a.cycleKind! });
      }
      module = { config: { ...module.config, ...(a.marked ? { enabled: true } : {}) }, events: events.sort((x,y) => x.date.localeCompare(y.date) || x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id)) };
    } else {
      const habits = [...(module.config.habits ?? [])];
      let index = habits.findIndex(h => a.habitId ? h.id === a.habitId : h.name === a.name);
      if (index < 0) { if (!a.marked || habits.length >= 100) throw new HttpError(400, "unknown_habit", "请先建立习惯"); habits.push({ id: randomUUID(), name: a.name!, icon: a.icon!, revision: 1, dates: [] }); index = habits.length - 1; }
      const habit = habits[index]!; const dates = new Set(habit.dates);
      if (a.marked) dates.add(a.date); else dates.delete(a.date);
      habits[index] = { ...habit, revision: habit.revision + 1, dates: [...dates].sort() };
      module = { ...module, config: { ...module.config, habits } };
    }
  }
  repository.replaceCycleIntimacyModule(module);
  return repository.cycleIntimacyModule();
}
