import test from "node:test";
import assert from "node:assert/strict";
import { lunarDayLabel, weekRangeLabel } from "../src/calendar-week.ts";

test("week ranges have date units and preserve month/year boundaries", () => {
  assert.equal(weekRangeLabel("2026-11-02", "2026-11-08", "2026"), "11月2日—8日");
  assert.equal(weekRangeLabel("2026-11-30", "2026-12-06", "2026"), "11月30日—12月6日");
  assert.equal(weekRangeLabel("2026-12-28", "2027-01-03", "2026"), "2026年12月28日—2027年1月3日");
  assert.equal(weekRangeLabel("2025-11-03", "2025-11-09", "2026"), "2025年11月3日—9日");
});

test("lunar art uses real lunar days and simplified common numerals", () => {
  assert.equal(lunarDayLabel("2026-02-17"), "初一");
  assert.equal(lunarDayLabel("2026-02-20"), "初四");
  assert.equal(lunarDayLabel("2026-11-02"), "廿四");
  assert.equal(lunarDayLabel("2025-07-25"), "初一"); // leap-sixth-month day one
  for (const malformed of ["", "2026-13-01", "2026-02-31", "not-a-date"]) assert.equal(lunarDayLabel(malformed), "");
});
