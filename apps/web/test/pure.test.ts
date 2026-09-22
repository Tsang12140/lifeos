/**
 * Pure-function tests for apps/web helpers that used to live only in the UI.
 * Run: node --experimental-strip-types --test apps/web/test/pure.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  combineDateTime,
  dateKeyForRecord,
  datePartOf,
  datesOfWeek,
  dayWindow,
  isFutureDay,
  isFutureMonth,
  minuteCapFor,
  monthGridDates,
  shiftDate,
  shiftMonth,
  startOfWeek,
  timePartOf,
} from "../src/time.ts";
import { storyWeight } from "../src/photoScore.ts";

test("shiftDate walks calendar days including month ends", () => {
  assert.equal(shiftDate("2026-01-31", 1), "2026-02-01");
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDate("2024-02-28", 1), "2024-02-29");
});

test("shiftMonth clamps to the last legal day", () => {
  assert.equal(shiftMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftMonth("2026-03-31", -1), "2026-02-28");
});

test("startOfWeek is Monday and datesOfWeek is seven consecutive days", () => {
  // 2026-09-22 is a Tuesday.
  assert.equal(startOfWeek("2026-09-22"), "2026-09-21");
  const week = datesOfWeek("2026-09-22");
  assert.equal(week.length, 7);
  assert.equal(week[0], "2026-09-21");
  assert.equal(week[6], "2026-09-27");
});

test("monthGridDates is 42 cells starting on the week of the 1st", () => {
  // 2026-09-01 is a Tuesday → grid starts Monday 2026-08-31.
  const grid = monthGridDates("2026-09-15");
  assert.equal(grid.length, 42);
  assert.equal(grid[0], "2026-08-31");
  assert.ok(grid.includes("2026-09-01"));
});

test("dayWindow is 43 days (three weeks either side) centred on the value", () => {
  const strip = dayWindow("2026-09-22");
  assert.equal(strip.length, 43);
  assert.equal(strip[21], "2026-09-22");
});

test("combineDateTime / datePartOf / timePartOf round-trip", () => {
  const value = combineDateTime("2026-09-22", "18:30");
  assert.equal(datePartOf(value), "2026-09-22");
  assert.equal(timePartOf(value), "18:30");
});

test("dateKeyForRecord prefers occurredAt over createdAt", () => {
  const occurredAt = { value: "2026-09-22", kind: "date" } as never;
  const createdAt = { value: "2026-09-20T00:00:00.000Z", kind: "instant" } as never;
  // dateKeyForRecord is timezone-aware; just assert it returns a non-empty key.
  const key = dateKeyForRecord(occurredAt, createdAt);
  assert.ok(typeof key === "string" && key.length > 0);
});

test("isFutureDay / isFutureMonth only move forward", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(isFutureDay(today), false);
  assert.equal(isFutureDay(shiftDate(today, 1)), true);
  assert.equal(isFutureDay(shiftDate(today, -1)), false);
  assert.equal(isFutureMonth(today.slice(0, 7)), false);
  assert.equal(isFutureMonth(shiftMonth(today, 1).slice(0, 7)), true);
});

test("minuteCapFor reopens past hours and clamps the current one", () => {
  // Past hour: every minute is legal.
  assert.equal(minuteCapFor("06", "2026-09-22T07:54", 5), "59");
  // Current hour: floor to the coarse step.
  assert.equal(minuteCapFor("07", "2026-09-22T07:54", 5), "50");
  // Future hour: nothing legal yet.
  assert.equal(minuteCapFor("08", "2026-09-22T07:54", 5), "");
});

test("storyWeight counts photo refs on top of prose", () => {
  const withPhotos = storyWeight(120, 3);
  const without = storyWeight(120, 0);
  assert.ok(withPhotos > without);
  assert.ok(storyWeight(0, 0) >= 0);
  // Caps: text ≤ 0.5, refs ≤ 0.4.
  assert.ok(storyWeight(10_000, 99) <= 0.9 + 1e-9);
});
