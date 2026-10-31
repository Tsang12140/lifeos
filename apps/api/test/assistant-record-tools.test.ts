import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { isDreamRecord, type TimelineRecord } from "@lifeos/core";
import { readConfig } from "../src/config.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { createHttpServer } from "../src/server.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";
import { AssistantRecordTools } from "../src/assistant-record-tools.js";
import { aiBackfillPlan, commitBackfill, saveBackfillPlan, storeBackfillDraft, undoBackfill } from "../src/assistant-backfill.js";
import { chatBackfill } from "../src/assistant-conversation.js";
import { appLockRepository } from "../src/app-lock-context.js";
import { decodeChatOutput } from "../src/assistant-reply-body.js";
import { journalDateRange, retrieveJournals } from "../src/journal-retrieval.js";

const full = "A：梦见虚构灯塔。\n" + "B：原话及细节。".repeat(5000) + "\nC：补充感受。\nD：真正的全文结尾。";
const record = (id: string, extra: Partial<TimelineRecord> = {}): TimelineRecord => ({ id, kind: "journal", body: { original: "最初原文", edited: full }, createdAt: { kind: "instant", value: "2026-10-21T20:00:00+08:00" }, occurredAt: { kind: "instant", value: "2026-10-21T23:45:00+08:00" }, entityRefs: [], relatedRecordIds: [], assetRefs: [], aiDerived: [], ...extra } as TimelineRecord);
function unit(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-record-tools-"));
  const config = readConfig({ LIFEOS_DATA_DIR: root }), repository = new SqliteRecordRepository(join(root, "lifeos.sqlite"));
  t.after(() => { repository.close(); assert(root.startsWith(join(tmpdir(), "lifeos-record-tools-"))); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const tools = new AssistantRecordTools(repository, "2026-10-26", false, undefined);
  return { config, repository, tools };
}
const read = (id: string, revision = 1) => [{ tool: "records.read", args: { id, revision } }];
const op = (id: string, type = "set_nature", targetNature: "dream" | "real" = "dream", sourceRevision = 1) => [{ type, sourceId: id, sourceRevision, targetNature }];

async function fixture(t: TestContext, model: (payload: any, index: number) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-record-tools-http-")), calls: any[] = [];
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const packet = JSON.parse(Buffer.concat(chunks).toString("utf8")); calls.push(packet);
    const content = model(packet, calls.length - 1);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }] }));
  });
  await listenOnFetchablePort(provider);
  const config = readConfig({ LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_DEEPSEEK_API_KEY: "fictional-only", LIFEOS_DEEPSEEK_BASE_URL: "http://127.0.0.1:" + (provider.address() as { port: number }).port });
  const app = createHttpServer(config); await listenOnFetchablePort(app.server);
  const base = "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>(done => app.server.close(() => done())); provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done())); assert(root.startsWith(join(tmpdir(), "lifeos-record-tools-http-"))); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const request = async (path: string, body?: unknown) => { const r = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  return { config, repository: app.app.repository, calls, request };
}
const payload = (packet: any) => JSON.parse(packet.messages.at(-1).content);

test("record tools search explicit source scopes, dates, literal fragments and pages independently of destination", async t => {
  const f = unit(t); f.repository.insert(record("real")); f.repository.insert(record("dream", { body: { original: "A：梦见虚构灯塔。", nature: "dream" } }));
  f.repository.insert({ ...record("note"), kind: "note", note: { format: "note", title: "测试笔记" } } as TimelineRecord);
  const all: any = (await f.tools.execute([{ tool: "records.search", args: { from: "2026-10-21", to: "2026-10-21", limit: 1 } }]))[0];
  assert.equal(all.total, 3); assert.equal(all.nextOffset, 1); assert.equal(all.records.length, 1);
  const scoped: any = (await f.tools.execute([{ tool: "records.search", args: { nature: "real", kind: "journal", query: "A：梦见虚构灯塔。" } }]))[0];
  assert.equal(scoped.records[0].id, "real"); assert.equal(scoped.records[0].complete, false); assert.equal(scoped.records[0].totalChars, Array.from(full).length);
  const notes: any = (await f.tools.execute([{ tool: "records.search", args: { kind: "note" } }]))[0]; assert.equal(notes.total, 1); assert.equal(notes.records[0].id, "note");
  assert.equal(f.repository.list().length, 3); assert.equal(f.repository.assistantBatches().length, 0);
});

