export type HolidayKind = "holiday" | "workday";

export interface CalendarDayInfo {
  readonly holiday?: { readonly kind: HolidayKind; readonly name: string };
  readonly solarTerm?: string;
}

type HolidayEntry = { readonly date: string; readonly kind: HolidayKind; readonly name: string };

// Official 2025/2026 mainland China holiday and make-up workday schedules.
// These are intentionally versioned data, not a weekend heuristic: make-up
// workdays change every year with the State Council notice.
const HOLIDAYS: readonly HolidayEntry[] = [
  { date: "2025-01-01", kind: "holiday", name: "元旦" },
  { date: "2025-01-26", kind: "workday", name: "春节调休" },
  ...dateRange("2025-01-28", "2025-02-04", "holiday", "春节"),
  { date: "2025-02-08", kind: "workday", name: "春节调休" },
  ...dateRange("2025-04-04", "2025-04-06", "holiday", "清明节"),
  { date: "2025-04-27", kind: "workday", name: "劳动节调休" },
  ...dateRange("2025-05-01", "2025-05-05", "holiday", "劳动节"),
  ...dateRange("2025-05-31", "2025-06-02", "holiday", "端午节"),
  { date: "2025-09-28", kind: "workday", name: "国庆节调休" },
  ...dateRange("2025-10-01", "2025-10-08", "holiday", "国庆节·中秋节"),
  { date: "2025-10-11", kind: "workday", name: "国庆节调休" },
  ...dateRange("2026-01-01", "2026-01-03", "holiday", "元旦"),
  { date: "2026-01-04", kind: "workday", name: "元旦调休" },
  { date: "2026-02-14", kind: "workday", name: "春节调休" },
  ...dateRange("2026-02-15", "2026-02-23", "holiday", "春节"),
  { date: "2026-02-28", kind: "workday", name: "春节调休" },
  ...dateRange("2026-04-04", "2026-04-06", "holiday", "清明节"),
  ...dateRange("2026-05-01", "2026-05-05", "holiday", "劳动节"),
  { date: "2026-05-09", kind: "workday", name: "劳动节调休" },
  ...dateRange("2026-06-19", "2026-06-21", "holiday", "端午节"),
  ...dateRange("2026-09-25", "2026-09-27", "holiday", "中秋节"),
  { date: "2026-09-20", kind: "workday", name: "国庆节调休" },
  ...dateRange("2026-10-01", "2026-10-07", "holiday", "国庆节"),
  { date: "2026-10-10", kind: "workday", name: "国庆节调休" },
];

// Solar terms are intentionally secondary display data. The dates are local
// China dates for the supported years; a missing year simply has no solar-term
// label instead of showing a guessed value.
const SOLAR_TERMS: Readonly<Record<string, string>> = {
  "2025-01-05": "小寒", "2025-01-20": "大寒", "2025-02-03": "立春", "2025-02-18": "雨水",
  "2025-03-05": "惊蛰", "2025-03-20": "春分", "2025-04-04": "清明", "2025-04-20": "谷雨",
  "2025-05-05": "立夏", "2025-05-21": "小满", "2025-06-05": "芒种", "2025-06-21": "夏至",
  "2025-07-07": "小暑", "2025-07-22": "大暑", "2025-08-07": "立秋", "2025-08-23": "处暑",
  "2025-09-07": "白露", "2025-09-23": "秋分", "2025-10-08": "寒露", "2025-10-23": "霜降",
  "2025-11-07": "立冬", "2025-11-22": "小雪", "2025-12-07": "大雪", "2025-12-21": "冬至",
  "2026-01-05": "小寒", "2026-01-20": "大寒", "2026-02-04": "立春", "2026-02-19": "雨水",
  "2026-03-05": "惊蛰", "2026-03-20": "春分", "2026-04-05": "清明", "2026-04-20": "谷雨",
  "2026-05-05": "立夏", "2026-05-21": "小满", "2026-06-05": "芒种", "2026-06-21": "夏至",
  "2026-07-07": "小暑", "2026-07-23": "大暑", "2026-08-07": "立秋", "2026-08-23": "处暑",
  "2026-09-07": "白露", "2026-09-23": "秋分", "2026-10-08": "寒露", "2026-10-23": "霜降",
  "2026-11-07": "立冬", "2026-11-22": "小雪", "2026-12-07": "大雪", "2026-12-22": "冬至",
};

function dateRange(from: string, to: string, kind: HolidayKind, name: string): HolidayEntry[] {
  const entries: HolidayEntry[] = [];
  for (let cursor = from; cursor <= to; cursor = nextDate(cursor)) entries.push({ date: cursor, kind, name });
  return entries;
}

function nextDate(date: string): string {
  const value = new Date(`${date}T12:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

const HOLIDAY_BY_DATE = new Map(HOLIDAYS.map((entry) => [entry.date, entry]));

export function calendarDayInfo(date: string): CalendarDayInfo {
  const holiday = HOLIDAY_BY_DATE.get(date);
  const solarTerm = SOLAR_TERMS[date];
  return { ...(holiday ? { holiday: { kind: holiday.kind, name: holiday.name } } : {}), ...(solarTerm ? { solarTerm } : {}) };
}
