import { randomUUID } from "node:crypto";
import { calendarToday, HABIT_ICON_IDS, type CustomHabit } from "@lifeos/core";
import { HttpError, setJson } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { booleanField, hasOnlyKeys, jsonObject, parseDateQuery, revisionField, stringField } from "./field-validate.js";
import type { RouteHandler } from "./route-context.js";

function habitFields(input: Record<string, unknown>) {
  const name = stringField(input.name, "name", { nonEmpty: true }).trim();
  const icon = stringField(input.icon, "icon", { nonEmpty: true });
  if (!name || name.length > 40) throw new HttpError(400, "invalid_habit", "习惯名称请填写1至40字");
  if (!HABIT_ICON_IDS.has(icon)) throw new HttpError(400, "invalid_habit", "请选择图标库中的图标");
  return { name, icon };
}

export const handleHabitRoutes: RouteHandler = async (ctx, req, res, pathname) => {
  const create = pathname === "/api/modules/cycle-intimacy/habits" && req.method === "POST";
  const match = /^\/api\/modules\/cycle-intimacy\/habits\/([A-Za-z0-9_-]+)(\/days)?$/.exec(pathname);
  if (!create && !(match && (match[2] ? req.method === "PUT" : req.method === "PATCH"))) return false;
  requireJsonContentType(req);
  const input = jsonObject(await readBody(req, ctx.config.bodyLimitBytes), "body");
  hasOnlyKeys(input, create ? ["name", "icon"] : match![2] ? ["date", "marked", "revision"] : ["name", "icon", "revision"]);
  const module = ctx.repository.atomic(() => {
    const current = ctx.repository.cycleIntimacyModule();
    const habits = [...(current.config.habits ?? [])];
    if (create) {
      if (habits.length >= 100) throw new HttpError(400, "habit_limit", "最多可创建100个习惯");
      const fields = habitFields(input);
      if (habits.some(habit => habit.name === fields.name)) throw new HttpError(409, "habit_exists", "已有同名习惯");
      habits.push({ id: randomUUID(), ...fields, revision: 1, dates: [] });
    } else {
      const index = habits.findIndex(habit => habit.id === match![1]);
      const habit = habits[index];
      if (!habit) throw new HttpError(404, "not_found", "习惯不存在");
      if (revisionField(input.revision) !== habit.revision) throw new HttpError(409, "habit_conflict", "习惯已更新，请重新读取后再操作");
      let updated: CustomHabit;
      if (match![2]) {
        const date = parseDateQuery(stringField(input.date, "date", { nonEmpty: true }), "date")!;
        if (date > calendarToday()) throw new HttpError(400, "future_habit", "未来日期不能标记习惯完成");
        const marked = booleanField(input.marked, "marked");
        const dates = new Set(habit.dates);
        if (marked) dates.add(date); else dates.delete(date);
        updated = { ...habit, dates: [...dates].sort(), revision: habit.revision + 1 };
      } else {
        const fields = habitFields(input);
        if (habits.some(other => other.id !== habit.id && other.name === fields.name)) throw new HttpError(409, "habit_exists", "已有同名习惯");
        updated = { ...habit, ...fields, revision: habit.revision + 1 };
      }
      habits[index] = updated;
    }
    return ctx.repository.writeCycleIntimacyConfig({ ...current.config, habits });
  });
  setJson(res, create ? 201 : 200, { ...module, eventRevision: ctx.repository.cycleIntimacyEventRevision() });
  return true;
};
