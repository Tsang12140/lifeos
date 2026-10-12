import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { locationClientIp, lookupAmapIp, publicAmapConfig, publicIpv4, readAmapConfig, saveAmapConfig } from "../src/amap-location.js";
import { tenantConfigFor } from "../src/tenant-config.js";
import type { AccountIdentity } from "../src/identity-store.js";
import type { IncomingMessage } from "node:http";

test("location previews do not change cities or profile keys; confirmation saves only the city", async t => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-location-"));
  const originalLog = process.env.LIFEOS_LOG_DIR;
  process.env.LIFEOS_LOG_DIR = join(root, "logs");
  const config = readConfig({ LIFEOS_HOST: "127.0.0.1", LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_BACKUP_DIR: join(root, "backups") });
  const { server } = createHttpServer(config);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  const originalProxy = process.env.LIFEOS_TRUST_PROXY;
  let geoCalls = 0, ipCalls = 0, failGeo = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "geoapi.qweather.com") {
      geoCalls += 1;
      assert.equal(url.searchParams.get("key"), "profile-private-probe");
      return Response.json(failGeo ? { code: "500" } : { code: "200", location: [{ id: "101280101", name: "广州", adm1: "广东", adm2: "广州" }] });
    }
    if (url.hostname === "restapi.amap.com") {
      ipCalls += 1; assert.equal(url.searchParams.get("ip"), "8.8.8.8");
      assert.equal(url.searchParams.get("key"), "amap-private-probe");
      return Response.json({ status: "1", city: "广州市", rectangle: "113.1,23.1;113.3,23.3" });
    }
    return originalFetch(input, init);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalProxy === undefined) delete process.env.LIFEOS_TRUST_PROXY; else process.env.LIFEOS_TRUST_PROXY = originalProxy;
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (originalLog === undefined) delete process.env.LIFEOS_LOG_DIR; else process.env.LIFEOS_LOG_DIR = originalLog;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true });
  });
  const first = await originalFetch(base + "/api/weather/status");
  const cookie = first.headers.get("set-cookie")?.match(/lifeos_weather_device=[^;]+/)?.[0] ?? "";
  const call = async (path: string, body?: unknown, headers = {}) => {
    const response = await originalFetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  assert.equal((await call("/api/weather/profiles", { label: "佛山", locationId: "101280800", city: "佛山", apiHost: "devapi.qweather.com", apiKey: "profile-private-probe", activate: true })).status, 200);
  const before = await call("/api/weather/profiles");
  const weatherFile = readFileSync(join(config.dataDirectory, "weather-config.json"), "utf8");
  const preview = await call("/api/weather/device/locate", { latitude: 23.12, longitude: 113.25, preview: true });
  assert.equal(preview.status, 200); assert.equal(preview.body.city, "广州");
  assert.deepEqual((await call("/api/weather/profiles")).body, before.body, "preview/cancellation preserves device city, profile and config");
  assert.equal(readFileSync(join(config.dataDirectory, "weather-config.json"), "utf8"), weatherFile);
  assert.equal((await call("/api/weather/device/locate", { latitude: 23.12, longitude: 113.25, preview: true })).status, 200);
  assert.equal(geoCalls, 1, "preview uses a successful city result instead of returning the old city when throttled");
  assert.equal((await call("/api/weather/device/location", { locationId: preview.body.locationId, city: preview.body.city })).status, 200);
  const after = (await call("/api/weather/profiles")).body;
  assert.equal(after.status.city, "广州"); assert.equal(after.activeProfileId, null); assert.equal(after.status.hasKey, true);
  assert.equal(readFileSync(join(config.dataDirectory, "weather-config.json"), "utf8").includes("profile-private-probe"), false);
  failGeo = true;
  assert.equal((await call("/api/weather/device/locate", { latitude: 24, longitude: 114, preview: true })).status, 502);
  failGeo = false;
  assert.equal((await call("/api/weather/device/locate", { latitude: 24, longitude: 114, preview: true })).status, 200, "failed lookup does not poison retry throttle");
  assert.equal((await call("/api/weather/device/locate", { latitude: 999, longitude: 114, preview: true })).status, 400);
  assert.equal((await call("/api/location/config")).body.enabled, false);
  const saved = await call("/api/location/config", { enabled: true, apiKey: "amap-private-probe" });
  assert.deepEqual(saved.body, { enabled: true, hasKey: true, keyUnreadable: false, keySource: "file" });
  assert.equal(readFileSync(join(config.dataDirectory, "amap-config.json"), "utf8").includes("amap-private-probe"), false);
  assert.equal((await call("/api/location/config", { enabled: true, apiKey: "" })).body.hasKey, true);
  delete process.env.LIFEOS_TRUST_PROXY;
  assert.equal((await call("/api/location/ip", {}, { "x-real-ip": "8.8.8.8" })).status, 422);
  assert.equal(ipCalls, 0, "untrusted headers cannot select a location or spend provider quota");
  process.env.LIFEOS_TRUST_PROXY = "1";
  const ipBefore = (await call("/api/weather/profiles")).body;
  for (let i = 0; i < 2; i++) {
    const ip = await call("/api/location/ip", {}, { "x-real-ip": "8.8.8.8" });
    assert.equal(ip.status, 200); assert.equal(ip.body.source, "ip");
  }
  assert.equal(ipCalls, 1); assert.deepEqual((await call("/api/weather/profiles")).body, ipBefore, "IP lookup never saves a weather city");
  assert.equal((await call("/api/location/config", { enabled: false, clearApiKey: true })).body.hasKey, false);
  assert.equal((await call("/api/location/ip", {}, { "x-real-ip": "8.8.8.8" })).status, 502);
  assert.equal(ipCalls, 1);
});

