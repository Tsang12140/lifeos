import test from "node:test";
import assert from "node:assert/strict";
import { mapPlatform, placeMapLinks } from "../src/place-map-links.ts";
const place = { name: "清平饭店 & 分店", city: "广州", address: "中山七路1号", longitude: 113.245021, latitude: 23.125304 };
test("map links preserve GCJ02 coordinates with each provider's latitude order and escape names", () => {
  for (const platform of ["ios", "android", "desktop"] as const) {
    const [amap, baidu] = placeMapLinks(place, platform);
    const a = new URL(amap!.web), b = new URL(baidu!.href), web = new URL(baidu!.web);
    assert.equal(a.searchParams.get("position"), "113.245021,23.125304");
    assert.equal(a.searchParams.get("coordinate"), "gaode");
    assert.equal(a.searchParams.get("name"), place.name);
    const app = new URL(amap!.href);
    assert.equal(app.protocol, platform === "ios" ? "iosamap:" : platform === "android" ? "androidamap:" : "https:");
    if (platform !== "desktop") { assert.equal(app.searchParams.get("dev"), "0"); assert.equal(app.searchParams.get("lat"), "23.125304"); assert.equal(app.searchParams.get("lon"), "113.245021"); }
    assert.equal(new URL(amap!.web).searchParams.get("callnative"), "0");
    assert.equal(b.searchParams.get("location"), "23.125304,113.245021");
    assert.equal(b.searchParams.get("coord_type"), "gcj02");
    assert.equal(b.searchParams.get("title"), place.name);
    assert.equal(b.protocol, platform === "ios" ? "baidumap:" : platform === "android" ? "bdapp:" : "https:");
    assert.equal(web.protocol, "https:"); assert.equal(web.searchParams.get("output"), "html");
  }
});
test("manual places use full address fallback instead of sending invalid or missing coordinates", () => {
  for (const coords of [{}, { longitude: 200, latitude: 1 }, { longitude: 113 }, { longitude: NaN, latitude: 1 }]) {
    const [a, b] = placeMapLinks({ name: "面馆", city: "佛山", address: "桂城路1号", ...coords }, "ios");
    assert.equal(new URL(a!.href).searchParams.get("name"), "佛山 桂城路1号");
    assert.equal(new URL(b!.href).pathname, "/geocoder");
    assert.equal(new URL(b!.href).searchParams.get("address"), "佛山 桂城路1号");
    assert.equal(new URL(b!.href).searchParams.has("location"), false);
  }
});
test("iPhone offers Apple address lookup and explicit installation; other platforms omit it", () => {
  const items = placeMapLinks(place, "ios"), apple = items.find(item => item.id === "apple")!;
  assert.equal(items.length, 3); assert.equal(new URL(apple.href).protocol, "maps:");
  assert.equal(new URL(apple.href).searchParams.get("q"), `${place.city} ${place.address} ${place.name}`);
  assert.equal(new URL(apple.href).searchParams.has("ll"), false, "GCJ02 must not be sent as Apple WGS84");
  for (const item of items) assert.equal(new URL(item.install).hostname, "apps.apple.com");
  for (const platform of ["desktop", "android"] as const) assert.deepEqual(placeMapLinks(place, platform).map(item => item.id), ["amap", "baidu"]);
});
test("map platform includes iPads requesting desktop sites", () => {
  assert.equal(mapPlatform("Mozilla iPhone"), "ios");
  assert.equal(mapPlatform("Mozilla Macintosh", 5), "ios");
  assert.equal(mapPlatform("Mozilla Android"), "android");
  assert.equal(mapPlatform("Mozilla Windows"), "desktop");
});
