import { HABIT_ICON_IDS } from "./habit-icons.js";

export interface CustomHabit {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly revision: number;
  readonly dates: readonly string[];
}

export function assertValidHabits(value: unknown): asserts value is readonly CustomHabit[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("习惯数量不能超过100");
  const ids = new Set<string>(), names = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) throw new Error("习惯编号无效或重复");
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 40 || names.has(item.name.trim())) throw new Error("习惯名称不能为空、重复或超过40字");
    if (typeof item.icon !== "string" || !HABIT_ICON_IDS.has(item.icon)) throw new Error("请选择图标库中的图标");
    if (!Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("习惯版本无效");
    if (!Array.isArray(item.dates) || item.dates.length > 40000 || new Set(item.dates).size !== item.dates.length) throw new Error("习惯标记日期无效或重复");
    for (const date of item.dates) {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("习惯标记日期无效");
    }
    ids.add(item.id); names.add(item.name.trim());
  }
}
