import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readConfig } from "../src/config.js";
import { tenantConfigFor } from "../src/tenant-config.js";
import type { AccountIdentity } from "../src/identity-store.js";
import { lookupAmapIp, publicAmapConfig, readAmapConfig, saveAmapConfig } from "../src/amap-location.js";
import { publicMovieConfig, readRuntimeMovieConfig, saveRuntimeMovieConfig } from "../src/movie-config.js";
import { photoTextStatus, saveRuntimePhotoTextConfig } from "../src/photo-text-config.js";
import { createHttpServer } from "../src/server.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

const member = { tenantId: "11111111-1111-4111-8111-111111111111" } as AccountIdentity;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lifeos-shared-services-"));
  const owner = readConfig({ LIFEOS_DATA_DIR: root, LIFEOS_AMAP_API_KEY: "env-map-key", LIFEOS_TMDB_API_KEY: "env-movie-key", LIFEOS_TENCENT_SECRET_ID: "ocr-id", LIFEOS_TENCENT_SECRET_KEY: "ocr-secret", DASHSCOPE_API_KEY: "embedding-key" });
  const config = tenantConfigFor(owner, member, "isolated-master", {
    amap: () => { const value = readAmapConfig(owner); return value.apiKey ? { apiKey: value.apiKey } : undefined; },
    movie: () => { const value = readRuntimeMovieConfig(owner); return value.apiKey ? { apiKey: value.apiKey } : undefined; },
  });
  return { owner, config, close() { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); } };
}

test("map credentials resolve live from the owner without copying keys or location preferences", async t => {
  const f = fixture(); t.after(() => f.close());
  const { config, owner } = f;
  assert.deepEqual(publicAmapConfig(config), { enabled: false, photoAddress: true, hasKey: true, keyUnreadable: false, keySource: "shared" });
  saveAmapConfig(owner, { enabled: true, apiKey: "owner-map-v1" });
  assert.equal(publicAmapConfig(config).enabled, false);
  assert.equal(readAmapConfig(config).apiKey, "owner-map-v1");
  saveAmapConfig(config, { enabled: true, apiKey: "" });
  assert.deepEqual(JSON.parse(readFileSync(join(config.dataDirectory, "amap-config.json"), "utf8")), { enabled: true });
  const original = globalThis.fetch, calls: string[] = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => {
    const url = new URL(String(input)); assert.equal(url.hostname, "restapi.amap.com"); calls.push(url.searchParams.get("key")!);
    return Response.json({ status: "1", city: "广州市", rectangle: "113,23;114,24" });
  };
  await lookupAmapIp(config, "8.8.8.8");
  saveAmapConfig(owner, { enabled: false, apiKey: "owner-map-v2" });
  await lookupAmapIp(config, "8.8.8.8");
  assert.deepEqual(calls, ["owner-map-v1", "owner-map-v2"], "rotation invalidates an existing IP cache entry");
  assert.equal(publicAmapConfig(config).enabled, true, "owner switches are not inherited");
  assert.equal(JSON.stringify(publicAmapConfig(config)).includes("owner-map"), false);
  assert.equal(saveAmapConfig(owner, { enabled: false, clearApiKey: true }).keySource, "env");
  assert.equal(readAmapConfig(config).apiKey, "env-map-key");
});

test("movie preference saves preserve live shared and environment keys without persisting borrowed credentials", t => {
  const f = fixture(); t.after(() => f.close());
  const { config, owner } = f;
  assert.equal(publicMovieConfig(config).source, "shared");
  assert.equal(publicMovieConfig(config).enabled, false);
  saveRuntimeMovieConfig(owner, { enabled: true, apiKey: "owner-movie-v1" });
  assert.equal(publicMovieConfig(config).enabled, false);
  assert.equal(saveRuntimeMovieConfig(config, { enabled: true, apiKey: "" }).configured, true);
  assert.deepEqual(JSON.parse(readFileSync(join(config.dataDirectory, "movie-config.json"), "utf8")), { enabled: true });
  saveRuntimeMovieConfig(owner, { enabled: false, apiKey: "owner-movie-v2" });
  assert.equal(readRuntimeMovieConfig(config).apiKey, "owner-movie-v2");
  assert.equal(readRuntimeMovieConfig(config).enabled, true);
  assert.equal(JSON.stringify(publicMovieConfig(config)).includes("owner-movie"), false);
  saveRuntimeMovieConfig(owner, { enabled: true, clearApiKey: true });
  assert.equal(readRuntimeMovieConfig(config).apiKey, "env-movie-key");
  assert.deepEqual(JSON.parse(readFileSync(join(owner.dataDirectory, "movie-config.json"), "utf8")), { enabled: true });
  assert.equal(readRuntimeMovieConfig({ ...owner, tmdbApiKey: "env-movie-rotated" }).apiKey, "env-movie-rotated");
});

