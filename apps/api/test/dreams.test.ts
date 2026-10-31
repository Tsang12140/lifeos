import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { isDreamRecord, exportRecordMarkdown, validateUiTurnPlan, type TimelineRecord } from "@lifeos/core";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { retrieveJournals, journalSourceOffers, journalDateRange } from "../src/journal-retrieval.js";
import { collectSummarisableRecords } from "../src/summary-routes.js";
import { summarySources } from "../src/summary.js";
import { aiBackfillPlan, ruleBackfillPlan, validateBackfillPlan } from "../src/assistant-backfill.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

async function fixture(t: TestContext, model?: (payload: any) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-dreams-"));
  const calls: any[] = [];
  const provider = model ? createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); calls.push(payload);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(model(payload)) }, finish_reason: "stop" }] }));
  }) : null;
  if (provider) await listenOnFetchablePort(provider);
  const config = readConfig({ LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), ...(provider ? { LIFEOS_DEEPSEEK_API_KEY: "fictional-only", LIFEOS_DEEPSEEK_BASE_URL: "http://127.0.0.1:" + (provider.address() as { port: number }).port } : {}) });
  const app = createHttpServer(config); await listenOnFetchablePort(app.server);
  const base = "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise<void>(done => app.server.close(() => done()));
    if (provider) { provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done())); }
    assert(root.startsWith(join(tmpdir(), "lifeos-dreams-"))); rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const request = async (path: string, body?: unknown, method = "POST") => {
    const response = await fetch(base + path, body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
  };
  return { root, config, repository: app.app.repository, request, calls };
}
const journal = (id: string, dream: boolean, extra: Partial<TimelineRecord> = {}): TimelineRecord => ({ id, kind: "journal", body: { original: dream ? "梦见蓝鹭灯塔的紫色贝壳" : "现实中在蓝鹭灯塔散步", ...(dream ? { nature: "dream" } : {}) }, createdAt: { kind: "instant", value: "2026-10-01T00:00:00Z" }, occurredAt: { kind: "date", value: "2025-06-11" }, entityRefs: [], assetRefs: [], relatedRecordIds: [], aiDerived: [], ...extra } as TimelineRecord);

test("dream identity survives persistence, text edits, export and hiding the optional page", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/pages/dreams")).body.enabled, false);
  assert.equal((await f.request("/api/pages/dreams", { enabled: true }, "PUT")).body.enabled, true);
  assert.equal((await f.request("/api/pages/dreams", { enabled: "true" }, "PUT")).status, 400);
  assert.equal((await f.request("/api/records", { kind: "task", nature: "dream", content: "梦中待办" })).status, 400);
  const saved = await f.request("/api/records", { kind: "journal", nature: "dream", content: "梦中散步", occurredAt: { kind: "date", value: "2025-06-11" } });
  assert.equal(saved.status, 201); assert.equal(saved.body.body.nature, "dream");
  const updated = await f.request("/api/records/" + saved.body.id, { revision: saved.body.revision, content: "醒来补充一个片段" }, "PATCH");
  assert.equal(updated.status, 200); assert.equal(updated.body.body.original, "梦中散步"); assert.equal(updated.body.body.nature, "dream");
  await f.request("/api/pages/dreams", { enabled: false }, "PUT");
  assert.equal(f.repository.list().length, 1);
  const reopened = new SqliteRecordRepository(join(f.root, "data", "lifeos.sqlite"));
  try { assert.equal(reopened.dreamsEnabled(), false); assert(isDreamRecord(reopened.findById(saved.body.id)!)); } finally { reopened.close(); }
  const bundle = await f.request("/api/export?format=json"); assert.equal(bundle.body.records[0].body.nature, "dream");
  const target = await fixture(t);
  assert.equal((await target.request("/api/import", { bundle: bundle.body })).status, 201);
  assert(isDreamRecord(target.repository.findById(saved.body.id)!));
  assert(exportRecordMarkdown(f.repository.findById(saved.body.id)!).includes('nature: "dream"'));
});

