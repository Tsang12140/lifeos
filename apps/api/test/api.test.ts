import test from "node:test";
import { deepEqual, equal, match, ok, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { BackupScheduler, backupScheduleRunKey, nextDailyBackupAt } from "../src/backup-scheduler.js";
import { assertValidBackupRetention, DEFAULT_BACKUP_RETENTION, describeBackupRetention, planBackupRetention, retentionHorizonDays } from "../src/backup-retention.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { isCollectableAsset, originalPathFor, planTrashPurge, planUnreferencedUploads, resolveWithinRoot, trashPathFor } from "../src/asset-gc.js";
import { nextAssetGcAt } from "../src/asset-gc-scheduler.js";
import { OBSERVATION_KEEP_LIMIT, selectDayObservations } from "../src/weather-selection.js";
import { SUMMARY_SYSTEM_PROMPT, createInstant, type Asset } from "@lifeos/core";
import sharp from "sharp";

// WHATWG fetch rejects a small set of historically reserved ports even when
// Node's HTTP server can bind them.  Windows can hand one of those ports out
// for listen(0), which makes an otherwise unrelated fetch fail with
// `TypeError: fetch failed` / `bad port`.  Keep the OS allocator (so parallel
// tests remain collision-safe), but close and retry if it picked a forbidden
// port.
const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 79,
  80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97,
  98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 113,
  119, 123, 135, 139, 143, 179, 389, 427, 465, 512, 513, 514, 515, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

async function listenOnFetchablePort(server: ReturnType<typeof createServer>, host: string): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    server.listen(0, host);
    await once(server, "listening");
    const address = server.address();
    if (address !== null && typeof address !== "string" && !FETCH_FORBIDDEN_PORTS.has(address.port)) {
      return address.port;
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        server.off("error", onError);
        server.off("close", onClose);
      };
      server.once("error", onError);
      server.once("close", onClose);
      server.close();
    });
  }
  throw new Error("Test server could not obtain a fetchable port after retries");
}

interface Harness {
  readonly root: string;
  readonly base: string;
  readonly app: ReturnType<typeof createHttpServer>["app"];
  readonly stop: (remove?: boolean) => Promise<void>;
}

async function startHarness(password?: string, bodyLimitBytes = 1024 * 1024, existingRoot?: string, assetRoot?: string, assetUploadLimitBytes = 25 * 1024 * 1024, assetOrphanGraceDays = 7, assetTrashDays = 30): Promise<Harness> {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "lifeos-api-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "lifeos.sqlite"),
    dataDirectory: root,
    webDirectory: join(root, "web"),
    backupDirectory: join(root, "backups"),
    allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    cookieSecure: false,
    bodyLimitBytes,
    assetUploadLimitBytes,
    assetOrphanGraceDays,
    assetTrashDays,
    deepseekModel: "deepseek-flash",
    deepseekBaseUrl: "https://api.deepseek.com",
    qweatherHost: "devapi.qweather.com",
    ...(password === undefined ? {} : { password }),
    ...(assetRoot === undefined ? {} : { assetRoot }),
  } as const;
  const { server, app } = createHttpServer(config);
  const port = await listenOnFetchablePort(server, config.host);
  const base = `http://${config.host}:${port}`;
  return {
    root,
    base,
    app,
    stop: async (remove = true) => {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      if (remove) rmSync(root, { recursive: true, force: true });
    },
  };
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  if (text.length === 0) return { response, body: undefined };
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) return { response, body: JSON.parse(text) as unknown };
  return { response, body: text };
}

function json(value: unknown): RequestInit {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

async function statusWithHost(base: string, host: string): Promise<number> {
  const url = new URL(`${base}/api/health`);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, headers: { host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

test("SQLite API persists records, preserves original content, filters, conflicts, and exports", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const health = await request(harness.base, "/api/health");
  equal(health.response.status, 200);
  deepEqual(health.body, { ok: true });

  const auth = await request(harness.base, "/api/auth");
  equal(auth.response.status, 200);
  deepEqual(auth.body, { required: false, authenticated: true });

  const created = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "journal", content: "原文 100%_ 中文", occurredAt: { kind: "instant", value: "2026-09-01T23:30:00Z" } }),
  });
  equal(created.response.status, 201);
  const createdBody = created.body as { id: string; body: { original: string }; revision: number; occurredAt: unknown };
  equal(createdBody.body.original, "原文 100%_ 中文");
  equal(createdBody.revision, 1);

  const task = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "task", content: "未来任务", dueAt: { kind: "date", value: "2099-01-01" } }),
  });
  equal(task.response.status, 201);
  const taskBody = task.body as { id: string; revision: number; task: { dueAt?: unknown } };
  ok(taskBody.task.dueAt);
  const taskCleared = await request(harness.base, `/api/records/${taskBody.id}`, {
    method: "PATCH",
    ...json({ revision: taskBody.revision, dueAt: null }),
  });
  equal(taskCleared.response.status, 200);
  equal((taskCleared.body as { task: { dueAt?: unknown } }).task.dueAt, undefined);

  const searched = await request(harness.base, "/api/records?q=%_");
  equal(searched.response.status, 200);
  equal((searched.body as { items: unknown[] }).items.length, 1);

  const dated = await request(harness.base, "/api/records?date=2026-09-02&timeZone=Asia%2FShanghai");
  equal(dated.response.status, 200);
  equal((dated.body as { items: unknown[] }).items.length, 1);

  const edited = await request(harness.base, `/api/records/${encodeURIComponent(createdBody.id)}`, {
    method: "PATCH",
    ...json({ revision: 1, content: "编辑正文", occurredAt: null }),
  });
  equal(edited.response.status, 200);
  const editedBody = edited.body as { revision: number; body: { original: string; edited?: string }; occurredAt?: unknown };
  equal(editedBody.revision, 2);
  equal(editedBody.body.original, "原文 100%_ 中文");
  equal(editedBody.body.edited, "编辑正文");
  equal(editedBody.occurredAt, undefined);

  const stale = await request(harness.base, `/api/records/${createdBody.id}`, {
    method: "PATCH",
    ...json({ revision: 1, content: "不应覆盖" }),
  });
  equal(stale.response.status, 409);
  equal((stale.body as { current: { body: { edited?: string } } }).current.body.edited, "编辑正文");

  const deletedStale = await request(harness.base, `/api/records/${createdBody.id}`, {
    method: "DELETE",
    ...json({ revision: 1 }),
  });
  equal(deletedStale.response.status, 409);
  const deleted = await request(harness.base, `/api/records/${createdBody.id}`, {
    method: "DELETE",
    ...json({ revision: 2 }),
  });
  equal(deleted.response.status, 204);

  const afterDelete = await request(harness.base, "/api/records");
  equal((afterDelete.body as { items: unknown[] }).items.length, 1);
  const exportResponse = await fetch(`${harness.base}/api/export?format=json`);
  equal(exportResponse.status, 200);
  const bundle = (await exportResponse.json()) as { records: unknown[]; entities: unknown[]; assets: unknown[] };
  equal(bundle.records.length, 1);
  equal(bundle.entities.length, 0);
  equal(bundle.assets.length, 0);

  // Closing and opening a second API instance must see the same file-backed data.
  const root = harness.root;
  await harness.stop(false);
  const reopened = await startHarness(undefined, 1024 * 1024, root);
  const persisted = await request(reopened.base, "/api/records");
  equal(persisted.response.status, 200);
  equal((persisted.body as { items: unknown[] }).items.length, 1);
  await reopened.stop();
});

test("notes persist format metadata, search it, patch it, and round-trip through export/import", async (t) => {
  const source = await startHarness();
  t.after(async () => source.stop());
  const create = async (payload: Record<string, unknown>) => {
    const result = await request(source.base, "/api/records", { method: "POST", ...json(payload) });
    equal(result.response.status, 201);
    return result.body as Record<string, unknown>;
  };
  const article = await create({ kind: "note", content: "文章正文", note: { format: "article", title: "我的文章" } });
  const fragment = await create({ kind: "note", content: "一条碎片" , note: { format: "fragment" } });
  const quote = await create({ kind: "note", content: "引文正文", note: { format: "quote", source: "《测试书》" } });
  equal(article.occurredAt, undefined);
  equal((article.note as { format: string; title: string }).format, "article");
  equal((fragment.note as { format: string }).format, "fragment");
  equal((quote.note as { source: string }).source, "《测试书》");

  const titleSearch = await request(source.base, "/api/records?kind=note&q=%E6%88%91%E7%9A%84%E6%96%87%E7%AB%A0");
  equal(titleSearch.response.status, 200);
  equal((titleSearch.body as { items: unknown[] }).items.length, 1);
  const sourceSearch = await request(source.base, "/api/records?kind=note&q=%E6%B5%8B%E8%AF%95%E4%B9%A6");
  equal((sourceSearch.body as { items: unknown[] }).items.length, 1);

  const patched = await request(source.base, `/api/records/${article.id}`, {
    method: "PATCH",
    ...json({ revision: article.revision, content: "编辑后的文章", note: { format: "article", title: "更新标题" } }),
  });
  equal(patched.response.status, 200);
  const patchedBody = patched.body as { revision: number; note: { title: string }; body: { edited?: string } };
  equal(patchedBody.revision, 2);
  equal(patchedBody.note.title, "更新标题");
  equal(patchedBody.body.edited, "编辑后的文章");

  const journal = await create({ kind: "journal", content: "普通记录" });
  const rejected = await request(source.base, `/api/records/${journal.id}`, { method: "PATCH", ...json({ revision: journal.revision, note: { format: "fragment" } }) });
  equal(rejected.response.status, 400);
  const invalidArticle = await request(source.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "缺标题", note: { format: "article" } }) });
  equal(invalidArticle.response.status, 400);

  const exportResponse = await fetch(`${source.base}/api/export?format=json`);
  equal(exportResponse.status, 200);
  const bundle = await exportResponse.json() as Record<string, unknown>;
  const importedRoot = mkdtempSync(join(tmpdir(), "lifeos-notes-import-"));
  const target = await startHarness(undefined, 1024 * 1024, importedRoot);
  t.after(async () => target.stop());
  const imported = await request(target.base, "/api/import", { method: "POST", ...json({ bundle }) });
  equal(imported.response.status, 201);
  const importedNotes = await request(target.base, "/api/records?kind=note");
  const noteItems = (importedNotes.body as { items: readonly { note?: { format?: string; title?: string; source?: string } }[] }).items;
  equal(noteItems.length, 3);
  ok(noteItems.some((item) => item.note?.format === "article" && item.note.title === "更新标题"));
  ok(noteItems.some((item) => item.note?.format === "quote" && item.note.source === "《测试书》"));
  ok(noteItems.some((item) => item.note?.format === "fragment"));
});

test("auth, host/origin checks, import transaction, and malformed writes", async (t) => {
  const harness = await startHarness("secret", 4096);
  t.after(async () => harness.stop());

  const unauthenticated = await request(harness.base, "/api/records");
  equal(unauthenticated.response.status, 401);
  const badOrigin = await request(harness.base, "/api/health", { headers: { origin: "https://evil.example" } });
  equal(badOrigin.response.status, 403);
  const noContentType = await request(harness.base, "/api/auth/login", { method: "POST", body: JSON.stringify({ password: "secret" }) });
  equal(noContentType.response.status, 415);
  const badLogin = await request(harness.base, "/api/auth/login", { method: "POST", ...json({ password: "wrong" }) });
  equal(badLogin.response.status, 401);
  const login = await request(harness.base, "/api/auth/login", { method: "POST", ...json({ password: "secret" }) });
  equal(login.response.status, 200);
  const setCookie = login.response.headers.get("set-cookie");
  ok(setCookie);
  const cookie = setCookie.split(";")[0]!;

  const created = await request(harness.base, "/api/records", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ kind: "note", content: "备份恢复" }),
  });
  equal(created.response.status, 201);
  const exportResponse = await fetch(`${harness.base}/api/export?format=json`, { headers: { cookie } });
  const bundle = await exportResponse.json();
  const duplicate = await request(harness.base, "/api/import", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ bundle }),
  });
  equal(duplicate.response.status, 409);

  const malformed = await request(harness.base, "/api/records", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{",
  });
  equal(malformed.response.status, 400);
  const oversized = await request(harness.base, "/api/records", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ kind: "note", content: "x".repeat(10000) }),
  });
  equal(oversized.response.status, 413);

  const logout = await request(harness.base, "/api/auth/logout", { method: "POST", headers: { cookie } });
  equal(logout.response.status, 204);
  const afterLogout = await request(harness.base, "/api/records");
  equal(afterLogout.response.status, 401);

  const restored = await startHarness();
  t.after(async () => restored.stop());
  const specialBundle = {
    format: "lifeos.export",
    version: 1,
    exportedAt: { kind: "instant", value: "2026-09-12T00:00:00Z" },
    records: [{
      id: "记录/100%",
      kind: "note",
      createdAt: { kind: "instant", value: "2026-09-11T00:00:00Z" },
      body: { original: "导入原文" },
      entityRefs: [],
      relatedRecordIds: [],
      assetRefs: [{ assetId: "photo/1", role: "photo" }],
      aiDerived: [],
    }],
    entities: [{ type: "person", id: "person/1", name: "导入人物" }],
    assets: [{ id: "photo/1", kind: "photo", storageRefs: [{ sourceId: "test", sourceRef: "photo/1.jpg" }] }],
  };
  const imported = await request(restored.base, "/api/import", { method: "POST", ...json({ bundle: specialBundle }) });
  equal(imported.response.status, 201);
  const restoredExport = await request(restored.base, "/api/export?format=json");
  const restoredBundle = restoredExport.body as { records: Array<{ id: string }>; entities: unknown[]; assets: unknown[] };
  equal(restoredBundle.records[0]?.id, "记录/100%");
  equal(restoredBundle.entities.length, 1);
  equal(restoredBundle.assets.length, 1);
  const specialPatch = await request(restored.base, `/api/records/${encodeURIComponent("记录/100%")}`, {
    method: "PATCH",
    ...json({ revision: 1, content: "编辑导入记录" }),
  });
  equal(specialPatch.response.status, 200);
});

test("passwordless mode rejects non-loopback Host and config requires password for network binding", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  equal(await statusWithHost(harness.base, "lifeos.example"), 421);
  throws(() => readConfig({ LIFEOS_HOST: "0.0.0.0" }), /LIFEOS_PASSWORD is required/);
});

test("login sessions persist in SQLite and AI assistant falls back without a key", async (t) => {
  let harness = await startHarness("secret");
  t.after(async () => harness.stop());
  const login = await request(harness.base, "/api/auth/login", { method: "POST", ...json({ password: "secret" }) });
  equal(login.response.status, 200);
  const setCookie = login.response.headers.get("set-cookie");
  ok(setCookie);
  const cookie = setCookie.split(";")[0]!;
  const root = harness.root;
  await harness.stop(false);
  harness = await startHarness("secret", 1024 * 1024, root);
  const persistedAuth = await request(harness.base, "/api/auth", { headers: { cookie } });
  deepEqual(persistedAuth.body, { required: true, authenticated: true });

  const publicRecord = await request(harness.base, "/api/records", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ kind: "note", content: "公开记录" }) });
  equal(publicRecord.response.status, 201);
  const privateRecord = await request(harness.base, "/api/records", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ kind: "note", content: "私密记录", isPrivate: true }) });
  equal(privateRecord.response.status, 201);
  const aiStatus = await request(harness.base, "/api/ai/status", { headers: { cookie } });
  deepEqual(aiStatus.body, {
    enabled: true,
    configured: false,
    keyConfigured: false,
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    thinking: false,
    reasoningEffort: null,
    preset: "quick",
    keySource: "none",
    keyUnreadable: false,
    summaryPrompt: SUMMARY_SYSTEM_PROMPT,
    summaryPromptCustom: false,
  });
  const aiReply = await request(harness.base, "/api/ai/assistant", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "有几条记录？", history: [] }) });
  equal(aiReply.response.status, 200);
  ok((aiReply.body as { reply: string }).reply.includes("1 条非隐私记录"));
});

test("AI config exposes effective presets, validates reasoning, and never returns the key", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const initial = await request(harness.base, "/api/ai/status");
  deepEqual(initial.body, {
    enabled: true,
    configured: false,
    keyConfigured: false,
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    thinking: false,
    reasoningEffort: null,
    preset: "quick",
    keySource: "none",
    keyUnreadable: false,
    summaryPrompt: SUMMARY_SYSTEM_PROMPT,
    summaryPromptCustom: false,
  });

  const invalidReasoning = await request(harness.base, "/api/ai/config", {
    method: "POST",
    ...json({ enabled: true, baseUrl: "https://api.deepseek.com", model: "deepseek-flash", thinking: true, reasoningEffort: "medium" }),
  });
  equal(invalidReasoning.response.status, 400);

  const saved = await request(harness.base, "/api/ai/config", {
    method: "POST",
    ...json({ enabled: true, baseUrl: "https://api.deepseek.com", model: "deepseek-flash", thinking: false, reasoningEffort: null, apiKey: "unit-test-secret" }),
  });
  equal(saved.response.status, 200);
  const savedJson = JSON.stringify(saved.body);
  ok(!savedJson.includes("unit-test-secret"));
  deepEqual(saved.body, {
    enabled: true,
    configured: true,
    keyConfigured: true,
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    thinking: false,
    reasoningEffort: null,
    preset: "quick",
    keySource: "file",
    keyUnreadable: false,
    summaryPrompt: SUMMARY_SYSTEM_PROMPT,
    summaryPromptCustom: false,
  });
  const persisted = readFileSync(join(harness.root, "ai-config.json"), "utf8");
  ok(!persisted.includes("unit-test-secret"));

  const reflect = await request(harness.base, "/api/ai/config", {
    method: "POST",
    ...json({ enabled: true, baseUrl: "https://api.deepseek.com", model: "deepseek-flash", thinking: true, reasoningEffort: "high" }),
  });
  equal(reflect.response.status, 200);
  equal((reflect.body as { preset: string; thinking: boolean; reasoningEffort: string | null; keyConfigured: boolean }).preset, "reflect");
  equal((reflect.body as { thinking: boolean }).thinking, true);
  equal((reflect.body as { reasoningEffort: string | null }).reasoningEffort, "high");
  equal((reflect.body as { keyConfigured: boolean }).keyConfigured, true);

  const custom = await request(harness.base, "/api/ai/config", {
    method: "POST",
    ...json({ enabled: true, baseUrl: "https://api.deepseek.com", model: "my-model", thinking: true, reasoningEffort: "low" }),
  });
  equal(custom.response.status, 200);
  equal((custom.body as { preset: string }).preset, "custom");
  equal((custom.body as { keyConfigured: boolean }).keyConfigured, true);
});

