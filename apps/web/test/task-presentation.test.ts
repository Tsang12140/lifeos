import { test } from "node:test";
import assert from "node:assert/strict";
import type { LifeTime, TaskStatus } from "@lifeos/core";
import type { TaskRecordView } from "../src/api.ts";
import {
  compareTaskRecords,
  groupTaskRecords,
  hasImplicitPlan,
  taskBucket,
  taskScheduleLabels,
  taskTimeFromInput,
  taskTimeToInput,
} from "../src/task-presentation.ts";

const task = (id: string, created: string, start?: LifeTime, end?: LifeTime, status: TaskStatus = "todo"): TaskRecordView => ({
  id, kind: "task", revision: 1, body: { original: id }, createdAt: { kind: "instant", value: created },
  ...(start ? { occurredAt: start } : {}), task: { status, ...(end ? { dueAt: end } : {}) },
  entityRefs: [], relatedRecordIds: [], assetRefs: [], aiDerived: [],
});
const day = (value: string): LifeTime => ({ kind: "date", value });
const at = (value: string): LifeTime => ({ kind: "instant", value });
const TODAY = "2026-10-23";

const fixture = () => [
  task("later", "2026-10-20T01:00:00Z", day("2026-10-26")),
  task("no-plan", "2026-10-18T02:00:00Z"),
  task("lapsed-old", "2026-10-01T00:00:00Z", day("2026-10-09")),
  task("today-all-day", "2026-10-20T03:00:00Z", day("2026-10-23")),
  task("note-to-self", "2026-10-20T02:00:00Z", day("2026-10-20")),
  task("soon", "2026-10-20T04:00:00Z", at("2026-10-24T01:00:00Z")),
  task("lapsed-recent", "2026-10-01T00:00:00Z", day("2026-10-21")),
];

test("planned order puts today onward first, freshest lapse next, then the idea pool newest first", () => {
  const records = fixture();
  const original = records.map(record => record.id);
  assert.deepEqual(
    [...records].sort((left, right) => compareTaskRecords(left, right, TODAY)).map(record => record.id),
    ["today-all-day", "soon", "later", "lapsed-recent", "lapsed-old", "note-to-self", "no-plan"],
  );
  assert.deepEqual(records.map(record => record.id), original);
});

test("a recording-day stamp with no end time is an idea, not an overdue task", () => {
  const stamped = task("note", "2026-10-20T02:00:00Z", day("2026-10-20"));
  assert.equal(hasImplicitPlan(stamped), true);
  assert.equal(taskBucket(stamped, TODAY), "unscheduled");
  const clocked = task("clocked", "2026-10-20T02:00:00Z", at("2026-10-20T02:00:00Z"));
  assert.equal(hasImplicitPlan(clocked), true);
  assert.equal(taskBucket(clocked, TODAY), "unscheduled");
  const ended = task("ended", "2026-10-20T02:00:00Z", day("2026-10-20"), day("2026-10-22"));
  assert.equal(hasImplicitPlan(ended), false);
  assert.equal(taskBucket(ended, TODAY), "overdue");
  const chosen = task("chosen", "2026-10-01T02:00:00Z", day("2026-10-20"));
  assert.equal(hasImplicitPlan(chosen), false);
  assert.equal(taskBucket(chosen, TODAY), "overdue");
  const futureStamp = task("future", "2026-10-20T02:00:00Z", day("2026-10-24"));
  assert.equal(taskBucket(futureStamp, TODAY), "upcoming");
});

test("overdue descends so the oldest debt is not the first card on the page", () => {
  const records = [
    task("oldest", "2026-09-01T00:00:00Z", day("2026-09-02")),
    task("newest", "2026-09-01T00:00:00Z", day("2026-10-22")),
    task("middle", "2026-09-01T00:00:00Z", day("2026-10-01")),
  ];
  assert.deepEqual(
    [...records].sort((left, right) => compareTaskRecords(left, right, TODAY)).map(record => record.id),
    ["newest", "middle", "oldest"],
  );
});

