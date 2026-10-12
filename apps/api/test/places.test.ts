import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { normalisePoi } from "../src/routes-places.js";

test("place search uses the server key independently of IP, saves reusable details and protects place photos", async t => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-places-"));
  const original = globalThis.fetch;
  const config = readConfig({ LIFEOS_HOST: "127.0.0.1", LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_BACKUP_DIR: join(root, "backups"), LIFEOS_AMAP_API_KEY: "server-only-poi-key" });
  const { server, app } = createHttpServer(config);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let calls = 0, providerError = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "restapi.amap.com") return original(input, init);
    calls++;
    assert.equal(url.pathname, "/v5/place/text"); assert.equal(url.searchParams.get("key"), "server-only-poi-key");
    assert.equal(url.searchParams.get("region"), "佛山"); assert.equal(url.searchParams.get("city_limit"), "true");
    assert.equal(url.searchParams.get("show_fields"), "business,photos");
    return Response.json(providerError ? { status: "0", infocode: "10003", info: "sensitive-key-never-show" } : { status: "1", pois: [{ id: "B0TEST01", name: "张三牛肉面", address: "桂城路1号", pname: "广东省", cityname: "佛山市", adname: "南海区", typecode: "050100", location: "113.12,23.04", business: { tel: "0757-12345678" }, photos: [{ url: "https://store.is.autonavi.com/photo.jpg" }] }] });
  };
  t.after(async () => { globalThis.fetch = original; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await original(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
  };
  assert.equal((await call("/api/location/config")).body.enabled, false);
  assert.equal((await call("/api/places/search", { query: " ", city: "佛山" })).status, 400);
  assert.equal((await call("/api/places/search", { query: "店", page: 0 })).status, 400);
  assert.equal(calls, 0, "invalid input does not spend quota");
  const result = await call("/api/places/search", { query: "张三牛肉面", city: "佛山" });
  assert.equal(result.status, 200); assert.equal(result.body.items[0].phone, "0757-12345678");
  assert.equal(result.body.items[0].role, "dining"); assert.equal(result.body.items[0].longitude, 113.12);
  assert.equal(JSON.stringify(result.body).includes("server-only-poi-key"), false);
  const saved = await call("/api/entities", { type: "place", ...result.body.items[0] });
  assert.equal(saved.status, 201); const id = saved.body.id;
  assert.equal((await call("/api/entities", { type: "place", ...result.body.items[0] })).body.id, id);
  assert.equal((await call("/api/entities?type=place")).body.items.length, 1);
  assert.equal(calls, 1, "saving and reusing do not call the provider");
  assert.equal((await call(`/api/entities/${id}`, { role: "深夜食堂", phone: "13800138000" }, "PATCH")).body.role, "深夜食堂");
  for (const fields of [{ longitude: 999, latitude: 1 }, { latitude: null }, { phone: "a".repeat(201) }, { photoUrl: "javascript:alert(1)" }, { role: " " }]) assert.equal((await call(`/api/entities/${id}`, fields, "PATCH")).status, 400);
  assert.equal((await call("/api/entities", { type: "person", name: "错误资料", phone: "123" })).status, 400);
  const image = await sharp({ create: { width: 180, height: 180, channels: 3, background: "#808080" } }).png().toBuffer();
  const upload = await original(base + "/api/assets/uploads?purpose=avatar", { method: "POST", headers: { "content-type": "image/png" }, body: image });
  assert.equal(upload.status, 201); const asset: any = await upload.json();
  assert.equal((await call(`/api/entities/${id}`, { avatarAssetId: asset.id }, "PATCH")).status, 200);
  assert.ok(app.repository.referencedAssetIds().has(asset.id));
  assert.equal((await call(`/api/assets/${asset.id}`, undefined, "DELETE")).status, 409);
  const bundle = (await call("/api/export")).body;
  assert.equal(bundle.entities.find((p: any) => p.id === id).amapId, "B0TEST01");
  assert.equal((await call(`/api/entities/${id}`, undefined, "DELETE")).status, 204);
  assert.equal((await call("/api/import", { bundle: { ...bundle, assets: [] } })).status, 201);
  assert.equal((await call(`/api/entities/${id}`)).body.avatarAssetId, asset.id);
  assert.ok(app.repository.referencedAssetIds().has(asset.id), "import retains place photo references");
  const now = new Date().toISOString();
  for (const [name, extra] of [["上海", {}], ["广州", {}], ["广州", {}], ["北京", { isPrivate: true }], ["深圳", { isDemo: true }]] as const) {
    const response = await call("/api/records", { kind: "journal", content: `今天到${name}吃饭`, occurredAt: { kind: "instant", value: now }, ...extra });
    assert.equal(response.status, 201);
  }
  const cities = (await call("/api/places/cities")).body;
  assert.equal(cities.frequent[0], "广州市"); assert.ok(cities.recent.includes("上海市"));
  assert.ok(!cities.frequent.includes("北京市") && !cities.frequent.includes("深圳市"));
  providerError = true;
  const failed = await call("/api/places/search", { query: "张三牛肉面", city: "佛山" });
  assert.equal(failed.status, 502); assert.ok(JSON.stringify(failed.body).includes("10003")); assert.ok(!JSON.stringify(failed.body).includes("sensitive-key"));
});

test("POI parser tolerates missing photos, array-shaped empty fields, and invalid coordinates", () => {
  assert.equal(normalisePoi({ name: "店", id: "bad id" }), null);
  const item = normalisePoi({ name: "店", id: "B0001", address: [], business: { tel: [] }, location: "999,20", photos: [{ url: "javascript:alert(1)" }] });
  assert.deepEqual(item, { name: "店", amapId: "B0001" });
  assert.equal(normalisePoi({ name: "店", id: "B0001", photos: [{ url: "http://store.is.autonavi.com/a.jpg" }] })?.photoUrl, "https://store.is.autonavi.com/a.jpg");
});