test("a saved key that cannot be decrypted is reported, and a later save never drops it", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const path = join(harness.root, "ai-config.json");

  const saved = await request(harness.base, "/api/ai/config", {
    method: "POST",
    ...json({ enabled: true, baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "unit-test-secret" }),
  });
  equal(saved.response.status, 200);
  equal((saved.body as { keyUnreadable: boolean }).keyUnreadable, false);
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as { encryptedApiKey: string; apiKeyIv: string; apiKeyTag: string };
  ok(!readFileSync(path, "utf8").includes("unit-test-secret"));

  // 把密文换成「另一把种子加出来的」，等价于加密种子变过（或文件被手改坏）。
  const tampered = JSON.stringify({ ...onDisk, encryptedApiKey: Buffer.from("not-our-ciphertext").toString("base64") }, null, 2) + "\n";
  writeFileSync(path, tampered, "utf8");

  const unreadable = await request(harness.base, "/api/ai/status");
  equal((unreadable.body as { keyConfigured: boolean }).keyConfigured, false);
  equal((unreadable.body as { keyUnreadable: boolean }).keyUnreadable, true);
  equal((unreadable.body as { keySource: string }).keySource, "none");

  // 再保存一次（不带 key）→ 那把读不出来的密文必须**原样留着**。
  const again = await request(harness.base, "/api/ai/config", {
    method: "POST",
    ...json({ enabled: true, baseUrl: "https://api.deepseek.com", model: "deepseek-flash" }),
  });
  equal(again.response.status, 200);
  equal((again.body as { keyUnreadable: boolean }).keyUnreadable, true);
  const afterAgain = JSON.parse(readFileSync(path, "utf8")) as { encryptedApiKey: string };
  equal(afterAgain.encryptedApiKey, (JSON.parse(tampered) as { encryptedApiKey: string }).encryptedApiKey);

  // 只有显式清除才允许把它删掉。
  const cleared = await request(harness.base, "/api/ai/config", {
    method: "POST",
    ...json({ enabled: true, baseUrl: "https://api.deepseek.com", model: "deepseek-flash", clearApiKey: true }),
  });
  equal(cleared.response.status, 200);
  equal((cleared.body as { keyUnreadable: boolean }).keyUnreadable, false);
  ok(!("encryptedApiKey" in (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)));
});

test("assistant sends DeepSeek thinking and reasoning fields according to the saved mode", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const payloads: Record<string, unknown>[] = [];
  const mockServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "模拟回答" } }] }));
    });
  });
  const port = await listenOnFetchablePort(mockServer, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (mockServer.listening) {
      mockServer.close();
      await once(mockServer, "close");
    }
  });
  const save = async (values: { readonly model: string; readonly thinking: boolean; readonly reasoningEffort: "low" | "high" | "max" | null }) => {
    const response = await request(harness.base, "/api/ai/config", {
      method: "POST",
      ...json({ enabled: true, baseUrl, ...values, apiKey: "payload-test-secret" }),
    });
    equal(response.response.status, 200);
  };

  await save({ model: "deepseek-flash", thinking: false, reasoningEffort: null });
  const quick = await request(harness.base, "/api/ai/assistant", { method: "POST", ...json({ message: "日常问答", history: [] }) });
  equal(quick.response.status, 200);
  const quickPayload = payloads.at(-1);
  ok(quickPayload !== undefined);
  deepEqual(quickPayload?.thinking, { type: "disabled" });
  equal(quickPayload?.temperature, 0.2);
  ok(!Object.hasOwn(quickPayload ?? {}, "reasoning_effort"));

  await save({ model: "deepseek-v4-pro", thinking: true, reasoningEffort: "high" });
  const review = await request(harness.base, "/api/ai/assistant", { method: "POST", ...json({ message: "重要复盘", history: [] }) });
  equal(review.response.status, 200);
  const reviewPayload = payloads.at(-1);
  ok(reviewPayload !== undefined);
  deepEqual(reviewPayload?.thinking, { type: "enabled" });
  equal(reviewPayload?.reasoning_effort, "high");
  ok(!Object.hasOwn(reviewPayload ?? {}, "temperature"));
});

test("timeline date filters and ordering respect instant, date-only, and local meanings", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const records = [
    { kind: "journal", content: "instant", occurredAt: { kind: "instant", value: "2026-09-01T23:30:00Z" } },
    { kind: "journal", content: "local", occurredAt: { kind: "local", value: "2026-09-02T12:00:00" } },
    { kind: "event", content: "date", occurredAt: { kind: "date", value: "2026-09-02" } },
  ];
  for (const record of records) {
    const response = await request(harness.base, "/api/records", { method: "POST", ...json(record) });
    equal(response.response.status, 201);
  }
  const filtered = await request(harness.base, "/api/records?date=2026-09-02&timeZone=Asia%2FShanghai");
  equal(filtered.response.status, 200);
  const items = (filtered.body as { items: Array<{ body: { original: string } }> }).items;
  deepEqual(items.map((item) => item.body.original), ["local", "instant", "date"]);
});

test("static file serving rejects encoded Windows absolute paths", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const webDirectory = join(harness.root, "web");
  mkdirSync(webDirectory, { recursive: true });
  writeFileSync(join(webDirectory, "index.html"), "safe");
  const root = await request(harness.base, "/");
  equal(root.response.status, 200);
  equal(root.body, "safe");
  const escaped = await request(harness.base, "/C:%5Coutside.txt");
  equal(escaped.response.status, 404);
});

test("local SQLite backups are recorded and unconfigured S3 fails clearly", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const status = await request(harness.base, "/api/backup/status");
  equal(status.response.status, 200);
  const initial = status.body as { localDirectory: string; s3: { configured: boolean }; runs: unknown[] };
  equal(initial.localDirectory, join(harness.root, "backups"));
  equal(initial.s3.configured, false);
  equal(initial.runs.length, 0);

  const local = await request(harness.base, "/api/backup/local", { method: "POST", ...json({}) });
  equal(local.response.status, 201);
  const localBody = local.body as { ok: boolean; location: string; sizeBytes: number };
  equal(localBody.ok, true);
  ok(localBody.sizeBytes > 0);
  ok(statSync(localBody.location).isFile());

  const after = await request(harness.base, "/api/backup/status");
  const runs = (after.body as { runs: Array<{ provider: string; status: string }> }).runs;
  ok(runs.some((run) => run.provider === "local" && run.status === "success"));

  const s3 = await request(harness.base, "/api/backup/s3", { method: "POST", ...json({}) });
  equal(s3.response.status, 502);
  equal((s3.body as { error: string }).error, "backup_failed");
});

test("dual backup records local success before an unconfigured remote skip", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const response = await request(harness.base, "/api/backup/dual", { method: "POST", ...json({}) });
  equal(response.response.status, 201);
  const body = response.body as {
    ok: boolean;
    status: string;
    batchId: string;
    local: { status: string; location: string };
    s3: { status: string; error?: string };
  };
  equal(body.ok, true);
  equal(body.status, "local_only");
  ok(body.batchId.length > 10);
  equal(body.local.status, "success");
  equal(body.s3.status, "skipped");
  match(body.s3.error ?? "", /对象存储.*跳过/);
  ok(statSync(body.local.location).isFile());

  const status = await request(harness.base, "/api/backup/status");
  const statusBody = status.body as { lastDualBackup: { batchId: string; status: string; local: { status: string }; s3: { status: string } } | null; runs: Array<{ batchId?: string; provider: string; status: string }> };
  equal(statusBody.lastDualBackup?.batchId, body.batchId);
  equal(statusBody.lastDualBackup?.status, "local_only");
  equal(statusBody.lastDualBackup?.local.status, "success");
  equal(statusBody.lastDualBackup?.s3.status, "skipped");
  const pair = statusBody.runs.filter((run) => run.batchId === body.batchId);
  equal(pair.length, 2);
  ok(pair.some((run) => run.provider === "local" && run.status === "success"));
  ok(pair.some((run) => run.provider === "s3" && run.status === "skipped"));
});

test("dual backup uploads the same SQLite artifact to a configured object store", async (t) => {
  const received: { readonly method: string; readonly url: string; readonly authorization: string; readonly body: Buffer }[] = [];
  const remote = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.once("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", authorization: String(req.headers.authorization ?? ""), body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("");
    });
  });
  const port = await listenOnFetchablePort(remote, "127.0.0.1");
  t.after(async () => {
    if (remote.listening) {
      remote.close();
      await once(remote, "close");
    }
  });

  const harness = await startHarness();
  t.after(async () => harness.stop());
  const configured = await request(harness.base, "/api/backup/config", {
    method: "POST",
    ...json({ enabled: true, endpoint: `http://127.0.0.1:${port}`, region: "local", bucket: "lifeos", prefix: "daily", forcePathStyle: true, accessKeyId: "test-access", secretAccessKey: "test-secret" }),
  });
  equal(configured.response.status, 200);

  const response = await request(harness.base, "/api/backup/dual", { method: "POST", ...json({}) });
  equal(response.response.status, 201);
  const body = response.body as { status: string; local: { status: string; fileName: string; location: string }; s3: { status: string; location: string } };
  equal(body.status, "success");
  equal(body.local.status, "success");
  equal(body.s3.status, "success");
  // The remote half has to be a signed HTTP PUT that carries the exact local
  // bytes; a local pseudo-bucket would make this assertion meaningless.
  // The prune that runs afterwards lists the recycle bin too, so count PUTs only.
  equal(received.filter((item) => item.method === "PUT").length, 1);
  // The prune that runs afterwards lists the recycle bin too, so pick the PUT.
  const put = received.find((item) => item.method === "PUT")!;
  equal(put.url, `/lifeos/daily/${body.local.fileName}`);
  ok(put.authorization.startsWith("AWS4-HMAC-SHA256 Credential=test-access/"));
  equal(body.s3.location, `http://127.0.0.1:${port}/lifeos/daily/${body.local.fileName}`);
  // Compare against the PUT itself, never against "the first request we saw":
  // the recycle-bin listing is a request too, and `deepEqual` on two Buffers of
  // wildly different lengths makes Node try to render the whole diff, which ends
  // as "RangeError: Array buffer allocation failed" instead of a readable
  // failure. Length + byte equality reports the same thing without the diff.
  const expectedBody = readFileSync(body.local.location);
  equal(put.body.length, expectedBody.length, `PUT carried ${put.body.length} bytes, the artifact is ${expectedBody.length}`);
  ok(put.body.equals(expectedBody), "the PUT body must be the exact local artifact bytes");
});

test("dual backup keeps the local success visible when the remote upload fails", async (t) => {
  const remote = createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end("<Error><Code>AccessDenied</Code></Error>");
    });
  });
  const port = await listenOnFetchablePort(remote, "127.0.0.1");
  t.after(async () => {
    if (remote.listening) {
      remote.close();
      await once(remote, "close");
    }
  });

  const harness = await startHarness();
  t.after(async () => harness.stop());
  const configured = await request(harness.base, "/api/backup/config", {
    method: "POST",
    ...json({ enabled: true, endpoint: `http://127.0.0.1:${port}`, region: "local", bucket: "lifeos", prefix: "daily", forcePathStyle: true, accessKeyId: "test-access", secretAccessKey: "test-secret" }),
  });
  equal(configured.response.status, 200);

  const response = await request(harness.base, "/api/backup/dual", { method: "POST", ...json({}) });
  equal(response.response.status, 201);
  const body = response.body as { status: string; local: { status: string; location: string }; s3: { status: string; error?: string } };
  equal(body.status, "partial");
  equal(body.local.status, "success");
  equal(body.s3.status, "failed");
  match(body.s3.error ?? "", /拒绝|PutObject/);
  ok(statSync(body.local.location).isFile());
});

test("retention cleans snapshots into the recycle bin and only then deletes for real", async (t) => {
  const received: { readonly method: string; readonly url: string; readonly copySource?: string }[] = [];
  const remote = createServer((req, res) => {
    const method = req.method ?? "";
    req.resume();
    req.once("end", () => {
      const url = req.url ?? "";
      const copySource = req.headers["x-amz-copy-source"];
      received.push({ method, url, ...(typeof copySource === "string" ? { copySource } : {}) });
      if (method === "GET") {
        // One aged object sitting in the remote recycle bin. It is the only
        // object the listing returns, so the purge branch has exactly one job.
        res.writeHead(200, { "content-type": "application/xml" });
        res.end("<?xml version=\"1.0\"?><ListBucketResult><Contents><Key>daily-trash/lifeos-ancient.sqlite</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>10</Size></Contents></ListBucketResult>");
        return;
      }
      if (method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("");
    });
  });
  const port = await listenOnFetchablePort(remote, "127.0.0.1");
  t.after(async () => {
    if (remote.listening) {
      remote.close();
      await once(remote, "close");
    }
  });

  const harness = await startHarness();
  t.after(async () => harness.stop());
  const configured = await request(harness.base, "/api/backup/config", {
    method: "POST",
    ...json({ enabled: true, endpoint: `http://127.0.0.1:${port}`, region: "local", bucket: "lifeos", prefix: "daily", forcePathStyle: true, accessKeyId: "test-access", secretAccessKey: "test-secret" }),
  });
  equal(configured.response.status, 200);
  const policy = await request(harness.base, "/api/backup/retention", {
    method: "POST",
    ...json({ dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0, trashDays: 30 }),
  });
  equal(policy.response.status, 200);

  const first = await request(harness.base, "/api/backup/dual", { method: "POST", ...json({}) });
  equal(first.response.status, 201);
  const firstBody = first.body as { local: { fileName: string; location: string }; s3: { status: string } };
  equal(firstBody.s3.status, "success");
  ok(existsSync(firstBody.local.location));

  const second = await request(harness.base, "/api/backup/dual", { method: "POST", ...json({}) });
  equal(second.response.status, 201);
  const secondBody = second.body as { local: { location: string } };

  // One snapshot per day, so the older one is cleaned — into the recycle bin,
  // never straight out of existence.
  const trashDirectory = join(harness.root, "backups", "_trash");
  const trashedFile = join(trashDirectory, firstBody.local.fileName);
  ok(existsSync(trashedFile), "the older snapshot must be waiting in the recycle bin");
  equal(existsSync(firstBody.local.location), false, "the live backup directory must no longer hold it");
  ok(existsSync(secondBody.local.location), "the newest snapshot must stay exactly where it is");

  // Remote half is a COPY into the trash prefix, and the DELETE may only follow
  // a copy that actually succeeded.
  const copyIndex = received.findIndex((item) => item.method === "PUT" && item.copySource !== undefined);
  const deleteIndex = received.findIndex((item) => item.method === "DELETE" && item.url.endsWith(`/${firstBody.local.fileName}`));
  ok(copyIndex >= 0, "the remote half must be copied into the trash prefix before anything is deleted");
  match(received[copyIndex]!.copySource ?? "", /\/daily\//);
  ok(received[copyIndex]!.url.includes("daily-trash/"), `the copy target must be the trash prefix, got ${received[copyIndex]!.url}`);
  ok(deleteIndex > copyIndex, "the original object may only be deleted after the copy landed");

  // An object that has aged out of the remote recycle bin is deleted for real.
  ok(received.some((item) => item.method === "DELETE" && item.url.includes("daily-trash/lifeos-ancient.sqlite")), "aged recycle-bin objects are deleted for real");

  // The ledger says where both halves went, so the UI can offer them back.
  const ledger = await request(harness.base, "/api/backup/retention");
  const trashed = (ledger.body as { trashed: { fileName: string; provider: string; trashLocation?: string }[] }).trashed;
  const cleaned = trashed.filter((entry) => entry.fileName === firstBody.local.fileName);
  equal(cleaned.length, 2, "both the local and the remote half must be recorded as cleaned");
  ok(cleaned.every((entry) => typeof entry.trashLocation === "string" && entry.trashLocation.length > 0), "each cleaned half must record its recycle-bin location");

  // Age the local recycle-bin entry past `trashDays`; the next cleanup pass is
  // what finally removes the bytes.
  const longAgo = new Date(Date.now() - 60 * 86_400_000);
  utimesSync(trashedFile, longAgo, longAgo);
  const third = await request(harness.base, "/api/backup/dual", { method: "POST", ...json({}) });
  equal(third.response.status, 201);
  equal(existsSync(trashedFile), false, "a recycle-bin entry past trashDays is deleted for real");
});

test("backup schedule uses Shanghai wall time and survives API restart", async (t) => {
  const now = new Date("2026-09-15T00:30:00+08:00");
  const next = nextDailyBackupAt(now, 2, 15);
  equal(next.toISOString(), "2026-09-14T18:15:00.000Z");
  equal(backupScheduleRunKey(next, 2, 15), "2026-09-15-0215");

  const harness = await startHarness();
  const root = harness.root;
  t.after(async () => {
    // The restarted harness owns the same database after the first one closes.
    if (harness.stop) await harness.stop(false);
  });
  const saved = await request(harness.base, "/api/backup/schedule", { method: "POST", ...json({ enabled: true, hour: 4, minute: 30 }) });
  equal(saved.response.status, 200);
  const savedBody = saved.body as { enabled: boolean; hour: number; minute: number; timeZone: string; nextRunAt: string };
  deepEqual({ enabled: savedBody.enabled, hour: savedBody.hour, minute: savedBody.minute, timeZone: savedBody.timeZone }, { enabled: true, hour: 4, minute: 30, timeZone: "Asia/Shanghai" });
  ok(Number.isFinite(Date.parse(savedBody.nextRunAt)));
  const status = await request(harness.base, "/api/backup/status");
  const schedule = (status.body as { schedule: { enabled: boolean; hour: number; minute: number; timeZone: string } }).schedule;
  deepEqual(schedule, { ...schedule, enabled: true, hour: 4, minute: 30, timeZone: "Asia/Shanghai" });

  await harness.stop(false);
  const restarted = await startHarness(undefined, 1024 * 1024, root);
  t.after(async () => restarted.stop());
  const afterRestart = await request(restarted.base, "/api/backup/status");
  const persisted = (afterRestart.body as { schedule: { enabled: boolean; hour: number; minute: number; timeZone: string } }).schedule;
  deepEqual({ enabled: persisted.enabled, hour: persisted.hour, minute: persisted.minute, timeZone: persisted.timeZone }, { enabled: true, hour: 4, minute: 30, timeZone: "Asia/Shanghai" });
  await request(restarted.base, "/api/backup/schedule", { method: "POST", ...json({ enabled: false, hour: 4, minute: 30 }) });
});

test("scheduler runOnce claims the supplied Shanghai slot instead of tomorrow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-scheduler-"));
  const databasePath = join(root, "lifeos.sqlite");
  const repository = new SqliteRecordRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  });
  repository.saveBackupSchedule({ enabled: true, hour: 4, minute: 30 });
  const config = {
    host: "127.0.0.1",
    port: 0,
    databasePath,
    dataDirectory: root,
    webDirectory: join(root, "web"),
    backupDirectory: join(root, "backups"),
    allowedOrigins: [],
    cookieSecure: false,
    bodyLimitBytes: 1024 * 1024,
    assetUploadLimitBytes: 25 * 1024 * 1024,
    assetOrphanGraceDays: 7,
    assetTrashDays: 30,
    deepseekModel: "deepseek-flash",
    deepseekBaseUrl: "https://api.deepseek.com",
    qweatherHost: "devapi.qweather.com",
  } as const;
  const now = new Date("2026-09-15T00:30:00+08:00");
  const scheduler = new BackupScheduler({ repository, config, now: () => now });
  equal(await scheduler.runOnce(now), true);
  equal(await scheduler.runOnce(now), false);
  const runs = repository.listBackupRuns(10).filter((run) => run.kind === "scheduled");
  equal(runs.length, 2);
  ok(runs.every((run) => run.batchId !== undefined));
  equal(new Set(runs.map((run) => run.batchId)).size, 1);
  equal(repository.backupScheduleLastRunKey(), "2026-09-15-0430");
});

