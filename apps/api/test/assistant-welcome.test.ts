import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WELCOME_PROMPT_SEEDS, type WelcomeAdminSnapshot, type WelcomeSelection } from "@lifeos/core";
import { AssistantWelcomeStore, drawWelcome, welcomeWeight } from "../src/assistant-welcome-store.js";
import { createHttpServer } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

const DAY = 86_400_000;
function storeFixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-welcome-store-")), path = join(root, "lifeos.sqlite");
  let store = new AssistantWelcomeStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { get store() { return store; }, restart() { store.close(); store = new AssistantWelcomeStore(path); } };
}
function reducePool(store: AssistantWelcomeStore) {
  for (const row of store.snapshot().items.filter(row => Number(row.id.slice(-2)) > 3)) store.update(row.id, row.revision, { enabled: false });
}

test("welcome seed pool reflects all six owner exclusions, persistent edits, bounded pool and optional single pinned entry", t => {
  const f = storeFixture(t), initial = f.store.snapshot().items;
  assert.equal(initial.length, 30); assert.equal(initial.filter(p => p.enabled).length, 24);
  assert.deepEqual(initial.filter(p => !p.enabled).map(p => p.id), ["welcome-11", "welcome-19", "welcome-20", "welcome-21", "welcome-25", "welcome-28"]);
  assert(initial.every(p => !p.pinned));
  let first = f.store.update(initial[0]!.id, 1, { pinned: true });
  f.store.update(initial[1]!.id, 1, { pinned: true });
  assert.equal(f.store.snapshot().items.filter(p => p.pinned).length, 1);
  assert.throws(() => f.store.update(first.id, first.revision, { text: "过时的修改" }), /已被修改/);
  const second = f.store.snapshot().items[1]!;
  f.store.update(second.id, second.revision, { enabled: false });
  assert(!f.store.snapshot().items.some(p => p.pinned));
  first = f.store.snapshot().items[0]!;
  f.store.update(first.id, first.revision, { text: "改写后的开场问题", general: false });
  f.restart();
  assert.equal(f.store.snapshot().items[0]!.text, "改写后的开场问题");
  assert.equal(f.store.snapshot().items[0]!.textVersion, 2);
  assert.equal(f.store.snapshot().items[1]!.enabled, false);
  for (let i = 0; i < 70; i++) f.store.create("新增候选" + i, false);
  assert.throws(() => f.store.create("超过上限", false), /最多保留100条/);
});

test("welcome selection is without replacement, keeps optional pinned first, and preserves substantial random exploration", () => {
  let seed = 28173;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  const items = WELCOME_PROMPT_SEEDS.filter(p => p.enabled).map(p => ({ ...p, ...welcomeWeight(p.general, 0, 0) }));
  const counts = new Map(items.map(p => [p.id, 0]));
  for (let i = 0; i < 30_000; i++) {
    const draw = drawWelcome(items, random);
    assert.equal(draw.length, 3); assert.equal(new Set(draw.map(p => p.id)).size, 3);
    for (const item of draw) counts.set(item.id, counts.get(item.id)! + 1);
  }
  const values = [...counts.values()]; assert(Math.min(...values) > 2800); assert(Math.max(...values) / Math.min(...values) < 1.3);
  const generalAverage = items.filter(p => p.general).reduce((sum, p) => sum + counts.get(p.id)!, 0) / items.filter(p => p.general).length;
  const ordinaryAverage = items.filter(p => !p.general).reduce((sum, p) => sum + counts.get(p.id)!, 0) / items.filter(p => !p.general).length;
  assert(generalAverage > ordinaryAverage * 1.07 && generalAverage < ordinaryAverage * 1.25);
  assert.equal(drawWelcome(items.map((p, i) => ({ ...p, pinned: i === 5 })), random)[0]!.id, items[5]!.id);
  assert.equal(drawWelcome([], random).length, 0);
  assert.equal(drawWelcome(items.slice(0, 1), random).length, 1);
});

