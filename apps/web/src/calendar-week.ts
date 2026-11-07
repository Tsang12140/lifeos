// A date key is interpreted in China time, independent of the browser's zone.
const chinaDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const lunarDate = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { timeZone: "Asia/Shanghai", day: "numeric" });
const DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

export function lunarDayLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const instant = new Date(`${date}T12:00:00+08:00`);
  if (!Number.isFinite(instant.getTime()) || chinaDate.format(instant) !== date || lunarDate.resolvedOptions().calendar !== "chinese") return "";
  const day = Number(lunarDate.formatToParts(instant).find(part => part.type === "day")?.value);
  if (day >= 1 && day < 10) return `初${DIGITS[day]}`;
  if (day === 10) return "初十";
  if (day > 10 && day < 20) return `十${DIGITS[day - 10]}`;
  if (day === 20) return "二十";
  if (day > 20 && day < 30) return `廿${DIGITS[day - 20]}`;
  return day === 30 ? "三十" : "";
}

export function weekRangeLabel(start: string, end: string, currentYear: string): string {
  const md = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${start.slice(0, 4)}年${md(start)}—${end.slice(0, 4)}年${md(end)}`;
  const prefix = start.slice(0, 4) === currentYear ? "" : `${start.slice(0, 4)}年`;
  return `${prefix}${md(start)}—${start.slice(0, 7) === end.slice(0, 7) ? `${Number(end.slice(8, 10))}日` : md(end)}`;
}