test("object storage config saves encrypted credentials and exposes only public status", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const saved = await request(harness.base, "/api/backup/config", {
    method: "POST",
    ...json({ enabled: true, endpoint: "https://s3.bitiful.net", region: "cn-east-1", bucket: "cdnb", prefix: "product-backup/lifeos", forcePathStyle: false, accessKeyId: "test-access", secretAccessKey: "test-secret" }),
  });
  equal(saved.response.status, 200);
  const savedStatus = (saved.body as { s3: { configured: boolean; enabled: boolean; endpoint: string; region: string; bucket: string; prefix: string; forcePathStyle: boolean; keySource: string; transport: string } }).s3;
  deepEqual(savedStatus, { configured: true, enabled: true, endpoint: "https://s3.bitiful.net", region: "cn-east-1", bucket: "cdnb", prefix: "product-backup/lifeos", forcePathStyle: false, keySource: "file", transport: "http" });
  const persisted = readFileSync(join(harness.root, "backup-config.json"), "utf8");
  ok(!persisted.includes("test-access"));
  ok(!persisted.includes("test-secret"));

  // A file:// endpoint writes the backup into a local directory instead of
  // uploading it, so saving one has to be refused unless the deployment
  // explicitly opts in with LIFEOS_ALLOW_FILE_BACKUP=1.
  const rejected = await request(harness.base, "/api/backup/config", {
    method: "POST",
    ...json({ enabled: true, endpoint: "file:///tmp/lifeos-pseudo-bucket", region: "local", bucket: "cdnb", prefix: "product-backup/lifeos", forcePathStyle: true, accessKeyId: "test-access", secretAccessKey: "test-secret" }),
  });
  equal(rejected.response.status, 400);
  ok(JSON.stringify(rejected.body).includes("LIFEOS_ALLOW_FILE_BACKUP"));

  const status = await request(harness.base, "/api/backup/status");
  equal(status.response.status, 200);
  deepEqual((status.body as { s3: unknown }).s3, savedStatus);
});

test("places carry role and period, and # mentions attach place refs on write", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const created = await request(harness.base, "/api/entities", {
    method: "POST",
    ...json({ type: "place", name: "爸妈家", aliases: ["父母家"], role: "home", period: { from: "2024-03" }, address: "广东省佛山市南海区桂城街道 1 号" }),
  });
  equal(created.response.status, 201);
  const placeBody = created.body as { id: string; role: string; period: { from: string }; address: string };
  equal(placeBody.role, "home");
  equal(placeBody.period.from, "2024-03");
  equal(placeBody.address, "广东省佛山市南海区桂城街道 1 号");

  const patched = await request(harness.base, `/api/entities/${encodeURIComponent(placeBody.id)}`, {
    method: "PATCH",
    ...json({ period: { from: "2024-03", until: "2025-08" } }),
  });
  equal(patched.response.status, 200);
  equal((patched.body as { period: { until: string } }).period.until, "2025-08");

  const addressCleared = await request(harness.base, `/api/entities/${encodeURIComponent(placeBody.id)}`, {
    method: "PATCH",
    ...json({ address: null }),
  });
  equal(addressCleared.response.status, 200);
  equal((addressCleared.body as { address?: string }).address, undefined);

  const badRole = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "place", name: "x", role: "cafe" }) });
  equal(badRole.response.status, 400);
  const roleOnPerson = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "person", name: "人", role: "home" }) });
  equal(roleOnPerson.response.status, 400);
  const addressOnPerson = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "person", name: "人", address: "某街道" }) });
  equal(addressOnPerson.response.status, 400);
  const periodOnPerson = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "person", name: "人", period: { from: "2024-01" } }) });
  equal(periodOnPerson.response.status, 400);
  const badPeriod = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "place", name: "x", period: { from: "2026-13" } }) });
  equal(badPeriod.response.status, 400);
  const invertedPeriod = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "place", name: "x", period: { from: "2026-01", until: "2024-01" } }) });
  equal(invertedPeriod.response.status, 400);

  const person = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "person", name: "阿彬" }) });
  equal(person.response.status, 201);
  const record = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "journal", content: "回#父母家吃饭，和@阿彬 聊了会儿。" }),
  });
  equal(record.response.status, 201);
  const refs = (record.body as { entityRefs: Array<{ entityId: string; entityType: string; label?: string }> }).entityRefs;
  const placeRef = refs.find((ref) => ref.entityType === "place");
  const personRef = refs.find((ref) => ref.entityType === "person");
  ok(placeRef !== undefined && placeRef.label === "爸妈家");
  ok(personRef !== undefined);

  // A doubled marker is the picker's force-new trigger, never a mention.
  const doubled = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "note", content: "记一下 ##父母家 这个触发器不关联。" }),
  });
  equal(doubled.response.status, 201);
  equal(((doubled.body as { entityRefs: unknown[] }).entityRefs).length, 0);
});

test("entity relations, record links, and asset references work end to end", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const person = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "person", name: "阿彬" }) });
  equal(person.response.status, 201);
  const personBody = person.body as { id: string; type: string; name: string };
  equal(personBody.type, "person");
  ok(personBody.id.startsWith("person_"));

  const place = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "place", name: "箭馆" }) });
  equal(place.response.status, 201);
  const placeBody = place.body as { id: string };

  const byType = await request(harness.base, "/api/entities?type=person");
  equal(byType.response.status, 200);
  equal((byType.body as { items: unknown[] }).items.length, 1);
  const byName = await request(harness.base, `/api/entities?q=${encodeURIComponent("箭")}`);
  equal((byName.body as { items: unknown[] }).items.length, 1);

  const badType = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "animal", name: "x" }) });
  equal(badType.response.status, 400);
  const emptyName = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "person", name: "" }) });
  equal(emptyName.response.status, 400);

  // An asset is a replaceable reference. LifeOS never copies the NAS original.
  const asset = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({
      kind: "photo",
      originalName: "IMG_0001.HEIC",
      mediaType: "image/heic",
      sizeBytes: 2048,
      storageRefs: [{ sourceId: "synology", sourceRef: "/photo/2026/IMG_0001.HEIC", link: { kind: "url", value: "https://nas.local/photo/IMG_0001.HEIC" } }],
    }),
  });
  equal(asset.response.status, 201);
  const assetBody = asset.body as { id: string };
  ok(assetBody.id.startsWith("asset_"));

  const noRefs = await request(harness.base, "/api/assets", { method: "POST", ...json({ kind: "photo", storageRefs: [] }) });
  equal(noRefs.response.status, 400);
  const absolutePath = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: "x.jpg", link: { kind: "export-path", value: "C:\\photo\\x.jpg" } }] }),
  });
  equal(absolutePath.response.status, 400);

  const created = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({
      kind: "journal",
      content: "今天在箭馆见到阿彬",
      entityRefs: [{ entityType: "person", entityId: personBody.id }],
      assetRefs: [{ assetId: assetBody.id, role: "photo" }],
    }),
  });
  equal(created.response.status, 201);
  const createdBody = created.body as {
    id: string;
    revision: number;
    entityRefs: Array<{ entityId: string; entityType: string; label?: string }>;
    assetRefs: unknown[];
  };
  equal(createdBody.entityRefs.length, 1);
  equal(createdBody.entityRefs[0]?.entityId, personBody.id);
  // The server stores the label so the timeline still reads well if the entity later disappears.
  equal(createdBody.entityRefs[0]?.label, "阿彬");
  equal(createdBody.assetRefs.length, 1);

  const unknownEntity = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "note", content: "x", entityRefs: [{ entityType: "person", entityId: "person_missing" }] }),
  });
  equal(unknownEntity.response.status, 400);
  const typeMismatch = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "note", content: "x", entityRefs: [{ entityType: "place", entityId: personBody.id }] }),
  });
  equal(typeMismatch.response.status, 400);
  const duplicate = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({
      kind: "note",
      content: "x",
      entityRefs: [
        { entityType: "person", entityId: personBody.id },
        { entityType: "person", entityId: personBody.id },
      ],
    }),
  });
  equal(duplicate.response.status, 400);
  const unknownRecord = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "note", content: "x", relatedRecordIds: ["missing"] }),
  });
  equal(unknownRecord.response.status, 400);
  const selfReference = await request(harness.base, `/api/records/${createdBody.id}`, {
    method: "PATCH",
    ...json({ revision: createdBody.revision, relatedRecordIds: [createdBody.id] }),
  });
  equal(selfReference.response.status, 400);

  const second = await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "关联笔记" }) });
  const secondBody = second.body as { id: string; revision: number };
  const linked = await request(harness.base, `/api/records/${createdBody.id}`, {
    method: "PATCH",
    ...json({ revision: createdBody.revision, relatedRecordIds: [secondBody.id] }),
  });
  equal(linked.response.status, 200);
  deepEqual((linked.body as { relatedRecordIds: string[] }).relatedRecordIds, [secondBody.id]);
  // PATCH replaces only what it was given; the entity link survives an unrelated edit.
  equal((linked.body as { entityRefs: unknown[] }).entityRefs.length, 1);

  const byEntity = await request(harness.base, `/api/records?entityId=${encodeURIComponent(personBody.id)}`);
  equal((byEntity.body as { items: unknown[] }).items.length, 1);
  const byAsset = await request(harness.base, `/api/records?assetId=${encodeURIComponent(assetBody.id)}`);
  equal((byAsset.body as { items: unknown[] }).items.length, 1);

  const markdown = await request(harness.base, "/api/export?format=markdown");
  ok(typeof markdown.body === "string" && markdown.body.includes("/photo/2026/IMG_0001.HEIC"));

  const exported = await request(harness.base, "/api/export?format=json");
  const bundle = exported.body as { records: unknown[]; entities: unknown[]; assets: unknown[] };
  equal(bundle.entities.length, 2);
  equal(bundle.assets.length, 1);

  // An entity that is still referenced must not vanish silently.
  const busyDelete = await request(harness.base, `/api/entities/${encodeURIComponent(personBody.id)}`, { method: "DELETE" });
  equal(busyDelete.response.status, 409);
  const freeDelete = await request(harness.base, `/api/entities/${encodeURIComponent(placeBody.id)}`, { method: "DELETE" });
  equal(freeDelete.response.status, 204);

  const renamed = await request(harness.base, `/api/entities/${encodeURIComponent(personBody.id)}`, {
    method: "PATCH",
    ...json({ name: "阿彬（同事）" }),
  });
  equal(renamed.response.status, 200);
  const renamedBody = renamed.body as { type: string; name: string };
  equal(renamedBody.type, "person");
  equal(renamedBody.name, "阿彬（同事）");

  const repointed = await request(harness.base, `/api/assets/${encodeURIComponent(assetBody.id)}`, {
    method: "PATCH",
    ...json({ storageRefs: [{ sourceId: "synology", sourceRef: "/volume1/photo/IMG_0001.HEIC" }] }),
  });
  equal(repointed.response.status, 200);
  const repointedBody = repointed.body as { id: string; storageRefs: Array<{ sourceRef: string }> };
  equal(repointedBody.id, assetBody.id);
  equal(repointedBody.storageRefs[0]?.sourceRef, "/volume1/photo/IMG_0001.HEIC");

  const assetBusy = await request(harness.base, `/api/assets/${encodeURIComponent(assetBody.id)}`, { method: "DELETE" });
  equal(assetBusy.response.status, 409);
  const missingEntity = await request(harness.base, "/api/entities/does_not_exist", { method: "DELETE" });
  equal(missingEntity.response.status, 404);
});

test("aliases, @ mentions, and the preloaded-record marker", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const person = await request(harness.base, "/api/entities", {
    method: "POST",
    ...json({ type: "person", name: "阿彬", aliases: ["彬哥", "Bin"] }),
  });
  equal(person.response.status, 201);
  const personBody = person.body as { id: string; aliases?: string[] };
  deepEqual(personBody.aliases, ["彬哥", "Bin"]);

  const place = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "place", name: "箭馆" }) });
  const placeBody = place.body as { id: string };

  // An explicit id keeps seeded or imported objects addressable.
  const vega = await request(harness.base, "/api/entities", { method: "POST", ...json({ id: "demo-person-vega", type: "person", name: "VEGA" }) });
  equal(vega.response.status, 201);
  const duplicateId = await request(harness.base, "/api/entities", {
    method: "POST",
    ...json({ id: "demo-person-vega", type: "person", name: "VEGA again" }),
  });
  equal(duplicateId.response.status, 409);

  const byAlias = await request(harness.base, `/api/entities?q=${encodeURIComponent("彬哥")}`);
  equal((byAlias.body as { items: unknown[] }).items.length, 1);
  const byAliasCaseInsensitive = await request(harness.base, "/api/entities?q=bin");
  equal((byAliasCaseInsensitive.body as { items: unknown[] }).items.length, 1);

  // `@` is a people-only syntax, so a place marker stays plain text instead of
  // becoming a guess about prose.
  const placeMarker = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "note", content: "又去了@箭馆 一趟" }),
  });
  equal(placeMarker.response.status, 201);
  deepEqual((placeMarker.body as { entityRefs: unknown[] }).entityRefs, []);

  // An @ mention becomes a real relation even though the client sent no entityRefs.
  // The place is linked through the explicit field, which is the only route a
  // non-person entity has into a record.
  const mentioned = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({
      kind: "journal",
      content: "今天和@阿彬 去了@箭馆",
      entityRefs: [{ entityType: "place", entityId: placeBody.id, label: "箭馆" }],
    }),
  });
  equal(mentioned.response.status, 201);
  const mentionedBody = mentioned.body as {
    id: string;
    revision: number;
    body: { original: string };
    entityRefs: Array<{ entityId: string; label?: string }>;
  };
  // The immutable original keeps exactly what was typed, marker included.
  equal(mentionedBody.body.original, "今天和@阿彬 去了@箭馆");
  // Explicit refs keep their order; the mention scan appends what it found.
  deepEqual(mentionedBody.entityRefs.map((ref) => ref.entityId), [placeBody.id, personBody.id]);
  equal(mentionedBody.entityRefs[1]?.label, "阿彬");

  const safe = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "note", content: "邮箱 abin@example.com，密码 @abcdef123 记一下" }),
  });
  equal((safe.body as { entityRefs: unknown[] }).entityRefs.length, 0);

  const viaAlias = await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "问一下@彬哥 什么时候有空" }) });
  deepEqual((viaAlias.body as { entityRefs: Array<{ entityId: string }> }).entityRefs.map((ref) => ref.entityId), [personBody.id]);

  const edited = await request(harness.base, `/api/records/${mentionedBody.id}`, {
    method: "PATCH",
    ...json({ revision: mentionedBody.revision, content: "今天和@阿彬 去了@箭馆，@VEGA 也在" }),
  });
  equal(edited.response.status, 200);
  const editedBody = edited.body as { revision: number; entityRefs: Array<{ entityId: string }> };
  // Mentions only ever add, so the earlier links survive the rewrite.
  deepEqual(editedBody.entityRefs.map((ref) => ref.entityId), [placeBody.id, personBody.id, "demo-person-vega"]);

  // A write that carries no text must not re-add a link that was removed by hand.
  const cleared = await request(harness.base, `/api/records/${mentionedBody.id}`, {
    method: "PATCH",
    ...json({ revision: editedBody.revision, entityRefs: [] }),
  });
  equal(cleared.response.status, 200);
  equal((cleared.body as { entityRefs: unknown[] }).entityRefs.length, 0);

  const aliasesPatched = await request(harness.base, `/api/entities/${encodeURIComponent(personBody.id)}`, {
    method: "PATCH",
    ...json({ aliases: ["阿彬哥"] }),
  });
  equal(aliasesPatched.response.status, 200);
  deepEqual((aliasesPatched.body as { aliases: string[] }).aliases, ["阿彬哥"]);
  const blankAlias = await request(harness.base, `/api/entities/${encodeURIComponent(personBody.id)}`, {
    method: "PATCH",
    ...json({ aliases: [" "] }),
  });
  equal(blankAlias.response.status, 400);

  // Preloaded data has an internal marker, so its actual words remain normal.
  const preloaded = await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "这是一条预置记录", isDemo: true }) });
  equal((preloaded.body as { isDemo?: boolean }).isDemo, true);
  const all = await request(harness.base, "/api/records");
  equal((all.body as { items: Array<{ isDemo?: boolean }> }).items.filter((item) => item.isDemo === true).length, 1);
  // Four records from this test plus the marked one; nothing was lost by the filter.
  const untouched = await request(harness.base, "/api/records");
  equal((untouched.body as { items: unknown[] }).items.length, 5);
});

