import test from "node:test";
import assert from "node:assert/strict";
import { shiftMapCenter } from "../src/place-map-geometry.ts";
import { applyPlaceWording } from "../src/place-mention-wording.ts";
test("drag pans in screen directions, changes less when zoomed, and bounds world edges", () => {
  const origin = { longitude: 113.24, latitude: 23.12 };
  const moved = shiftMapCenter(origin, 16, 100, 100);
  assert.ok(moved.longitude < origin.longitude); assert.ok(moved.latitude > origin.latitude);
  const back = shiftMapCenter(moved, 16, -100, -100);
  assert.ok(Math.abs(back.longitude - origin.longitude) < 1e-8 && Math.abs(back.latitude - origin.latitude) < 1e-8);
  assert.ok(Math.abs(shiftMapCenter(origin, 17, 100, 0).longitude - origin.longitude) < Math.abs(moved.longitude - origin.longitude));
  const edge = shiftMapCenter({ longitude: 179.999, latitude: 84.99 }, 3, -1000, 10000);
  assert.ok(edge.longitude >= -180 && edge.longitude <= 180 && edge.latitude <= 85);
});
test("diary wording replaces one selected occurrence and shifts later decisions without renaming objects", () => {
  const text = "BC吃过，今天跟小李去BC，再找小王", start = text.lastIndexOf("BC");
  const decisions = [{ start: 0, end: 2, text: "BC", entityId: null, entityType: "place" as const }, { start, end: start + 2, text: "BC", entityId: "place-1", entityType: "place" as const }, { start: text.indexOf("小王"), end: text.length, text: "小王", entityId: "person-1", entityType: "person" as const }];
  const result = applyPlaceWording(text, { start, end: start + 2, text: "BC" }, " 我的牛肉面馆 ", decisions);
  assert.equal(result.text, "BC吃过，今天跟小李去我的牛肉面馆，再找小王");
  assert.equal(result.decisions[0], decisions[0]); assert.equal(result.decisions[1]!.entityId, "place-1");
  for (const item of result.decisions) assert.equal(result.text.slice(item.start, item.end), item.text);
  assert.equal(text.slice(start, start + 2), "BC"); assert.equal(decisions[1]!.text, "BC");
  assert.throws(() => applyPlaceWording(text, { start, end: start + 2, text: "changed" }, "店铺", decisions));
  assert.throws(() => applyPlaceWording(text, { start, end: start + 2, text: "BC" }, " ", decisions));
  assert.equal(applyPlaceWording(text, { start, end: start + 2, text: "BC" }, "店铺", decisions.map(item => ({ ...item, entityId: null }))).text, text);
});
