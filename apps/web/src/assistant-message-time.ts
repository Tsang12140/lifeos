const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function values(value: string | Date): Record<string, string> | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? Object.fromEntries(parts.formatToParts(date).map(part => [part.type, part.value])) : null;
}
export function assistantMessageTime(value: string | undefined, now = new Date()): string {
  if (!value) return "";
  const date = values(value), current = values(now);
  if (!date || !current) return "";
  return `${date.year === current.year ? "" : date.year + "年"}${date.month}月${date.day}日 ${date.hour}:${date.minute}`;
}
export function assistantTimeDivider(previous: string | undefined, current: string | undefined): boolean {
  if (!previous || !current) return false;
  const before = values(previous), after = values(current);
  if (!before || !after) return false;
  return Date.parse(current) - Date.parse(previous) >= 5 * 60_000 || ["year", "month", "day"].some(key => before[key] !== after[key]);
}
