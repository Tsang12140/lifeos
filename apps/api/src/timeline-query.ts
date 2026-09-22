import type { LifeTime } from "@lifeos/core";
import type { RecordView } from "./repository.js";
import { HttpError } from "./http-kit.js";

export function dateForTime(time: LifeTime, timeZone: string): string {
  if (time.kind === "date" || time.kind === "local") return time.value.slice(0, 10);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time.value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function timelineDisplayKey(record: RecordView, timeZone: string): string {
  const time = record.occurredAt ?? record.createdAt;
  if (time.kind === "date") return `${time.value}T00:00:00`;
  if (time.kind === "local") return time.value;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time.value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function sortTimeline(items: readonly RecordView[], timeZone: string): readonly RecordView[] {
  return [...items].sort((left, right) => {
    const leftKey = timelineDisplayKey(left, timeZone);
    const rightKey = timelineDisplayKey(right, timeZone);
    if (leftKey < rightKey) return 1;
    if (leftKey > rightKey) return -1;
    if (left.createdAt.value < right.createdAt.value) return 1;
    if (left.createdAt.value > right.createdAt.value) return -1;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  });
}

export function filterDate(items: readonly RecordView[], date: string | undefined, timeZone: string): readonly RecordView[] {
  assertTimeZone(timeZone);
  if (date === undefined) return items;
  return items.filter((item) => dateForTime(item.occurredAt ?? item.createdAt, timeZone) === date);
}

export function assertTimeZone(timeZone: string): void {
  try {
    // Constructing the formatter validates IANA names before rows are examined.
    new Intl.DateTimeFormat("en-CA", { timeZone }).format();
  } catch {
    throw new HttpError(400, "invalid_time_zone", "timeZone must be a valid IANA time zone");
  }
}

/** Inclusive range over the same local-day key `filterDate` matches on. */
export function filterDateRange(items: readonly RecordView[], from: string | undefined, to: string | undefined, timeZone: string): readonly RecordView[] {
  if (from === undefined && to === undefined) return items;
  assertTimeZone(timeZone);
  return items.filter((item) => {
    const date = dateForTime(item.occurredAt ?? item.createdAt, timeZone);
    if (from !== undefined && date < from) return false;
    return !(to !== undefined && date > to);
  });
}

/** Parse note metadata at the HTTP boundary so all clients receive the same
 * 400-shaped error instead of a raw core validation exception. */
export function datesBetween(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = start; at <= end; at += 86_400_000) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}