test("unreadable personal map/movie keys survive blank saves and clearing them resumes sharing", t => {
  const f = fixture(); t.after(() => f.close());
  saveAmapConfig(f.config, { enabled: true, apiKey: "personal-map" });
  saveRuntimeMovieConfig(f.config, { enabled: true, apiKey: "personal-movie" });
  const paths = [join(f.config.dataDirectory, "amap-config.json"), join(f.config.dataDirectory, "movie-config.json")];
  const before = paths.map(path => readFileSync(path, "utf8"));
  const wrong = { ...f.config, tenantConfigSecrets: { weather: "wrong", movie: "wrong" } };
  assert.equal(publicAmapConfig(wrong).keyUnreadable, true);
  assert.equal(readRuntimeMovieConfig(wrong).apiKey, undefined);
  saveAmapConfig(wrong, { enabled: true, apiKey: "" });
  saveRuntimeMovieConfig(wrong, { enabled: true, apiKey: "" });
  assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before);
  assert.equal(readAmapConfig(f.config).apiKey, "personal-map");
  assert.equal(readRuntimeMovieConfig(f.config).apiKey, "personal-movie");
  assert.equal(saveAmapConfig(wrong, { enabled: true, clearApiKey: true }).keySource, "shared");
  assert.equal(saveRuntimeMovieConfig(wrong, { enabled: true, clearApiKey: true }).source, "shared");
  assert.equal(readAmapConfig(f.owner).apiKey, "env-map-key");
  assert.equal(readRuntimeMovieConfig(f.owner).apiKey, "env-movie-key");
});

test("OCR and embeddings already share server credentials while photo processing switches remain personal", t => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.config.tencentOcr, f.owner.tencentOcr);
  assert.equal(f.config.journalEmbedding, f.owner.journalEmbedding);
  assert.equal(f.config.tencentOcr?.secretKey, "ocr-secret");
  assert.equal(f.config.journalEmbedding?.apiKey, "embedding-key");
  assert.equal(photoTextStatus(f.config).ocr.credentials, true);
  saveRuntimePhotoTextConfig(f.config, { ocr: false, caption: false });
  assert.equal(photoTextStatus(f.owner).ocr.enabled, true);
  assert.equal(photoTextStatus(f.config).ocr.enabled, false);
  assert.equal(JSON.stringify(photoTextStatus(f.config)).includes("ocr-secret"), false);
});