test("calendar range queries and day summaries mark rule output as a fallback", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  // Three days, two of them inside the week a calendar would ask for and one
  // deliberately outside it, so the range has something to exclude.
  await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "journal", content: "江边散步", occurredAt: { kind: "date", value: "2026-09-08" } }) });
  await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "写信给阿彬", occurredAt: { kind: "date", value: "2026-09-09" } }) });
  await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "更早的事", occurredAt: { kind: "date", value: "2026-08-30" } }) });

  // A range answers the whole window at once; the order still matches the timeline.
  const range = await request(harness.base, "/api/records?from=2026-09-07&to=2026-09-13&timeZone=Asia%2FShanghai");
  equal(range.response.status, 200);
  const rangeItems = (range.body as { items: Array<{ id: string; revision: number; body: { original: string } }> }).items;
  deepEqual(rangeItems.map((item) => item.body.original), ["江边散步"]);

  const bothScopes = await request(harness.base, "/api/records?date=2026-09-08&from=2026-09-07&to=2026-09-13");
  equal(bothScopes.response.status, 400);
  const reversed = await request(harness.base, "/api/records?from=2026-09-13&to=2026-09-07");
  equal(reversed.response.status, 400);
  // The range is matched in memory, so it is capped to what a calendar can ask for.
  const tooWide = await request(harness.base, "/api/records?from=2020-01-01&to=2026-01-01");
  equal(tooWide.response.status, 400);

  const unbounded = await request(harness.base, "/api/summaries?from=2026-09-07");
  equal(unbounded.response.status, 400);

  // No key is configured, so the offline rule answers and says so rather than
  // passing itself off as a reading of the day.
  const summaries = await request(harness.base, "/api/summaries?from=2026-09-07&to=2026-09-13&timeZone=Asia%2FShanghai");
  equal(summaries.response.status, 200);
  const summariesBody = summaries.body as {
    items: Array<{ date: string; text: string; provider: string; status: string; sourceRevision: string; contextRevision?: string; generatedAt: { value: string } }>;
    provider: string;
    ai: boolean;
  };
  equal(summariesBody.ai, false);
  equal(summariesBody.provider, "rule");
  // A day whose only material is a note is still answered, with the note standing
  // in as filler; a day with nothing at all stays blank.
  deepEqual(summariesBody.items.map((item) => item.date), ["2026-09-08", "2026-09-09"]);
  equal(summariesBody.items[0]?.text, "江边散步");
  equal(summariesBody.items[0]?.status, "fallback");
  equal(summariesBody.items[0]?.provider, "rule");
  ok((summariesBody.items[0]?.sourceRevision.length ?? 0) > 0);
  equal(summariesBody.items[1]?.text, "写信给阿彬");
  equal(summariesBody.items[1]?.status, "fallback");
  equal(summariesBody.items[1]?.contextRevision, "rule:v1");

  // An unchanged day is served from the store, so opening a month twice is cheap.
  const cached = await request(harness.base, "/api/summaries?from=2026-09-08&to=2026-09-08&timeZone=Asia%2FShanghai");
  equal((cached.body as { items: Array<{ generatedAt: { value: string } }> }).items[0]?.generatedAt.value, summariesBody.items[0]?.generatedAt.value);

  // Editing the record changes its version, which invalidates the stored summary.
  const target = rangeItems[0]!;
  const patched = await request(harness.base, `/api/records/${encodeURIComponent(target.id)}`, {
    method: "PATCH",
    ...json({ revision: target.revision, content: "改成了登山" }),
  });
  equal(patched.response.status, 200);
  const refreshed = await request(harness.base, "/api/summaries?from=2026-09-08&to=2026-09-08&timeZone=Asia%2FShanghai");
  const refreshedItem = (refreshed.body as { items: Array<{ text: string; sourceRevision: string }> }).items[0];
  equal(refreshedItem?.text, "改成了登山");
  ok(refreshedItem !== undefined && refreshedItem.sourceRevision !== summariesBody.items[0]!.sourceRevision);
});

test("owner-written summaries outlive their records and can be regenerated or cleared", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const created = await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "journal", content: "江边散步", occurredAt: { kind: "date", value: "2026-09-08" } }) });
  equal(created.response.status, 201);
  const record = created.body as { id: string; revision: number };
  const range = "from=2026-09-08&to=2026-09-08&timeZone=Asia%2FShanghai";

  const written = await request(harness.base, "/api/summaries/manual", {
    method: "POST",
    ...json({ timeZone: "Asia/Shanghai", entries: [{ date: "2026-09-08", text: "在江边坐了很久。" }] }),
  });
  equal(written.response.status, 200);
  const writtenBody = written.body as { items: Array<{ date: string; text: string; status: string; provider: string }>; cleared: string[] };
  deepEqual(writtenBody.cleared, []);
  // Owner text keeps its punctuation; the sanitiser is for derived text only.
  equal(writtenBody.items[0]?.text, "在江边坐了很久。");
  equal(writtenBody.items[0]?.status, "manual");
  equal(writtenBody.items[0]?.provider, "manual");

  const readBack = await request(harness.base, `/api/summaries?${range}`);
  equal((readBack.body as { items: Array<{ text: string; status: string }> }).items[0]?.status, "manual");
  equal((readBack.body as { items: Array<{ text: string }> }).items[0]?.text, "在江边坐了很久。");

  // Editing the record must not recompute over what the owner wrote.
  const patched = await request(harness.base, `/api/records/${encodeURIComponent(record.id)}`, { method: "PATCH", ...json({ revision: record.revision, content: "改成了登山" }) });
  equal(patched.response.status, 200);
  const afterEdit = await request(harness.base, `/api/summaries?${range}`);
  equal((afterEdit.body as { items: Array<{ text: string; status: string }> }).items[0]?.status, "manual");
  equal((afterEdit.body as { items: Array<{ text: string }> }).items[0]?.text, "在江边坐了很久。");

  // Regenerating steps over it and writes a fresh derived summary.
  const regenerated = await request(harness.base, "/api/summaries/regenerate", { method: "POST", ...json({ date: "2026-09-08", timeZone: "Asia/Shanghai" }) });
  equal(regenerated.response.status, 200);
  const regeneratedBody = regenerated.body as { items: Array<{ date: string; text: string; status: string; provider: string }> };
  deepEqual(regeneratedBody.items.map((item) => item.date), ["2026-09-08"]);
  equal(regeneratedBody.items[0]?.status, "fallback");
  equal(regeneratedBody.items[0]?.text, "改成了登山");

  // Emptying the field is a revert: the row goes, and the next read recomputes.
  const cleared = await request(harness.base, "/api/summaries/manual", { method: "POST", ...json({ timeZone: "Asia/Shanghai", entries: [{ date: "2026-09-08", text: "   " }] }) });
  equal(cleared.response.status, 200);
  deepEqual((cleared.body as { cleared: string[] }).cleared, ["2026-09-08"]);
  const afterClear = await request(harness.base, `/api/summaries?${range}`);
  equal((afterClear.body as { items: Array<{ status: string }> }).items[0]?.status, "fallback");

  // A day with nothing at all has no summary to regenerate.
  const empty = await request(harness.base, "/api/summaries/regenerate", { method: "POST", ...json({ date: "2026-09-30" }) });
  equal(empty.response.status, 200);
  deepEqual((empty.body as { items: unknown[] }).items, []);
  // The range form is accepted too, and rejects a malformed request.
  const badRange = await request(harness.base, "/api/summaries/regenerate", { method: "POST", ...json({ from: "2026-09-30" }) });
  equal(badRange.response.status, 400);
  const badDate = await request(harness.base, "/api/summaries/manual", { method: "POST", ...json({ entries: [{ date: "9/8", text: "x" }] }) });
  equal(badDate.response.status, 400);
});

test("weather status and encrypted configuration stay usable without a weather key", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const status = await request(harness.base, "/api/weather/status");
  equal(status.response.status, 200);
  equal((status.body as { configured: boolean; apiHost: string }).configured, false);
  equal((status.body as { apiHost: string }).apiHost, "devapi.qweather.com");

  const empty = await request(harness.base, "/api/weather");
  equal(empty.response.status, 200);
  equal((empty.body as { weatherSnapshot: unknown }).weatherSnapshot, null);

  const badDate = await request(harness.base, "/api/weather?date=not-a-date");
  equal(badDate.response.status, 400);

  const secret = "qweather-test-secret";
  const saved = await request(harness.base, "/api/weather/config", {
    method: "POST",
    ...json({ enabled: true, locationId: "101280601", city: "珠海香洲", apiHost: "devapi.qweather.com", apiKey: secret }),
  });
  equal(saved.response.status, 200);
  equal((saved.body as { configured: boolean; hasKey: boolean }).configured, true);
  equal((saved.body as { hasKey: boolean }).hasKey, true);
  const stored = readFileSync(join(harness.root, "weather-config.json"), "utf8");
  ok(!stored.includes(secret), "weather key is encrypted at rest");
});