test("read returns actual complete long original and edited text, and proposals bind that read version", async t => {
  const f = unit(t); f.repository.insert(record("source"));
  assert.throws(() => f.tools.plan(op("source")), /先按当前版本读取/);
  const result: any = (await f.tools.execute(read("source")))[0];
  assert(result.ok && result.complete); assert.equal(result.content, full); assert(result.content.endsWith("D：真正的全文结尾。"));
  const plan = f.tools.plan(op("source")); assert.equal(plan.entries[0]?.content, full); assert.equal(f.repository.assistantBatches().length, 0);
  assert.throws(() => f.tools.plan(op("source", "set_nature", "dream", 2)), /先按当前版本读取/);
});

test("set nature preserves identity, original/edited body, exact time and photos, and undo restores", async t => {
  const f = unit(t); f.repository.insertAsset({ id: "photo", kind: "photo", originalName: "fictional.jpg", storageRefs: [{ sourceId: "test", sourceRef: "fictional.jpg" }] });
  f.repository.insert(record("source", { assetRefs: [{ assetId: "photo", role: "photo", label: "原照片" }] })); const before = f.repository.findById("source")!;
  await f.tools.execute(read("source")); const draft = await storeBackfillDraft(f.config, f.repository, [{ name: "用户请求", text: "调整记录性质" }], f.tools.plan(op("source")), "ai");
  assert.deepEqual(f.repository.findById("source"), before);
  const saved = commitBackfill(f.repository, draft.id, draft.revision), after = f.repository.findById("source")!;
  assert.equal(after.id, before.id); assert(isDreamRecord(after)); assert.equal(after.body.original, before.body.original); assert.equal(after.body.edited, full);
  for (const key of ["occurredAt", "createdAt", "assetRefs", "entityRefs", "relatedRecordIds", "aiDerived"] as const) assert.deepEqual(after[key], before[key]);
  assert.equal(f.repository.list().length, 1); assert.equal(commitBackfill(f.repository, draft.id, saved.revision).revision, saved.revision);
  undoBackfill(f.repository, draft.id); assert.deepEqual(f.repository.findById("source")!.body, before.body);
});

test("the same operation adjusts dream back to real and copies journals or notes without a destination-specific route", async t => {
  const f = unit(t); f.repository.insert(record("dream", { body: { original: full, nature: "dream" } }));
  await f.tools.execute(read("dream")); const draft = await storeBackfillDraft(f.config, f.repository, [{ name: "请求", text: "改回普通日记" }], f.tools.plan(op("dream", "set_nature", "real")), "ai");
  commitBackfill(f.repository, draft.id, draft.revision); assert(!isDreamRecord(f.repository.findById("dream")!));
  f.repository.insert({ ...record("note"), kind: "note", note: { format: "note", title: "原笔记", html: "<p>原文</p>" } } as TimelineRecord);
  const tools = new AssistantRecordTools(f.repository, "2026-10-26", false, undefined); await tools.execute(read("note"));
  const plan = tools.plan([{ type: "copy", sourceId: "note", sourceRevision: 1 }]);
  const copy = await storeBackfillDraft(f.config, f.repository, [{ name: "请求", text: "复制整篇笔记" }], plan, "ai"); const saved = commitBackfill(f.repository, copy.id, copy.revision);
  const copied = f.repository.findById(saved.recordIds![0]!)!; assert.equal(copied.kind, "note"); assert(copied.kind === "note"); const originalNote = f.repository.findById("note")!; assert(originalNote.kind === "note"); assert.deepEqual(copied.note, originalNote.note); assert.equal(copied.body.edited, full);
});

test("copy keeps source and fallback time, and repeated copies are refused", async t => {
  const f = unit(t); const { occurredAt: _, ...source } = record("source"); f.repository.insert(source);
  const before = f.repository.findById("source")!; await f.tools.execute(read("source"));
  const plan = f.tools.plan(op("source", "copy")); const draft = await storeBackfillDraft(f.config, f.repository, [{ name: "请求", text: "复制原记录" }], plan, "ai");
  const saved = commitBackfill(f.repository, draft.id, draft.revision), copied = f.repository.findById(saved.recordIds![0]!)!;
  assert.notEqual(copied.id, before.id); assert.deepEqual(copied.occurredAt, before.createdAt); assert.deepEqual(f.repository.findById("source"), before);
  const repeated = await storeBackfillDraft(f.config, f.repository, [{ name: "请求", text: "再复制" }], plan, "ai"); assert.throws(() => commitBackfill(f.repository, repeated.id, repeated.revision), /已有同日期/);
});