test("feedback has a hard five-percent ceiling and negligible effect from a small sample", () => {
  assert.equal(welcomeWeight(false, 0, 0).effectiveWeight, 1);
  assert(welcomeWeight(true, 1, 1).effectiveWeight < 1.151);
  assert(welcomeWeight(false, 10, 10).feedbackBonus < .005);
  for (const views of [0, 1, 10, 100, 10_000, 1e9]) for (const clicks of [-10, 0, 1, 100, 1e12]) {
    const result = welcomeWeight(true, views, clicks);
    assert(result.effectiveWeight >= 1.15 && result.effectiveWeight <= 1.2);
    assert(result.feedbackBonus >= 0 && result.feedbackBonus <= .05);
  }
});

test("signed display accounting deduplicates retries, prevents unshown/foreign/expired clicks, and caps one account-day feedback", t => {
  const { store } = storeFixture(t); reducePool(store);
  const now = Date.parse("2026-10-18T04:00:00Z"), selection = store.selection("alice", now), id = selection.prompts[0]!.id;
  assert.equal(store.snapshot().items.reduce((sum, p) => sum + p.impressions, 0), 0, "GET selection never counts exposure");
  assert.equal(store.event("alice", selection.selectionId, "click", id, now).counted, false);
  assert.throws(() => store.event("bob", selection.selectionId, "impression", undefined, now), /当前账号/);
  assert.throws(() => store.event("alice", selection.selectionId + "x", "impression", undefined, now), /已失效/);
  assert.throws(() => store.event("alice", selection.selectionId, "impression", undefined, now + DAY + 1), /已过期/);
  assert.throws(() => store.event("alice", selection.selectionId, "click", "unknown", now), /不在本次展示/);
  assert.equal(store.event("alice", selection.selectionId, "impression", undefined, now).counted, true);
  assert.equal(store.event("alice", selection.selectionId, "impression", undefined, now).counted, false);
  assert.equal(store.event("alice", selection.selectionId, "click", id, now).counted, true);
  assert.equal(store.event("alice", selection.selectionId, "click", id, now).counted, false);
  assert.equal(store.event("alice", selection.selectionId, "click", selection.prompts[1]!.id, now).counted, false);
  for (let i = 0; i < 30; i++) {
    const next = store.selection("alice", now); store.event("alice", next.selectionId, "impression", undefined, now); store.event("alice", next.selectionId, "click", id, now);
  }
  const row = store.snapshot(30, now).items.find(p => p.id === id)!;
  assert.equal(row.impressions, 31); assert.equal(row.clicks, 31);
  assert.equal(row.feedbackViews, 1); assert.equal(row.feedbackClicks, 1); assert(row.feedbackBonus < .0005);
  const other = store.selection("bob", now); store.event("bob", other.selectionId, "impression", undefined, now); store.event("bob", other.selectionId, "click", id, now);
  assert.equal(store.snapshot(30, now).items.find(p => p.id === id)!.feedbackClicks, 2);
});

test("version changes isolate wording statistics, config-only edits retain stats and stopped entries cannot count", t => {
  const { store } = storeFixture(t); reducePool(store);
  const now = Date.now(), selection = store.selection("owner", now), id = selection.prompts[0]!.id;
  store.event("owner", selection.selectionId, "impression", undefined, now); store.event("owner", selection.selectionId, "click", id, now);
  let row = store.snapshot().items.find(p => p.id === id)!;
  store.update(id, row.revision, { general: false });
  row = store.snapshot().items.find(p => p.id === id)!; assert.equal(row.clicks, 1); assert.equal(row.textVersion, 1);
  store.update(id, row.revision, { text: "全新文案" });
  row = store.snapshot().items.find(p => p.id === id)!; assert.equal(row.clicks, 0); assert.equal(row.textVersion, 2);
  assert.equal(store.event("owner", selection.selectionId, "impression", undefined, now).counted, false);
  store.update(id, row.revision, { enabled: false });
  assert(!store.selection("owner").prompts.some(p => p.id === id));
  assert.equal(store.snapshot(7, now + 32 * DAY).items.every(p => p.feedbackViews === 0 && p.impressions === 0), true);
  assert.equal(store.snapshot(0, now + 400 * DAY).items.every(p => p.impressions === 0), true, "year view bounds its read even before a new event triggers pruning");
});