test("weather uses a device location, archives daily snapshots, and pins live weather to records", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const firstStatus = await request(harness.base, "/api/weather/status");
  equal(firstStatus.response.status, 200);
  const setCookie = firstStatus.response.headers.get("set-cookie") ?? "";
  const deviceCookie = setCookie.match(/lifeos_weather_device=[^;]+/)?.[0];
  ok(deviceCookie !== undefined, "weather status assigns a device cookie");
  const headers = { "content-type": "application/json", cookie: deviceCookie ?? "" };
  const saved = await request(harness.base, "/api/weather/config", {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true, locationId: "101280601", city: "广州", apiHost: "devapi.qweather.com", apiKey: "qweather-test-secret" }),
  });
  equal(saved.response.status, 200);
  equal((saved.body as { locationScope: string }).locationScope, "device");
  const profileSaved = await request(harness.base, "/api/weather/profiles", {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "佛山南海区", locationId: "101280601", city: "佛山南海区", apiHost: "devapi.qweather.com", apiKey: "profile-secret", activate: true }),
  });
  equal(profileSaved.response.status, 200);
  const profilePayload = profileSaved.body as { items: Array<{ id: string; label: string; hasKey: boolean }>; activeProfileId: string | null; status: { apiHost: string; locationId: string } };
  equal(profilePayload.items[0]?.label, "佛山南海区");
  equal(profilePayload.items[0]?.hasKey, true);
  equal(profilePayload.activeProfileId, profilePayload.items[0]?.id);
  equal(profilePayload.status.apiHost, "devapi.qweather.com");
  equal(profilePayload.status.locationId, "101280601");

  const originalFetch = globalThis.fetch;
  let dailyCalls = 0;
  let nowCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("geoapi.qweather.com/v2/city/lookup")) {
      if (url.includes("location=101280803")) return new Response(JSON.stringify({ code: "404" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ code: "200", location: [{ id: "101280601", name: "南海区", adm2: "佛山市", adm1: "广东省" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v7/weather/7d")) {
      dailyCalls += 1;
      return new Response(JSON.stringify({ code: "200", daily: [
        { fxDate: "2026-09-14", textDay: "小雨", tempMax: "30", tempMin: "25", iconDay: "305", windDirDay: "东南风", windScaleDay: "2" },
        { fxDate: "2026-09-15", textDay: "多云", tempMax: "31", tempMin: "25", iconDay: "101", windDirDay: "南风", windScaleDay: "2" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v7/weather/now")) {
      nowCalls += 1;
      return new Response(JSON.stringify({ code: "200", now: { obsTime: "2026-09-14T12:30+08:00", temp: "28", text: "雷阵雨", icon: "302", windDir: "东南风", windScale: "3" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  };
  try {
    const weatherPath = "/api/weather?date=2026-09-14";
    const firstDay = await request(harness.base, weatherPath, { headers: { cookie: deviceCookie ?? "" } });
    equal(firstDay.response.status, 200);
    equal((firstDay.body as { weatherSnapshot: { today: { textDay: string } } }).weatherSnapshot.today.textDay, "小雨");
    equal((firstDay.body as { location: { name: string } }).location.name, "佛山南海区");
    equal(dailyCalls, 1);
    const secondDay = await request(harness.base, weatherPath, { headers: { cookie: deviceCookie ?? "" } });
    equal(secondDay.response.status, 200);
    equal((secondDay.body as { weatherSnapshot: { today: { textDay: string } } }).weatherSnapshot.today.textDay, "小雨");
    equal(dailyCalls, 1, "the same device/date is served from the SQLite daily archive");

    const knownLocationConfig = await request(harness.base, "/api/weather/config", {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: true, locationId: "101280803", city: "", apiHost: "devapi.qweather.com", apiKey: "qweather-test-secret" }),
    });
    equal(knownLocationConfig.response.status, 200);
    const knownLocation = await request(harness.base, weatherPath, { headers: { cookie: deviceCookie ?? "" } });
    equal(knownLocation.response.status, 200);
    equal((knownLocation.body as { location: { name: string } }).location.name, "佛山南海区");

    const live = await request(harness.base, "/api/weather/current", { method: "POST", headers: { cookie: deviceCookie ?? "" } });
    equal(live.response.status, 200);
    const liveBody = live.body as { weather: { mode: string; text: string; temperature?: string } };
    equal(liveBody.weather.mode, "realtime");
    equal(liveBody.weather.text, "雷阵雨");
    equal(liveBody.weather.temperature, "28");
    equal(nowCalls, 1);

    const record = await request(harness.base, "/api/records", {
      method: "POST",
      ...json({ kind: "journal", content: "突然雷暴雨了", weather: liveBody.weather }),
    });
    equal(record.response.status, 201);
    equal((record.body as { weather: { mode: string; text: string } }).weather.mode, "realtime");
    equal((record.body as { weather: { mode: string; text: string } }).weather.text, "雷阵雨");

    const legacyWeatherRecord = await request(harness.base, "/api/records", {
      method: "POST",
      ...json({
        kind: "journal",
        content: "旧天气快照也应显示地区名",
        weather: {
          mode: "realtime",
          locationId: "101280803",
          city: "101280803",
          text: "阴",
          icon: "104",
          temperature: "32",
          capturedAt: { kind: "instant", value: "2026-09-14T12:30:00+08:00" },
        },
      }),
    });
    equal(legacyWeatherRecord.response.status, 201);
    equal((legacyWeatherRecord.body as { weather: { city: string } }).weather.city, "佛山南海区", "legacy weather IDs are normalized to their friendly location name");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("historical weather archive hits SQLite before any external location or forecast request", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const status = await request(harness.base, "/api/weather/status");
  const deviceCookie = (status.response.headers.get("set-cookie") ?? "").match(/lifeos_weather_device=[^;]+/)?.[0] ?? "";
  const headers = { "content-type": "application/json", cookie: deviceCookie };
  const saved = await request(harness.base, "/api/weather/config", {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true, locationId: "101280601", city: "佛山南海区", apiHost: "devapi.qweather.com", apiKey: "archive-key" }),
  });
  equal(saved.response.status, 200);
  const day = { fxDate: "2026-09-14", textDay: "中雨", tempMax: "30", tempMin: "25", iconDay: "306", windDirDay: "东南风", windScaleDay: "2" };
  const location = { id: "101280601", name: "佛山南海区", adm2: "佛山市", adm1: "广东省" };
  harness.app.repository.saveWeatherDayCache("2026-09-14", "101280601", "101280601", "佛山南海区", { weatherSnapshot: { today: day, tomorrow: day, days: [day] }, location }, new Date().toISOString(), true);
  harness.app.repository.saveWeatherDayCache("2026-09-14", "other-location", "other-location", "其他城市", { weatherSnapshot: { today: { ...day, textDay: "晴", iconDay: "100" }, tomorrow: day, days: [day] }, location: { ...location, id: "other-location", name: "其他城市" } }, new Date().toISOString(), true);
  const batch = await request(harness.base, "/api/weather/archive?from=2026-09-01&to=2026-09-30", { headers: { cookie: deviceCookie } });
  equal(batch.response.status, 200);
  equal((batch.body as { items: unknown[] }).items.length, 1);
  equal((batch.body as { items: Array<{ locationKey: string }> }).items[0]?.locationKey, "101280601");
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://")) {
      externalCalls += 1;
      throw new Error("historical archive should not call an external API");
    }
    return originalFetch(input, init);
  };
  try {
    const response = await request(harness.base, "/api/weather?date=2026-09-14", { headers: { cookie: deviceCookie } });
    equal(response.response.status, 200);
    equal((response.body as { weatherSnapshot: { today: { textDay: string; iconDay: string } } }).weatherSnapshot.today.textDay, "中雨");
    equal((response.body as { weatherSnapshot: { today: { iconDay: string } } }).weatherSnapshot.today.iconDay, "306");
    equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily weather scheduler archives the final Shanghai day once and reuses its local row", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const saved = await request(harness.base, "/api/weather/config", {
    method: "POST",
    ...json({ enabled: true, locationId: "101280601", city: "佛山南海区", apiHost: "devapi.qweather.com", apiKey: "scheduler-key" }),
  });
  equal(saved.response.status, 200);

  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  const location = { id: "101280601", name: "佛山南海区", adm2: "佛山市", adm1: "广东省" };
  const weatherDay = (fxDate: string) => ({ fxDate, textDay: "中雨", tempMax: "30", tempMin: "25", iconDay: "306", windDirDay: "东南风", windScaleDay: "2" });
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://")) externalCalls += 1;
    if (url.includes("geoapi.qweather.com")) return new Response(JSON.stringify({ code: "200", location: [location] }), { status: 200 });
    if (url.includes("/v7/weather/7d")) return new Response(JSON.stringify({ code: "200", daily: [weatherDay("2026-09-14"), weatherDay("2026-09-15"), weatherDay("2026-09-16")] }), { status: 200 });
    throw new Error(`unexpected scheduler fetch: ${url}`);
  };
  try {
    const afterFinalTime = new Date("2026-09-15T15:56:00.000Z"); // 23:56 in Shanghai.
    equal(await harness.app.weatherArchiveScheduler.runOnce(afterFinalTime), true);
    const archived = harness.app.repository.getWeatherDayCache("2026-09-15", "101280601");
    equal(archived?.archived, true);
    const callsAfterFirstRun = externalCalls;
    equal(callsAfterFirstRun > 0, true);
    equal(await harness.app.weatherArchiveScheduler.runOnce(afterFinalTime), true);
    equal(externalCalls, callsAfterFirstRun, "an archived day is never fetched a second time");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a day keeps its story when the observations overflow the limit", () => {
  const observation = (hour: number, source: "auto" | "manual", icon: string, precip?: string) => ({
    date: "2026-09-16",
    hour,
    locationKey: "101280601",
    locationId: "101280601",
    city: "佛山南海区",
    source,
    text: icon === "306" ? "中雨" : "多云",
    icon,
    ...(precip === undefined ? {} : { precip }),
    capturedAt: `2026-09-16T${String(hour).padStart(2, "0")}:00:00.000Z`,
  });

  // 60 routine hours of identical sky: the day overflows and must be trimmed.
  const routine = Array.from({ length: 60 }, (_, index) => observation(index % 24, "auto", "101"));
  const trimmed = selectDayObservations(routine);
  equal(trimmed.length, OBSERVATION_KEEP_LIMIT);

  // With a real story underneath, the story is what survives.
  const mixed = [
    ...routine,
    observation(8, "manual", "306", "3.2"),
    observation(14, "auto", "306", "5.0"),
  ];
  const kept = selectDayObservations(mixed);
  equal(kept.length, OBSERVATION_KEEP_LIMIT);
  equal(kept.some((item) => item.source === "manual"), true, "the reading the owner took by hand is never dropped");
  equal(kept.some((item) => item.icon === "306"), true, "a change in the sky outranks a routine tick");
  // The kept set still reads forward, so the day renders as a timeline.
  const hours = kept.map((item) => item.hour);
  deepEqual(hours, [...hours].sort((left, right) => left - right));

  // A day under the limit is handed back whole, untouched.
  const small = [observation(9, "auto", "101"), observation(10, "manual", "306")];
  equal(selectDayObservations(small).length, 2);
});

test("the hourly tick files one observation per hour and a second press inside the hour replaces it", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const saved = await request(harness.base, "/api/weather/config", {
    method: "POST",
    ...json({ enabled: true, locationId: "101280601", city: "佛山南海区", apiHost: "devapi.qweather.com", apiKey: "observation-key" }),
  });
  equal(saved.response.status, 200);

  const originalFetch = globalThis.fetch;
  const location = { id: "101280601", name: "佛山南海区", adm2: "佛山市", adm1: "广东省" };
  let nowText = "多云";
  let nowIcon = "101";
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Only the provider is stubbed; the harness's own localhost traffic must
    // still reach the server under test.
    if (!url.startsWith("https://")) return originalFetch(input, init);
    if (url.includes("geoapi.qweather.com")) return new Response(JSON.stringify({ code: "200", location: [location] }), { status: 200 });
    if (url.includes("/v7/weather/now")) {
      return new Response(JSON.stringify({ code: "200", now: { obsTime: "2026-09-16T08:00+08:00", temp: "27", text: nowText, icon: nowIcon, windDir: "西北风", windScale: "2", precip: "0.0", cloud: "97" } }), { status: 200 });
    }
    throw new Error(`unexpected observation fetch: ${url}`);
  };
  try {
    // The hourly tick writes one row for the current hour.
    equal(await harness.app.weatherArchiveScheduler.takeObservation(), true);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const first = harness.app.repository.listWeatherObservations(today);
    equal(first.length, 1);
    equal(first[0]?.source, "auto");
    equal(first[0]?.text, "多云");
    // The raw measurement travels with it, not just the provider's wording.
    equal(first[0]?.precip, "0.0");
    equal(first[0]?.cloud, "97");

    // A second tick in the same hour updates that row instead of adding one.
    nowText = "雷阵雨";
    nowIcon = "302";
    equal(await harness.app.weatherArchiveScheduler.takeObservation(), true);
    const second = harness.app.repository.listWeatherObservations(today);
    equal(second.length, 1, "the same hour is one fact, not two");
    equal(second[0]?.text, "雷阵雨");

    // The owner pressing the button is filed separately, under `manual`.
    const live = await request(harness.base, "/api/weather/current", { method: "POST", ...json({}) });
    equal(live.response.status, 200);
    const third = harness.app.repository.listWeatherObservations(today);
    equal(third.filter((item) => item.source === "manual").length, 1);
    equal(third.length, 2, "auto and manual for the same hour coexist");

    // Reading the day back yields the kept set.
    const read = await request(harness.base, `/api/weather/observations?date=${today}`);
    equal(read.response.status, 200);
    const payload = read.body as { readonly total: number; readonly items: readonly { readonly source: string }[] };
    equal(payload.total, 2);
    equal(payload.items.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a manual forecast refresh is rate-limited, and pressing again is the way through", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const saved = await request(harness.base, "/api/weather/config", {
    method: "POST",
    ...json({ enabled: true, locationId: "101280601", city: "佛山南海区", apiHost: "devapi.qweather.com", apiKey: "refresh-key" }),
  });
  equal(saved.response.status, 200);

  const originalFetch = globalThis.fetch;
  const location = { id: "101280601", name: "佛山南海区", adm2: "佛山市", adm1: "广东省" };
  const weatherDay = (fxDate: string) => ({ fxDate, textDay: "多云", tempMax: "32", tempMin: "26", iconDay: "101", windDirDay: "北风", windScaleDay: "1-3" });
  let forecastCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://")) return originalFetch(input, init);
    if (url.includes("geoapi.qweather.com")) return new Response(JSON.stringify({ code: "200", location: [location] }), { status: 200 });
    if (url.includes("/v7/weather/7d")) {
      forecastCalls += 1;
      return new Response(JSON.stringify({ code: "200", daily: [weatherDay("2026-09-16"), weatherDay("2026-09-17")] }), { status: 200 });
    }
    throw new Error(`unexpected refresh fetch: ${url}`);
  };
  try {
    // First manual refresh is allowed and really hits the provider.
    const first = await request(harness.base, "/api/weather?force=1");
    equal(first.response.status, 200);
    equal((first.body as { readonly throttled?: boolean }).throttled, undefined);
    const callsAfterFirst = forecastCalls;
    equal(callsAfterFirst > 0, true);

    // A second press inside the window is refused politely: 200, not an error,
    // with the snapshot still present so the header does not blank out.
    const second = await request(harness.base, "/api/weather?force=1");
    equal(second.response.status, 200);
    const secondBody = second.body as { readonly throttled?: boolean; readonly retryAfterMs?: number; readonly weatherSnapshot?: unknown };
    equal(secondBody.throttled, true);
    equal(typeof secondBody.retryAfterMs === "number" && secondBody.retryAfterMs > 0, true);
    equal(secondBody.weatherSnapshot !== null, true, "a refused refresh still shows the last known forecast");
    equal(forecastCalls, callsAfterFirst, "the refused press did not touch the provider");

    // Pressing again after being told to wait is the documented escape hatch.
    const escalated = await request(harness.base, "/api/weather?force=1&escalate=1");
    equal(escalated.response.status, 200);
    equal((escalated.body as { readonly throttled?: boolean }).throttled, undefined);
    equal(forecastCalls > callsAfterFirst, true, "the second deliberate press goes through");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relations stay symmetric and local originals are served read-only", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-assets-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "lifeos-outside-"));
  t.after(() => {
    rmSync(assetRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });
  const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
  writeFileSync(join(assetRoot, "note.png"), pngBytes);
  writeFileSync(join(assetRoot, "secrets.txt"), "not a media file");
  writeFileSync(join(outsideRoot, "secret.png"), "outside the root");

  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot);
  t.after(async () => harness.stop());

  await request(harness.base, "/api/entities", { method: "POST", ...json({ id: "self", type: "person", name: "我" }) });
  await request(harness.base, "/api/entities", { method: "POST", ...json({ id: "demo-person-xiaoyu", type: "person", name: "小雨" }) });
  await request(harness.base, "/api/entities", { method: "POST", ...json({ id: "demo-person-abin", type: "person", name: "阿彬" }) });

  const linked = await request(harness.base, "/api/entities/self/relations", {
    method: "POST",
    ...json({ kind: "partner", targetId: "demo-person-xiaoyu" }),
  });
  equal(linked.response.status, 200);
  const linkedBody = linked.body as {
    source: { relations: Array<{ kind: string; entityId: string }> };
    target: { relations: Array<{ kind: string; entityId: string }> };
  };
  deepEqual(linkedBody.source.relations, [{ kind: "partner", entityId: "demo-person-xiaoyu" }]);
  // The far side is written too, so either direction can be read.
  deepEqual(linkedBody.target.relations, [{ kind: "partner", entityId: "self" }]);

  const found = await request(harness.base, `/api/entities?q=${encodeURIComponent("小雨")}`);
  const foundItem = (found.body as { items: Array<{ relations?: unknown[] }> }).items[0];
  equal(foundItem?.relations?.length, 1);

  // Re-linking the same pair replaces the kind instead of duplicating the edge.
  const relinked = await request(harness.base, "/api/entities/self/relations", {
    method: "POST",
    ...json({ kind: "friend", targetId: "demo-person-xiaoyu" }),
  });
  deepEqual((relinked.body as { source: { relations: Array<{ kind: string }> } }).source.relations.map((relation) => relation.kind), ["friend"]);

  const selfLink = await request(harness.base, "/api/entities/self/relations", { method: "POST", ...json({ kind: "friend", targetId: "self" }) });
  equal(selfLink.response.status, 400);
  const badKind = await request(harness.base, "/api/entities/self/relations", { method: "POST", ...json({ kind: "enemy", targetId: "demo-person-abin" }) });
  equal(badKind.response.status, 400);
  const unknownTarget = await request(harness.base, "/api/entities/self/relations", { method: "POST", ...json({ kind: "friend", targetId: "nobody" }) });
  equal(unknownTarget.response.status, 404);
  const unknownSource = await request(harness.base, "/api/entities/nobody/relations", { method: "POST", ...json({ kind: "friend", targetId: "self" }) });
  equal(unknownSource.response.status, 404);

  const dropped = await request(harness.base, "/api/entities/self/relations/demo-person-xiaoyu", { method: "DELETE" });
  equal(dropped.response.status, 200);
  deepEqual((dropped.body as { target: { relations?: unknown[] } }).target.relations, undefined);

  // An original is streamed in place; nothing is copied into LifeOS.
  const asset = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ id: "demo-asset-note", kind: "photo", originalName: "note.png", storageRefs: [{ sourceId: "local", sourceRef: "note.png" }] }),
  });
  equal(asset.response.status, 201);
  const content = await fetch(`${harness.base}/api/assets/demo-asset-note/content`);
  equal(content.status, 200);
  equal(content.headers.get("content-type"), "image/png");
  deepEqual(Array.from(new Uint8Array(await content.arrayBuffer())), Array.from(pngBytes));

  const escape = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ id: "demo-asset-escape", kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: `../${outsideRoot.split(/[\\/]/).pop()}/secret.png` }] }),
  });
  equal(escape.response.status, 201);
  equal((await fetch(`${harness.base}/api/assets/demo-asset-escape/content`)).status, 403);

  const absoluteEscape = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ id: "demo-asset-absolute", kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: join(outsideRoot, "secret.png") }] }),
  });
  equal(absoluteEscape.response.status, 201);
  equal((await fetch(`${harness.base}/api/assets/demo-asset-absolute/content`)).status, 403);

  const wrongType = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ id: "demo-asset-text", kind: "file", storageRefs: [{ sourceId: "local", sourceRef: "secrets.txt" }] }),
  });
  equal(wrongType.response.status, 201);
  equal((await fetch(`${harness.base}/api/assets/demo-asset-text/content`)).status, 415);

  const missingFile = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ id: "demo-asset-missing", kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: "gone.png" }] }),
  });
  equal(missingFile.response.status, 201);
  equal((await fetch(`${harness.base}/api/assets/demo-asset-missing/content`)).status, 404);

  const remoteOnly = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ id: "demo-asset-remote", kind: "photo", storageRefs: [{ sourceId: "synology", sourceRef: "/photo/a.png" }] }),
  });
  equal(remoteOnly.response.status, 201);
  equal((await fetch(`${harness.base}/api/assets/demo-asset-remote/content`)).status, 404);

  // Without LIFEOS_ASSET_ROOT nothing is served at all.
  const bareHarness = await startHarness();
  t.after(async () => bareHarness.stop());
  await request(bareHarness.base, "/api/assets", {
    method: "POST",
    ...json({ id: "demo-asset-bare", kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: "note.png" }] }),
  });
  const bare = await request(bareHarness.base, "/api/assets/demo-asset-bare/content");
  equal(bare.response.status, 404);
  equal((bare.body as { error: string }).error, "asset_root_not_configured");
});

// One real 1x1 PNG. A genuine file matters here: the sniffer must accept a
// photo someone actually dropped, not just any bytes with the right prefix.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8QAAAkAAQGjJSbCAAAAAElFTkSuQmCC",
  "base64",
);

test("a dropped photo is written into the asset root, served back, and linked to a record", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-uploads-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot);
  t.after(async () => harness.stop());

  const upload = await request(harness.base, `/api/assets/uploads?name=${encodeURIComponent("阳台的花.png")}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const asset = upload.body as {
    id: string;
    kind: string;
    originalName?: string;
    mediaType?: string;
    sizeBytes?: number;
    storageRefs: Array<{ sourceId: string; sourceRef: string; mediaType?: string }>;
  };
  equal(asset.kind, "photo");
  equal(asset.originalName, "阳台的花.png");
  equal(asset.mediaType, "image/png");
  equal(asset.sizeBytes, TINY_PNG.length);
  equal(asset.storageRefs.length, 1);
  equal(asset.storageRefs[0]?.sourceId, "local");
  // The stored name is generated, never taken from the request: it is the photo's
  // own sha256, so the path is content-addressed and the same bytes can never be
  // written under a second name.
  const sourceRef = asset.storageRefs[0]?.sourceRef ?? "";
  const digest = createHash("sha256").update(TINY_PNG).digest("hex");
  ok(/^uploads\/\d{4}\/\d{2}\/[0-9a-f]{64}\.png$/.test(sourceRef), `unexpected stored path: ${sourceRef}`);
  equal(sourceRef.endsWith(`/${digest}.png`), true, "the file is named by its own content hash");
  ok(existsSync(join(assetRoot, ...sourceRef.split("/"))), "the photo should be on disk");

  const content = await fetch(`${harness.base}/api/assets/${encodeURIComponent(asset.id)}/content`);
  equal(content.status, 200);
  equal(content.headers.get("content-type"), "image/png");
  equal((await content.arrayBuffer()).byteLength, TINY_PNG.length);

  // The composer links the upload to the entry it was dropped on.
  const record = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "journal", content: "阳台的花开了", assetRefs: [{ assetId: asset.id, role: "photo", label: "阳台的花.png" }] }),
  });
  equal(record.response.status, 201);
  const recordBody = record.body as { assetRefs: Array<{ assetId: string; role: string }> };
  equal(recordBody.assetRefs.length, 1);
  equal(recordBody.assetRefs[0]?.assetId, asset.id);

  // A referenced asset cannot be deleted out from under its record.
  const busy = await request(harness.base, `/api/assets/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
  equal(busy.response.status, 409);
});

test("uploads refuse anything that is not a real photo", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-uploads-reject-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot);
  t.after(async () => harness.stop());

  const wrongType = await request(harness.base, "/api/assets/uploads", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "just some notes",
  });
  equal(wrongType.response.status, 415);

  // Declaring a photo is not enough: the bytes have to agree.
  const lying = await request(harness.base, "/api/assets/uploads", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(Buffer.from("this is plainly not a png")),
  });
  equal(lying.response.status, 415);
  equal((lying.body as { error: string }).error, "content_type_mismatch");

  const empty = await request(harness.base, "/api/assets/uploads", { method: "POST", headers: { "content-type": "image/png" } });
  equal(empty.response.status, 400);
  equal((empty.body as { error: string }).error, "empty_upload");

  // A hostile original name never reaches the path, and never breaks the upload.
  const sneaky = await request(harness.base, `/api/assets/uploads?name=${encodeURIComponent("../../etc/passwd.png")}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(sneaky.response.status, 201);
  const sneakyRef = (sneaky.body as { storageRefs: Array<{ sourceRef: string }> }).storageRefs[0]?.sourceRef ?? "";
  equal(sneakyRef.includes(".."), false);
  equal(existsSync(join(assetRoot, ...sneakyRef.split("/"))), true);

  // The photo limit is its own knob, far above the JSON body limit.
  const tinyLimit = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 32);
  t.after(async () => tinyLimit.stop());
  const tooLarge = await request(tinyLimit.base, "/api/assets/uploads", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(tooLarge.response.status, 413);

  // Without an asset root there is nowhere to put the file, so nothing is stored.
  const bareHarness = await startHarness();
  t.after(async () => bareHarness.stop());
  const noRoot = await request(bareHarness.base, "/api/assets/uploads", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(noRoot.response.status, 404);
  equal((noRoot.body as { error: string }).error, "asset_root_not_configured");
});

test("privacy records persist, stay in raw timeline/export data, and leave calendar summaries out", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const created = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "journal", content: "只给自己看的内容", isPrivate: true, occurredAt: { kind: "date", value: "2026-09-14" } }),
  });
  equal(created.response.status, 201);
  const privateRecord = created.body as { id: string; revision: number; isPrivate?: boolean };
  equal(privateRecord.isPrivate, true);

  const invalid = await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "bad", isPrivate: "yes" }) });
  equal(invalid.response.status, 400);

  const timeline = await request(harness.base, "/api/records?date=2026-09-14");
  equal(timeline.response.status, 200);
  equal((timeline.body as { items: Array<{ isPrivate?: boolean; body: { original: string } }> }).items[0]?.isPrivate, true);
  equal((timeline.body as { items: Array<{ body: { original: string } }> }).items[0]?.body.original, "只给自己看的内容");

  const summaries = await request(harness.base, "/api/summaries?from=2026-09-14&to=2026-09-14");
  equal(summaries.response.status, 200);
  deepEqual((summaries.body as { items: unknown[] }).items, []);

  const exported = await request(harness.base, "/api/export");
  equal(exported.response.status, 200);
  const exportedRecord = (exported.body as { records: Array<{ isPrivate?: boolean }> }).records[0];
  equal(exportedRecord?.isPrivate, true);
  const markdown = await request(harness.base, "/api/export?format=markdown");
  equal(markdown.response.status, 200);
  match(String(markdown.body), /isPrivate: true/);

  const unhidden = await request(harness.base, `/api/records/${privateRecord.id}`, { method: "PATCH", ...json({ revision: privateRecord.revision, isPrivate: false }) });
  equal(unhidden.response.status, 200);
  equal((unhidden.body as { isPrivate?: boolean }).isPrivate, undefined);
  const nowSummarized = await request(harness.base, "/api/summaries?from=2026-09-14&to=2026-09-14");
  equal((nowSummarized.body as { items: Array<{ date: string }> }).items[0]?.date, "2026-09-14");
});

test("cycle intimacy module persists private calendar facts and travels in JSON export", async (t) => {
  const harness = await startHarness();
  const restored = await startHarness();
  t.after(async () => harness.stop());
  t.after(async () => restored.stop());

  const defaultModule = await request(harness.base, "/api/modules/cycle-intimacy");
  equal(defaultModule.response.status, 200);
  deepEqual((defaultModule.body as { config: { enabled: boolean; cycleLength: number; periodLength: number }; events: unknown[] }).config, { enabled: false, cycleLength: 28, periodLength: 7 });
  equal((defaultModule.body as { events: unknown[] }).events.length, 0);

  const configured = await request(harness.base, "/api/modules/cycle-intimacy/config", {
    method: "PUT",
    ...json({ enabled: true, cycleLength: 29, periodLength: 6, anchorStart: "2026-09-01" }),
  });
  equal(configured.response.status, 200);
  equal((configured.body as { config: { anchorStart?: string } }).config.anchorStart, "2026-09-01");

  const start = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-01", kind: "period_start" }) });
  equal(start.response.status, 201);
  const intimate = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-03", kind: "intimacy" }) });
  equal(intimate.response.status, 201);
  const fitness = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-04", kind: "fitness" }) });
  equal(fitness.response.status, 201);
  const end = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-06", kind: "period_end" }) });
  equal(end.response.status, 201);
  const duplicate = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-03", kind: "intimacy" }) });
  equal(duplicate.response.status, 409);

  const exportResponse = await request(harness.base, "/api/export?format=json");
  equal(exportResponse.response.status, 200);
  const exported = exportResponse.body as { modules?: { cycleIntimacy?: { config: { enabled: boolean; cycleLength: number }; events: Array<{ id: string; date: string; kind: string }> } } };
  equal(exported.modules?.cycleIntimacy?.config.enabled, true);
  equal(exported.modules?.cycleIntimacy?.config.cycleLength, 29);
  deepEqual(exported.modules?.cycleIntimacy?.events.map((event) => `${event.date}:${event.kind}`), ["2026-09-01:period_start", "2026-09-03:intimacy", "2026-09-04:fitness", "2026-09-06:period_end"]);

  const imported = await request(restored.base, "/api/import", { method: "POST", ...json({ bundle: exported }) });
  equal(imported.response.status, 201);
  const restoredModule = await request(restored.base, "/api/modules/cycle-intimacy");
  deepEqual((restoredModule.body as { config: unknown; events: unknown[] }), exported.modules?.cycleIntimacy);

  const eventId = exported.modules?.cycleIntimacy?.events[1]?.id;
  ok(eventId);
  const removed = await request(harness.base, `/api/modules/cycle-intimacy/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  equal(removed.response.status, 200);
  equal((removed.body as { events: unknown[] }).events.length, 3);
});

