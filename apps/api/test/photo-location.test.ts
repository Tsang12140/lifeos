import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Asset } from "@lifeos/core";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { resetPhotoLocationCache } from "../src/photo-location.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

/**
 * The address next to a photo is a courtesy lookup; the coordinate is the fact.
 * These tests hold both halves: the address is fetched once per distinct point,
 * stored beside the data, and its absence never costs the panel a coordinate.
 */

const regeo = (component: Record<string, unknown>, aoi?: string) => (url: URL) => url.pathname.endsWith("/convert")
  ? { status: "1", locations: "113.195657,23.113234" }
  : { status: "1", regeocode: { addressComponent: component, ...(aoi ? { aois: [{ name: aoi }] } : {}) } };

async function harness(t: TestContext, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-photo-location-"));
  const config = readConfig({ LIFEOS_HOST: "127.0.0.1", LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_BACKUP_DIR: join(root, "backup"), ...env });
  const app = createHttpServer(config); await listenOnFetchablePort(app.server);
  const address = app.server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const original = globalThis.fetch;
  const state: { calls: URL[]; reply: (url: URL) => unknown } = { calls: [], reply: regeo({}) };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === base) return original(input, init);
    assert.equal(url.origin, "https://restapi.amap.com");
    state.calls.push(url);
    return Response.json(state.reply(url));
  };
  t.after(async () => {
    globalThis.fetch = original;
    app.server.closeAllConnections(); await new Promise<void>(done => app.server.close(() => done()));
    resetPhotoLocationCache(); rmSync(root, { recursive: true, force: true });
  });
  // Content addressing means identical bytes reuse one asset: every fixture differs.
  let seq = 0;
  const upload = async () => {
    const bytes = await sharp({ create: { width: 24 + seq++, height: 16, channels: 3, background: "blue" } }).jpeg().toBuffer();
    const response = await original(`${base}/api/assets/uploads?name=location.jpg`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: bytes });
    assert.equal(response.status, 201);
    return await response.json() as Asset;
  };
  /** Stamp coordinates onto a real asset: EXIF stays untouched, only the metadata does. */
  const withPoint = (asset: Asset, latitude?: number, longitude?: number) => {
    const stamped = { ...asset, photoMetadata: { version: 1 as const, width: asset.photoMetadata?.width ?? 24, height: asset.photoMetadata?.height ?? 16, cameraEvidence: "capture" as const, detailsVersion: 1 as const, details: latitude === undefined || longitude === undefined ? { lens: "fake" } : { latitude, longitude } } };
    app.app.repository.updateAsset(stamped);
    return stamped;
  };
  const read = async (id: string) => {
    const response = await original(`${base}/api/assets/${encodeURIComponent(id)}/photo-location`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { root, config, app, base, state, original, upload, withPoint, read };
}

test("photo-location turns one coordinate into an address, caches it, and degrades without losing the number", async t => {
  const { root, config, app, state, upload, withPoint, read } = await harness(t, { LIFEOS_AMAP_API_KEY: "fake-location-key" });
  state.reply = regeo({ province: "广东省", city: "佛山市", district: "南海区", township: "大沥镇" }, "随寓青年社区(广佛路店)");
  const asset = withPoint(await upload(), 23.115861111111112, 113.19027777777778);

  const first = await read(asset.id);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { place: "随寓青年社区(广佛路店)", area: "佛山市南海区大沥镇", latitude: 23.115861111111112, longitude: 113.19027777777778 });
  assert.equal(state.calls.length, 2, "one coordinate conversion plus one reverse geocode");
  assert.equal(state.calls[0]!.searchParams.get("coordsys"), "gps", "EXIF is WGS84 and must be converted, not passed through");
  assert.equal(state.calls[1]!.searchParams.get("extensions"), "all", "the AOI name only exists in the extended payload");
  assert.equal(state.calls[1]!.searchParams.get("location"), "113.195657,23.113234");

  // The panel reopens constantly; only the first open may cost a request.
  await read(asset.id); await read(asset.id);
  assert.equal(state.calls.length, 2, "repeat opens hit the in-memory cache");

  // A different photo taken at the same spot must not pay again.
  const twin = withPoint(await upload(), 23.115861111111112, 113.19027777777778);
  await read(twin.id);
  assert.equal(state.calls.length, 2, "the same point is one lookup, not one per photo");

  // A restart drops the memory cache, not the stored address.
  await new Promise(resolve => setTimeout(resolve, 700));
  resetPhotoLocationCache();
  await read(asset.id);
  assert.equal(state.calls.length, 2, "the address survives a restart because it is stored beside the data");
  const stored = JSON.parse(readFileSync(join(config.dataDirectory, "derived", "photo-addresses.json"), "utf8")) as { entries: Record<string, { place?: string }> };
  assert.equal(stored.entries["23.11586,113.19028"]?.place, "随寓青年社区(广佛路店)");

  // Municipalities report an empty city: the province is the city there.
  state.reply = regeo({ province: "北京市", city: [], district: "朝阳区", township: "望京街道" }, "望京SOHO");
  const beijing = withPoint(await upload(), 39.99, 116.47);
  const beijingBody = (await read(beijing.id)).body;
  assert.equal(beijingBody.area, "北京市朝阳区望京街道");
  assert.equal(beijingBody.place, "望京SOHO");

  // No coordinates at all: the panel keeps its own silence, no provider call.
  const count = state.calls.length;
  const plain = await upload();
  assert.deepEqual((await read(plain.id)).body, { unavailable: "no_gps" });
  assert.equal(state.calls.length, count, "a photo without GPS never reaches the provider");

  // A throttled provider is reported, never retried on every open.
  state.reply = (url: URL) => url.pathname.endsWith("/convert")
    ? { status: "1", locations: "114.3,30.5" }
    : { status: "0", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT", infocode: "10021" };
  const throttled = withPoint(await upload(), 30.5, 114.3);
  assert.deepEqual((await read(throttled.id)).body, { unavailable: "rate_limited" });
  const afterFirstMiss = state.calls.length;
  await read(throttled.id);
  assert.equal(state.calls.length, afterFirstMiss, "a recent miss is remembered instead of hammering the endpoint");

  // The key must never travel back to the browser, and the EXIF value stays as read.
  assert(!JSON.stringify(await read(asset.id)).includes("fake-location-key"));
  assert.equal(app.app.repository.findAssetById(asset.id)?.photoMetadata?.details?.latitude, 23.115861111111112);
  assert(!readFileSync(join(root, "data", "derived", "photo-addresses.json"), "utf8").includes("fake-location-key"));
});

test("photo-location stops asking, and stops showing, the moment its switch is off", async t => {
  const { base, state, upload, withPoint, read, original } = await harness(t, { LIFEOS_AMAP_API_KEY: "fake-location-key" });
  state.reply = regeo({ province: "广东省", city: "佛山市", district: "南海区", township: "大沥镇" }, "随寓青年社区(广佛路店)");
  const asset = withPoint(await upload(), 23.115861111111112, 113.19027777777778);
  assert.equal((await read(asset.id)).body.place, "随寓青年社区(广佛路店)");
  const paid = state.calls.length;
  const save = async (body: Record<string, unknown>) => {
    const response = await original(`${base}/api/location/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return await response.json() as { enabled: boolean; photoAddress: boolean };
  };

  assert.equal((await save({ enabled: false, photoAddress: false })).photoAddress, false);
  assert.deepEqual((await read(asset.id)).body, { unavailable: "disabled" }, "turning it off also hides what was already resolved");
  assert.equal(state.calls.length, paid, "and sends nothing to the provider");

  // The two consents are independent: the IP fallback stays off here.
  assert.equal((await save({ enabled: false, photoAddress: true })).photoAddress, true);
  assert.equal((await read(asset.id)).body.place, "随寓青年社区(广佛路店)", "turning it back on restores the stored address");
  assert.equal(state.calls.length, paid, "restoring costs no call: switching off keeps the local cache");
  assert.equal((await save({ enabled: false })).photoAddress, true, "an older client that never heard of the field keeps it on");
});

test("photo-location says so plainly when no Amap key is configured", async t => {
  const { state, upload, withPoint, read } = await harness(t);
  const asset = withPoint(await upload(), 23.1, 113.1);
  const response = await read(asset.id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { unavailable: "no_key" });
  assert.equal(state.calls.length, 0, "without a key there is nothing to ask");
  assert.equal((await read("asset_missing")).status, 404);
});
