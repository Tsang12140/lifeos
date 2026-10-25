import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TimelineRecord } from "@lifeos/core";
import { createInstant } from "@lifeos/core";
import { readConfig } from "../src/config.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { JournalMemoryIndexer, journalChunks, nextJournalMemorySweep } from "../src/journal-memory.js";
import { embedJournalTexts, embeddingIdentity, normalizedVector, readJournalEmbeddingConfig } from "../src/journal-embedding.js";
import { journalDateRange, journalSourceOffers, retrieveJournals, wantsJournalMemory } from "../src/journal-retrieval.js";
import { chatBackfill } from "../src/assistant-conversation.js";
import { tenantConfigFor } from "../src/tenant-config.js";
import { spaceFingerprint } from "../src/portable-space.js";

function record(id: string, text: string, date = "2026-09-01", extra: Partial<TimelineRecord> = {}): TimelineRecord {
  return { id, kind: "journal", body: { original: text }, createdAt: { kind: "instant", value: "2026-10-01T00:00:00Z" }, occurredAt: { kind: "date", value: date }, entityRefs: [], relatedRecordIds: [], assetRefs: [], aiDerived: [], ...extra } as TimelineRecord;
}
function fixture(t: import("node:test").TestContext, embedding = true) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-journal-memory-")), path = join(root, "lifeos.sqlite");
  const config = readConfig({ LIFEOS_DATA_DIR: root, ...(embedding ? { DASHSCOPE_API_KEY: "fake-vector-key", LIFEOS_EMBEDDING_BASE_URL: "https://embedding.invalid/v1", LIFEOS_EMBEDDING_DIMENSIONS: "64" } : {}) });
  const repository = new SqliteRecordRepository(path), indexer = new JournalMemoryIndexer(config, repository);
  t.after(() => { indexer.stop(); repository.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, path, config, repository, indexer };
}
function provider(t: import("node:test").TestContext, handle?: (texts: string[], init?: RequestInit) => Promise<Response> | Response) {
  const original = globalThis.fetch, calls: string[][] = [];
  globalThis.fetch = (async (input, init) => {
    if (!String(input).startsWith("https://embedding.invalid/")) return original(input, init);
    const texts = (JSON.parse(String(init?.body)) as { input: string[] }).input; calls.push(texts);
    if (handle) return handle(texts, init);
    return response(texts);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
function response(texts: string[]): Response {
  return Response.json({ data: texts.map((text, index) => ({ index, embedding: [/(?:旅行|旅途|出游|扫兴)/.test(text) ? 1 : 0, /(?:旅行|旅途|出游|扫兴)/.test(text) ? 0 : 1, ...Array(62).fill(0)] })).reverse(), usage: { total_tokens: texts.length * 5 } });
}

function clock(t: import("node:test").TestContext, now = "2026-10-16T10:00:00+08:00") {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: new Date(now) });
  return async (milliseconds: number) => {
    t.mock.timers.tick(milliseconds);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
}

test("nightly sweep stays at Beijing 03:00 across month and year boundaries", () => {
  for (const [now, expected] of [
    ["2026-10-16T02:59:59+08:00", "2026-10-16T03:00:00+08:00"],
    ["2026-10-16T03:00:00+08:00", "2026-10-17T03:00:00+08:00"],
    ["2026-12-31T23:30:00+08:00", "2027-01-01T03:00:00+08:00"],
    ["2028-02-29T04:00:00+08:00", "2028-03-01T03:00:00+08:00"],
  ]) assert.equal(nextJournalMemorySweep(Date.parse(now!)), Date.parse(expected!));
});

test("saves wait thirty seconds and repeated edits restart the grace period", async t => {
  const f = fixture(t), calls = provider(t), advance = clock(t);
  f.repository.insert(record("delayed", "最初正文")); f.indexer.schedule();
  await advance(20_000);
  const current = f.repository.findById("delayed")!;
  f.repository.update({ ...current, body: { original: "最后保存的正文" } }, current.revision);
  f.indexer.schedule();
  await advance(29_999); assert.equal(calls.length, 0);
  await advance(1); assert.deepEqual(calls, [["最后保存的正文"]]);
});

test("idle service performs no daytime minute polling and sweeps once each night", async t => {
  const f = fixture(t), calls = provider(t), advance = clock(t);
  const lists = t.mock.method(f.repository, "list");
  f.repository.insert(record("startup", "启动补漏")); f.indexer.start();
  await advance(29_999); assert.equal(calls.length, 0);
  await advance(1); assert.equal(calls.length, 1);
  const listCount = lists.mock.callCount();
  f.repository.insert(record("missed", "遗漏的更新")); // Deliberately bypass HTTP/save scheduling.
  for (let step = 0; step < 4; step++) await advance(30_000);
  assert.equal(lists.mock.callCount(), listCount);
  const due = Date.parse("2026-10-17T03:00:00+08:00");
  await advance(due - Date.now() - 1);
  assert.equal(calls.length, 1); assert.equal(lists.mock.callCount(), listCount);
  await advance(1); assert.equal(calls.length, 2); assert.deepEqual(calls[1], ["遗漏的更新"]);
  f.repository.insert(record("tomorrow", "次日晚间补漏"));
  await advance(86_400_000 - 1); assert.equal(calls.length, 2);
  await advance(1); assert.equal(calls.length, 3);
  f.indexer.stop(); f.repository.insert(record("stopped", "停止后不处理"));
  await advance(86_400_000); assert.equal(calls.length, 3);
});

test("sleeping through the nightly window does not trigger a daytime catch-up scan", async t => {
  const f = fixture(t), calls = provider(t), advance = clock(t);
  f.indexer.start(); await advance(30_000);
  const lists = t.mock.method(f.repository, "list");
  f.repository.insert(record("sleep", "等待下一次深夜"));
  t.mock.timers.setTime(Date.parse("2026-10-17T10:00:00+08:00"));
  await advance(0); assert.equal(calls.length, 0); assert.equal(lists.mock.callCount(), 0);
  await advance(Date.parse("2026-10-18T03:00:00+08:00") - Date.now());
  assert.deepEqual(calls, [["等待下一次深夜"]]);
});

test("large imports continue in small batches after one thirty-second grace period", async t => {
  const f = fixture(t), calls = provider(t), advance = clock(t);
  for (let i = 0; i < 23; i++) f.repository.insert(record(`batch-${i}`, "批量正文"));
  f.indexer.schedule(); await advance(30_000); assert.equal(calls.length, 1);
  await advance(500); assert.equal(calls.length, 2);
  await advance(500); assert.deepEqual(calls.map(batch => batch.length), [10, 10, 3]);
});

test("failed requests retry after backoff without relying on a minute poll or next night", async t => {
  const f = fixture(t); let attempts = 0;
  const calls = provider(t, texts => ++attempts === 1 ? new Response("unavailable", { status: 503 }) : response(texts));
  const advance = clock(t);
  f.repository.insert(record("retry", "失败后恢复")); f.indexer.schedule();
  await advance(30_000); assert.equal(calls.length, 1);
  await advance(59_999); assert.equal(calls.length, 1);
  await advance(1); assert.equal(calls.length, 2);
  assert.equal(f.repository.journalMemory.list(embeddingIdentity(f.config.journalEmbedding!)).length, 1);
});

test("an edit during an in-flight batch retains its own thirty-second grace period", async t => {
  const f = fixture(t); let release!: () => void, attempts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls = provider(t, async texts => { if (++attempts === 1) await gate; return response(texts); });
  const advance = clock(t);
  f.repository.insert(record("during", "请求中的旧正文")); f.indexer.schedule();
  await advance(30_000); assert.equal(calls.length, 1);
  await advance(5_000);
  const current = f.repository.findById("during")!;
  f.repository.update({ ...current, body: { original: "请求期间修改的正文" } }, current.revision); f.indexer.schedule();
  await advance(5_000); release(); await advance(0);
  assert.equal(f.repository.journalMemory.list(embeddingIdentity(f.config.journalEmbedding!)).length, 0);
  await advance(24_999); assert.equal(calls.length, 1);
  await advance(1); assert.equal(calls.length, 2); assert.deepEqual(calls[1], ["请求期间修改的正文"]);
});

test("embedding config is opt-in, credentials stay server-side, identity includes endpoint/model/dimensions", () => {
  assert.equal(readJournalEmbeddingConfig({}), undefined);
  assert.equal(readJournalEmbeddingConfig({ DASHSCOPE_API_KEY: "key", LIFEOS_EMBEDDING_ENABLED: "false" }), undefined);
  const a = readJournalEmbeddingConfig({ DASHSCOPE_API_KEY: "key" })!;
  assert.equal(a.dimensions, 1024); assert.equal(a.model, "text-embedding-v4");
  assert.equal(embeddingIdentity(a), embeddingIdentity({ ...a, apiKey: "rotated" }));
  for (const changed of [{ ...a, model: "another" }, { ...a, dimensions: 512 }, { ...a, baseUrl: "https://another.invalid/v1" }]) assert.notEqual(embeddingIdentity(a), embeddingIdentity(changed));
  assert.throws(() => readJournalEmbeddingConfig({ DASHSCOPE_API_KEY: "key", LIFEOS_EMBEDDING_BASE_URL: "https://user:password@example.com" }));
  assert.throws(() => normalizedVector([NaN], 1)); assert.throws(() => normalizedVector([0], 1));
});

test("incremental index resumes from SQLite, metadata changes reuse vectors, long tails are covered", async t => {
  const f = fixture(t), calls = provider(t);
  f.repository.insert(record("long", "开头".repeat(900) + "蓝鹭灯塔在最后一段"));
  const chunks = journalChunks(f.repository.findById("long")!); assert(chunks.length >= 2);
  assert.equal(await f.indexer.runSlice(), chunks.length); assert.equal(calls.length, 1);
  assert.equal(await f.indexer.runSlice(), 0); assert.equal(calls.length, 1);
  let live = f.repository.findById("long")!;
  f.repository.update({ ...live, occurredAt: { kind: "date", value: "2025-06-12" } }, live.revision);
  assert.equal(await f.indexer.runSlice(), 0); assert.equal(calls.length, 1);
  const reopened = new SqliteRecordRepository(f.path);
  try { assert.equal(reopened.journalMemory.list(embeddingIdentity(f.config.journalEmbedding!)).length, chunks.length); } finally { reopened.close(); }
  const hits = await retrieveJournals(f.config, f.repository, "去年六月的日记里蓝鹭灯塔", "2026-10-16");
  assert.equal(hits.candidates[0]?.id, "long"); assert(hits.candidates[0]?.content.includes("蓝鹭灯塔"));
});

test("edits invalidate vectors immediately and rebuild only the changed text", async t => {
  const f = fixture(t), calls = provider(t);
  f.repository.insert(record("one", "普通正文")); await f.indexer.runSlice();
  const live = f.repository.findById("one")!;
  f.repository.update({ ...live, body: { original: "修改后的正文" } }, live.revision);
  assert.equal(f.repository.journalMemory.list(embeddingIdentity(f.config.journalEmbedding!)).length, 0);
  assert.equal(await f.indexer.runSlice(), 1); assert.equal(calls.length, 2);
});

test("private, demo, trashed and other record kinds never reach the embedding service", async t => {
  const f = fixture(t), calls = provider(t);
  f.repository.insert(record("readable", "公开原文")); f.repository.insert(record("private", "PRIVATE_SENTINEL", "2026-09-01", { isPrivate: true }));
  f.repository.insert(record("demo", "DEMO_SENTINEL", "2026-09-01", { isDemo: true }));
  f.repository.insert(record("event", "EVENT_SENTINEL", "2026-09-01", { kind: "event" }));
  f.repository.insert(record("trashed", "TRASH_SENTINEL")); f.repository.softDelete("trashed", 1, JSON.stringify(createInstant("2026-10-15T00:00:00Z")));
  await f.indexer.runSlice(); assert.deepEqual(calls, [["公开原文"]]);
  const current = f.repository.findById("readable")!;
  f.repository.update({ ...current, isPrivate: true }, current.revision);
  assert.equal(f.repository.journalMemory.list(embeddingIdentity(f.config.journalEmbedding!)).length, 0);
  const hits = await retrieveJournals(f.config, f.repository, "以前的公开原文日记", "2026-10-16"); assert.equal(hits.candidates.length, 0);
});

test("late responses after privacy change, deletion or shutdown cannot restore an index", async t => {
  for (const operation of ["private", "delete", "stop"] as const) {
    await t.test(operation, async child => {
    const f = fixture(child); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls = provider(child, async texts => { await gate; return response(texts); });
    f.repository.insert(record("race", "旧的公开正文")); const pending = f.indexer.runSlice();
    assert.equal(calls.length, 1);
    const current = f.repository.findById("race")!;
    if (operation === "private") f.repository.update({ ...current, isPrivate: true }, current.revision);
    if (operation === "delete") f.repository.softDelete("race", current.revision, JSON.stringify(createInstant("2026-10-15T00:00:00Z")));
    if (operation === "stop") f.indexer.stop();
    release(); assert.equal(await pending, 0);
    assert.equal(f.repository.journalMemory.list(embeddingIdentity(f.config.journalEmbedding!)).length, 0);
    });
  }
});

test("one indexing slice is limited to ten texts and a provider failure backs off", async t => {
  const f = fixture(t), calls = provider(t, () => new Response("raw upstream detail", { status: 429 }));
  for (let i = 0; i < 23; i++) f.repository.insert(record(`bounded-${i}`, "虚构正文"));
  assert.equal(await f.indexer.runSlice(), 0); assert.equal(calls[0]?.length, 10);
  assert.equal(await f.indexer.runSlice(), 0); assert.equal(calls.length, 1);
});

test("hybrid search reaches a semantically matching diary beyond the latest hundred and caches queries", async t => {
  const f = fixture(t), calls = provider(t);
  f.repository.insert(record("old-trip", "那次旅行的旅途令人失望", "2023-06-01"));
  for (let i = 0; i < 110; i++) f.repository.insert(record(`recent-${i}`, "普通的工作和休息", "2026-10-01"));
  for (let i = 0; i < 12; i++) await f.indexer.runSlice();
  const question = "以前哪次出游让我扫兴？";
  const result = await retrieveJournals(f.config, f.repository, question, "2026-10-16");
  assert.equal(result.mode, "hybrid"); assert.equal(result.candidates[0]?.id, "old-trip");
  assert(!result.candidates.some(hit => hit.id.startsWith("recent")));
  const before = calls.length; await retrieveJournals(f.config, f.repository, question, "2026-10-16"); assert.equal(calls.length, before);
});

test("Shanghai ranges handle leap years, prior month, week and a midnight instant", async t => {
  assert.deepEqual(journalDateRange("去年六月的旅行", "2026-10-16"), { from: "2025-06-01", to: "2025-06-30" });
  assert.deepEqual(journalDateRange("2024年二月", "2026-10-16"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(journalDateRange("上个月", "2026-01-03"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(journalDateRange("上周的日记", "2026-10-16"), { from: "2026-10-05", to: "2026-10-11" });
  const f = fixture(t, false);
  f.repository.insert(record("midnight", "午夜灯塔", "2026-01-01", { occurredAt: { kind: "instant", value: "2025-06-30T16:30:00Z" } }));
  const june = await retrieveJournals(f.config, f.repository, "2025年六月灯塔日记", "2026-10-16"); assert.equal(june.journalCount, 0);
  const july = await retrieveJournals(f.config, f.repository, "2025年七月灯塔日记", "2026-10-16"); assert.equal(july.candidates[0]?.id, "midnight");
});

test("no key and provider outages retain lexical search and honest no-result responses", async t => {
  const f = fixture(t, false);
  f.repository.insert(record("lexical", "走到了蓝鹭灯塔"));
  const hit = await retrieveJournals(f.config, f.repository, "找出蓝鹭灯塔的日记", "2026-10-16"); assert.equal(hit.mode, "lexical"); assert.equal(hit.candidates[0]?.id, "lexical");
  const result = await chatBackfill(f.config, f.repository, { message: "找出蓝鹭灯塔的日记？" }); assert(result.reply.includes("蓝鹭灯塔")); assert.equal(result.ui?.offers?.[0]?.command.type, "record.focus");
  const empty = await chatBackfill(f.config, f.repository, { message: "以前有黑曜星河的日记吗？" }); assert(empty.reply.includes("本次")); assert.equal(empty.ui, undefined);
  const online = fixture(t); provider(t, () => new Response("no", { status: 503 }));
  online.repository.insert(record("fallback", "蓝鹭灯塔"));
  const chunk = journalChunks(online.repository.findById("fallback")!)[0]!;
  online.repository.journalMemory.put("fallback", chunk.index, chunk.hash, embeddingIdentity(online.config.journalEmbedding!), [1, ...Array(63).fill(0)]);
  const fallback = await retrieveJournals(online.config, online.repository, "找出蓝鹭灯塔日记", "2026-10-16"); assert.equal(fallback.mode, "lexical"); assert.equal(fallback.candidates[0]?.id, "fallback");
});

test("journal counts are database counts, not top-k results", async t => {
  const f = fixture(t, false);
  for (let i = 0; i < 31; i++) f.repository.insert(record(`count-${i}`, "虚构的日记", "2025-06-01"));
  f.repository.insert(record("excluded", "私密", "2025-06-01", { isPrivate: true }));
  const answer = await chatBackfill(f.config, f.repository, { message: "去年六月一共有多少篇日记？" }); assert(answer.reply.includes("31 篇")); assert.equal(answer.mode, "rules");
});

test("source IDs must be retrieved, readable and unchanged; another card cannot see the index", async t => {
  const a = fixture(t, false), b = fixture(t, false);
  a.repository.insert(record("same-id", "蓝鹭灯塔")); b.repository.insert(record("same-id", "另一张卡的生活"));
  const hit = await retrieveJournals(a.config, a.repository, "以前蓝鹭灯塔的日记", "2026-10-16");
  assert.equal(journalSourceOffers(["same-id"], hit, a.repository)[0]?.label, "来源 1 2026-09-01");
  assert.throws(() => journalSourceOffers(["invented"], hit, a.repository));
  const other = await retrieveJournals(b.config, b.repository, "以前蓝鹭灯塔的日记", "2026-10-16"); assert.equal(other.candidates.length, 0);
  const live = a.repository.findById("same-id")!; a.repository.update({ ...live, isPrivate: true }, live.revision);
  assert.throws(() => journalSourceOffers(["same-id"], hit, a.repository));
});

test("malformed vectors and duplicate response indices are rejected without persisting partial data", async t => {
  const f = fixture(t);
  provider(t, () => Response.json({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }));
  await assert.rejects(embedJournalTexts(f.config.journalEmbedding!, ["一", "二"]));
  assert.equal(f.repository.journalMemory.list(embeddingIdentity(f.config.journalEmbedding!)).length, 0);
});

test("recall intent includes natural questions without the word journal", () => {
  for (const question of ["我上次去海边是什么时候？", "我以前看过什么电影？", "最近都做过什么？", "我哪天去的灯塔？"]) assert.equal(wantsJournalMemory(question), true, question);
  assert.equal(wantsJournalMemory("你好"), false);
});

test("tenant configs share only embedding credentials, never vectors or query cache", async t => {
  const f = fixture(t), calls = provider(t);
  const account = { id: "account", username: "test", displayName: "test", spaceName: "test", role: "member" as const, disabled: false };
  const one = tenantConfigFor(f.config, { ...account, tenantId: "11111111-1111-4111-8111-111111111111" }, "test-master");
  const two = tenantConfigFor(f.config, { ...account, tenantId: "22222222-2222-4222-8222-222222222222" }, "test-master");
  assert.equal(one.journalEmbedding?.apiKey, f.config.journalEmbedding?.apiKey);
  assert.notEqual(one.databasePath, two.databasePath);
  const a = new SqliteRecordRepository(one.databasePath), b = new SqliteRecordRepository(two.databasePath);
  const indexer = new JournalMemoryIndexer(one, a);
  try {
    a.insert(record("tenant-shared-id", "一次旅行")); b.insert(record("tenant-shared-id", "普通正文"));
    await indexer.runSlice(); const before = calls.length;
    const hit = await retrieveJournals(one, a, "以前的出游日记", "2026-10-16"); assert.equal(hit.candidates[0]?.id, "tenant-shared-id");
    const other = await retrieveJournals(two, b, "以前的出游日记", "2026-10-16"); assert.equal(other.candidates.length, 0);
    assert.equal(calls.length, before + 1); assert.equal(b.journalMemory.list(embeddingIdentity(two.journalEmbedding!)).length, 0);
  } finally { indexer.stop(); a.close(); b.close(); }
});

test("portable replacement cannot inherit vectors for the old record with the same ID", async t => {
  const target = fixture(t), source = fixture(t, false); provider(t);
  target.repository.insert(record("reused-id", "一次旅行")); source.repository.insert(record("reused-id", "替换后的正文"));
  await target.indexer.runSlice(); assert.equal(target.repository.journalMemory.list(embeddingIdentity(target.config.journalEmbedding!)).length, 1);
  target.repository.restorePortableSpace(source.repository.portableSpace(), spaceFingerprint(target.repository.portableSpace()));
  assert.equal(target.repository.journalMemory.list(embeddingIdentity(target.config.journalEmbedding!)).length, 0);
  assert.equal(target.repository.findById("reused-id")?.body.original, "替换后的正文");
});

test("model fabricated source IDs retain prose without guessed controls or regenerating the answer", async t => {
  const f = fixture(t, false), original = globalThis.fetch; let calls = 0;
  f.repository.insert(record("verified-source", "蓝鹭灯塔旁看海"));
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: "reply", reply: "在灯塔旁看海。[1]", sourceIds: [calls === 1 ? "invented-id" : "verified-source"] }) }, finish_reason: "stop" }] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const answer = await chatBackfill({ ...f.config, deepseekApiKey: "fake-chat-key", deepseekBaseUrl: "http://mock-ai.invalid" }, f.repository, { message: "找出蓝鹭灯塔的日记？" });
  assert.equal(calls, 1); assert.equal(answer.reply, "在灯塔旁看海。[1]"); assert.equal(answer.delivery?.issue, "references"); assert.equal(answer.ui?.offers, undefined);
});

test("a visible recent journal remains citable while semantic indexing is unavailable", async t => {
  const f = fixture(t, false), original = globalThis.fetch;
  f.repository.insert(record("recent-source", "海岛度假遇到暴雨，兴致全无"));
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ action: "reply", reply: "海岛度假遇到暴雨。[1]", sourceIds: ["recent-source"] }) }, finish_reason: "stop" }] })) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const answer = await chatBackfill({ ...f.config, deepseekApiKey: "fake-chat-key", deepseekBaseUrl: "http://mock-ai.invalid" }, f.repository, { message: "以前哪次出游很扫兴？" });
  assert.equal(answer.mode, "ai"); assert.equal(answer.ui?.offers?.[0]?.label, "来源 1 2026-09-01");
});
