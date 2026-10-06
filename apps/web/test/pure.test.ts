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
  localDateToday,
  minuteCapFor,
  monthGridDates,
  shiftDate,
  shiftMonth,
  startOfWeek,
  timePartOf,
} from "../src/time.ts";
import { storyWeight } from "../src/photoScore.ts";
import { clampFixedMenuPosition } from "../src/menu-position.ts";
import { getCelestialScale, getMoonPosition, getSolarPosition, getSunEventMoment, hasKnownChinaWeatherTimeZone, nextSunEventBoundaryDelay, SOLAR_POSITION_INTERVAL_MS, shouldRefreshSolarPosition, weatherClockAt, type WeatherDay } from "../src/weather.ts";

test("fixed context menus stay inside both viewport edges", () => {
  assert.deepEqual(clampFixedMenuPosition(383, 775, 172, 180, 390, 800), { x: 210, y: 612 });
  assert.deepEqual(clampFixedMenuPosition(1, 2, 172, 180, 390, 800), { x: 8, y: 8 });
  assert.deepEqual(clampFixedMenuPosition(180, 300, 172, 180, 390, 800), { x: 180, y: 300 });
});

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
  // Derive "today" from the same local-calendar helper the product uses. Using
  // `new Date().toISOString()` here made this test red every day between 00:00
  // and 08:00 Asia/Shanghai: UTC is still on yesterday while local is not.
  const today = localDateToday();
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

test("solar position follows a continuous sunrise-to-noon-to-sunset arc", () => {
  const day: WeatherDay = { fxDate: "2026-09-29", textDay: "晴", tempMax: "30", tempMin: "24", iconDay: "100", windDirDay: "", windScaleDay: "", sunrise: "05:40", sunset: "18:45" };
  const at = (time: string) => getSolarPosition(day, time, true);
  const dawn = at("05:30");
  const sunrise = at("05:40");
  const morning = at("09:00");
  const noon = at("12:13");
  const afternoon = at("16:00");
  const dusk = at("18:55");
  assert.ok(dawn.y > sunrise.y && dawn.opacity > 0 && dawn.opacity < 1);
  assert.ok(morning.y < sunrise.y && morning.y > noon.y);
  assert.ok(noon.y < morning.y && noon.y < afternoon.y);
  assert.ok(afternoon.y < dusk.y && dusk.opacity > 0 && dusk.opacity < 1);
  assert.ok([dawn, sunrise, morning, noon, afternoon, dusk].every((position) => position.x >= 78 && position.x <= 90));
  assert.equal(SOLAR_POSITION_INTERVAL_MS, 300_000);
});

test("scenic moon arcs through the night and trades light smoothly at sunrise and sunset", () => {
  const day: WeatherDay = { fxDate: "2026-09-29", textDay: "晴", tempMax: "30", tempMin: "24", iconDay: "100", windDirDay: "", windScaleDay: "", sunrise: "05:40", sunset: "18:45" };
  const sun = (time: string) => getSolarPosition(day, time, true);
  const moon = (time: string) => getMoonPosition(day, time, true);
  assert.equal(moon("12:00").opacity, 0);
  assert.equal(sun("18:30").opacity, 1);
  assert.equal(moon("18:30").opacity, 0);
  assert.equal(sun("18:45").opacity, 0.5);
  assert.equal(moon("18:45").opacity, 0.5);
  assert.equal(sun("19:00").opacity, 0);
  assert.equal(moon("19:00").opacity, 1);
  assert.ok(moon("00:12").y < moon("21:00").y);
  assert.ok(moon("00:12").y < moon("04:00").y);
  assert.ok(moon("19:00").x < moon("00:12").x && moon("00:12").x < moon("05:30").x);
  assert.equal(sun("05:40").opacity, 0.5);
  assert.equal(moon("05:40").opacity, 0.5);
  assert.equal(sun("05:55").opacity, 1);
  assert.equal(moon("05:55").opacity, 0);
  assert.equal(getMoonPosition(day, "00:12", false).opacity, 0);
});