test("account gateway enforces admin-only catalog/stats while all accounts contribute to one shared pool", async t => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-welcome-accounts-"));
  const config = readConfig({ LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_ACCOUNT_MODE: "1", LIFEOS_OWNER_USERNAME: "owner", LIFEOS_PASSWORD: "owner-welcome-password", LIFEOS_ALLOWED_ORIGINS: "http://127.0.0.1:3099", LIFEOS_COOKIE_SECURE: "false" });
  const running = createHttpServer(config); await listenOnFetchablePort(running.server);
  t.after(async () => { running.server.closeAllConnections(); await new Promise<void>(done => running.server.close(() => done())); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const base = "http://127.0.0.1:" + (running.server.address() as { port: number }).port;
  const request = async (path: string, method = "GET", body?: unknown, cookie = "") => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, value: await response.json() };
  };
  const login = async (username: string, password: string) => { const result = await request("/api/auth/login", "POST", { username, password }); assert.equal(result.response.status, 200); return result.response.headers.get("set-cookie")!.split(";")[0]!; };
  const adminPath = "/api/admin/assistant-welcome", path = "/api/ai/assistant/welcome";
  assert.equal((await request(adminPath)).response.status, 401); assert.equal((await request(path)).response.status, 401);
  const owner = await login("owner", "owner-welcome-password");
  const created = await request("/api/admin/accounts", "POST", { username: "member", password: "member-welcome-password", displayName: "测试成员", spaceName: "测试空间" }, owner);
  assert.equal(created.response.status, 201);
  const member = await login("member", "member-welcome-password");
  for (const [method, suffix, body] of [["GET", "", undefined], ["POST", "", { text: "越权新增" }], ["PATCH", "/welcome-01", { revision: 1, enabled: false }]] as const) assert.equal((await request(adminPath + suffix, method, body, member)).response.status, 403);
  const selection = (await request(path, "GET", undefined, member)).value as WelcomeSelection;
  assert.equal(selection.prompts.length, 3);
  assert.equal((await request(path + "/events", "POST", { selectionId: selection.selectionId, type: "impression" }, owner)).response.status, 403);
  await request(path + "/events", "POST", { selectionId: selection.selectionId, type: "impression" }, member);
  await request(path + "/events", "POST", { selectionId: selection.selectionId, type: "click", promptId: selection.prompts[0]!.id }, member);
  const stats = (await request(adminPath, "GET", undefined, owner)).value as WelcomeAdminSnapshot;
  assert.equal(stats.items.reduce((sum, p) => sum + p.clicks, 0), 1); assert.equal(stats.items.reduce((sum, p) => sum + p.impressions, 0), 3);
  assert(!JSON.stringify(stats).includes("member-welcome-password")); assert(!JSON.stringify(stats).includes("actor"));
  const row = stats.items.find(p => p.id === selection.prompts[0]!.id)!;
  const patch = await request(adminPath + "/" + row.id, "PATCH", { revision: row.revision, enabled: false }, owner); assert.equal(patch.response.status, 200);
  assert.equal((await request(adminPath + "/" + row.id, "PATCH", { revision: row.revision, text: "过时保存" }, owner)).response.status, 409);
  assert.equal((await request(adminPath, "POST", { text: "\n" }, owner)).response.status, 400);
  assert.equal((await request(adminPath, "POST", { text: "文本", effectiveWeight: 999 }, owner)).response.status, 400);
  assert.equal((await request(adminPath + "?days=2", "GET", undefined, owner)).response.status, 400);
  assert.equal((await request(adminPath + "/welcome-01", "PATCH", { revision: 1, general: "yes" }, owner)).response.status, 400);
  assert.equal((await request(path + "/events", "POST", { selectionId: selection.selectionId, type: "click", promptId: "not-shown" }, member)).response.status, 400);
});