test("a period ends once: recording an end on another day moves it instead of stacking a second", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());
  const ends = (body: unknown) => (body as { events: Array<{ date: string; kind: string }> }).events.filter((event) => event.kind === "period_end").map((event) => event.date);

  await request(harness.base, "/api/modules/cycle-intimacy/config", { method: "PUT", ...json({ enabled: true, cycleLength: 28, periodLength: 7 }) });
  await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-20", kind: "period_start" }) });

  // The owner's own sequence (2026-09-21): confirm the end on 9/25, then correct it
  // to 9/24. Before this rule the 9/25 row stayed behind — drawn by nothing, because
  // the calendar takes the first end after the start, but still ticked in the panel.
  const later = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-25", kind: "period_end" }) });
  equal(later.response.status, 201);
  const moved = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-24", kind: "period_end" }) });
  equal(moved.response.status, 201);
  deepEqual(ends(moved.body), ["2026-09-24"]);

  // A new period is a new span: moving its end must not reach back into the first.
  await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-10-18", kind: "period_start" }) });
  const nextPeriod = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-10-22", kind: "period_end" }) });
  deepEqual(ends(nextPeriod.body), ["2026-09-24", "2026-10-22"]);

  // Independent habits are never collateral: only ends inside the same span move.
  await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-21", kind: "fitness" }) });
  const again = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-23", kind: "period_end" }) });
  deepEqual(ends(again.body), ["2026-09-23", "2026-10-22"]);
  deepEqual((again.body as { events: Array<{ date: string; kind: string }> }).events.filter((event) => event.kind === "fitness").map((event) => event.date), ["2026-09-21"]);

  // Same day, same kind is still a plain duplicate — the store cannot grow a second
  // row keyed to one day, which is the limit this rule deliberately stops at.
  const sameDay = await request(harness.base, "/api/modules/cycle-intimacy/events", { method: "POST", ...json({ date: "2026-09-23", kind: "period_end" }) });
  equal(sameDay.response.status, 409);
});

test("movie module is opt-in, keeps TMDb keys private, resolves candidates, and upserts refs", async (t) => {
  const harness = await startHarness();
  const restored = await startHarness();
  t.after(async () => harness.stop());
  t.after(async () => restored.stop());

  const initial = await request(harness.base, "/api/movie/status");
  equal(initial.response.status, 200);
  deepEqual(initial.body, {
    enabled: false,
    configured: false,
    hasKey: false,
    source: "none",
    apiBaseUrl: "https://api.themoviedb.org/3",
  });
  let externalCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://api.themoviedb.org/3")) return originalFetch(input, init);
    externalCalls += 1;
    equal(new URL(url).searchParams.get("api_key"), "movie-test-key");
    if (url.includes("/find/")) {
      return new Response(JSON.stringify({ movie_results: [{ id: 111, title: "霸王别姬", original_title: "Farewell My Concubine", release_date: "1993-01-01", poster_path: "/poster.jpg", overview: "一段故事" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [
      { id: 111, title: "霸王别姬", original_title: "Farewell My Concubine", release_date: "1993-01-01", poster_path: "/poster.jpg", overview: "一段故事" },
      { id: 222, title: "霸王别姬（修复版）", original_title: "Farewell My Concubine", release_date: "1993-01-01", poster_path: null, overview: "另一个候选" },
    ] }), { status: 200 });
  };
  try {
    const disabled = await request(harness.base, "/api/movie/resolve", { method: "POST", ...json({ query: "霸王别姬" }) });
    equal(disabled.response.status, 409);
    equal((disabled.body as { error: string }).error, "movie_module_disabled");
    equal(externalCalls, 0);
    const disabledImport = await request(harness.base, "/api/movie/import", { method: "POST", ...json({ movie: { name: "不应写入", externalIds: { tmdb: 999 } } }) });
    equal(disabledImport.response.status, 409);
    equal((disabledImport.body as { error: string }).error, "movie_module_disabled");

    const configured = await request(harness.base, "/api/movie/config", { method: "POST", ...json({ enabled: true, apiKey: "movie-test-key" }) });
    equal(configured.response.status, 200);
    equal((configured.body as { enabled: boolean; hasKey: boolean }).enabled, true);
    equal((configured.body as { hasKey: boolean }).hasKey, true);
    equal(JSON.stringify(configured.body).includes("movie-test-key"), false);
    const stored = readFileSync(join(harness.root, "movie-config.json"), "utf8");
    equal(stored.includes("movie-test-key"), false);
    equal(stored.includes("encryptedApiKey"), true);

    const resolved = await request(harness.base, "/api/movie/resolve", { method: "POST", ...json({ title: "霸王别姬" }) });
    equal(resolved.response.status, 200);
    const candidates = (resolved.body as { candidates: Array<{ tmdbId: number; name: string; posterUrl?: string }> }).candidates;
    equal(candidates.length, 2);
    equal(candidates[0]?.tmdbId, 111);
    equal(candidates[0]?.posterUrl, "https://image.tmdb.org/t/p/w500/poster.jpg");

    const imported = await request(harness.base, "/api/movie/import", {
      method: "POST",
      ...json({ movie: { ...candidates[0], personalRating: 9.5, personalReview: "值得重看", watchedAt: "2026-09-15" } }),
    });
    equal(imported.response.status, 201);
    const importedEntity = (imported.body as { created: boolean; entity: { id: string; type: string; externalIds: { tmdb: string }; personalRating: number } }).entity;
    equal((imported.body as { created: boolean }).created, true);
    equal(importedEntity.type, "movie");
    equal(importedEntity.externalIds.tmdb, "111");
    equal(importedEntity.personalRating, 9.5);

    const duplicate = await request(harness.base, "/api/movie/upsert", {
      method: "POST",
      ...json({ name: "Farewell My Concubine", externalIds: { tmdb: 111 }, personalRating: 8.5 }),
    });
    equal(duplicate.response.status, 200);
    equal((duplicate.body as { created: boolean }).created, false);
    equal((duplicate.body as { entity: { id: string } }).entity.id, importedEntity.id);
    equal((duplicate.body as { entity: { name: string } }).entity.name, "霸王别姬");
    equal((duplicate.body as { entity: { personalReview?: string } }).entity.personalReview, "值得重看");
    const clearedRating = await request(harness.base, `/api/entities/${encodeURIComponent(importedEntity.id)}`, {
      method: "PATCH",
      ...json({ personalRating: null }),
    });
    equal(clearedRating.response.status, 200);
    equal((clearedRating.body as { personalRating?: number }).personalRating, undefined);

    const linked = await request(harness.base, "/api/records", { method: "POST", ...json({ kind: "note", content: "重看霸王别姬", entityRefs: [{ entityType: "movie", entityId: importedEntity.id }] }) });
    equal(linked.response.status, 201);
    const movies = await request(harness.base, "/api/entities?type=movie&q=Farewell");
    equal(movies.response.status, 200);
    equal((movies.body as { items: unknown[] }).items.length, 1);

    const invalidRating = await request(harness.base, "/api/entities", { method: "POST", ...json({ type: "movie", name: "坏评分", personalRating: 8.25 }) });
    equal(invalidRating.response.status, 400);
    const exported = await request(harness.base, "/api/export");
    equal(exported.response.status, 200);
    const bundle = exported.body as { entities: Array<{ type: string }>; records: unknown[] };
    equal(bundle.entities.some((entity) => entity.type === "movie"), true);
    const restoredImport = await request(restored.base, "/api/import", { method: "POST", ...json({ bundle }) });
    equal(restoredImport.response.status, 201);
    equal((await request(restored.base, "/api/entities?type=movie")).response.status, 200);

    const imdb = await request(harness.base, "/api/movie/resolve", { method: "POST", ...json({ query: "https://www.imdb.com/title/tt0106332/" }) });
    equal(imdb.response.status, 200);
    equal((imdb.body as { candidates: Array<{ externalIds: { imdb?: string } }> }).candidates[0]?.externalIds.imdb, "tt0106332");
    const beforeDouban = externalCalls;
    const doubanOnly = await request(harness.base, "/api/movie/resolve", { method: "POST", ...json({ doubanId: "1295644" }) });
    equal(doubanOnly.response.status, 400);
    equal((doubanOnly.body as { error: string }).error, "douban_title_required");
    equal(externalCalls, beforeDouban);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Backup retention
// ---------------------------------------------------------------------------

const RETENTION_NOW = new Date("2026-09-15T04:00:00.000Z"); // 2026-09-15 12:00 Asia/Shanghai

test("retention keeps one snapshot per day inside the daily window", () => {
  const planned = planBackupRetention([
    { startedAt: "2026-09-15T02:00:00.000Z", name: "today" },
    { startedAt: "2026-09-14T02:00:00.000Z", name: "yesterday-newest" },
    { startedAt: "2026-09-14T01:00:00.000Z", name: "yesterday-older" },
  ], { dailyDays: 7, weeklyWeeks: 0, monthlyMonths: 0, trashDays: 30 }, RETENTION_NOW);
  const byName = new Map(planned.map((entry) => [entry.name, entry]));
  equal(byName.get("today")!.keep, true);
  equal(byName.get("today")!.tier, "daily");
  equal(byName.get("yesterday-newest")!.keep, true);
  // A second snapshot on an already-claimed day has no slot of its own.
  equal(byName.get("yesterday-older")!.keep, false);
  equal(byName.get("yesterday-older")!.tier, "none");
});

test("retention falls back to the weekly and monthly tiers for older snapshots", () => {
  const policy = { dailyDays: 7, weeklyWeeks: 8, monthlyMonths: 12, trashDays: 30 };
  const planned = planBackupRetention([
    { startedAt: "2026-09-15T02:00:00.000Z", name: "today" },
    { startedAt: "2026-09-02T02:00:00.000Z", name: "two-weeks-ago" },
    { startedAt: "2026-06-10T02:00:00.000Z", name: "three-months-ago" },
    { startedAt: "2026-06-01T02:00:00.000Z", name: "oldest-in-that-month" },
  ], policy, RETENTION_NOW);
  const byName = new Map(planned.map((entry) => [entry.name, entry]));
  equal(byName.get("today")!.tier, "daily");
  equal(byName.get("two-weeks-ago")!.tier, "weekly");
  equal(byName.get("three-months-ago")!.tier, "monthly");
  // Same month as the one already kept, so no second slot.
  equal(byName.get("oldest-in-that-month")!.keep, false);
});

test("retention never drops the newest snapshot, whatever the policy says", () => {
  const planned = planBackupRetention([{ startedAt: "2020-01-01T00:00:00.000Z" }], { dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0, trashDays: 30 }, RETENTION_NOW);
  equal(planned.length, 1);
  equal(planned[0]!.keep, true);
  equal(planned[0]!.tier, "newest");
});

test("retention excludes connection-test objects and validates its policy", () => {
  const planned = planBackupRetention([
    { startedAt: "2026-09-15T02:00:00.000Z", name: "backup" },
    { startedAt: "2026-09-15T03:00:00.000Z", name: "connection-test", isConnectionTest: true },
  ], DEFAULT_BACKUP_RETENTION, RETENTION_NOW);
  const byName = new Map(planned.map((entry) => [entry.name, entry]));
  // Newer than the backup, yet still refused a slot: it is not a backup.
  equal(byName.get("connection-test")!.keep, false);
  equal(byName.get("backup")!.keep, true);

  throws(() => assertValidBackupRetention({ dailyDays: 0, weeklyWeeks: 1, monthlyMonths: 1, trashDays: 30 }));
  throws(() => assertValidBackupRetention({ dailyDays: 7, weeklyWeeks: -1, monthlyMonths: 1, trashDays: 30 }));
  throws(() => assertValidBackupRetention({ dailyDays: 7, weeklyWeeks: 1, monthlyMonths: 999, trashDays: 30 }));
  throws(() => planBackupRetention([], { dailyDays: 1.5, weeklyWeeks: 1, monthlyMonths: 1, trashDays: 30 }, RETENTION_NOW));
  equal(planBackupRetention([], DEFAULT_BACKUP_RETENTION, RETENTION_NOW).length, 0);
  ok(describeBackupRetention(DEFAULT_BACKUP_RETENTION).every((line) => typeof line === "string" && line.length > 0));
  equal(retentionHorizonDays({ dailyDays: 7, weeklyWeeks: 8, monthlyMonths: 12, trashDays: 30 }), 372);
});

test("backup retention endpoint exposes the plan and saves changes", async (t) => {
  const harness = await startHarness();
  t.after(async () => harness.stop());

  const initial = await request(harness.base, "/api/backup/retention");
  equal(initial.response.status, 200);
  const initialBody = initial.body as {
    policy: unknown;
    described: readonly string[];
    entries: readonly unknown[];
    summary: { keepCount: number; deleteCount: number };
    cleanupScope: { local: boolean; remote: boolean; recycleBin: { local: boolean; remote: boolean } };
    trashed: readonly unknown[];
    cleanupScheduled: boolean;
  };
  deepEqual(initialBody.policy, DEFAULT_BACKUP_RETENTION);
  ok(Array.isArray(initialBody.described) && initialBody.described.length >= 3);
  ok(Array.isArray(initialBody.entries));
  // Cleaned snapshots go to LifeOS's own recycle bin first, so both halves are
  // pruned and the API says exactly that.
  equal(initialBody.cleanupScope.local, true);
  equal(initialBody.cleanupScope.remote, true);
  equal(initialBody.cleanupScope.recycleBin.local, true);
  equal(initialBody.cleanupScope.recycleBin.remote, true);
  ok(Array.isArray(initialBody.trashed));
  equal(typeof initialBody.summary.keepCount, "number");

  const saved = await request(harness.base, "/api/backup/retention", {
    method: "POST",
    ...json({ dailyDays: 3, weeklyWeeks: 2, monthlyMonths: 6, trashDays: 14 }),
  });
  equal(saved.response.status, 200);
  deepEqual((saved.body as { policy: unknown }).policy, { dailyDays: 3, weeklyWeeks: 2, monthlyMonths: 6, trashDays: 14 });

  const status = await request(harness.base, "/api/backup/status");
  deepEqual((status.body as { retention: { policy: unknown } }).retention.policy, { dailyDays: 3, weeklyWeeks: 2, monthlyMonths: 6, trashDays: 14 });

  const invalid = await request(harness.base, "/api/backup/retention", {
    method: "POST",
    ...json({ dailyDays: 0, weeklyWeeks: 2, monthlyMonths: 6, trashDays: 14 }),
  });
  equal(invalid.response.status, 400);

  const unknownKey = await request(harness.base, "/api/backup/retention", {
    method: "POST",
    ...json({ dailyDays: 3, weeklyWeeks: 2, monthlyMonths: 6, trashDays: 14, extra: 1 }),
  });
  equal(unknownKey.response.status, 400);
});

function photoAsset(id: string, sourceRef: string, createdAt?: string): Asset {
  return {
    id,
    kind: "photo",
    ...(createdAt === undefined ? {} : { createdAt: createInstant(createdAt) }),
    storageRefs: [{ sourceId: "local", sourceRef }],
  };
}

test("the collector's rule set refuses anything LifeOS does not own", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const fresh = photoAsset("asset_fresh", "uploads/2026/09/fresh.png", "2026-09-15T00:00:00.000Z");
  const stale = photoAsset("asset_stale", "uploads/2026/09/stale.png", "2026-09-01T00:00:00.000Z");
  // The owner's own file, an escaping path, and an upload with no timestamp:
  // all three are refused rather than guessed at.
  const foreign = photoAsset("asset_foreign", "holiday.jpg", "2020-01-01T00:00:00.000Z");
  const escape = photoAsset("asset_escape", "../outside.png", "2020-01-01T00:00:00.000Z");
  const unstamped = photoAsset("asset_unstamped", "uploads/2026/09/unstamped.png");
  const mixed: Asset = {
    ...photoAsset("asset_mixed", "uploads/2026/09/mixed.png", "2026-09-01T00:00:00.000Z"),
    storageRefs: [
      { sourceId: "local", sourceRef: "uploads/2026/09/mixed.png" },
      { sourceId: "synology", sourceRef: "/photo/mixed.heic" },
    ],
  };

  const plan = planUnreferencedUploads([fresh, stale, foreign, escape, unstamped, mixed], new Set<string>(), now, 7);
  deepEqual(plan.map((item) => item.asset.id), ["asset_fresh", "asset_stale"]);
  equal(plan[0]?.overdue, false);
  equal(plan[0]?.daysRemaining, 7);
  equal(plan[0]?.dueAt.toISOString(), "2026-09-22T00:00:00.000Z");
  equal(plan[1]?.overdue, true);
  equal(plan[1]?.daysRemaining, 0);

  // A reference — even one from a soft-deleted record — takes it out entirely.
  deepEqual(planUnreferencedUploads([stale], new Set(["asset_stale"]), now, 7), []);

  equal(isCollectableAsset(foreign), false);
  equal(isCollectableAsset(mixed), false);
  equal(trashPathFor("uploads/2026/09/a.png"), "uploads/_orphan-trash/2026/09/a.png");
  equal(trashPathFor("holiday.jpg"), null);
  equal(trashPathFor("uploads/_orphan-trash/2026/09/a.png"), null);
  equal(originalPathFor("uploads/_orphan-trash/2026/09/a.png"), "uploads/2026/09/a.png");
  equal(resolveWithinRoot("root", "../etc/passwd"), null);
  ok(resolveWithinRoot("root", "uploads/a.png")?.endsWith("a.png") === true);

  // The daily pass lands at 03:30 in Shanghai whatever the host clock says.
  equal(nextAssetGcAt(new Date("2026-09-15T12:00:00.000Z")).toISOString(), "2026-09-15T19:30:00.000Z");
  equal(nextAssetGcAt(new Date("2026-09-15T20:00:00.000Z")).toISOString(), "2026-09-16T19:30:00.000Z");

  const entry = { asset: stale, trashedAt: "2026-09-01T00:00:00.000Z", origin: "orphan-scan" as const, relativePath: "uploads/2026/09/stale.png" };
  deepEqual(planTrashPurge([entry], new Date("2026-09-20T00:00:00.000Z"), 30), []);
  deepEqual(planTrashPurge([entry], new Date("2026-10-05T00:00:00.000Z"), 30).map((item) => item.asset.id), ["asset_stale"]);
  deepEqual(planTrashPurge([{ ...entry, restoredAt: "2026-09-10T00:00:00.000Z" }], new Date("2026-10-05T00:00:00.000Z"), 30), []);
});

test("an unreferenced upload is collected after the grace period, then restorable", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-gc-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const upload = await request(harness.base, "/api/assets/uploads?name=orphan.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const asset = upload.body as { id: string; storageRefs: Array<{ sourceRef: string }> };
  const sourceRef = asset.storageRefs[0]?.sourceRef ?? "";
  const originalPath = join(assetRoot, ...sourceRef.split("/"));
  ok(existsSync(originalPath), "the upload should start on disk");

  // Inside the grace period nothing moves: the owner may still be writing.
  equal(harness.app.assetGcScheduler.runOnce(new Date())?.collected.length, 0);
  ok(existsSync(originalPath), "a fresh upload must survive the first pass");

  const pendingView = await request(harness.base, "/api/assets/trash", { method: "GET" });
  equal(pendingView.response.status, 200);
  const pendingBody = pendingView.body as {
    graceDays: number;
    trashDays: number;
    pending: Array<{ asset: { id: string }; daysRemaining: number; overdue: boolean }>;
    trashed: unknown[];
  };
  equal(pendingBody.graceDays, 7);
  equal(pendingBody.trashDays, 30);
  equal(pendingBody.pending.length, 1);
  equal(pendingBody.pending[0]?.asset.id, asset.id);
  equal(pendingBody.pending[0]?.overdue, false);
  equal(pendingBody.pending[0]?.daysRemaining, 7);
  equal(pendingBody.trashed.length, 0);

  // Eight days on the collector moves it aside — parked, not deleted.
  const pass = harness.app.assetGcScheduler.runOnce(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
  deepEqual(pass?.collected, [asset.id]);
  equal(existsSync(originalPath), false);
  const trashedPath = join(assetRoot, "uploads", "_orphan-trash", ...sourceRef.split("/").slice(1));
  ok(existsSync(trashedPath), "the file should wait in the trash");
  equal((await fetch(`${harness.base}/api/assets/${encodeURIComponent(asset.id)}/content`)).status, 404);

  const afterView = await request(harness.base, "/api/assets/trash", { method: "GET" });
  const afterBody = afterView.body as { pending: unknown[]; trashed: Array<{ asset: { id: string }; origin: string; daysRemaining: number }> };
  equal(afterBody.pending.length, 0);
  equal(afterBody.trashed.length, 1);
  equal(afterBody.trashed[0]?.asset.id, asset.id);
  equal(afterBody.trashed[0]?.origin, "orphan-scan");
  // The trash window counts from the moment of collection, which this test
  // pushed eight days into the future — hence 30 days of policy plus those 8.
  equal(afterBody.trashed[0]?.daysRemaining, 38);

  // The panel needs a thumbnail, and a collected file is no longer at its path.
  const thumb = await fetch(`${harness.base}/api/assets/trash/${encodeURIComponent(asset.id)}/content`);
  equal(thumb.status, 200);
  equal((await thumb.arrayBuffer()).byteLength, TINY_PNG.length);

  const restored = await request(harness.base, `/api/assets/trash/${encodeURIComponent(asset.id)}/restore`, { method: "POST" });
  equal(restored.response.status, 204);
  ok(existsSync(originalPath), "restoring must put the file back where it was");
  const content = await fetch(`${harness.base}/api/assets/${encodeURIComponent(asset.id)}/content`);
  equal(content.status, 200);
  equal((await content.arrayBuffer()).byteLength, TINY_PNG.length);
});

test("the collector leaves referenced uploads alone, including records in the recycle bin", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-gc-ref-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const upload = await request(harness.base, "/api/assets/uploads?name=kept.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  const asset = upload.body as { id: string; storageRefs: Array<{ sourceRef: string }> };
  const originalPath = join(assetRoot, ...((asset.storageRefs[0]?.sourceRef ?? "").split("/")));

  const created = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "journal", content: "用上了这张图", assetRefs: [{ assetId: asset.id, role: "photo" }] }),
  });
  equal(created.response.status, 201);
  const createdBody = created.body as { id: string; revision?: number };

  const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  equal(harness.app.assetGcScheduler.runOnce(far)?.collected.length, 0);
  ok(existsSync(originalPath), "a referenced upload is never collected");

  // A soft-deleted record can still be restored, so its photo has to survive.
  // This is the trap the whole feature hinges on.
  const removed = await request(harness.base, `/api/records/${encodeURIComponent(createdBody.id)}`, {
    method: "DELETE",
    ...json({ revision: createdBody.revision ?? 1 }),
  });
  equal(removed.response.status, 204);
  equal(harness.app.assetGcScheduler.runOnce(far)?.collected.length, 0);
  ok(existsSync(originalPath), "a record in the recycle bin still owns its photo");
});

test("a photo a kept snapshot still shows is not orphaned, and loses that protection when the snapshot goes", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-gc-snap-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const upload = await request(harness.base, "/api/assets/uploads?name=只在快照里.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const asset = upload.body as { id: string; storageRefs: Array<{ sourceRef: string }> };
  const originalPath = join(assetRoot, ...((asset.storageRefs[0]?.sourceRef ?? "").split("/")));

  const created = await request(harness.base, "/api/records", {
    method: "POST",
    ...json({ kind: "journal", content: "这张图只在快照里还画得出来", assetRefs: [{ assetId: asset.id, role: "photo" }] }),
  });
  equal(created.response.status, 201);
  const createdBody = created.body as { id: string; revision?: number };

  // The snapshot is taken while the entry still pointed at the picture.
  const snapshot = await request(harness.base, "/api/backup/local", { method: "POST", ...json({}) });
  equal(snapshot.response.status, 201);
  const fileName = String((snapshot.body as { location?: string }).location ?? "").match(/lifeos-\d{8}-\d{6}-[0-9a-f]{8}\.sqlite$/)?.[0];
  ok(fileName !== undefined, "a local backup has to carry a time-machine-readable name");
  const snapshotPath = join(harness.root, "backups", fileName ?? "");
  ok(existsSync(snapshotPath), "the snapshot has to be on disk for this test to mean anything");

  // Then the picture leaves the *timeline*: the entry stays, its photo does not.
  const edited = await request(harness.base, `/api/records/${encodeURIComponent(createdBody.id)}`, {
    method: "PATCH",
    ...json({ revision: createdBody.revision ?? 1, assetRefs: [] }),
  });
  equal(edited.response.status, 200);

  const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  // Nothing live references it any more -- but the snapshot still draws it. The
  // collector's old rule ("no record points at it") would have eaten the picture
  // and left the time machine showing an empty frame.
  equal(harness.app.assetGcScheduler.runOnce(far)?.collected.length, 0);
  ok(existsSync(originalPath), "a photo a kept snapshot still shows must not be collected");

  // Take the snapshot off the shelf the way retention does, and the very same pass
  // collects it: what protected the file was the snapshot, nothing about the asset.
  const run = harness.app.repository.listAllBackupRuns().find((entry) => entry.fileName === fileName || entry.location === snapshotPath);
  ok(run !== undefined, "the snapshot run has to be on record");
  harness.app.repository.markBackupRunPruned(run?.id ?? 0, new Date().toISOString(), join(harness.root, "backups", "_trash", fileName ?? ""));
  deepEqual(harness.app.assetGcScheduler.runOnce(far)?.collected, [asset.id]);
  equal(existsSync(originalPath), false);
});

test("a collected file is put back by its content hash when the remembered path no longer holds it", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-restore-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const upload = await request(harness.base, "/api/assets/uploads?name=要捞回来的.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const asset = upload.body as { id: string; storageRefs: Array<{ sourceRef: string }> };
  const relative = asset.storageRefs[0]?.sourceRef ?? "";
  const originalPath = join(assetRoot, ...relative.split("/"));
  // The stored name really is the content's own address; the restore below rests on it.
  equal(basename(relative), `${createHash("sha256").update(TINY_PNG).digest("hex")}.png`);

  deepEqual(harness.app.assetGcScheduler.runOnce(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))?.collected, [asset.id]);
  const trashedPath = join(assetRoot, ...(trashPathFor(relative) ?? "").split("/"));
  ok(existsSync(trashedPath), "the collected file has to be waiting in the trash");
  equal(existsSync(originalPath), false);

  // Now the memory is wrong: the file sits a level deeper than the row remembers,
  // which is exactly what a path-only restore cannot survive.
  const movedAside = join(dirname(trashedPath), "moved-aside", basename(relative));
  mkdirSync(dirname(movedAside), { recursive: true });
  renameSync(trashedPath, movedAside);
  equal(existsSync(trashedPath), false);

  const restored = await request(harness.base, `/api/assets/trash/${encodeURIComponent(asset.id)}/restore`, { method: "POST" });
  equal(restored.response.status, 204);
  ok(existsSync(originalPath), "the bytes have to come back to the path the row names");
  equal(existsSync(movedAside), false);
  const content = await fetch(`${harness.base}/api/assets/${encodeURIComponent(asset.id)}/content`);
  equal(content.status, 200);
  equal((await content.arrayBuffer()).byteLength, TINY_PNG.length);
});