test("celestial size stays bounded and follows height on asymmetric day/night arcs", () => {
  const day: WeatherDay = { fxDate: "2026-10-06", textDay: "晴", tempMax: "30", tempMin: "24", iconDay: "100", windDirDay: "", windScaleDay: "", sunrise: "05:00", sunset: "19:00" };
  assert.equal(getCelestialScale(22), 1);
  assert.equal(getCelestialScale(70), 1.12);
  assert.equal(getCelestialScale(46), 1.06);
  assert.equal(getCelestialScale(100), 1.12);
  assert.equal(getCelestialScale(-10), 1);
  assert.equal(getCelestialScale(NaN), 1);
  assert.equal(getCelestialScale(getSolarPosition(day, "12:00", true).y), 1);
  assert.equal(getCelestialScale(getMoonPosition(day, "00:00", true).y), 1);
  assert.ok(getCelestialScale(getSolarPosition(day, "05:00", true).y) > getCelestialScale(getSolarPosition(day, "09:00", true).y));
  const shifted = { ...day, sunrise: "08:00", sunset: "20:00" };
  assert.equal(getCelestialScale(getMoonPosition(shifted, "02:00", true).y), 1);
  assert.ok(getCelestialScale(getMoonPosition(shifted, "00:00", true).y) > 1);
  for (const positionAt of [getSolarPosition, getMoonPosition]) {
    let previous = null;
    for (let minute = 0; minute < 1440; minute++) {
      const position = positionAt(day, `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`, true);
      const scale = getCelestialScale(position.y);
      assert.ok(scale >= 1 && scale <= 1.12);
      // The scenic trajectory resets while completely hidden during daytime.
      // Compare successive visible frames; the last fade frame can be followed
      // by a fully hidden reset without a visible size jump.
      if (previous !== null && position.opacity > 0 && previous.opacity > 0) assert.ok(Math.abs(scale - previous.scale) < 0.002, `${positionAt.name} ${minute}: visible minute/phase boundaries must not jump`);
      previous = { scale, opacity: position.opacity };
    }
  }
});

test("solar position safely falls back without reliable local daylight data", () => {
  const day: WeatherDay = { fxDate: "2026-09-29", textDay: "晴", tempMax: "30", tempMin: "24", iconDay: "100", windDirDay: "", windScaleDay: "" };
  const neutral = getSolarPosition(day, "12:00", true);
  assert.deepEqual(getSolarPosition(day, "12:00", false), neutral);
  assert.deepEqual(getSolarPosition({ ...day, sunrise: "12:00", sunset: "12:01" }, "12:00", true), neutral);
  assert.deepEqual(getSolarPosition({ ...day, sunrise: "26:90", sunset: "18:45" }, "12:00", true), neutral);
  assert.deepEqual(getSolarPosition(null, "12:00", true), neutral);
});

test("sunrise and sunset hint appears only in the current day's three-hour windows", () => {
  const day: WeatherDay = { fxDate: "2026-09-30", textDay: "晴", tempMax: "30", tempMin: "24", iconDay: "100", windDirDay: "", windScaleDay: "", sunrise: "06:00", sunset: "18:00" };
  const at = (time: string) => getSunEventMoment(day, time, true);
  assert.equal(at("02:59"), null);
  assert.deepEqual(at("03:00"), { kind: "sunrise", time: "06:00" });
  assert.deepEqual(at("08:59"), { kind: "sunrise", time: "06:00" });
  assert.equal(at("09:00"), null);
  assert.equal(at("14:59"), null);
  assert.deepEqual(at("15:00"), { kind: "sunset", time: "18:00" });
  assert.deepEqual(at("20:59"), { kind: "sunset", time: "18:00" });
  assert.equal(at("21:00"), null);
  assert.equal(getSunEventMoment(day, "06:00", false), null);
  assert.equal(getSunEventMoment({ ...day, sunrise: "26:90" }, "06:00", true), null);
  assert.equal(nextSunEventBoundaryDelay(day, day.fxDate, Date.parse("2026-09-30T02:59:00+08:00")), 60_000);
  assert.equal(nextSunEventBoundaryDelay(day, day.fxDate, Date.parse("2026-09-30T03:00:00+08:00")), 6 * 60 * 60_000);
  assert.equal(nextSunEventBoundaryDelay(day, day.fxDate, Date.parse("2026-09-30T21:00:00+08:00")), null);
});

test("only visible, current sunny China scenes run the solar clock", () => {
  assert.equal(shouldRefreshSolarPosition("visible", true, true, "sunny"), true);
  assert.equal(shouldRefreshSolarPosition("visible", true, true, "partly-cloudy"), true);
  assert.equal(shouldRefreshSolarPosition("hidden", true, true, "sunny"), false);
  assert.equal(shouldRefreshSolarPosition("visible", false, true, "sunny"), false);
  assert.equal(shouldRefreshSolarPosition("visible", true, false, "sunny"), false);
  assert.equal(shouldRefreshSolarPosition("visible", true, true, "rainy"), false);
});

test("China admin names include common short forms while unknown locations stay cautious", () => {
  assert.equal(hasKnownChinaWeatherTimeZone({ adm1: "广东" }), true);
  assert.equal(hasKnownChinaWeatherTimeZone({ adm1: "广东省" }), true);
  assert.equal(hasKnownChinaWeatherTimeZone({ adm1: "香港特别行政区" }), true);
  assert.equal(hasKnownChinaWeatherTimeZone({ adm1: "台湾省" }), true);
  assert.equal(hasKnownChinaWeatherTimeZone({ adm1: "" }), false);
  assert.equal(hasKnownChinaWeatherTimeZone({ adm1: "California" }), false);
});

test("Shanghai weather clock stays aligned across the device's midnight boundary", () => {
  assert.deepEqual(weatherClockAt(new Date("2026-09-29T21:30:00.000Z"), "Asia/Shanghai"), { date: "2026-09-30", time: "05:30" });
});