test("AMap ciphertext survives a blank save with a wrong encryption seed; proxy inputs fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-amap-key-"));
  try {
    const config = readConfig({ LIFEOS_DATA_DIR: root });
    const correct = { ...config, tenantConfigSecrets: { ...config.tenantConfigSecrets, weather: "correct-seed" } };
    const wrong = { ...correct, tenantConfigSecrets: { ...correct.tenantConfigSecrets, weather: "wrong-seed" } };
    saveAmapConfig(correct, { enabled: false, apiKey: "ciphertext-probe" });
    assert.equal(readAmapConfig(wrong).apiKey, undefined);
    saveAmapConfig(wrong, { enabled: true, apiKey: "" });
    assert.equal(readAmapConfig(correct).apiKey, "ciphertext-probe");
    for (const value of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "::1", "8.8.8.8,1.1.1.1"]) assert.equal(publicIpv4(value), false, value);
    const req = { socket: { remoteAddress: "::1" }, headers: { "x-real-ip": "127.0.0.1" } } as unknown as IncomingMessage;
    assert.equal(locationClientIp(req), null);
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); }
});

test("AMap environment key supports IP fallback, file precedence and isolated member credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-amap-env-"));
  const originalFetch = globalThis.fetch;
  try {
    const config = readConfig({ LIFEOS_DATA_DIR: root, LIFEOS_AMAP_API_KEY: " env-key-probe " });
    assert.equal(readConfig({ LIFEOS_AMAP_API_KEY: "  " }).amapApiKey, undefined);
    assert.deepEqual(publicAmapConfig(config), { enabled: false, hasKey: true, keyUnreadable: false, keySource: "env" });
    await assert.rejects(lookupAmapIp(config, "8.8.8.8"), /尚未启用/);
    saveAmapConfig(config, { enabled: true, apiKey: "" });
    assert.equal(readFileSync(join(root, "amap-config.json"), "utf8").includes("env-key-probe"), false, "blank save never copies the env secret to disk");
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "restapi.amap.com");
      assert.equal(url.searchParams.get("key"), "env-key-probe");
      assert.equal(url.searchParams.get("ip"), "8.8.8.8");
      return Response.json({ status: "1", city: "广州市", rectangle: "113,23;114,24" });
    };
    assert.deepEqual(await lookupAmapIp(config, "8.8.8.8"), { longitude: 113.5, latitude: 23.5 });
    const correct = { ...config, tenantConfigSecrets: { weather: "correct-env-seed" } };
    saveAmapConfig(correct, { enabled: true, apiKey: "file-key-probe" });
    assert.equal(readAmapConfig(correct).apiKey, "file-key-probe");
    assert.equal(publicAmapConfig(correct).keySource, "file");
    const wrong = { ...correct, tenantConfigSecrets: { weather: "wrong-env-seed" } };
    assert.equal(readAmapConfig(wrong).apiKey, undefined, "unreadable saved ciphertext must not silently fall back to env");
    assert.equal(publicAmapConfig(wrong).keyUnreadable, true);
    saveAmapConfig(wrong, { enabled: false, apiKey: "" });
    assert.equal(readAmapConfig(correct).apiKey, "file-key-probe");
    assert.equal(saveAmapConfig(correct, { enabled: false, clearApiKey: true }).keySource, "env");
    const member = tenantConfigFor(config, { tenantId: "11111111-1111-4111-8111-111111111111" } as AccountIdentity, "member-master-probe");
    assert.equal(member.amapApiKey, undefined);
    assert.equal(publicAmapConfig(member).hasKey, false, "member must not implicitly use the owner's env key");
    saveAmapConfig(member, { enabled: true, apiKey: "member-key-probe" });
    assert.equal(readAmapConfig(member).apiKey, "member-key-probe");
    assert.equal(readAmapConfig(config).apiKey, "env-key-probe");
  } finally {
    globalThis.fetch = originalFetch;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true });
  }
});