test("diary defaults exclude dreams, calendar requests preserve labelled dream context, privacy still applies", async t => {
  const f = await fixture(t); f.repository.insert(journal("reality", false)); f.repository.insert(journal("dream", true));
  const path = "/api/records?from=2025-06-11&to=2025-06-11&timeZone=Asia/Shanghai";
  assert.deepEqual((await f.request(path)).body.items.map((r: any) => r.id), ["reality"]);
  assert.deepEqual((await f.request(path + "&nature=dream")).body.items.map((r: any) => r.id), ["dream"]);
  assert.equal((await f.request(path + "&nature=all")).body.items.length, 2);
  const calendar = (await f.request(path + "&calendar=1")).body.items;
  assert.equal(calendar.find((r: any) => r.id === "dream").body.nature, "dream");
  assert.equal((await f.request(path + "&nature=imagined")).status, 400);
  assert.deepEqual(summarySources(f.repository.list()).map(r => r.id), ["reality"]);
  assert.deepEqual(collectSummarisableRecords(f.repository, "Asia/Shanghai").get("2025-06-11")?.map(r => r.id), ["reality"]);
  f.repository.insert(journal("private", true, { isPrivate: true }));
  assert.equal((await f.request("/api/ai/assistant/sources/private")).status, 404);
});

test("dreams do not create real contact activity or first place visits", async t => {
  const f = await fixture(t);
  f.repository.insertEntity({ id: "friend", type: "person", name: "蓝鹭" });
  f.repository.insertEntity({ id: "place", type: "place", name: "灯塔", collectionHistory: { trackingSince: { kind: "instant", value: "2025-01-01T00:00:00Z" } } });
  const refs = [{ entityId: "friend", entityType: "person" as const }, { entityId: "place", entityType: "place" as const }];
  f.repository.insert(journal("dream", true, { entityRefs: refs }));
  assert.equal(f.repository.contactActivity().length, 0);
  assert.equal(f.repository.placeCollectionArchive("place")?.firstJournalStatus, "none");
  f.repository.insert(journal("real", false, { entityRefs: refs }));
  assert.equal(f.repository.contactActivity().length, 1);
  assert.equal(f.repository.placeCollectionArchive("place")?.firstJournal?.id, "real");
});

test("retrieval scopes and citations distinguish dream evidence from reality without an AI key", async t => {
  const f = await fixture(t); f.repository.insert(journal("real", false)); f.repository.insert(journal("dream", true));
  f.repository.insert(journal("demo", true, { isDemo: true })); f.repository.insert(journal("secret", true, { isPrivate: true }));
  const real = await retrieveJournals(f.config, f.repository, "以前在蓝鹭灯塔发生了什么", "2026-10-19");
  assert.deepEqual(real.candidates.map(r => r.id), ["real"]); assert.equal(real.journalCount, 1);
  const dream = await retrieveJournals(f.config, f.repository, "以前梦见蓝鹭灯塔", "2026-10-19");
  assert.deepEqual(dream.candidates.map(r => r.id), ["dream"]); assert.equal(dream.dreamCount, 1); assert.equal(dream.candidates[0]?.nature, "dream");
  assert.equal(journalSourceOffers(["dream"], dream, f.repository)[0]?.source?.nature, "dream");
  const preview = await f.request("/api/ai/assistant/sources/dream?preview=1"); assert.equal(preview.body.nature, "dream");
  const reply = await f.request("/api/ai/backfill/chat", { message: "以前梦见蓝鹭灯塔" });
  assert.equal(reply.body.mode, "rules"); assert(reply.body.reply.includes("梦中内容")); assert.equal(reply.body.ui.offers[0].source.nature, "dream");
  const count = await f.request("/api/ai/backfill/chat", { message: "我记录了几条梦境" }); assert(count.body.reply.includes("1 条")); assert(count.body.reply.includes("不代表实际做梦次数"));
});

