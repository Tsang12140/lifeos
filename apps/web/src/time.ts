import { createDateOnly, createInstant, createLocalDateTime, type LifeTime } from "@lifeos/core";

export const FALLBACK_TIME_ZONE = "Asia/Shanghai";
export const USER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;

function partsToObject(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function validDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
}

export function localDateToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = partsToObject(parts);
  return `${values.year ?? "1970"}-${values.month ?? "01"}-${values.day ?? "01"}`;
}

export function shiftDate(value: string, offset: number): string {
  const base = validDateKey(value) ? value : localDateToday();
  const date = new Date(`${base}T12:00:00`);
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function displayDate(value: string): string {
  if (!validDateKey(value)) return "选择日期";
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: USER_TIME_ZONE,
  }).format(new Date(`${value}T12:00:00`));
}

export function shortDate(value: string): string {
  if (!validDateKey(value)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    timeZone: USER_TIME_ZONE,
  }).format(new Date(`${value}T12:00:00`));
}

function dateKeyFromInstant(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const values = partsToObject(
    new Intl.DateTimeFormat("en-US", {
      timeZone: USER_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date),
  );
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : undefined;
}

function timeFromInstant(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const values = partsToObject(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: USER_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      hour12: false,
    }).formatToParts(date),
  );
  return values.hour && values.minute ? `${values.hour}:${values.minute}` : undefined;
}

function dateTimeLocalFromInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const values = partsToObject(
    new Intl.DateTimeFormat("en-US", {
      timeZone: USER_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      hour12: false,
    }).formatToParts(date),
  );
  if (!values.year || !values.month || !values.day || !values.hour || !values.minute) return "";
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function lifeTimeDate(value: LifeTime | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.kind === "instant") return dateKeyFromInstant(value.value);
  return value.value.slice(0, 10);
}

export function lifeTimeTime(value: LifeTime | undefined): string {
  if (value === undefined) return "—";
  if (value.kind === "date") return "全天";
  if (value.kind === "instant") return timeFromInstant(value.value) ?? "—";
  const timePart = value.value.includes("T") ? value.value.split("T")[1] : undefined;
  return timePart?.slice(0, 5) ?? "—";
}

export function lifeTimeToInput(value: LifeTime | undefined): string {
  if (value === undefined) return "";
  if (value.kind === "instant") return dateTimeLocalFromInstant(value.value);
  if (value.kind === "local") return value.value.slice(0, 16);
  return `${value.value}T09:00`;
}

export function instantFromInput(value: string): LifeTime | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return createInstant(parsed.toISOString(), USER_TIME_ZONE);
}

export function localFromInput(value: string): LifeTime | undefined {
  if (!value) return undefined;
  try {
    return createLocalDateTime(value, USER_TIME_ZONE);
  } catch {
    return undefined;
  }
}

export function dateOnly(value: string): LifeTime | undefined {
  if (!validDateKey(value)) return undefined;
  try {
    return createDateOnly(value, USER_TIME_ZONE);
  } catch {
    return undefined;
  }
}

export function dateKeyForRecord(occurredAt: LifeTime | undefined, createdAt: LifeTime): string | undefined {
  return lifeTimeDate(occurredAt) ?? lifeTimeDate(createdAt);
}

/** The current local wall-clock minute, ready for a datetime-local input. */
export function localNowInput(): string {
  const values = partsToObject(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: USER_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date()),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

/**
 * "Now" relocated to another calendar day. Back-filling a past date still
 * starts from the current time of day instead of an empty field.
 */
export function localNowInputFor(date: string): string {
  const timeOfDay = localNowInput().slice(11);
  return validDateKey(date) ? `${date}T${timeOfDay}` : localNowInput();
}

/** Monday, because the week grid reads 一二三四五六日. */
export function startOfWeek(value: string): string {
  const base = validDateKey(value) ? value : localDateToday();
  const weekday = (new Date(`${base}T12:00:00`).getDay() + 6) % 7;
  return shiftDate(base, -weekday);
}

/** The seven days of the week that contains `value`, Monday first. */
export function datesOfWeek(value: string): readonly string[] {
  const start = startOfWeek(value);
  return Array.from({ length: 7 }, (_, index) => shiftDate(start, index));
}

export function startOfMonth(value: string): string {
  const base = validDateKey(value) ? value : localDateToday();
  return `${base.slice(0, 7)}-01`;
}

/**
 * Six Monday-first weeks: always 42 days, so switching months never reflows the
 * grid. Days outside the month are kept and marked, which is what lets the last
 * days of the previous month show their own summaries.
 */
export function monthGridDates(value: string): readonly string[] {
  const first = startOfWeek(startOfMonth(value));
  return Array.from({ length: 42 }, (_, index) => shiftDate(first, index));
}

export function monthTitle(value: string): string {
  const base = validDateKey(value) ? value : localDateToday();
  return `${base.slice(0, 4)}年${Number(base.slice(5, 7))}月`;
}

/** Keeps the day of month, clamped to the shorter month, so paging months is stable. */
export function shiftMonth(value: string, offset: number): string {
  const base = validDateKey(value) ? value : localDateToday();
  const target = new Date(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1 + offset, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const day = Math.min(Number(base.slice(8, 10)), lastDay);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function weekdayShort(value: string): string {
  if (!validDateKey(value)) return "—";
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: USER_TIME_ZONE }).format(new Date(`${value}T12:00:00`));
}
