import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TimelineRecord, AssistantConversationDetail } from "@lifeos/core";
import { validateUiTurnPlan } from "@lifeos/core";
import { createHttpServer } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { journalDateRange, retrieveJournals, journalSourceOffers } from "../src/journal-retrieval.js";
import { chatBackfill } from "../src/assistant-conversation.js";
import { allowsPrivateAiAccess } from "../src/assistant-private-access.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

const record = (id: string, text: string, extra: Partial<TimelineRecord> = {}): TimelineRecord => ({ id, kind: "journal", body: { original: text }, createdAt: { kind: "instant", value: "2026-10-01T00:00:00Z" }, occurredAt: { kind: "date", value: "2025-06-11" }, entityRefs: [], relatedRecordIds: [], assetRefs: [], aiDerived: [], ...extra } as TimelineRecord);
async function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-assistant-sources-"));
  const config = readConfig({ LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets") });
  const running = createHttpServer(config); await listenOnFetchablePort(running.server);
  t.after(async () => { running.server.closeAllConnections(); await new Promise<void>(done => running.server.close(() => done())); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const base = "http://127.0.0.1:" + (running.server.address() as { port: number }).port;
  return { ...running, config, repository: running.app.repository, get: (path: string, init?: RequestInit) => fetch(base + path, init) };
}

test("private AI access requires its own unexpired grant and never follows display visibility", async t => {
  const now = Date.now();
  for (const value of [undefined, null, true, 'true', 'invalid', new Date(now).toISOString(), new Date(now + 172800000).toISOString()]) assert.equal(allowsPrivateAiAccess(value, now), false);
  assert.equal(allowsPrivateAiAccess('always', now), true);
  assert.equal(allowsPrivateAiAccess(new Date(now + 86400000).toISOString(), now), true);
  const f = await fixture(t);
  f.repository.insert(record('public', '蓝鹭灯塔公开散步'));
  f.repository.insert(record('private', '蓝鹭灯塔私密日记', { isPrivate: true }));
  f.repository.insert(record('private-note', '蓝鹭灯塔私密笔记', { kind: 'note', note: { format: 'note' }, isPrivate: true }));
  f.repository.insert(record('demo-private', '蓝鹭灯塔预置内容', { isDemo: true, isPrivate: true }));
  const message = '找找以前蓝鹭灯塔的日记和笔记';
  const closed = await chatBackfill(f.config, f.repository, { message, privacyVisible: true });
  assert(!closed.reply.includes('私密日记')); assert(!closed.reply.includes('私密笔记'));
  const open = await chatBackfill(f.config, f.repository, { message, privateAccessUntil: 'always', privacyVisible: false });
  assert(open.reply.includes('私密日记')); assert(open.reply.includes('私密笔记')); assert(!open.reply.includes('预置内容'));
  assert.equal((await f.get('/api/ai/assistant/sources/private')).status, 404);
  assert.equal((await f.get('/api/ai/assistant/sources/private', { headers: { 'X-LifeOS-Private-Access': 'always' } })).status, 200);
  assert.equal((await f.get('/api/ai/assistant/sources/private', { headers: { 'X-LifeOS-Private-Access': new Date(now - 1000).toISOString() } })).status, 404);
});

test("notes and journals retrieve whole-history text while respecting source kind, title, date and private exclusions", async t => {
  const f = await fixture(t);
  f.repository.insert(record("old-note", "桌面整理。".repeat(140) + "蓝鹭灯塔旅行笔记末尾的紫色贝壳", { kind: "note", note: { format: "note", title: "海风手册" } }));
  f.repository.insert(record("diary", "蓝鹭灯塔的散步"));
  f.repository.insert(record("hidden", "蓝鹭灯塔隐私", { kind: "note", note: { format: "note" }, isPrivate: true }));
  f.repository.insert(record("demo", "蓝鹭灯塔样例", { isDemo: true }));
  const notes = await retrieveJournals(f.config, f.repository, "找找蓝鹭灯塔笔记里的紫色贝壳", "2026-10-18");
  assert.deepEqual(notes.candidates.map(hit => hit.id), ["old-note"]); assert(notes.candidates[0]!.content.includes("紫色贝壳"));
  const title = await retrieveJournals(f.config, f.repository, "找找海风手册笔记", "2026-10-18"); assert.equal(title.candidates[0]?.title, "海风手册");
  const diary = await retrieveJournals(f.config, f.repository, "找找蓝鹭灯塔日记", "2026-10-18"); assert.deepEqual(diary.candidates.map(hit => hit.id), ["diary"]);
  assert.equal(notes.journalCount, 1); assert.equal(notes.noteCount, 1);
  assert.deepEqual(journalDateRange("帮我回顾这一周", "2026-10-18"), { from: "2026-10-12", to: "2026-10-18" });
});

test("citations require actual supplied unchanged source excerpts; model-authored source metadata is discarded", async t => {
  const f = await fixture(t); f.repository.insert(record("source", "蓝鹭灯塔的原文"));
  const retrieval = await retrieveJournals(f.config, f.repository, "找找蓝鹭灯塔日记", "2026-10-18");
  const offers = journalSourceOffers(["source"], retrieval, f.repository);
  assert.equal(offers[0]?.source?.excerpt, "蓝鹭灯塔的原文");
  assert.throws(() => journalSourceOffers(["made-up"], retrieval, f.repository));
  assert.throws(() => journalSourceOffers(["source", "source"], retrieval, f.repository));
  assert.throws(() => journalSourceOffers(["source"], { ...retrieval, candidates: [{ ...retrieval.candidates[0]!, content: "并不存在的原文" }] }, f.repository));
  const checked = validateUiTurnPlan({ offers }, { entityIds: new Set(), recordIds: new Set(["source"]), today: "2026-10-18" });
  assert.equal(checked.plan.offers?.[0]?.source, undefined);
  const old = f.repository.findById("source")!; f.repository.update({ ...old, isPrivate: true }, old.revision);
  assert.throws(() => journalSourceOffers(["source"], retrieval, f.repository));
});

test("source readers and persisted history recheck current eligibility, provide bounded previews and preserve original stored UI", async t => {
  const f = await fixture(t); f.repository.insert(record("source", "原文首段\n" + "正文".repeat(1500), { kind: "note", note: { format: "note", title: "小书", html: "<p>原文首段</p>" } }));
  const retrieval = await retrieveJournals(f.config, f.repository, "找找原文首段笔记", "2026-10-18");
  const offers = journalSourceOffers(["source"], retrieval, f.repository);
  const at = new Date().toISOString(); f.repository.createAssistantConversation("conversation", at);
  f.repository.appendAssistantMessages("conversation", [{ role: "assistant", text: "这段记录。[1]", ui: { offers } }], at);
  const full = await (await f.get("/api/ai/assistant/sources/source")).json() as { record: { body: { original: string }; note: { title: string } } }; assert.equal(full.record.body.original.length, 3005); assert.equal(full.record.note.title, "小书");
  const preview = await (await f.get("/api/ai/assistant/sources/source?preview=1")).json() as { date: string; excerpt: string; record?: unknown }; assert.equal(preview.date, "2025-06-11"); assert.equal(preview.excerpt.length, 1400); assert.equal(preview.record, undefined);
  assert.equal((await f.get("/api/ai/assistant/sources/source?preview=all")).status, 400);
  const history = await (await f.get("/api/ai/assistant/history/conversation")).json() as AssistantConversationDetail; assert.equal(history.messages[0]?.ui?.offers?.[0]?.source?.kind, "note");
  let saved = f.repository.findById("source")!; f.repository.update({ ...saved, body: { original: "改过的正文" } }, saved.revision); saved = f.repository.findById("source")!;
  const updated = await (await f.get("/api/ai/assistant/history/conversation")).json() as AssistantConversationDetail; assert.equal(updated.messages[0]?.ui?.offers?.[0]?.source?.excerpt, "");
  assert.equal(f.repository.assistantMessagePage("conversation", { limit: 10 }).items[0]?.ui?.offers?.[0]?.source?.excerpt, offers[0]?.source?.excerpt);
  f.repository.update({ ...saved, isPrivate: true }, saved.revision);
  assert.equal((await f.get("/api/ai/assistant/sources/source")).status, 404); assert.equal((await f.get("/api/ai/assistant/sources/source?preview=1")).status, 404);
  const privateHistory = await (await f.get("/api/ai/assistant/history/conversation")).json() as AssistantConversationDetail; assert.equal(privateHistory.messages[0]?.ui?.offers?.length, 0);
  assert.equal((await f.get("/api/ai/assistant/sources/missing")).status, 404);
});

test("local notes produce verified inline sources without an AI key", async t => {
  const f = await fixture(t); f.repository.insert(record("note", "蓝鹭灯塔的贝壳观察", { kind: "note", note: { format: "note" } }));
  const answer = await chatBackfill(f.config, f.repository, { message: "找找蓝鹭灯塔的笔记" });
  assert.equal(answer.mode, "rules"); assert(answer.reply.includes("[1]")); assert.equal(answer.ui?.offers?.[0]?.source?.kind, "note");
});
