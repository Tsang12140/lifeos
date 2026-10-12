import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { placePhotoTransport, placePhotoUrl, downloadPlacePhoto } from "../src/place-photo.js";
import dns from "node:dns/promises";
import https from "node:https";
import { PassThrough } from "node:stream";
import { normalisePoi, requestPlaceSearch } from "../src/routes-places.js";

test("place search uses the server key independently of IP, saves reusable details and protects place photos", async t => {
  const transport = placePhotoTransport.download;
  let photoCalls = 0, failPhoto = false;
  placePhotoTransport.download = async () => { photoCalls++; if (failPhoto) throw Error("fixture"); return { bytes: await sharp({ create: { width: 300, height: 200, channels: 3, background: "#607060" } }).png().toBuffer(), mediaType: "image/png" }; };
  t.after(() => { placePhotoTransport.download = transport; });
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
  assert.ok(saved.body.avatarAssetId, "selected provider photo is stored as a managed asset");
  const storedImage = await original(base + `/api/assets/${saved.body.avatarAssetId}/thumbnail?w=160`);
  assert.equal(storedImage.status, 200);
  const metadata = await sharp(Buffer.from(await storedImage.arrayBuffer())).metadata();
  assert.equal(metadata.width, 160); assert.equal(metadata.height, 160); assert.equal(metadata.format, "webp");
  assert.ok(app.repository.referencedAssetIds().has(saved.body.avatarAssetId));
  assert.equal((await call(`/api/assets/${saved.body.avatarAssetId}`, undefined, "DELETE")).status, 409);
  assert.equal((await call(`/api/entities/${id}/photo/import`, {})).body.saved, true);
  assert.equal(photoCalls, 1, "already copied photos are never downloaded again");
  assert.equal((await call("/api/entities", { type: "place", ...result.body.items[0] })).body.id, id);
  assert.equal((await call("/api/entities?type=place")).body.items.length, 1);
  assert.equal(calls, 1, "saving and reusing do not call the provider");
  assert.equal(photoCalls, 1);
  await call(`/api/entities/${id}`); await call("/api/entities?type=place");
  assert.equal(photoCalls, 1, "reads never import or call a provider");
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
  failPhoto = true;
  const missing = await call("/api/entities", { type: "place", name: "图片失效的店", amapId: "BFAIL01", photoUrl: "https://aos-comment.amap.com/missing.jpg" });
  assert.equal(missing.status, 201); assert.equal(missing.body.avatarAssetId, undefined);
  const failureId = missing.body.id;
  assert.equal((await call(`/api/entities/${failureId}/photo/import`, {})).body.saved, false);
  failPhoto = false;
  const copied = (await call(`/api/entities/${failureId}/photo/import`, {})).body;
  assert.equal(copied.saved, true); assert.equal(copied.entity.avatarAssetId, saved.body.avatarAssetId, "identical photo bytes reuse managed asset");
  const beforeUnsafe = photoCalls;
  const unsafe = await call("/api/entities", { type: "place", name: "不可信图片", amapId: "BFAIL02", photoUrl: "https://127.0.0.1/private" });
  assert.equal(unsafe.status, 201); assert.equal(unsafe.body.avatarAssetId, undefined); assert.equal(photoCalls, beforeUnsafe);
  // A user removing or replacing a photo during a download must win.
  await call(`/api/entities/${failureId}`, { avatarAssetId: null }, "PATCH");
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { started = done; });
  placePhotoTransport.download = async () => { started(); await gate; return { bytes: image, mediaType: "image/png" }; };
  const inFlight = call(`/api/entities/${failureId}/photo/import`, {});
  await entered;
  await call(`/api/entities/${failureId}`, { photoUrl: null }, "PATCH");
  release(); await inFlight;
  assert.equal((await call(`/api/entities/${failureId}`)).body.avatarAssetId, undefined, "concurrent removal is not overwritten");
  providerError = true;
  const failed = await call("/api/places/search", { query: "另一家牛肉面", city: "佛山" });
  assert.equal(failed.status, 502); assert.ok(JSON.stringify(failed.body).includes("10003")); assert.ok(!JSON.stringify(failed.body).includes("sensitive-key"));
});