test("dream drafts cannot append to reality, silently lose context or turn dream events into real actions", async t => {
  const f = await fixture(t); f.repository.insert(journal("real", false));
  const entry = { key: "d1", kind: "journal", content: "梦中的灯塔", date: "2025-06-11", selected: true, evidence: "原句", questions: "", entityKeys: [], assetIds: [] };
  const plan = aiBackfillPlan({ entries: [entry], objects: [], explanation: "" }, f.repository, undefined, true);
  assert.equal(plan.entries[0]?.nature, "dream");
  assert.equal(aiBackfillPlan({ entries: [entry], objects: [], explanation: "" }, f.repository, plan).entries[0]?.nature, "dream");
  assert.throws(() => validateBackfillPlan({ ...plan, entries: [{ ...plan.entries[0], targetId: "real", targetRevision: 1 }] }, f.repository));
  assert.throws(() => aiBackfillPlan({ entries: [{ ...entry, kind: "task" }], objects: [], explanation: "" }, f.repository, undefined, true));
  assert.throws(() => validateBackfillPlan({ ...plan, actions: [{ key: "a1", type: "cycle", cycleKind: "fitness", date: "2025-06-11", selected: true, marked: true, evidence: "梦", questions: "" }] }, f.repository));
  const local = ruleBackfillPlan([{ name: "手记", text: "2025-06-11 梦见看了《灯塔》，遇到@蓝鹭" }], f.repository, true);
  assert.equal(local.objects.length, 0); assert.equal(local.entries[0]?.nature, "dream");
});

test("durable conversation carries dream context, supplies marked evidence and rejects context changes on replay", async t => {
  const f = await fixture(t, () => ({ action: "reply", reply: "你梦见了灯塔。[1]", sourceIds: ["dream"] }));
  f.repository.insert(journal("dream", true)); f.repository.insert(journal("real", false));
  const conversation = await f.request("/api/ai/assistant/history/new", {});
  const input = { conversationId: conversation.body.conversationId, turnId: "dream-context-turn", message: "回顾一下", pageContext: "dreams", batchId: null, revision: null };
  const answer = await f.request("/api/ai/backfill/chat", input);
  assert.equal(answer.status, 200); assert.equal(answer.body.mode, "ai"); assert.equal(answer.body.ui.offers[0].source.nature, "dream");
  const payload = JSON.parse(f.calls[0].messages.at(-1).content);
  assert(payload.recentRecords.some((r: any) => r.nature === "dream"));
  assert(payload.recentRecords.some((r: any) => r.id === "real" && r.nature !== "dream"));
  assert.equal(payload.journalRetrieval.scope, "all");
  assert(f.calls[0].messages[0].content.includes("不能把梦境当作现实经历"));
  assert.equal((await f.request("/api/ai/backfill/chat", input)).status, 200); assert.equal(f.calls.length, 1);
  const { pageContext: _, ...without } = input;
  assert.equal((await f.request("/api/ai/backfill/chat", without)).status, 409);
});

test("assistant dream drafts require confirmation and commit as dreams even when the model omits nature", async t => {
  const f = await fixture(t, () => ({ action: "new_draft", reply: "已列出梦境草稿，确认后保存。", plan: { explanation: "原文整理", objects: [], entries: [{ key: "d1", selected: true, kind: "journal", content: "梦里看见紫色灯塔", date: "2025-06-11", evidence: "梦里看见紫色灯塔", questions: "", entityKeys: [], assetIds: [] }] } }));
  const draft = await f.request("/api/ai/backfill/chat", { message: "帮我记下这个梦", pageContext: "dreams" });
  assert.equal(draft.status, 200); assert.equal(draft.body.action, "draft");
  assert.equal(draft.body.batch.plan.entries[0].nature, "dream"); assert.equal(f.repository.list().length, 0);
  const committed = await f.request(`/api/ai/backfill/${draft.body.batch.id}/commit`, { revision: draft.body.batch.revision });
  assert.equal(committed.status, 200); assert.equal(f.repository.list().length, 1); assert(isDreamRecord(f.repository.list()[0]!));
  const ui = validateUiTurnPlan({ commands: [{ type: "search.records", params: { nature: "dream" } }] }, { entityIds: new Set(), recordIds: new Set(), today: "2026-10-19" });
  assert.equal(ui.plan.commands?.[0]?.type, "search.records"); assert.deepEqual(ui.plan.commands?.[0]?.params, { nature: "dream" });
});