test("a collected file whose bytes are gone is not pretended back, and never taken from a live photo", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-restore-gone-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const upload = await request(harness.base, "/api/assets/uploads?name=先被收走的.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const asset = upload.body as { id: string; storageRefs: Array<Record<string, unknown>> };
  const september = String(asset.storageRefs[0]?.["sourceRef"] ?? "");
  const digest = createHash("sha256").update(TINY_PNG).digest("hex");
  equal(basename(september), `${digest}.png`);

  // This test cannot wait until January, so the photo is aged by hand: its row is
  // told the file arrived in January and the file is moved to match. Being collected
  // from an older month is exactly what makes the row's memory stale later on.
  const january = `uploads/2026/01/${basename(september)}`;
  mkdirSync(dirname(join(assetRoot, ...january.split("/"))), { recursive: true });
  renameSync(join(assetRoot, ...september.split("/")), join(assetRoot, ...january.split("/")));
  const patched = await request(harness.base, `/api/assets/${encodeURIComponent(asset.id)}`, {
    method: "PATCH",
    ...json({ storageRefs: [{ ...asset.storageRefs[0], sourceRef: january }] }),
  });
  equal(patched.response.status, 200);

  deepEqual(harness.app.assetGcScheduler.runOnce(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))?.collected, [asset.id]);
  // The bytes are lost -- and the panel would still list the entry, so a restore that
  // answered 204 here would hand back a row pointing at nothing.
  rmSync(join(assetRoot, ...(trashPathFor(january) ?? "").split("/")), { force: true });

  // Meanwhile the same picture was uploaded again this month, so a live photo owns
  // those bytes at a *different* content-addressed path -- the very file a hash
  // search turns up first. Taking it is the mistake this guard exists to prevent.
  const again = await request(harness.base, "/api/assets/uploads?name=重新上传同一张.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(again.response.status, 201);
  const live = again.body as { id: string; storageRefs: Array<{ sourceRef: string }> };
  ok(live.id !== asset.id, "a re-upload must not revive the collected row");
  const livePath = join(assetRoot, ...((live.storageRefs[0]?.sourceRef ?? "").split("/")));
  ok(livePath !== join(assetRoot, ...january.split("/")), "the live copy has to live somewhere else");
  ok(existsSync(livePath), "the re-upload has to own that path now");

  const restored = await request(harness.base, `/api/assets/trash/${encodeURIComponent(asset.id)}/restore`, { method: "POST" });
  equal(restored.response.status, 404);
  const panel = await request(harness.base, "/api/assets/trash", { method: "GET" });
  const body = panel.body as { trashed: Array<{ asset: { id: string } }> };
  equal(body.trashed.some((entry) => entry.asset.id === asset.id), true, "an entry with no bytes stays on the list");
  // The control: a file *does* carry that content-addressed name on disk, so the 404
  // above can only come from the live-reference guard -- not from an empty search.
  equal(basename(livePath), `${digest}.png`);
  ok(existsSync(livePath), "the live photo keeps its file");
  equal((await fetch(`${harness.base}/api/assets/${encodeURIComponent(live.id)}/content`)).status, 200);
});

test("deleting an asset parks its file in the orphan trash instead of leaving it behind", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-delete-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const upload = await request(harness.base, "/api/assets/uploads?name=bye.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  const asset = upload.body as { id: string; storageRefs: Array<{ sourceRef: string }> };
  const sourceRef = asset.storageRefs[0]?.sourceRef ?? "";
  const originalPath = join(assetRoot, ...sourceRef.split("/"));
  const trashedPath = join(assetRoot, "uploads", "_orphan-trash", ...sourceRef.split("/").slice(1));

  const removed = await request(harness.base, `/api/assets/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
  equal(removed.response.status, 204);
  equal(existsSync(originalPath), false, "the file must not stay where the asset was");
  ok(existsSync(trashedPath), "the file belongs in the trash, not deleted outright");

  const view = await request(harness.base, "/api/assets/trash", { method: "GET" });
  const viewBody = view.body as { trashed: Array<{ asset: { id: string }; origin: string }> };
  equal(viewBody.trashed.length, 1);
  equal(viewBody.trashed[0]?.origin, "asset-delete");

  // Emptying the trash is the only step that really deletes.
  const purged = await request(harness.base, `/api/assets/trash/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
  equal(purged.response.status, 204);
  equal(existsSync(trashedPath), false, "emptying the trash deletes the file for good");
  const emptied = await request(harness.base, "/api/assets/trash", { method: "GET" });
  equal((emptied.body as { trashed: unknown[] }).trashed.length, 0);
});

test("the collector never touches a photo the owner put into the asset root by hand", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-foreign-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  writeFileSync(join(assetRoot, "holiday.jpg"), TINY_PNG);
  const registered = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ kind: "photo", originalName: "holiday.jpg", storageRefs: [{ sourceId: "local", sourceRef: "holiday.jpg" }] }),
  });
  equal(registered.response.status, 201);

  equal(harness.app.assetGcScheduler.runOnce(new Date(Date.now() + 400 * 24 * 60 * 60 * 1000))?.collected.length, 0);
  ok(existsSync(join(assetRoot, "holiday.jpg")), "a photo from the owner's own folder is not ours to collect");
  equal((await fetch(`${harness.base}/api/assets/${encodeURIComponent((registered.body as { id: string }).id)}/content`)).status, 200);
});

test("an uploaded photo carries a server-computed sha256, and resolve hands the same asset back", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-hash-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot);
  t.after(async () => harness.stop());

  const expectedHash = createHash("sha256").update(TINY_PNG).digest("hex");

  const upload = await request(harness.base, "/api/assets/uploads?name=%E7%A7%92%E4%BC%A0.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const asset = upload.body as {
    id: string;
    lastUsedAt?: { value: string };
    storageRefs: Array<{ sourceRef: string; contentHash?: { algorithm: string; value: string } }>;
  };
  // The bytes actually received decide the hash; the client never gets a vote.
  equal(asset.storageRefs[0]?.contentHash?.algorithm, "sha256");
  equal(asset.storageRefs[0]?.contentHash?.value, expectedHash);
  equal(asset.lastUsedAt, undefined, "a plain upload has not been reused yet");

  // Nothing is known yet, and a miss is a normal answer rather than a failure.
  const miss = await request(harness.base, "/api/assets/resolve", {
    method: "POST",
    ...json({ algorithm: "sha256", value: "0".repeat(64) }),
  });
  equal(miss.response.status, 200);
  deepEqual(miss.body, { matched: false });

  // The second drop of the same photo is answered without storing it twice.
  const hit = await request(harness.base, "/api/assets/resolve", {
    method: "POST",
    ...json({ algorithm: "sha256", value: expectedHash }),
  });
  equal(hit.response.status, 200);
  const hitBody = hit.body as { matched: boolean; asset?: { id: string; lastUsedAt?: { value: string } } };
  equal(hitBody.matched, true);
  equal(hitBody.asset?.id, asset.id);
  ok(hitBody.asset?.lastUsedAt !== undefined, "a reuse is stamped so the grace period can move");

  // One asset, one file on disk: the bytes were never written a second time.
  const library = await request(harness.base, "/api/assets", { method: "GET" });
  const libraryBody = library.body as { items: Array<{ id: string; storageRefs: Array<{ sourceRef: string }> }> };
  equal(libraryBody.items.length, 1);
  equal(libraryBody.items[0]?.id, asset.id);
  equal(libraryBody.items[0]?.storageRefs.length, 1);
  const singleRef = libraryBody.items[0]?.storageRefs[0]?.sourceRef ?? "";
  ok(existsSync(join(assetRoot, ...singleRef.split("/"))), "the single file should still be there");

  // A digest that is not sha256, or not a digest at all, is a client bug.
  const badAlgorithm = await request(harness.base, "/api/assets/resolve", {
    method: "POST",
    ...json({ algorithm: "md5", value: expectedHash }),
  });
  equal(badAlgorithm.response.status, 400);
  const badValue = await request(harness.base, "/api/assets/resolve", {
    method: "POST",
    ...json({ algorithm: "sha256", value: "NOT A DIGEST" }),
  });
  equal(badValue.response.status, 400);
  equal((badValue.body as { error: string }).error, "invalid_hash");
});