test("nearby search converts GPS, sorts distances, caches requests and falls back without precise coordinates", async t => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-nearby-"));
  const original = globalThis.fetch;
  const { server } = createHttpServer(readConfig({ LIFEOS_HOST: "127.0.0.1", LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_BACKUP_DIR: join(root, "backups"), LIFEOS_AMAP_API_KEY: "nearby-secret" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const urls: URL[] = []; let failConversion = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "restapi.amap.com") return original(input, init);
    urls.push(url);
    if (url.pathname.endsWith("/convert")) {
      assert.equal(url.searchParams.get("coordsys"), "gps");
      return Response.json(failConversion ? { status: "0" } : { status: "1", locations: "113.12,23.04" });
    }
    return Response.json({ status: "1", pois: [{ id: "BFAR", name: "陈师傅牛肉店（远）", location: "113.13,23.04" }, { id: "BNEAR", name: "陈师傅牛肉店（近）", location: "113.1203,23.04" }] });
  };
  t.after(async () => { globalThis.fetch = original; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const call = async (body: unknown) => { const r = await original(`http://127.0.0.1:${address.port}/api/places/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, value: await r.json() as any }; };
  const location = { longitude: 113.115, latitude: 23.035, accuracy: 15 };
  const body = { query: "陈师傅牛肉店", location };
  const result = await call(body);
  assert.equal(result.status, 200); assert.equal(result.value.mode, "nearby");
  assert.equal(urls.length, 2); assert.equal(urls[1]!.pathname, "/v5/place/around");
  assert.equal(urls[1]!.searchParams.get("location"), "113.120000,23.040000");
  assert.equal(urls[1]!.searchParams.get("sortrule"), "distance");
  assert.equal(urls[1]!.searchParams.get("radius"), "5000");
  assert.equal(result.value.items[0].amapId, "BNEAR");
  assert.ok(result.value.items[0].distanceMeters > 20 && result.value.items[0].distanceMeters < 40, "distance uses the converted origin, not raw GPS");
  assert.ok(!JSON.stringify(result.value).includes("nearby-secret"));
  await call(body); assert.equal(urls.length, 2, "repeated searches use a short cache");
  await call({ ...body, radius: 50000 }); assert.equal(urls.length, 3, "new radius reuses conversion only");
  assert.equal(urls.at(-1)!.searchParams.get("radius"), "50000");
  const city = await call({ ...body, city: "广州" });
  assert.equal(city.value.mode, "text"); assert.equal(city.value.items[0].distanceMeters, undefined);
  assert.equal(urls.at(-1)!.pathname, "/v5/place/text"); assert.equal(urls.at(-1)!.searchParams.get("region"), "广州");
  const coarse = await call({ ...body, location: { ...location, accuracy: 3000 } });
  assert.equal(coarse.value.mode, "text"); assert.equal(coarse.value.origin, undefined);
  assert.equal(urls.at(-1)!.searchParams.has("region"), false);
  assert.equal((await call({ query: "地址" })).status, 200, "city and GPS are optional");
  const before = urls.length;
  for (const invalid of [{ ...body, radius: 50001 }, { ...body, location: { ...location, latitude: 91 } }, { ...body, location: { latitude: 1, longitude: 1 } }, { ...body, location: { ...location, accuracy: -1 } }]) assert.equal((await call(invalid)).status, 400);
  assert.equal(urls.length, before, "invalid inputs spend no quota");
  failConversion = true;
  const fallback = await call({ ...body, location: { ...location, longitude: 114 } });
  assert.equal(fallback.status, 200); assert.equal(fallback.value.mode, "text");
  assert.equal(urls.at(-1)!.pathname, "/v5/place/text");
});

test("POI parser tolerates missing photos, array-shaped empty fields, and invalid coordinates", () => {
  assert.equal(normalisePoi({ name: "店", id: "bad id" }), null);
  const item = normalisePoi({ name: "店", id: "B0001", address: [], business: { tel: [] }, location: "999,20", photos: [{ url: "javascript:alert(1)" }] });
  assert.deepEqual(item, { name: "店", amapId: "B0001" });
  assert.equal(normalisePoi({ name: "店", id: "B0001", photos: [{ url: "http://store.is.autonavi.com/a.jpg" }] })?.photoUrl, "https://store.is.autonavi.com/a.jpg");
});

test("place transport recovers once from a reset without retrying provider errors or leaking keys", async t => {
  const original = globalThis.fetch, warn = console.warn;
  const logs: string[] = [], signals: unknown[] = [];
  console.warn = message => { logs.push(String(message)); };
  t.after(() => { globalThis.fetch = original; console.warn = warn; });
  const url = new URL("https://restapi.amap.com/v5/place/text?key=secret-not-for-logs");
  const reset = new TypeError(`fetch failed ${url.href}`, { cause: Object.assign(new Error(url.href), { code: "ECONNRESET" }) });
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++; signals.push(init?.signal);
    if (calls === 1) throw reset;
    return Response.json({ status: "1", pois: [] });
  };
  assert.equal((await requestPlaceSearch(url)).data?.status, "1");
  assert.equal(calls, 2); assert.equal(signals[0], signals[1], "one shared deadline covers both attempts");
  assert.ok(logs.some(line => line.includes("ECONNRESET") && line.includes('"retry":true')));

  calls = 0;
  globalThis.fetch = async () => { calls++; throw reset; };
  await assert.rejects(requestPlaceSearch(url), error => error === reset);
  assert.equal(calls, 2, "permanent network failure stops after one retry");

  calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ status: "0", infocode: "10003" }); };
  assert.equal((await requestPlaceSearch(url)).data?.infocode, "10003");
  assert.equal(calls, 1, "provider key/quota rejection is not retried");

  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("invalid JSON with secret-not-for-logs"); };
  await assert.rejects(requestPlaceSearch(url), SyntaxError);
  assert.equal(calls, 1, "malformed data is not a transient connection failure");

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(reset); } }));
    return Response.json({ status: "1", pois: [] });
  };
  assert.equal((await requestPlaceSearch(url)).data?.status, "1");
  assert.equal(calls, 2, "a reset while reading the response also recovers");

  calls = 0;
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => { assert.equal(milliseconds, 10000); return controller.signal; });
  globalThis.fetch = async () => { calls++; controller.abort(); throw reset; };
  await assert.rejects(requestPlaceSearch(url));
  assert.equal(calls, 1, "an expired deadline cannot launch another request");
  assert.ok(logs.every(line => !line.includes("secret-not-for-logs") && !line.includes("https://")), "logs omit provider URL, key and raw error messages");
});


test("place photo URL rejects arbitrary origins and private DNS before any request", async t => {
  for (const url of ["http://store.is.autonavi.com/a", "https://store.is.autonavi.com.evil.test/a", "https://user:pass@store.is.autonavi.com/a", "https://aos-comment.amap.com:444/a", "https://localhost/a", "https://169.254.169.254/latest"]) assert.throws(() => placePhotoUrl(url));
  assert.equal(placePhotoUrl("https://aos-comment.amap.com/a.jpg").hostname, "aos-comment.amap.com");
  const lookup = dns.lookup;
  t.after(() => { dns.lookup = lookup; });
  dns.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof dns.lookup;
  await assert.rejects(downloadPlacePhoto("https://store.is.autonavi.com/a"), /private_photo_address/);
});

test("place photo transport pins public DNS and rejects redirects, oversized bodies and non-images", async t => {
  const lookup = dns.lookup, get = https.get;
  t.after(() => { dns.lookup = lookup; https.get = get; });
  dns.lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof dns.lookup;
  let status = 200, type = "image/png", body = Buffer.from("image"), declared: string | undefined;
  https.get = ((_url: unknown, options: any, callback: (response: any) => void) => {
    assert.equal(options.agent, false);
    options.lookup("store.is.autonavi.com", {}, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
    const request = new PassThrough();
    const response = Object.assign(new PassThrough(), { statusCode: status, headers: { "content-type": type, ...(declared ? { "content-length": declared } : {}) } });
    queueMicrotask(() => { callback(response); response.end(body); });
    return request;
  }) as unknown as typeof https.get;
  assert.equal((await downloadPlacePhoto("https://store.is.autonavi.com/a")).bytes.toString(), "image");
  status = 302; await assert.rejects(downloadPlacePhoto("https://store.is.autonavi.com/a"), /photo_http_failed/);
  status = 200; type = "text/html"; await assert.rejects(downloadPlacePhoto("https://store.is.autonavi.com/a"), /photo_type_invalid/);
  type = "image/png"; declared = "9999999"; await assert.rejects(downloadPlacePhoto("https://store.is.autonavi.com/a"), /photo_too_large/);
  declared = undefined; body = Buffer.alloc(2 * 1024 * 1024 + 1); await assert.rejects(downloadPlacePhoto("https://store.is.autonavi.com/a"), /photo_too_large/);
});
