import test from "node:test";
import assert from "node:assert/strict";
import { recommendedPlaceCities, placeDistanceLabel, rememberDevicePoint, placeSearchPoint } from "../src/place-search-options.ts";

test("city recommendations merge sources, normalise names and stop at three unique cities", () => {
  assert.deepEqual(recommendedPlaceCities("佛山市", ["佛山"], ["广州", "佛山市"]), ["佛山", "广州"]);
  assert.deepEqual(recommendedPlaceCities("佛山", ["广州", "上海", "成都"], ["北京"]), ["佛山", "广州", "上海"]);
  assert.deepEqual(recommendedPlaceCities("", [" ", "广州市"], ["广州", "北京"]), ["广州", "北京"]);
});

test("device location reuses fresh weather coordinates and falls back on browser policy failures", async t => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { for (const [key, descriptor] of [["window", windowDescriptor], ["navigator", navigatorDescriptor]] as const) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  let calls = 0;
  const now = Date.now();
  rememberDevicePoint({ latitude: 23, longitude: 113, accuracy: 15 }, now);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: true } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { geolocation: { getCurrentPosition() { calls++; throw Error("policy denied"); } } } });
  assert.equal((await placeSearchPoint())?.longitude, 113); assert.equal(calls, 0, "fresh weather GPS avoids another permission request");
  rememberDevicePoint({ latitude: 23, longitude: 113, accuracy: 15 }, now - 120_000);
  assert.equal(await placeSearchPoint(), null); assert.equal(calls, 1, "synchronous browser policy rejection is handled");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { geolocation: { getCurrentPosition(good: (point: unknown) => void) { good({ coords: { latitude: 23, longitude: 113, accuracy: 3000 }, timestamp: Date.now() }); } } } });
  assert.equal(await placeSearchPoint(), null, "coarse GPS is not used for nearby metre estimates");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: false } });
  assert.equal(await placeSearchPoint(), null);
});
test("distance labels reflect GPS accuracy and never claim metres from coarse location", () => {
  assert.equal(placeDistanceLabel(32, 15), "约 40 米");
  assert.equal(placeDistanceLabel(20, 80), "附近");
  assert.equal(placeDistanceLabel(1250, 15), "约 1.3 公里");
  for (const accuracy of [1001, Infinity, NaN, -1]) assert.equal(placeDistanceLabel(30, accuracy), undefined);
  assert.equal(placeDistanceLabel(undefined, 10), undefined);
});
