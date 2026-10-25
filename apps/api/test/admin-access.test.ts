import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

async function fixture(t: import("node:test").TestContext, options: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-admin-access-"));
  const env: NodeJS.ProcessEnv = { LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_ALLOWED_ORIGINS: "http://127.0.0.1:3099", ...options };
  let instance: ReturnType<typeof createHttpServer>, base = "";
  const stop = async () => { if (instance?.server.listening) { instance.server.closeAllConnections(); await new Promise<void>(done => instance.server.close(() => done())); } };
  const start = async () => { instance = createHttpServer(readConfig(env)); await listenOnFetchablePort(instance.server); base = "http://127.0.0.1:" + (instance.server.address() as { port: number }).port; };
  await start(); t.after(async () => { await stop(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const request = async (path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", body: await response.json() as Record<string, any> };
  };
  const hostStatus = (host: string) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(base + "/api/auth", { headers: { host, "x-forwarded-host": "localhost" } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.once("error", reject); req.end();
  });
  return { request, hostStatus, restart: async (patch: NodeJS.ProcessEnv) => { await stop(); Object.assign(env, patch); await start(); } };
}

test("explicit preview administrator capability cannot be enabled for public, LAN or account-mode configurations", () => {
  assert.throws(() => readConfig({ LIFEOS_LOCAL_PREVIEW_ADMIN: "yes" }), /must be/);
  assert.throws(() => readConfig({ LIFEOS_LOCAL_PREVIEW_ADMIN: "1", LIFEOS_HOST: "0.0.0.0", LIFEOS_PASSWORD: "test-password" }), /loopback-only/);
  assert.throws(() => readConfig({ LIFEOS_LOCAL_PREVIEW_ADMIN: "1", LIFEOS_ALLOWED_ORIGINS: "https://public.example" }), /loopback-only/);
  assert.throws(() => readConfig({ LIFEOS_LOCAL_PREVIEW_ADMIN: "1", LIFEOS_ACCOUNT_MODE: "1", LIFEOS_OWNER_USERNAME: "owner", LIFEOS_PASSWORD: "owner-password-long", LIFEOS_ALLOWED_ORIGINS: "http://127.0.0.1:3099" }), /loopback-only/);
  assert.equal(readConfig({ LIFEOS_LOCAL_PREVIEW_ADMIN: "1" }).localPreviewAdmin, true);
});

test("ordinary local/password-only instances do not become administrators from localhost or forged username headers", async t => {
  const f = await fixture(t, { LIFEOS_OWNER_USERNAME: "owner", LIFEOS_PASSWORD: "local-password" });
  assert.equal((await f.request("/api/auth")).body.admin, false);
  const login = await f.request("/api/auth/login", "POST", { password: "local-password" });
  assert.equal(login.status, 200); assert.equal(login.body.admin, false);
  for (const path of ["/api/admin/attention", "/api/admin/assistant-welcome", "/api/admin/accounts", "/api/admin/invites", "/api/admin/storage-pool"]) assert.equal((await f.request(path, "GET", undefined, login.cookie, { "x-lifeos-admin": "true", "x-lifeos-username": "owner", "x-lifeos-local-preview-admin": "1" })).status, 403);
  assert.equal((await f.request("/api/ai/assistant/welcome", "GET", undefined, login.cookie)).status, 200);
});

test("explicit local preview retains administrator UI capability and welcome management while rejecting foreign Host and Origin", async t => {
  const f = await fixture(t, { LIFEOS_LOCAL_PREVIEW_ADMIN: "1" });
  const auth = await f.request("/api/auth"); assert.equal(auth.body.admin, true); assert.equal(auth.body.accountMode, undefined);
  assert.equal((await f.request("/api/admin/assistant-welcome")).status, 200);
  const added = await f.request("/api/admin/assistant-welcome", "POST", { text: "本机预览虚构问题" }); assert.equal(added.status, 201);
  // 「待处理」只列反复失败的东西；干净实例上它必须诚实地说没事，而不是编一条出来。
  const attention = await f.request("/api/admin/attention"); assert.equal(attention.status, 200);
  assert.ok(Array.isArray(attention.body.items)); assert.equal(typeof attention.body.summary.stuck, "number");
  assert.deepEqual(attention.body.summary, { stuck: 0, retrying: 0, fallbackTotal: 0 });
  assert.equal(attention.body.items.some((item: { severity: string }) => item.severity === "critical"), false);
  const retried = await f.request("/api/admin/attention/summary-retry", "POST", {});
  assert.equal(retried.status, 200); assert.deepEqual(retried.body, { retried: 0, recovered: 0, remaining: 0 });
  assert.equal((await f.request("/api/admin/attention/summary-retry", "GET")).status, 405);
  assert.equal((await f.request("/api/admin/assistant-welcome", "GET", undefined, "", { origin: "https://outside.example" })).status, 403);
  assert.equal(await f.hostStatus("outside.example"), 421, "raw HTTP preserves hostile Host; fetch rewrites it");
  await f.restart({ LIFEOS_LOCAL_PREVIEW_ADMIN: "0" });
  assert.equal((await f.request("/api/auth")).body.admin, false);
  assert.equal((await f.request("/api/admin/assistant-welcome")).status, 403);
});

test("only the env-designated logged-in owner is administrator; removing/changing designation revokes admin without breaking user login", async t => {
  const f = await fixture(t, { LIFEOS_ACCOUNT_MODE: "1", LIFEOS_OWNER_USERNAME: " OwNeR ", LIFEOS_PASSWORD: "owner-password-long" });
  assert.equal((await f.request("/api/auth")).body.admin, false);
  const owner = await f.request("/api/auth/login", "POST", { username: "owner", password: "owner-password-long" }); assert.equal(owner.body.admin, true);
  assert.equal((await f.request("/api/auth", "GET", undefined, owner.cookie)).body.admin, true);
  assert.equal((await f.request("/api/admin/accounts", "POST", { username: "member", password: "member-password-long", displayName: "成员", spaceName: "独立空间" }, owner.cookie)).status, 201);
  const member = await f.request("/api/auth/login", "POST", { username: "member", password: "member-password-long" }); assert.equal(member.body.admin, false);
  for (const path of ["/api/admin/attention", "/api/admin/assistant-welcome", "/api/admin/accounts", "/api/admin/invites", "/api/admin/storage-pool"]) assert.equal((await f.request(path, "GET", undefined, member.cookie, { "x-lifeos-admin": "true" })).status, 403);
  assert.equal((await f.request("/api/ai/assistant/welcome", "GET", undefined, member.cookie)).status, 200);
  for (const designation of ["another-owner", undefined]) {
    await f.restart({ LIFEOS_OWNER_USERNAME: designation, LIFEOS_PASSWORD: designation ? "ignored-bootstrap-password" : undefined });
    const state = (await f.request("/api/auth", "GET", undefined, owner.cookie)).body;
    assert.equal(state.authenticated, true); assert.equal(state.account.role, "owner"); assert.equal(state.admin, false);
    for (const path of ["/api/admin/attention", "/api/admin/assistant-welcome", "/api/admin/accounts", "/api/admin/invites", "/api/admin/storage-pool"]) assert.equal((await f.request(path, "GET", undefined, owner.cookie)).status, 403);
    assert.equal((await f.request("/api/records", "GET", undefined, owner.cookie)).status, 200);
    assert.equal((await f.request("/api/admin/assistant-welcome/welcome-01", "PATCH", { revision: 1, enabled: false }, owner.cookie)).status, 403);
  }
});