test("the upload route reuses what the library holds instead of writing a second file", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-upload-reuse-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot);
  t.after(async () => harness.stop());

  // The bytes on disk are the invariant that matters. The composer asks /resolve
  // before it spends the bandwidth, but that is a courtesy and not a guard: a
  // script, a second tab, or a resolve that missed all arrive at this route with
  // bytes the library already holds.
  const filesUnder = () => {
    let count = 0;
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else count += 1;
      }
    };
    walk(assetRoot);
    return count;
  };
  const library = async () => ((await request(harness.base, "/api/assets", { method: "GET" })).body as {
    items: Array<{ id: string; lastUsedAt?: { value: string }; storageRefs: Array<{ sourceRef: string }> }>;
  }).items;
  const upload = (name: string, bytes: Buffer) => request(harness.base, `/api/assets/uploads?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(bytes),
  });

  const first = await upload("first.png", TINY_PNG);
  equal(first.response.status, 201);
  const firstAsset = first.body as { id: string; lastUsedAt?: { value: string }; storageRefs: Array<{ sourceRef: string }> };
  equal(firstAsset.lastUsedAt, undefined, "a first upload has nothing to reuse");
  equal(filesUnder(), 1, "the first upload writes one file");

  // The same bytes under a different name: one asset, one file, and the server
  // says so itself by stamping lastUsedAt.
  const again = await upload("second.png", TINY_PNG);
  equal(again.response.status, 201, "a reuse answers exactly like any other upload, so callers need no second branch");
  const againAsset = again.body as { id: string; lastUsedAt?: { value: string }; storageRefs: Array<{ sourceRef: string }> };
  equal(againAsset.id, firstAsset.id, "the second upload hands back the asset that already exists");
  ok(againAsset.lastUsedAt !== undefined, "the server, not the client, is what moved the grace period");
  equal(againAsset.storageRefs[0]?.sourceRef, firstAsset.storageRefs[0]?.sourceRef);
  equal(filesUnder(), 1, "the bytes were never written a second time");
  equal((await library()).length, 1);

  // A genuinely different photo still becomes its own asset, so a stuck
  // "always reuse" could not pass the assertions above on its own.
  const otherBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 47, g: 158, b: 107 } } }).png().toBuffer();
  ok(!otherBytes.equals(TINY_PNG), "the control photo has to differ from the fixture");
  const other = await upload("other.png", otherBytes);
  equal(other.response.status, 201);
  ok((other.body as { id: string }).id !== firstAsset.id, "different bytes are a different asset");
  equal(filesUnder(), 2);
  equal((await library()).length, 2);

  // Reuse happens between LIVE assets only. Removing one must not make a later
  // upload of those bytes quietly put it back.
  equal((await request(harness.base, `/api/assets/${encodeURIComponent(firstAsset.id)}`, { method: "DELETE" })).response.status, 204);
  const afterDelete = await upload("after-delete.png", TINY_PNG);
  equal(afterDelete.response.status, 201);
  ok((afterDelete.body as { id: string }).id !== firstAsset.id, "a removed photo must not come back through an upload");
});

test("reusing an upload restarts its orphan grace period instead of letting it be collected", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-reuse-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const hash = createHash("sha256").update(TINY_PNG).digest("hex");
  const upload = await request(harness.base, "/api/assets/uploads?name=old.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const assetId = (upload.body as { id: string }).id;

  // Move the upload eight days into the past: it is now due for collection.
  const stored = harness.app.repository.findAssetById(assetId)!;
  harness.app.repository.updateAsset({
    ...stored,
    createdAt: createInstant(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()),
  });

  const due = await request(harness.base, "/api/assets/trash", { method: "GET" });
  const dueBody = due.body as { pending: Array<{ asset: { id: string }; overdue: boolean; daysRemaining: number }> };
  equal(dueBody.pending.length, 1);
  equal(dueBody.pending[0]?.overdue, true);
  equal(dueBody.pending[0]?.daysRemaining, 0);

  // Dropping the same photo again counts as a fresh use, so the timer restarts.
  const hit = await request(harness.base, "/api/assets/resolve", {
    method: "POST",
    ...json({ algorithm: "sha256", value: hash }),
  });
  equal((hit.body as { matched: boolean }).matched, true);

  const safe = await request(harness.base, "/api/assets/trash", { method: "GET" });
  const safeBody = safe.body as { pending: Array<{ asset: { id: string }; overdue: boolean; daysRemaining: number }> };
  equal(safeBody.pending.length, 1);
  equal(safeBody.pending[0]?.overdue, false);
  equal(safeBody.pending[0]?.daysRemaining, 7);
  equal(harness.app.assetGcScheduler.runOnce(new Date())?.collected.length, 0);

  // A reprieve is a full window, not immortality.
  deepEqual(harness.app.assetGcScheduler.runOnce(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))?.collected, [assetId]);
});

test("a collected photo is invisible to resolve, and comes back only once restored", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-asset-trash-hash-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot, 25 * 1024 * 1024, 7, 30);
  t.after(async () => harness.stop());

  const hash = createHash("sha256").update(TINY_PNG).digest("hex");
  const upload = await request(harness.base, "/api/assets/uploads?name=bye-again.png", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(TINY_PNG),
  });
  equal(upload.response.status, 201);
  const assetId = (upload.body as { id: string }).id;

  const removed = await request(harness.base, `/api/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  equal(removed.response.status, 204);

  // The bytes are still on disk, but the asset left the register: a drag must
  // never quietly undo the owner's delete.
  const afterDelete = await request(harness.base, "/api/assets/resolve", {
    method: "POST",
    ...json({ algorithm: "sha256", value: hash }),
  });
  deepEqual(afterDelete.body, { matched: false });

  const restored = await request(harness.base, `/api/assets/trash/${encodeURIComponent(assetId)}/restore`, { method: "POST" });
  equal(restored.response.status, 204);
  const afterRestore = await request(harness.base, "/api/assets/resolve", {
    method: "POST",
    ...json({ algorithm: "sha256", value: hash }),
  });
  const restoredBody = afterRestore.body as { matched: boolean; asset?: { id: string } };
  equal(restoredBody.matched, true);
  equal(restoredBody.asset?.id, assetId);
});

/**
 * A real photo to derive from, built with sharp so the suite needs no binary fixture.
 * 1600x1200 in two flat halves: the assertions are about the thumbnail's dimensions and
 * identity, and a 1x1 PNG could not tell a resize from a passthrough.
 */
async function photoJpeg(orientation?: number): Promise<Buffer> {
  const pipeline = sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 47, g: 111, b: 143 } } })
    .composite([{ input: { create: { width: 800, height: 1200, channels: 3, background: { r: 240, g: 192, b: 96 } } }, left: 0, top: 0 }]);
  return (orientation === undefined ? pipeline : pipeline.withMetadata({ orientation })).jpeg({ quality: 92 }).toBuffer();
}

async function sizeOf(bytes: Buffer): Promise<{ readonly width: number | undefined; readonly height: number | undefined; readonly format: string | undefined }> {
  const meta = await sharp(bytes).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

test("a thumbnail is derived once, filed under the data directory, and rebuilt after being cleared", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-thumbs-root-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot);
  t.after(async () => harness.stop());

  const original = await photoJpeg();
  const upload = await request(harness.base, "/api/assets/uploads?name=hill.jpg", {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(original),
  });
  equal(upload.response.status, 201);
  const assetId = (upload.body as { id: string }).id;
  const thumbPath = (width: number) => `/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=${width}`;
  const thumbsDirectory = join(harness.root, "derived", "thumbs");

  const first = await fetch(`${harness.base}${thumbPath(400)}`);
  equal(first.status, 200);
  equal(first.headers.get("content-type"), "image/webp");
  const firstBytes = Buffer.from(await first.arrayBuffer());
  const firstSize = await sizeOf(firstBytes);
  equal(firstSize.format, "webp");
  equal(firstSize.width, 400);
  equal(firstSize.height, 300, "the aspect ratio of the original has to survive");
  ok(firstBytes.length < original.length, `a 400px thumbnail (${firstBytes.length}B) must be smaller than the original (${original.length}B)`);
  equal(readdirSync(thumbsDirectory).length, 1);

  // Asking twice must not encode twice: the file on disk is the answer.
  const second = await fetch(`${harness.base}${thumbPath(400)}`);
  equal(second.status, 200);
  ok(Buffer.from(await second.arrayBuffer()).equals(firstBytes), "the second request is served from the derived file, byte for byte");
  equal(readdirSync(thumbsDirectory).length, 1);

  // The other width is a second file, not a rescale of the first.
  const wide = await fetch(`${harness.base}${thumbPath(1200)}`);
  equal(wide.status, 200);
  equal((await sizeOf(Buffer.from(await wide.arrayBuffer()))).width, 1200);
  equal(readdirSync(thumbsDirectory).length, 2);

  // Widths outside the pair are refused rather than rounded: a stray value would
  // otherwise fill the cache with a size nothing will ever request again.
  const stray = await request(harness.base, thumbPath(500));
  equal(stray.response.status, 400);
  equal((stray.body as { error: string }).error, "unsupported_thumbnail_width");

  // The cache lives beside the database, never inside the owner's photo library.
  ok(!existsSync(join(assetRoot, "derived")), "the asset root is the owner's library, not a cache directory");

  const stats = await request(harness.base, "/api/assets/thumbnails");
  equal(stats.response.status, 200);
  const statsBody = stats.body as { count: number; bytes: number; widths: number[]; directory: string };
  equal(statsBody.count, 2);
  equal(statsBody.widths.join(","), "400,1200");
  equal(statsBody.directory, thumbsDirectory);
  ok(statsBody.bytes > 0, "the reported size must come from the files, not from a guess");

  // Clearing is a supported operation, not a repair: it must leave anything that is
  // not ours alone, and the next request must rebuild what it needs.
  writeFileSync(join(thumbsDirectory, "keep.txt"), "not ours");
  const cleared = await request(harness.base, "/api/assets/thumbnails", { method: "DELETE" });
  equal(cleared.response.status, 200);
  const clearedBody = cleared.body as { removed: number; freedBytes: number };
  equal(clearedBody.removed, 2);
  equal(clearedBody.freedBytes, statsBody.bytes);
  deepEqual(readdirSync(thumbsDirectory), ["keep.txt"]);

  const rebuilt = await fetch(`${harness.base}${thumbPath(400)}`);
  equal(rebuilt.status, 200);
  equal((await sizeOf(Buffer.from(await rebuilt.arrayBuffer()))).width, 400);
  const afterRebuild = await request(harness.base, "/api/assets/thumbnails");
  equal((afterRebuild.body as { count: number }).count, 1, "only the width that was actually asked for came back");
});

test("a thumbnail is rotated upright from EXIF, and an audio original is refused", async (t) => {
  const assetRoot = mkdtempSync(join(tmpdir(), "lifeos-thumbs-exif-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  const harness = await startHarness(undefined, 1024 * 1024, undefined, assetRoot);
  t.after(async () => harness.stop());

  // Orientation 6 means "stored landscape, display rotated a quarter turn". The
  // browser paints the original upright, so a thumbnail that skipped `.rotate()` would
  // come out sideways beside it — and 400x533 instead of 400x300 is how that shows.
  const upload = await request(harness.base, "/api/assets/uploads?name=sideways.jpg", {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: new Uint8Array(await photoJpeg(6)),
  });
  equal(upload.response.status, 201);
  const assetId = (upload.body as { id: string }).id;
  const thumbnail = await fetch(`${harness.base}/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=400`);
  equal(thumbnail.status, 200);
  const size = await sizeOf(Buffer.from(await thumbnail.arrayBuffer()));
  equal(size.width, 400);
  equal(size.height, 533, "the thumbnail has to be portrait, the way the original displays");

  // sharp cannot decode audio, so the route has to refuse before it gets there.
  writeFileSync(join(assetRoot, "voice.mp3"), Buffer.from([0x49, 0x44, 0x33, 0x03]));
  const registered = await request(harness.base, "/api/assets", {
    method: "POST",
    ...json({ kind: "audio", originalName: "voice.mp3", storageRefs: [{ sourceId: "local", sourceRef: "voice.mp3" }] }),
  });
  equal(registered.response.status, 201);
  const audioId = (registered.body as { id: string }).id;
  const refused = await request(harness.base, `/api/assets/${encodeURIComponent(audioId)}/thumbnail?w=400`);
  equal(refused.response.status, 415);
  equal((refused.body as { error: string }).error, "unsupported_thumbnail_type");
});

test("the time machine reads a snapshot without touching it and sorts the drift three ways", async (t) => {
  type Reading = {
    fileName: string;
    source: string;
    counts: { records: number; recordsTrashed: number; people: number };
    diff: {
      gone: { total: number; samples: Array<{ id: string; preview: string; isPrivate: boolean; restorable?: boolean }> };
      changed: { total: number; samples: Array<{ id: string; revisions?: { then: number; now: number } }> };
      added: { total: number; samples: Array<{ id: string; preview: string }> };
      unchanged: number;
      trashedInSnapshot: number;
    };
  };

  const harness = await startHarness();
  t.after(async () => harness.stop());

  const create = async (payload: Record<string, unknown>): Promise<{ id: string; revision: number }> => {
    const created = await request(harness.base, "/api/records", { method: "POST", ...json(payload) });
    equal(created.response.status, 201);
    return created.body as { id: string; revision: number };
  };
  // Every snapshot below has to be addressed by the name the route accepts, so the
  // extraction doubles as a check that local backups are named the way the time
  // machine expects.
  const fileNameOf = (body: unknown): string => {
    const fileName = String((body as { location: string }).location).match(/lifeos-\d{8}-\d{6}-[0-9a-f]{8}\.sqlite$/)?.[0];
    ok(fileName !== undefined, "a local backup must carry a time-machine-readable name");
    return fileName;
  };

  const edited = await create({ kind: "journal", content: "会被改的那条", occurredAt: { kind: "date", value: "2026-09-10" } });
  const trashed = await create({ kind: "journal", content: "会被删的那条", occurredAt: { kind: "date", value: "2026-09-11" } });
  await create({ kind: "note", content: "一直没动的那条", occurredAt: { kind: "date", value: "2026-09-12" } });
  const hidden = await create({ kind: "journal", content: "私密的那条", isPrivate: true, occurredAt: { kind: "date", value: "2026-09-13" } });

  const snapshot = await request(harness.base, "/api/backup/local", { method: "POST", ...json({}) });
  equal(snapshot.response.status, 201);
  const fileName = fileNameOf(snapshot.body);
  const snapshotPath = join(harness.root, "backups", fileName);
  const bytesBefore = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");

  // Drift since the snapshot: one edit, two recycle-bin moves, one new record, one
  // record left alone.
  const editResponse = await request(harness.base, `/api/records/${encodeURIComponent(edited.id)}`, {
    method: "PATCH",
    ...json({ revision: edited.revision, content: "改过之后的内容" }),
  });
  equal(editResponse.response.status, 200);
  const trashResponse = await request(harness.base, `/api/records/${encodeURIComponent(trashed.id)}`, {
    method: "DELETE",
    ...json({ revision: trashed.revision }),
  });
  equal(trashResponse.response.status, 204);
  const hideResponse = await request(harness.base, `/api/records/${encodeURIComponent(hidden.id)}`, {
    method: "DELETE",
    ...json({ revision: hidden.revision }),
  });
  equal(hideResponse.response.status, 204);
  await create({ kind: "journal", content: "备份之后才写的", occurredAt: { kind: "date", value: "2026-09-14" } });

  const reading = await request(harness.base, `/api/backup/snapshot?fileName=${encodeURIComponent(fileName)}`);
  equal(reading.response.status, 200);
  const body = reading.body as Reading;

  equal(body.fileName, fileName);
  equal(body.source, "local");
  equal(body.counts.records, 4);
  equal(body.counts.recordsTrashed, 0);
  equal(body.counts.people, 0);
  equal(body.diff.gone.total, 2);
  equal(body.diff.changed.total, 1);
  equal(body.diff.added.total, 1);
  equal(body.diff.unchanged, 1);
  equal(body.diff.trashedInSnapshot, 0);

  const goneTrashed = body.diff.gone.samples.find((sample) => sample.id === trashed.id);
  equal(goneTrashed?.restorable, true, "a record waiting in the recycle bin can still be brought back");
  const gonePrivate = body.diff.gone.samples.find((sample) => sample.id === hidden.id);
  equal(gonePrivate?.isPrivate, true);
  equal(gonePrivate?.preview, "", "the diff must not become a way around the privacy mask");
  const changedSample = body.diff.changed.samples.find((sample) => sample.id === edited.id);
  deepEqual(changedSample?.revisions, { then: 1, now: 2 });
  equal(body.diff.added.samples.length, 1);

  // Read-only in the two ways that actually matter. Byte-identical afterwards, and
  // nothing new beside it: SQLite creates -wal/-shm sidecars wherever it opens a
  // file, which is precisely what reading a snapshot in place would have caused in
  // the owner's backup directory.
  equal(createHash("sha256").update(readFileSync(snapshotPath)).digest("hex"), bytesBefore);
  deepEqual(readdirSync(join(harness.root, "backups")).filter((name) => name.endsWith("-wal") || name.endsWith("-shm")), []);
  deepEqual(readdirSync(join(harness.root, "derived", "snapshots")), [], "the scratch copy has to be cleaned up again");

  // A record that was already in the recycle bin when the snapshot was taken lands
  // in no bucket: reporting it as "gone" would describe a loss that had happened
  // before the moment being read.
  const secondSnapshot = await request(harness.base, "/api/backup/local", { method: "POST", ...json({}) });
  equal(secondSnapshot.response.status, 201);
  const secondReading = await request(harness.base, `/api/backup/snapshot?fileName=${encodeURIComponent(fileNameOf(secondSnapshot.body))}`);
  equal(secondReading.response.status, 200);
  const second = secondReading.body as Reading;
  equal(second.counts.records, 3);
  equal(second.counts.recordsTrashed, 2);
  equal(second.diff.trashedInSnapshot, 2);
  equal(second.diff.gone.total, 0);
  equal(second.diff.changed.total, 0);
  equal(second.diff.unchanged, 3);

  // A name that is not a backup name never reaches the filesystem, and a point that
  // exists nowhere is a 404 rather than a server error.
  const traversal = await request(harness.base, "/api/backup/snapshot?fileName=..%2F..%2Flifeos.sqlite");
  equal(traversal.response.status, 400);
  equal((traversal.body as { error: string }).error, "invalid_snapshot_name");
  const unnamed = await request(harness.base, "/api/backup/snapshot");
  equal(unnamed.response.status, 400);
  equal((unnamed.body as { error: string }).error, "invalid_snapshot_name");
  const absent = await request(harness.base, "/api/backup/snapshot?fileName=lifeos-20200101-000000-deadbeef.sqlite");
  equal(absent.response.status, 404);
  equal((absent.body as { error: string }).error, "snapshot_missing");
});