test("version changes, deletion, privacy changes and lock revocation invalidate reads and pending execution", async t => {
  for (const mode of ["edit", "delete", "private"] as const) {
    const f = unit(t); f.repository.insert(record(mode)); await f.tools.execute(read(mode));
    const draft = await storeBackfillDraft(f.config, f.repository, [{ name: "请求", text: mode }], f.tools.plan(op(mode)), "ai"); const source = f.repository.findById(mode)!;
    if (mode === "delete") f.repository.softDelete(mode, source.revision, JSON.stringify({ kind: "instant", value: new Date().toISOString() }));
    else f.repository.update(mode === "private" ? { ...source, isPrivate: true } : { ...source, body: { ...source.body, edited: "另一端新增E" } }, source.revision);
    assert.throws(() => f.tools.assertCurrent(), /不可读取|已更新/); assert.throws(() => commitBackfill(f.repository, draft.id, draft.revision), /已改变|不可读取/);
    assert.equal(f.repository.assistantBatch(draft.id)?.status, "draft");
  }
  const f = unit(t); f.repository.insert(record("lock")); await f.tools.execute(read("lock")); const plan = f.tools.plan(op("lock"));
  const draft = await storeBackfillDraft(f.config, f.repository, [{ name: "请求", text: "锁前" }], plan, "ai");
  const scoped = appLockRepository(f.repository, { protected: true, ai: true, locked: target => target === "dreams" });
  assert.throws(() => commitBackfill(scoped, draft.id, draft.revision), /解锁/);
});

test("read tools respect private access and source scope, while private writes keep their existing boundary", async t => {
  const f = unit(t); f.repository.insert(record("private", { isPrivate: true }));
  assert.equal((await f.tools.execute(read("private")) as any)[0].ok, false);
  const granted = new AssistantRecordTools(f.repository, "2026-10-26", true, "always"); assert.equal((await granted.execute(read("private")) as any)[0].complete, true);
  assert.throws(() => granted.plan(op("private")), /只支持读取私密/);
  const expired = new AssistantRecordTools(f.repository, "2026-10-26", true, "2020-01-01T00:00:00Z"); await assert.rejects(expired.execute(read("private")), /授权已到期/);
});

test("tool arguments, source proofs and operation preview guard record boundaries", async t => {
  const f = unit(t); f.repository.insert(record("source"));
  for (const request of [[{ tool: "records.delete", args: {} }], [{ tool: "records.search", args: { from: "2026-02-31" } }], [{ tool: "records.read", args: { id: "other-space", revision: 1 } }]]) assert.equal((await f.tools.execute(request) as any)[0].ok, false);
  assert.equal((await f.tools.execute(read("source", 999)) as any)[0].error, "record_changed");
  await f.tools.execute(read("source")); const plan = f.tools.plan(op("source")); const draft = await storeBackfillDraft(f.config, f.repository, [{ name: "请求", text: "整条" }], plan, "ai");
  assert.throws(() => saveBackfillPlan(f.repository, draft, { ...plan, entries: [{ ...plan.entries[0], content: "只有A" }] }), /保留原文/);
  assert.throws(() => aiBackfillPlan(plan, f.repository), /明确请求/);
  assert.equal(f.repository.list().length, 1);
});

test("tool work has bounded call, content and cancellation budgets", async t => {
  const f = unit(t); f.repository.insert(record("source"));
  for (let i = 0; i < 4; i++) await f.tools.execute(read("source"));
  assert.equal((await f.tools.execute(read("source")) as any)[0].error, "record_tool_limit");
  const controller = new AbortController(); controller.abort(); const stopped = new AssistantRecordTools(f.repository, "2026-10-26", false, undefined, controller.signal);
  await assert.rejects(stopped.execute(read("source"))); assert.equal(f.repository.assistantBatches().length, 0);
});

test("weekday date queries still enumerate bounded records and expose fragment completeness", async t => {
  assert.deepEqual(journalDateRange("周三", "2026-10-26"), { from: "2026-10-21", to: "2026-10-21" });
  assert.deepEqual(journalDateRange("上上周日", "2026-01-05"), { from: "2025-12-28", to: "2025-12-28" });
  const f = unit(t); f.repository.insert(record("source"));
  const result = await retrieveJournals(f.config, f.repository, "周三的日记", "2026-10-26"); assert.equal(result.candidates[0]?.id, "source"); assert.equal(result.candidates[0]?.complete, false);
});

test("metadata-only lookup requests are protocol, not visible JSON or invented record content", () => {
  assert.equal((decodeChatOutput('```lifeos\n{"action":"lookup","requests":[]}\n```')?.value as any).action, "lookup");
  assert.equal(decodeChatOutput('```lifeos\n{"action":"new_draft","plan":{}}\n```'), null);
});

