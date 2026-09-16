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

/**
 * The month and day of a day key, in Chinese: `9月16日`.
 *
 * Deliberately not `shortDate`, which renders `9月16日` too but through the
 * `short` month style — that is a fallback for places with no room (it returns
 * an em dash for junk input) and it is free to change its mind across ICU
 * versions. This is the label the composer shows on every keystroke, so it is
 * spelled out.
 */
export function dayLabel(value: string): string {
  if (!validDateKey(value)) return "选日期";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: USER_TIME_ZONE,
  }).format(new Date(`${value}T12:00:00`));
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

/**
 * The day key of a `datetime-local` value: `2026-09-16` for
 * `2026-09-16T06:32`, empty for anything that is not a real date.
 *
 * The day, not the value: everything that formats a day (`dayLabel`,
 * `displayDate`, `monthGridDates`) takes a bare key and rejects the `T` form, so
 * a helper that handed back `2026-09-16T06:32` would silently fall through to
 * each of their empty fallbacks. That is exactly what an earlier version of this
 * function did.
 */
export function datePartOf(input: string): string {
  if (!input) return "";
  const date = input.slice(0, 10);
  return validDateKey(date) ? date : "";
}

/** The `HH:MM` half of a `datetime-local` value, or empty. */
export function timePartOf(input: string): string {
  if (!input) return "";
  const time = input.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(time) ? time : "";
}

/**
 * The value with its time half dropped, or kept if it is well formed.
 *
 * A truncated value (a bare date, no `T`) is a legal state for this field — the
 * picker writes one when a day is chosen before any time — so it is passed
 * through rather than repaired.
 */
export function keepValidTime(input: string): string {
  if (!input) return "";
  const date = datePartOf(input);
  if (date === "") return "";
  if (input.length === 10) return date;
  const time = timePartOf(input);
  return time === "" ? date : `${date}T${time}`;
}

/** The two halves back into a `datetime-local` value. */
export function combineDateTime(date: string, time: string): string {
  if (!validDateKey(date)) return "";
  return time === "" ? date : `${date}T${time}`;
}

/**
 * The piece of `input` that fires N steps away, or "" at either end.
 *
 * Stepping is done from this piece rather than the value as a whole: shifting
 * the hour of `2026-09-16T23:40` by `-1` has to land on `22:40`, and reading
 * the day off the full string is the only way to know the value is complete
 * enough to carry a time at all.
 */
export function stepTimePart(input: string, part: "hour" | "minute", step: number): string {
  const time = timePartOf(input);
  if (time === "") return "";
  const [hourText, minuteText] = time.split(":");
  let hour = Number(hourText);
  let minute = Number(minuteText);
  if (part === "hour") hour = (((hour + step) % 24) + 24) % 24;
  else minute = (((minute + step) % 60) + 60) % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** How many days either side of the selected day the quick strip covers. */
export const DAY_WINDOW = 21;

/**
 * The quick day strip: the selected day, three weeks of neighbours each way.
 *
 * Three weeks because the common corrections are "yesterday", "the day before"
 * and "last weekend", and 43 slots fit on one scrollable row. The strip is
 * dated from the selected day rather than clamped to a month, so nudging it
 * across a month boundary never changes how it behaves.
 */
export function dayWindow(value: string): readonly string[] {
  const anchor = validDateKey(value) ? value : localDateToday();
  return Array.from({ length: DAY_WINDOW * 2 + 1 }, (_, index) => shiftDate(anchor, index - DAY_WINDOW));
}

export function isDaySunday(value: string): boolean {
  return validDateKey(value) && new Date(`${value}T12:00:00`).getDay() === 0;
}

export function hourOptions(): readonly string[] {
  return Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
}

export function minuteOptions(step = 1): readonly string[] {
  return Array.from({ length: Math.ceil(60 / step) }, (_, index) => String(index * step).padStart(2, "0"));
}

/**
 * The default minute step for the time columns, and the finer one the "精细"
 * switch turns on.
 *
 * Five minutes is the honest grain for a journal: nobody remembers whether the
 * coffee was at 08:07 or 08:09, and 60 slots in a 132px column is a list you
 * scroll rather than a wheel you turn. Twelve slots are deliberately coarse. A
 * person who does care can ask for the minute, but they have to say so — the
 * cost of precision is paid by the few who want it, not by everyone.
 */
export const MINUTE_STEP_COARSE = 5;
export const MINUTE_STEP_FINE = 1;

/**
 * The most recent whole hour at or before `now`, as `HH` (or `HH:MM` when a
 * minute step is given).
 *
 * Rounded *down*, never to the nearest: 07:54 must not become 08:00, because
 * 08:00 has not happened yet. A default that quietly points at the future is
 * exactly the bug the whole cap rule exists to prevent, so the rounding here
 * leans the same way as the rule.
 */
/**
 * The most recent whole hour at or before `now`, as `HH:00`.
 *
 * Whole hour, not "the current hour and its minute": the entry being made is
 * usually "this morning" rather than "08:06", and a round default is the one a
 * person leaves alone. Rounded *down*, never to the nearest — 07:54 must not
 * become 08:00, because 08:00 has not happened yet. A default that quietly
 * points at the future is exactly the bug the whole cap rule exists to prevent,
 * so the rounding here leans the same way as the rule.
 *
 * `HH:00` is always on the minute column's grid whether the grain is five
 * minutes or one, so the default never lands between two rows.
 */
export function lastWholeHour(now: string): string {
  const time = timePartOf(now);
  if (time === "") return "";
  return `${time.slice(0, 2)}:00`;
}

/**
 * The latest minute, within `hour`, that is still in the past — as the `HH:MM`
 * value of a slot, or `""` when no slot in that hour qualifies.
 *
 * `hour` is compared against the current hour rather than the current instant so
 * that stepping the hour *backwards* reopens the whole minute column: once you
 * are looking at 06:xx every minute of it is in the past, and greying half of it
 * out would be a lie.
 */
export function minuteCapFor(hour: string, now: string, step = MINUTE_STEP_COARSE): string {
  const time = timePartOf(now);
  if (time === "" || !/^\d{2}$/.test(hour)) return "";
  if (hour < time.slice(0, 2)) return "59";
  if (hour > time.slice(0, 2)) return "";
  return String(Math.floor(Number(time.slice(3, 5)) / step) * step).padStart(2, "0");
}

/**
 * Whether a day key is in the future, i.e. later than today in the user's zone.
 *
 * Compared as plain strings on purpose: both sides are `YYYY-MM-DD`, which sorts
 * the same lexically as chronologically, so there is no Date arithmetic to get
 * wrong and no timezone to lose. The same reasoning that makes `validDateKey`
 * the only gate for day keys applies here.
 */
export function isFutureDay(value: string): boolean {
  return validDateKey(value) && value > localDateToday();
}

/**
 * Whether a `YYYY-MM` month anchor is entirely in the future, so paging to it
 * should be refused. The current month is never "future": the days inside it
 * that have not happened yet are handled one level down, by the day cells.
 */
export function isFutureMonth(anchor: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(anchor)) return false;
  return anchor > localDateToday().slice(0, 7);
}

/**
 * The 42 cells of a month grid, grouped into weeks so the grid is read row by
 * row instead of cell by cell. Same dates as `monthGridDates`, one level
 * coarser — a month picker needs to know where the weeks end.
 */
export function monthGridWeeks(value: string): readonly (readonly string[])[] {
  const dates = monthGridDates(value);
  return Array.from({ length: 6 }, (_, week) => dates.slice(week * 7, week * 7 + 7));
}