test("cached member apps use owner map/movie keys after setup, rotation and revocation without changing owner settings", async t => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-shared-gateway-"));
  const originalLog = process.env.LIFEOS_LOG_DIR, originalFetch = globalThis.fetch;
  process.env.LIFEOS_LOG_DIR = join(root, "logs");
  const config = readConfig({ LIFEOS_HOST: "127.0.0.1", LIFEOS_ACCOUNT_MODE: "1", LIFEOS_OWNER_USERNAME: "owner", LIFEOS_PASSWORD: "isolated-owner-password", LIFEOS_DATA_DIR: root, LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_BACKUP_DIR: join(root, "backups"), LIFEOS_WEB_DIR: join(root, "web"), LIFEOS_ALLOWED_ORIGINS: "http://127.0.0.1:3001" });
  const { server } = createHttpServer(config);
  await listenOnFetchablePort(server);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  (config.allowedOrigins as string[]).push(base);
  t.after(async () => { globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); if (originalLog === undefined) delete process.env.LIFEOS_LOG_DIR; else process.env.LIFEOS_LOG_DIR = originalLog; assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const calls: { host: string; key: string | null; redirect: RequestInit["redirect"] }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === "http:") return originalFetch(input, init);
    assert.ok(["restapi.amap.com", "api.themoviedb.org"].includes(url.hostname), "unexpected external request");
    calls.push({ host: url.hostname, key: url.searchParams.get(url.hostname === "restapi.amap.com" ? "key" : "api_key"), redirect: init?.redirect });
    if (url.hostname === "restapi.amap.com") return Response.json({ status: "1", pois: [{ id: "MAP_SHARED_1", name: "共享店铺", location: "113,23", address: "测试地址" }] });
    return Response.json({ results: [{ id: 123, media_type: "movie", title: "共享电影", release_date: "2020-01-01" }] });
  };
  const call = async (cookie: string, path: string, body?: unknown) => { const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, body: await response.json() as any }; };
  const login = async (username: string, password: string) => { const value = await call("", "/api/auth/login", { username, password }); assert.equal(value.response.status, 200); return value.response.headers.get("set-cookie")!.split(";")[0]!; };
  const owner = await login("owner", "isolated-owner-password");
  const created = await call(owner, "/api/admin/accounts", { username: "shared-member", password: "isolated-member-password", displayName: "Shared", spaceName: "Shared" });
  assert.equal(created.response.status, 201);
  const memberCookie = await login("shared-member", "isolated-member-password");
  assert.equal((await call(memberCookie, "/api/location/config")).body.hasKey, false);
  assert.equal((await call(memberCookie, "/api/movie/status")).body.hasKey, false);
  for (const version of [1, 2]) {
    assert.equal((await call(owner, "/api/location/config", { enabled: false, apiKey: `owner-map-v${version}` })).response.status, 200);
    assert.equal((await call(owner, "/api/movie/config", { enabled: false, apiKey: `owner-movie-v${version}` })).response.status, 200);
    const map = await call(memberCookie, "/api/location/config"); assert.equal(map.body.hasKey, true); assert.equal(map.body.keySource, "shared");
    const movie = await call(memberCookie, "/api/movie/status"); assert.equal(movie.body.hasKey, true); assert.equal(movie.body.source, "shared");
    assert.equal((await call(memberCookie, "/api/location/config", { enabled: true, apiKey: "" })).body.keySource, "shared");
    assert.equal((await call(memberCookie, "/api/movie/config", { enabled: true, apiKey: "" })).body.source, "shared");
    assert.equal((await call(memberCookie, "/api/places/search", { query: "共享店铺", city: "广州" })).response.status, 200);
    assert.equal((await call(memberCookie, "/api/movie/resolve", { query: "共享电影" })).response.status, 200);
    assert.equal((await call(memberCookie, "/api/movie/config/test", {})).response.status, 200);
    assert.equal(calls.filter(x => x.host === "restapi.amap.com").at(-1)?.key, `owner-map-v${version}`);
    assert.equal(calls.filter(x => x.host === "api.themoviedb.org").at(-1)?.key, `owner-movie-v${version}`);
    assert.equal(JSON.stringify([map.body, movie.body]).includes("owner-map"), false);
    assert.equal(JSON.stringify([map.body, movie.body]).includes("owner-movie"), false);
    assert.equal((await call(owner, "/api/location/config")).body.enabled, false);
    assert.equal((await call(owner, "/api/movie/status")).body.enabled, false);
  }
  const tenant = join(root, "tenants", created.body.account.tenantId);
  assert.deepEqual(JSON.parse(readFileSync(join(tenant, "amap-config.json"), "utf8")), { enabled: true });
  assert.deepEqual(JSON.parse(readFileSync(join(tenant, "movie-config.json"), "utf8")), { enabled: true });
  await call(owner, "/api/location/config", { enabled: false, clearApiKey: true });
  await call(owner, "/api/movie/config", { enabled: false, clearApiKey: true });
  assert.equal((await call(memberCookie, "/api/location/config")).body.hasKey, false);
  assert.equal((await call(memberCookie, "/api/movie/status")).body.hasKey, false);
  assert.equal((await call(memberCookie, "/api/places/search", { query: "共享店铺" })).response.status, 409);
  assert.equal((await call(memberCookie, "/api/movie/resolve", { query: "共享电影" })).response.status, 503);
  assert.ok(calls.every(x => x.redirect === "error"));
});