test("the model-selected search/read/propose loop serves different phrasings through the same tools", async t => {
  // This scripted provider verifies protocol and source preservation, not language understanding.
  for (const message of ["把周三的日记迁移到梦境", "星期三那篇其实是做梦，帮我归到梦境里。", "周三的日记写的是梦，应该算梦境，帮我纠正一下。", "帮我把周三的日记迁移到梦境，可以吗？", "把我日记里周三那篇梦保留原文，分类调整为梦境。"] ) {
    const f = await fixture(t, packet => {
      const current = payload(packet), rounds = current.recordToolResults.length;
      if (!rounds) return { action: "lookup", reply: "我先查找原记录。", requests: [{ tool: "records.search", args: { nature: "all", kind: "journal", from: "2026-10-21", to: "2026-10-21" } }] };
      if (rounds === 1) return { action: "lookup", reply: "读取完整来源。", requests: read("source") };
      const received = current.recordToolResults[1].results[0].content;
      assert(received === full, `tool must receive exact whole content (${received?.length}/${full.length})`);
      return { action: "new_draft", reply: "已列出整条记录的待确认调整。", recordOperations: op("source") };
    });
    f.repository.insert(record("source")); const result = await chatBackfill(f.config, f.repository, { message, pageContext: "dreams" });
    assert.equal(f.calls.length, 3); assert.equal(result.batch?.plan.entries[0]?.content, full); assert.equal(f.repository.list().length, 1); assert(!isDreamRecord(f.repository.findById("source")!));
    assert(f.calls.every(packet => packet.messages[0].content.includes("records.search")));
  }
});

test("plain, ambiguous and declined model replies stay read-only without phrase-routing", async t => {
  for (const message of ["这几条我还没决定选哪条", "不用调整了，解释一下就好", "把那篇作为资料引用，不更改", "没有找到就告诉我"] ) {
    const f = await fixture(t, () => ({ action: "reply", reply: "本次仅讨论，原记录保持原样。" })); f.repository.insert(record("source"));
    const answer = await chatBackfill(f.config, f.repository, { message }); assert.equal(answer.action, "reply"); assert.equal(f.repository.assistantBatches().length, 0);
  }
});

test("repeated lookups stop at the shared budget without writes or a fabricated completion", async t => {
  const f = await fixture(t, () => ({ action: "lookup", reply: "继续查询。", requests: [{ tool: "records.search", args: {} }] }));
  const result = await chatBackfill(f.config, f.repository, { message: "查看资料" }); assert.equal(f.calls.length, 6); assert.equal(result.action, "reply"); assert(!result.batch); assert.equal(f.repository.assistantBatches().length, 0); assert(result.reply.includes("尚未形成"));
});

test("durable history retains verified source IDs across ordinary followups and reloads", async t => {
  const f = await fixture(t, packet => {
    const current = payload(packet), rounds = current.recordToolResults.length;
    if (current.message === "找出那篇测试灯塔日记") {
      if (!rounds) return { action: "lookup", reply: "先读取来源。", requests: read("source") };
      return { action: "reply", reply: "这篇记录描述了梦见测试灯塔的经历。[1]", sourceIds: ["source"] };
    }
    assert.equal(current.historySources.at(-1).sources[0].id, "source");
    if (!rounds) return { action: "lookup", reply: "重新读取刚才那条来源。", requests: read(current.historySources.at(-1).sources[0].id) };
    return { action: "new_draft", reply: "已列出性质调整，等待确认。", recordOperations: op("source") };
  });
  f.repository.insert(record("source")); const conversationId = (await f.request("/api/ai/assistant/history/new", {})).body.conversationId;
  const first = await f.request("/api/ai/backfill/chat", { conversationId, turnId: "first", message: "找出那篇测试灯塔日记", batchId: null, revision: null }); assert.equal(first.status, 200); assert.equal(first.body.ui.offers[0].command.params.recordId, "source");
  const second = await f.request("/api/ai/backfill/chat", { conversationId, turnId: "second", message: "刚才那篇应该属于梦境，帮我纠正分类", batchId: null, revision: null });
  assert.equal(second.status, 200); assert.equal(second.body.batch.plan.entries[0].content, full); assert.equal(second.body.batch.plan.entries[0].transfer.sourceId, "source");
  const committed = await f.request('/api/ai/backfill/' + second.body.batch.id + '/commit', { revision: second.body.batch.revision }); assert.equal(committed.status, 200); assert(isDreamRecord(f.repository.findById("source")!));
});
