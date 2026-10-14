import test from "node:test";
import assert from "node:assert/strict";
import { createInstant } from "@lifeos/core";
import { dateForTime, dateWithWeekdayForTime } from "../src/timeline-query.js";

const ZONE = "Asia/Shanghai";

test("dateWithWeekdayForTime names the Shanghai day and its weekday", () => {
  assert.equal(dateWithWeekdayForTime(createInstant("2026-10-06T15:55:00.000Z"), ZONE), "2026-10-06（周二）");
  assert.equal(dateWithWeekdayForTime(createInstant("2026-10-11T10:00:00.000Z"), ZONE), "2026-10-11（周日）");
});

test("a UTC instant past midnight lands on the Shanghai day, carrying that day's weekday", () => {
  // 2026-10-05T16:23Z is 00:23 on 2026-10-06 in Shanghai, so the record belongs
  // to Tuesday, not Monday. Handing the raw instant to the model is exactly the
  // step where "上周二" turns into "上周一".
  assert.equal(dateForTime(createInstant("2026-10-05T16:23:00.000Z"), ZONE), "2026-10-06");
  assert.equal(dateWithWeekdayForTime(createInstant("2026-10-05T16:23:00.000Z"), ZONE), "2026-10-06（周二）");
});

test("day-only and local times keep the day they already carry", () => {
  assert.equal(dateWithWeekdayForTime({ kind: "date", value: "2026-10-09" }, ZONE), "2026-10-09（周五）");
  assert.equal(dateWithWeekdayForTime({ kind: "local", value: "2026-10-13T13:34:00" }, ZONE), "2026-10-13（周二）");
});

test("an unreadable day is handed back unchanged rather than guessed", () => {
  assert.equal(dateWithWeekdayForTime({ kind: "date", value: "" }, ZONE), "");
  assert.equal(dateWithWeekdayForTime({ kind: "date", value: "not-a-day" }, ZONE), "not-a-day");
});
