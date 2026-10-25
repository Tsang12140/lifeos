import type { LifeTime, TaskStatus } from "@lifeos/core";
import type { RecordView, TaskRecordView } from "./api.ts";
import { dateOnly, instantFromInput, lifeTimeToInput, localDateToday } from "./time.ts";

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const clockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function parts(value: LifeTime): { day: string; clock: string } {
  if (value.kind === "date") return { day: value.value, clock: "" };
  if (value.kind === "local") return { day: value.value.slice(0, 10), clock: value.value.slice(11, 16) };
  const date = new Date(value.value);
  return { day: dayFormat.format(date), clock: clockFormat.format(date) };
}

export function taskTimeFromInput(value: string): LifeTime | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateOnly(value) : instantFromInput(value);
}

export function taskTimeToInput(value: LifeTime | undefined): string {
  return value?.kind === "date" ? value.value : lifeTimeToInput(value);
}

/** How the task page arranges its cards. */
export type TaskSortMode = "planned" | "created" | "status";

export const TASK_SORT_MODES: readonly { readonly id: TaskSortMode; readonly label: string; readonly hint: string }[] = [
  { id: "planned", label: "计划", hint: "按计划时间：接下来在前，已过期随后，没有排期的在最后" },
  { id: "created", label: "添加", hint: "按添加时间：最近记下的排在最前" },
  { id: "status", label: "状态", hint: "按状态分组：未完成、已完成、已取消" },
];

export function isTaskSortMode(value: unknown): value is TaskSortMode {
  return value === "planned" || value === "created" || value === "status";
}

/**
 * Which stretch of the page a task belongs to.
 *
 * `overdue` is deliberately narrow. A task recorded on some day without any
 * clock and without an end time carries that day in `occurredAt` only because
 * the composer stamped it there — nothing was ever planned. Counting those as
 * "overdue" turned ten notes-to-self into a wall of dead debt on the task page
 * (measured 2026-10-23: 10 of 15 open tasks, all of them same-day stamps with
 * no `dueAt`). They belong to the idea pool, not to the arrears.
 */
export type TaskBucket = "upcoming" | "overdue" | "unscheduled";

const BUCKET_ORDER: Record<TaskBucket, number> = { upcoming: 0, overdue: 1, unscheduled: 2 };

export const TASK_BUCKET_LABELS: Record<TaskBucket, string> = { upcoming: "接下来", overdue: "已过期", unscheduled: "没有排期" };

const STATUS_ORDER: Record<TaskStatus, number> = { todo: 0, in_progress: 0, done: 1, cancelled: 2 };
const STATUS_GROUP_LABELS: Record<number, string> = { 0: "未完成", 1: "已完成", 2: "已取消" };

export function taskPlanTime(record: RecordView): LifeTime | undefined {
  return record.kind === "task" ? record.occurredAt ?? record.task.dueAt : undefined;
}

/** True when `occurredAt` is just the recording day, not a day the user picked. */
export function hasImplicitPlan(record: RecordView): boolean {
  if (record.kind !== "task") return false;
  if (record.task.dueAt !== undefined) return false;
  const plan = record.occurredAt;
  if (plan === undefined) return false;
  return parts(plan).day === parts(record.createdAt).day;
}

export function taskBucket(record: RecordView, today: string): TaskBucket {
  const plan = taskPlanTime(record);
  if (plan === undefined) return "unscheduled";
  if (parts(plan).day >= today) return "upcoming";
  return hasImplicitPlan(record) ? "unscheduled" : "overdue";
}

/**
 * Planned order. Upcoming ascends from today (the nearest thing to do first),
 * overdue descends (the freshest lapse first, so the oldest debt is not the
 * first thing on the page), and the idea pool is newest first — what was just
 * written down is what is still on your mind.
 */
export function compareTaskRecords(left: RecordView, right: RecordView, today: string = localDateToday()): number {
  const a = taskBucket(left, today), b = taskBucket(right, today);
  if (a !== b) return BUCKET_ORDER[a] - BUCKET_ORDER[b];
  if (a !== "unscheduled") {
    const x = parts(taskPlanTime(left)!), y = parts(taskPlanTime(right)!);
    const order = a === "overdue"
      ? y.day.localeCompare(x.day) || y.clock.localeCompare(x.clock)
      : x.day.localeCompare(y.day) || x.clock.localeCompare(y.clock);
    if (order) return order;
  }
  if (a === "unscheduled") return Date.parse(right.createdAt.value) - Date.parse(left.createdAt.value) || right.id.localeCompare(left.id);
  return Date.parse(left.createdAt.value) - Date.parse(right.createdAt.value) || left.id.localeCompare(right.id);
}

export function compareTaskRecordsByCreated(left: RecordView, right: RecordView): number {
  return Date.parse(right.createdAt.value) - Date.parse(left.createdAt.value) || right.id.localeCompare(left.id);
}

function statusRank(record: RecordView): number {
  return record.kind === "task" ? STATUS_ORDER[record.task.status] : 0;
}

export function compareTaskRecordsByStatus(left: RecordView, right: RecordView, today: string = localDateToday()): number {
  const order = statusRank(left) - statusRank(right);
  return order || compareTaskRecords(left, right, today);
}

export interface TaskRow {
  /** Stable key for React; also tells the renderer whether a heading is due. */
  readonly key: string;
  /** Rendered above the row when the page shows more than one stretch. */
  readonly label?: string;
  readonly records: readonly RecordView[];
}

/**
 * The rows the task page draws, already ordered. A heading is only attached
 * when it carries information: the leading stretch stays unlabelled so the
 * page does not open with a redundant "接下来" banner over an empty-or-not list.
 */
export function groupTaskRecords(records: readonly RecordView[], mode: TaskSortMode, today: string = localDateToday()): readonly TaskRow[] {
  if (mode === "created") return [{ key: "created", records: [...records].sort(compareTaskRecordsByCreated) }];
  if (mode === "status") {
    const rows: TaskRow[] = [];
    for (const rank of [0, 1, 2]) {
      const bucket = records.filter((record) => statusRank(record) === rank);
      if (bucket.length === 0) continue;
      rows.push({ key: `status-${rank}`, label: `${STATUS_GROUP_LABELS[rank]} ${bucket.length} 条`, records: [...bucket].sort((left, right) => compareTaskRecords(left, right, today)) });
    }
    return rows;
  }
  const rows: TaskRow[] = [];
  for (const bucket of ["upcoming", "overdue", "unscheduled"] as const) {
    const picked = records.filter((record) => taskBucket(record, today) === bucket);
    if (picked.length === 0) continue;
    const label = bucket === "upcoming" && rows.length === 0 ? undefined : `${TASK_BUCKET_LABELS[bucket]} ${picked.length} 条`;
    rows.push({ key: `bucket-${bucket}`, label, records: [...picked].sort((left, right) => compareTaskRecords(left, right, today)) });
  }
  return rows;
}

export function taskScheduleLabels(record: TaskRecordView): readonly { label: string; value: string; dateTime: string }[] {
  const entries = [{ label: "开始", time: record.occurredAt }, { label: "结束", time: record.task.dueAt }];
  return entries.flatMap(({ label, time }) => {
    if (!time) return [];
    const { day, clock } = parts(time), year = dayFormat.format(new Date()).slice(0, 4);
    const date = `${day.slice(0, 4) === year ? "" : `${day.slice(0, 4)}年`}${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
    return [{ label, value: `${date}${clock ? ` ${clock}` : " 全天"}`, dateTime: time.value }];
  });
}