test("same-day order keeps all-day before clocked, then first-in-first-out", () => {
  const records = [
    task("late", "2026-10-20T01:00:00Z", at("2026-10-24T11:00:00Z")),
    task("all-day-new", "2026-10-20T02:00:00Z", day("2026-10-24")),
    task("early", "2026-10-20T03:00:00Z", at("2026-10-24T01:00:00Z")),
    task("all-day-old", "2026-10-20T01:00:00Z", day("2026-10-24")),
  ];
  assert.deepEqual(
    [...records].sort((left, right) => compareTaskRecords(left, right, TODAY)).map(record => record.id),
    ["all-day-old", "all-day-new", "early", "late"],
  );
});

test("planned rows label every stretch except the leading one", () => {
  const rows = groupTaskRecords(fixture(), "planned", TODAY);
  assert.deepEqual(rows.map(row => row.key), ["bucket-upcoming", "bucket-overdue", "bucket-unscheduled"]);
  assert.equal(rows[0]!.label, undefined);
  assert.equal(rows[1]!.label, "已过期 2 条");
  assert.equal(rows[2]!.label, "没有排期 2 条");
  assert.deepEqual(rows[1]!.records.map(record => record.id), ["lapsed-recent", "lapsed-old"]);
  assert.equal(rows.reduce((total, row) => total + row.records.length, 0), fixture().length);
});

test("created order is newest first and carries no heading", () => {
  const rows = groupTaskRecords(fixture(), "created", TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, undefined);
  assert.deepEqual(rows[0]!.records.map(record => record.id), ["soon", "today-all-day", "note-to-self", "later", "no-plan", "lapsed-recent", "lapsed-old"]);
});

test("status order groups open, done and cancelled without losing records", () => {
  const records = [
    task("open", "2026-10-01T00:00:00Z", day("2026-10-24")),
    task("done", "2026-10-02T00:00:00Z", day("2026-10-24"), undefined, "done"),
    task("running", "2026-10-03T00:00:00Z", day("2026-10-23"), undefined, "in_progress"),
    task("cancelled", "2026-10-04T00:00:00Z", day("2026-10-24"), undefined, "cancelled"),
  ];
  const rows = groupTaskRecords(records, "status", TODAY);
  assert.deepEqual(rows.map(row => row.label), ["未完成 2 条", "已完成 1 条", "已取消 1 条"]);
  assert.deepEqual(rows[0]!.records.map(record => record.id), ["running", "open"]);
  assert.equal(rows.reduce((total, row) => total + row.records.length, 0), 4);
});

test("a page with only upcoming tasks shows no headings at all", () => {
  const rows = groupTaskRecords([task("only", "2026-10-01T00:00:00Z", day("2026-10-25"))], "planned", TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, undefined);
});

test("date-only task inputs stay dates through editing, while explicit clocks stay timed", () => {
  const date = taskTimeFromInput("2026-10-21");
  assert.equal(date?.kind, "date"); assert.equal(date?.value, "2026-10-21"); assert.equal(taskTimeToInput(date), "2026-10-21");
  const timed = taskTimeFromInput("2026-10-21T09:30");
  assert.equal(timed?.kind, "instant"); assert.equal(taskTimeToInput(timed), "2026-10-21T09:30");
  assert.equal(taskTimeFromInput(""), undefined); assert.equal(taskTimeFromInput("invalid"), undefined);
});

test("task cards never label the creation moment as a schedule", () => {
  assert.deepEqual(taskScheduleLabels(task("none", "2026-10-20T04:00:00Z")), []);
  const labels = taskScheduleLabels(task("planned", "2026-10-20T04:00:00Z", day("2026-10-21"), at("2026-10-22T01:30:00Z")));
  assert.equal(labels.length, 2); assert.equal(labels[0]!.label, "开始"); assert.match(labels[0]!.value, /10月21日 全天$/);
  assert.equal(labels[1]!.label, "结束"); assert.match(labels[1]!.value, /10月22日 09:30$/);
});
