import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHttpServer } from "../src/server.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { chatBackfillWithHistory } from "../src/assistant-chat-history.js";
import { HttpError } from "../src/http-kit.js";
import type { AssistantConversationDetail, AssistantHistoryCurrent, AssistantHistoryPage, BackfillBatch, UiTurnPlan } from "@lifeos/core";

// fetch() refuses a short list of ports, so retry until the OS hands us one it
// will actually connect to.
const FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 79,
  80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97,
  98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 113,
  119, 123, 135, 139, 143, 179, 389, 427, 465, 512, 513, 514, 515, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

const shanghaiDay = (value: string | number | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(value));

async function fixture(options: { readonly mockAi?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-assistant-history-"));
  const databasePath = join(root, "lifeos.sqlite");
  const config = {
    host: "127.0.0.1",
    port: 0,
    databasePath,
    dataDirectory: root,
    webDirectory: join(root, "web"),
    backupDirectory: join(root, "backups"),
    allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    cookieSecure: false,
    bodyLimitBytes: 1024 * 1024,
    assetUploadLimitBytes: 25 * 1024 * 1024,
    assetOrphanGraceDays: 7,
    assetTrashDays: 30,
    deepseekModel: "deepseek-flash",
    deepseekBaseUrl: options.mockAi ? "http://mock-ai.invalid" : "https://api.deepseek.com",
    qweatherHost: "devapi.qweather.com",
    ...(options.mockAi ? { deepseekApiKey: "test-only-key" } : {}),
  } as const;
  const { server } = createHttpServer(config);
  let port = 0;
  for (let attempt = 0; attempt < 8 && port === 0; attempt += 1) {
    await new Promise<void>((resolve) => { server.listen(0, config.host, resolve); });
    const address = server.address();
    if (address !== null && typeof address !== "string" && !FORBIDDEN_PORTS.has(address.port)) port = address.port;
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (port === 0) throw new Error("could not bind a fetchable port");
  const base = `http://${config.host}:${port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) as unknown };
  };
  const post = (path: string, value: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const current = async () => (await call("/api/ai/assistant/history/current")).body as AssistantHistoryCurrent;
  const page = async (query = "") => (await call(`/api/ai/assistant/history${query}`)).body as AssistantHistoryPage;
  const detail = async (id: string, beforeSeq?: number) => (await call(`/api/ai/assistant/history/${id}${beforeSeq === undefined ? "" : `?beforeSeq=${beforeSeq}`}`)).body as AssistantConversationDetail;
  return {
    root, databasePath, base, config, call, post, current, page, detail,
    /** A second connection, so a test can plant rows with a chosen timestamp. */
    openStore: () => new SqliteRecordRepository(databasePath),
    close: async () => {
      if (server.listening) { server.close(); await once(server, "close"); }
      if (!root.startsWith(join(tmpdir(), "lifeos-assistant-history-"))) throw new Error("test cleanup escaped its temp directory");
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function installMockProvider(t: import("node:test").TestContext, answer: (call: number) => Promise<string> | string): { readonly calls: unknown[] } {
  const originalFetch = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("http://mock-ai.invalid/")) return originalFetch(input, init);
    const call = calls.length + 1;
    calls.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
    const content = await answer(call);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return { calls };
}

function draftBatch(id: string, revision = 1): BackfillBatch {
  return {
    id,
    revision,
    status: "draft",
    createdAt: "2026-10-09T10:00:00.000Z",
    updatedAt: "2026-10-09T10:00:00.000Z",
    materials: [],
    plan: {
      entries: [{ key: "entry-1", selected: true, kind: "journal", content: "这是一条已确认的测试记录", date: "2026-10-09", evidence: "测试原话", questions: "", entityKeys: [], assetIds: [] }],
      objects: [],
      explanation: "测试草稿",
    },
    mode: "rules",
  };
}

test("assistant history keeps both sides, hides on clear, and comes back on continue", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await f.current()).conversation, null, "a fresh install has no conversation yet");
  assert.equal((await f.page()).items.length, 0);

  const started = await f.post("/api/ai/assistant/history/new", {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const id = (started.body as { conversationId: string }).conversationId;
  assert.equal((await f.current()).conversation!.id, id, "explicit new sets the current conversation");

  const first = await f.post("/api/ai/assistant/history", { conversationId: id, messages: [{ role: "user", text: "今天很累，被当众说了几句" }, { role: "assistant", text: "听起来很难受，愿意说说当时的情况吗？" }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((first.body as { appended: number }).appended, 2);

  const live = (await f.current()).conversation!;
  assert.equal(live.id, id);
  assert.equal(live.messages.length, 2);
  assert.equal(live.clearedAt, null);
  assert.equal(live.messages[0]!.role, "user");
  assert.equal(live.messages[0]!.text, "今天很累，被当众说了几句");

  const listed = await f.page();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.hasMore, false);
  assert.equal(listed.items[0]!.id, id);
  assert.equal(listed.items[0]!.day, shanghaiDay(Date.now()));
  assert.equal(listed.items[0]!.messageCount, 2);
  assert.equal(listed.items[0]!.preview, "今天很累，被当众说了几句");

  // Appending to the same conversation keeps one thread, not a second one.
  assert.equal((await f.post("/api/ai/assistant/history", { conversationId: id, messages: [{ role: "user", text: "她没听我解释" }] })).status, 200);
  assert.equal((await f.page()).items.length, 1);
  assert.equal((await f.detail(id)).messages.length, 3);

  // Clearing only hides the screen; the archive still holds everything.
  const cleared = await f.post(`/api/ai/assistant/history/${id}/clear`, {});
  assert.equal(cleared.status, 200);
  const hidden = (await f.current()).conversation!;
  assert.equal(hidden.messages.length, 0);
  assert.equal(typeof hidden.clearedAt, "string");
  assert.equal((await f.detail(id)).messages.length, 3);

  // Continuing an old conversation brings it back and makes it current again.
  assert.equal((await f.post(`/api/ai/assistant/history/${id}/continue`, {})).status, 200);
  assert.equal((await f.current()).conversation!.messages.length, 3);
});

test("assistant history searches message text literally and refuses malformed input", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.post("/api/ai/assistant/history", { messages: [{ role: "user", text: "买咖啡机打了 50% 折扣" }] });
  await f.post("/api/ai/assistant/history", { messages: [{ role: "user", text: "周末去公园散步" }] });

  // instr() is literal: a percent sign must not behave like a LIKE wildcard.
  const percent = await f.page("?q=50%25");
  assert.equal(percent.items.length, 1, "50% must match only the message that contains it");
  assert.equal(percent.query, "50%");
  assert.equal((await f.page("?q=公园")).items.length, 1);
  assert.equal((await f.page("?q=公园")).items[0]!.preview, "周末去公园散步");
  assert.equal((await f.page("?q=没写过的词")).items.length, 0);

  // Both sides of the exchange are searchable, not just the person's words.
  await f.post("/api/ai/assistant/history", { messages: [{ role: "assistant", text: "你已经很努力了" }] });
  const assistantOnly = await f.page("?q=很努力");
  assert.equal(assistantOnly.items.length, 1);
  assert.equal(assistantOnly.items[0]!.preview, "你已经很努力了", "AI-only hits show the matching answer in the list");

  await f.post("/api/ai/assistant/history", { messages: [{ role: "user", text: "你好" }, { role: "assistant", text: "前文".repeat(60) + "阿彬建议去看海" + "后文".repeat(50) }] });
  const lateHit = await f.page("?q=阿彬");
  assert.equal(lateHit.items.length, 1);
  assert.match(lateHit.items[0]!.preview, /阿彬建议去看海/, "late AI answer hits remain inside the excerpt");
  assert.ok(!lateHit.items[0]!.preview.includes("你好"), "search preview is the answer, not the unrelated first user message");

  assert.equal((await f.post("/api/ai/assistant/history", { messages: [{ role: "user", text: "x" }], extra: 1 })).status, 400);
  assert.equal((await f.call("/api/ai/assistant/history?q=x&q=y")).status, 400, "repeated query keys are rejected");
  assert.equal((await f.call("/api/ai/assistant/history?unknown=x")).status, 400, "unknown query keys are rejected");
  assert.equal((await f.post("/api/ai/assistant/history", { messages: [{ role: "system", text: "x" }] })).status, 400);
  assert.equal((await f.post("/api/ai/assistant/history", { messages: [{ role: "user", text: "" }] })).status, 400);
  assert.equal((await f.post("/api/ai/assistant/history", { messages: Array.from({ length: 21 }, () => ({ role: "user", text: "x" })) })).status, 400);
  assert.equal((await f.post("/api/ai/assistant/history", { conversationId: "no-such-conversation", messages: [] })).status, 404);
  assert.equal((await f.call("/api/ai/assistant/history/no-such-conversation")).status, 404);
});

test("a new conversation starts empty and the day key follows Shanghai time", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.post("/api/ai/assistant/history", { messages: [{ role: "user", text: "第一段" }] });

  const fresh = await f.post("/api/ai/assistant/history/new", {});
  assert.equal(fresh.status, 200);
  const freshId = (fresh.body as { conversationId: string }).conversationId;
  const current = (await f.current()).conversation!;
  assert.equal(current.id, freshId);
  assert.equal(current.messages.length, 0);
  // 空对话不进列表：它只是给下一条消息占了个位置，还没有可读的内容。
  assert.equal((await f.page()).items.length, 1, "an empty conversation is not listed");
  assert.equal((await f.page()).items[0]!.messageCount, 1);

  // 一旦真的往新对话里说了话，它才出现在存档里。
  await f.post("/api/ai/assistant/history", { conversationId: freshId, messages: [{ role: "user", text: "新话题" }] });
  assert.equal((await f.page()).items.length, 2, "the older conversation stays in the archive");

  // Legacy append still writes an archive, but cannot take over current state.
  const oldId = (await f.post("/api/ai/assistant/history", { messages: [{ role: "user", text: "旧接口追加" }] })).body as { conversationId: string };
  assert.equal((await f.current()).conversation!.id, freshId);
  assert.notEqual((await f.current()).conversation!.id, oldId.conversationId);
  assert.equal((await f.page()).items.length, 3);

  // 2026-03-14T17:30Z is already 2026-03-15 in Shanghai; a UTC slice would say 03-14.
  const store = f.openStore();
  try {
    store.createAssistantConversation("edge-conversation", "2026-03-14T17:30:00.000Z");
    store.appendAssistantMessages("edge-conversation", [{ role: "user", text: "跨午夜的一段" }], "2026-03-14T17:30:00.000Z");
  } finally { store.close(); }
  const edge = (await f.page()).items.find((item) => item.id === "edge-conversation")!;
  assert.equal(edge.day, "2026-03-15");
  assert.equal(shanghaiDay("2026-03-14T17:30:00.000Z"), "2026-03-15");
});

test("message pages expose the full 501-message transcript and current shows the newest tail", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const store = f.openStore();
  const id = "conversation-501";
  const at = "2026-10-01T00:00:00.000Z";
  try {
    store.createAssistantConversation(id, at);
    store.appendAssistantMessages(id, Array.from({ length: 501 }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", text: `message-${index + 1}` })), at);
    store.setAssistantCurrentConversation(id);
  } finally { store.close(); }

  const first = await f.detail(id);
  assert.equal(first.messages.length, 100);
  assert.equal(first.messages[0]!.seq, 402);
  assert.equal(first.messages.at(-1)!.seq, 501);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBeforeSeq, 402);
  const current = (await f.current()).conversation!;
  assert.equal(current.id, id);
  assert.equal(current.messages.length, 100);
  assert.equal(current.messages.at(-1)!.text, "message-501");

  let page = first;
  const all = [...page.messages];
  while (page.hasMore) {
    assert.ok(page.nextBeforeSeq !== null);
    page = await f.detail(id, page.nextBeforeSeq!);
    all.unshift(...page.messages);
  }
  assert.equal(all.length, 501);
  assert.equal(all[0]!.seq, 1);
  assert.equal(all.at(-1)!.seq, 501);
  assert.equal(new Set(all.map((message) => message.id)).size, 501);
  assert.equal((await f.call(`/api/ai/assistant/history/${id}?beforeSeq=0`)).status, 400);

  // A late touch changes list ordering but never reclaims the selected current id.
  const second = f.openStore();
  try {
    second.createAssistantConversation("older-but-touched", at);
    second.appendAssistantMessages("older-but-touched", [{ role: "user", text: "older" }], at);
    second.setAssistantCurrentConversation(id);
    second.touchAssistantConversation("older-but-touched", "2030-01-01T00:00:00.000Z");
    assert.equal(second.assistantCurrentConversationId(), id);
    // Same-millisecond append remains visible after the seq-based clear boundary.
    second.clearAssistantConversation(id, at);
    second.appendAssistantMessages(id, [{ role: "user", text: "after clear" }], at);
  } finally { second.close(); }
  const afterClear = (await f.current()).conversation!;
  assert.equal(afterClear.messages.length, 1);
  assert.equal(afterClear.messages[0]!.text, "after clear");
});

test("conversation list cursor is stable past item 100", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const store = f.openStore();
  const at = "2026-10-08T12:00:00.000Z";
  try {
    for (let index = 0; index < 101; index += 1) {
      const id = `page-${String(index).padStart(3, "0")}`;
      store.createAssistantConversation(id, at);
      store.appendAssistantMessages(id, [{ role: "user", text: `session-${index}` }], at);
    }
  } finally { store.close(); }
  const first = await f.page();
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");
  const second = await f.page(`?cursor=${encodeURIComponent(first.nextCursor!)}`);
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 101);
  assert.equal((await f.call("/api/ai/assistant/history?cursor=not-a-cursor")).status, 400);
});

test("date search matches the same message and uses Shanghai dates across a month boundary", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const store = f.openStore();
  try {
    store.createAssistantConversation("cross-month", "2026-02-28T15:50:00.000Z");
    store.appendAssistantMessages("cross-month", [{ role: "user", text: "Needle from February" }], "2026-02-28T15:55:00.000Z");
    store.appendAssistantMessages("cross-month", [{ role: "assistant", text: "Berry after midnight" }], "2026-02-28T16:05:00.000Z");
  } finally { store.close(); }
  assert.equal((await f.page("?q=NEEDLE")).items.length, 1, "English search folds ASCII case");
  assert.equal((await f.page("?from=2026-03-01&to=2026-03-01&q=Needle")).items.length, 0, "date and text must match one message");
  const inRange = await f.page("?from=2026-03-01&to=2026-03-01&q=BERRY");
  assert.equal(inRange.items.length, 1);
  assert.equal(inRange.items[0]!.id, "cross-month");
  assert.equal(inRange.items[0]!.preview, "Berry after midnight");
  assert.equal((await f.page()).items.length, 1, "no date defaults to all stored dates, including old months");
  assert.equal((await f.page("?q=Needle")).items[0]!.preview, "Needle from February", "date-free text search includes earlier months");
  assert.equal((await f.call("/api/ai/assistant/history?from=2026-03-02&to=2026-03-01")).status, 400);
});

test("old assistant tables migrate additively and preserve clear/current state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-assistant-history-migration-"));
  const databasePath = join(root, "lifeos.sqlite");
  const old = new DatabaseSync(databasePath);
  old.exec(`
    CREATE TABLE assistant_conversations (id TEXT PRIMARY KEY NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, cleared_at TEXT);
    CREATE TABLE assistant_messages (id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, seq INTEGER NOT NULL);
  `);
  old.prepare("INSERT INTO assistant_conversations(id, started_at, updated_at, cleared_at) VALUES(?, ?, ?, ?)").run("old-thread", "2026-10-01T00:00:00.000Z", "2026-10-01T00:01:00.000Z", "2026-10-01T00:00:00.000Z");
  const insert = old.prepare("INSERT INTO assistant_messages(id, conversation_id, role, text, created_at, seq) VALUES(?, 'old-thread', ?, ?, ?, ?)");
  insert.run("old-1", "user", "hidden before upgrade", "2026-10-01T00:00:00.000Z", 1);
  insert.run("old-2", "assistant", "visible after clear", "2026-10-01T00:00:00.001Z", 2);
  old.close();
  t.after(() => {
    if (!root.startsWith(join(tmpdir(), "lifeos-assistant-history-migration-"))) throw new Error("migration cleanup escaped its temp directory");
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const store = new SqliteRecordRepository(databasePath);
  try {
    const current = store.assistantCurrentConversation()!;
    assert.equal(current.id, "old-thread");
    assert.equal(current.clearSeq, 1, "migration backfills the old cleared timestamp to a seq boundary");
    assert.deepEqual(store.assistantMessagePage("old-thread", { afterSeq: current.clearSeq, limit: 100 }).items.map((message) => message.text), ["visible after clear"]);
    assert.equal(store.assistantMessagePage("old-thread", { limit: 100 }).items.length, 2, "archive retains both messages");
    store.createAssistantConversation("new-thread", "2026-10-02T00:00:00.000Z");
    store.setAssistantCurrentConversation("new-thread");
    store.touchAssistantConversation("old-thread", "2030-01-01T00:00:00.000Z");
    assert.equal(store.assistantCurrentConversationId(), "new-thread");
  } finally { store.close(); }
});

test("durable chat survives a disconnected client and is idempotent by turn id", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  let providerStartedResolve!: () => void;
  const providerStarted = new Promise<void>((resolve) => { providerStartedResolve = resolve; });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const mock = installMockProvider(t, async () => {
    providerStartedResolve();
    await providerGate;
    return JSON.stringify({ action: "reply", reply: "已归档回复" });
  });
  const id = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  const body = { conversationId: id, turnId: "11111111-1111-4111-8111-111111111111", message: "请聊聊今天", materials: [], batchId: null, revision: null };
  const controller = new AbortController();
  const lostResponse = fetch(`${f.base}/api/ai/backfill/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  await providerStarted;
  const store = f.openStore();
  try {
    const pending = store.assistantChatTurn(id, body.turnId)!;
    assert.equal(pending.status, "running");
    assert.equal(store.assistantMessagePage(id, { limit: 100 }).items.length, 1, "user message is durable before provider completion");
  } finally { store.close(); }
  controller.abort();
  await assert.rejects(lostResponse, "the browser has already lost the response");

  const changed = await f.post("/api/ai/backfill/chat", { ...body, message: "改写同一轮" });
  assert.equal(changed.status, 409);
  const retry = f.post("/api/ai/backfill/chat", body);
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseProvider();
  const replayed = await retry;
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal((replayed.body as { reply: string }).reply, "已归档回复");
  assert.equal(mock.calls.length, 1, "same turn joined the in-flight call");
  const completed = await f.detail(id);
  assert.equal(completed.messages.length, 2);
  assert.equal(completed.messages[0]!.turnStatus, "completed");
  assert.equal(completed.messages[1]!.turnId, body.turnId);
  assert.equal(completed.messages[1]!.text, "已归档回复");
  const completedReplay = await f.post("/api/ai/backfill/chat", body);
  assert.equal(completedReplay.status, 200);
  assert.equal(mock.calls.length, 1, "completed replay does not call the provider again");
  assert.equal((await f.detail(id)).messages.length, 2, "retry never duplicates the user's message");
});

test("a turn's compiled interface commands are stored with its reply and come back on reload", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  installMockProvider(t, () => JSON.stringify({
    action: "reply",
    reply: "去日历看看。",
    ui: {
      commands: [{ type: "view.goto", params: { view: "calendar" } }],
      offers: [{ label: "回到今天", command: { type: "view.goto", params: { view: "today" } } }],
    },
  }));
  const id = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  const answer = (await f.post("/api/ai/backfill/chat", {
    conversationId: id, turnId: "22222222-2222-4222-8222-222222222222",
    message: "去日历", materials: [], batchId: null, revision: null,
  })).body as { readonly ui?: UiTurnPlan };
  assert.deepEqual(answer.ui?.commands, [{ type: "view.goto", params: { view: "calendar" } }]);
  // The point of the test. A plan that only lives in the tab is gone the moment
  // the conversation is reloaded — and a clarify prompt whose candidates vanish
  // is a question nobody can answer by clicking.
  const stored = (await f.detail(id)).messages.at(-1);
  assert.equal(stored?.role, "assistant");
  assert.deepEqual(stored?.ui?.commands, [{ type: "view.goto", params: { view: "calendar" } }], "the archive keeps the commands, not just the words");
  assert.equal(stored?.ui?.offers?.[0]?.label, "回到今天", "offers survive too");
});

test("a refused command is not archived as if it had worked", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  // `settings` is deliberately outside UI_VIEW_IDS: the model may send the owner
  // to the pages they read, never to the page that holds credentials.
  installMockProvider(t, () => JSON.stringify({ action: "reply", reply: "打开设置。", ui: { commands: [{ type: "view.goto", params: { view: "settings" } }] } }));
  const id = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  const answer = (await f.post("/api/ai/backfill/chat", {
    conversationId: id, turnId: "33333333-3333-4333-8333-333333333333",
    message: "打开设置页", materials: [], batchId: null, revision: null,
  })).body as { readonly ui?: UiTurnPlan };
  assert.equal(answer.ui, undefined, "a turn whose only command was refused carries no plan");
  const stored = (await f.detail(id)).messages.at(-1);
  assert.equal(stored?.text, "打开设置。", "the reply itself still reaches the owner");
  assert.equal(stored?.ui, undefined, "and nothing is archived as if the jump had happened");
});

test("the model is told private records exist without being told what is in them", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  const mock = installMockProvider(t, () => JSON.stringify({ action: "reply", reply: "收到。" }));
  const private_ = await f.post("/api/records", { kind: "journal", content: "私密的那条正文", isPrivate: true, occurredAt: { kind: "date", value: "2026-10-06" } });
  const open = await f.post("/api/records", { kind: "journal", content: "公开的一条", occurredAt: { kind: "date", value: "2026-10-07" } });
  assert.ok(private_.status < 300 && open.status < 300, `fixture wrote both records (${private_.status}/${open.status})`);
  const id = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  await f.post("/api/ai/backfill/chat", {
    conversationId: id, turnId: "44444444-4444-4444-8444-444444444444",
    message: "我一共有多少条记录", materials: [], batchId: null, revision: null, privacyVisible: false,
  });
  const systemOf = (call: unknown) => (call as { messages: { role: string; content: string }[] }).messages[0]!.content;
  const prompt = systemOf(mock.calls[0]);
  // Tier A: the count is metadata, the body is not. A model that cannot see the
  // record still has to know it is there — otherwise it answers with the records it
  // can see and the owner never learns a fourth was withheld.
  assert.match(prompt, /另有 1 条隐私记录/);
  assert.match(prompt, /主人自己在界面上也看不到（隐私总开关关着）/, "with the switch off the owner cannot look either");
  const everything = JSON.stringify(mock.calls[0]);
  assert.doesNotMatch(everything, /私密的那条正文/, "the private body never leaves the machine");
  assert.match(everything, /公开的一条/, "the visible record still reaches the model");

  await f.post("/api/ai/backfill/chat", {
    conversationId: id, turnId: "55555555-5555-4555-8555-555555555555",
    message: "再问一次", materials: [], batchId: null, revision: null, privacyVisible: true,
  });
  assert.match(systemOf(mock.calls[1]), /主人自己在界面上看得到（隐私开关开着）/, "with the switch on the advice changes: look at the list yourself");
});

test("a running turn from a closed repository is interrupted after reopen without a second provider call", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  let providerStartedResolve!: () => void;
  const providerStarted = new Promise<void>((resolve) => { providerStartedResolve = resolve; });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const mock = installMockProvider(t, async () => {
    providerStartedResolve();
    await providerGate;
    return JSON.stringify({ action: "reply", reply: "不会重复执行" });
  });
  const id = "restart-conversation";
  const turnId = "12121212-1212-4212-8212-121212121212";
  const body = { conversationId: id, turnId, message: "重启期间的未完成轮次", materials: [], batchId: null, revision: null };
  const firstRepository = f.openStore();
  firstRepository.createAssistantConversation(id, "2026-10-10T00:00:00.000Z");
  firstRepository.setAssistantCurrentConversation(id);
  const originalRun = chatBackfillWithHistory(f.config, firstRepository, body);
  const originalRunSettled = originalRun.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await providerStarted;
  assert.equal(mock.calls.length, 1, "the original request reached the provider once");
  firstRepository.close();

  const reopenedRepository = f.openStore();
  try {
    const interrupted = await assert.rejects(
      chatBackfillWithHistory(f.config, reopenedRepository, body),
      (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "turn_interrupted",
    );
    assert.equal(interrupted, undefined);
    assert.equal(mock.calls.length, 1, "the retry after repository reopen does not call the provider again");
    const turn = reopenedRepository.assistantChatTurn(id, turnId);
    assert.equal(turn?.status, "interrupted");
    const messages = reopenedRepository.assistantMessagePage(id, { limit: 100 }).items;
    assert.equal(messages.length, 1, "the original user message remains durable");
    assert.equal(messages[0]!.text, body.message);
    assert.equal(messages[0]!.turnStatus, "interrupted");
  } finally {
    reopenedRepository.close();
  }

  releaseProvider();
  const originalOutcome = await originalRunSettled;
  assert.equal(originalOutcome.ok, false, "the abandoned pre-restart operation cannot complete on the closed repository");
});

test("failed chat remains visible, can retry safely, and cannot overlap another turn", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  let secondProviderResolve!: () => void;
  const secondProviderStarted = new Promise<void>((resolve) => { secondProviderResolve = resolve; });
  let releaseSecond!: () => void;
  const secondProviderGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const mock = installMockProvider(t, async (call) => {
    if (call === 1) return "not-json";
    if (call === 2) { secondProviderResolve(); await secondProviderGate; }
    return JSON.stringify({ action: "reply", reply: `回复-${call}` });
  });
  const id = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  const a = { conversationId: id, turnId: "22222222-2222-4222-8222-222222222222", message: "第一轮", materials: [], batchId: null, revision: null };
  const failed = await f.post("/api/ai/backfill/chat", a);
  assert.equal(failed.status, 502);
  const failedView = await f.detail(id);
  assert.equal(failedView.messages.length, 1);
  assert.equal(failedView.messages[0]!.turnStatus, "failed");
  assert.equal(failedView.messages[0]!.retryable, true);

  const b = { conversationId: id, turnId: "33333333-3333-4333-8333-333333333333", message: "第二轮", materials: [], batchId: null, revision: null };
  const second = f.post("/api/ai/backfill/chat", b);
  await secondProviderStarted;
  const retryAWhileBRunning = await f.post("/api/ai/backfill/chat", a);
  assert.equal(retryAWhileBRunning.status, 409);
  assert.equal(mock.calls.length, 2, "the overlapping retry did not start another provider request");
  releaseSecond();
  assert.equal((await second).status, 200);

  const retryA = await f.post("/api/ai/backfill/chat", a);
  assert.equal(retryA.status, 200, JSON.stringify(retryA.body));
  assert.equal(mock.calls.length, 3);
  const messages = (await f.detail(id)).messages;
  assert.equal(messages.length, 4, "failed user message is reused while the other turn and reply remain");
  assert.equal(messages[0]!.turnStatus, "completed");
  assert.equal(messages[0]!.text, "第一轮");
});

test("batch binding rejects mismatch and stale revision before saving; completed write replays safely", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  const store = f.openStore();
  const batch = draftBatch("bound-draft");
  try { store.saveAssistantBatch(batch); }
  finally { store.close(); }
  const missing = await f.post("/api/ai/assistant/history/new", { batchId: "missing-batch" });
  assert.equal(missing.status, 404);
  const started = await f.post("/api/ai/assistant/history/new", { batchId: batch.id });
  assert.equal(started.status, 200);
  const id = (started.body as { conversationId: string }).conversationId;
  const body = { conversationId: id, turnId: "44444444-4444-4444-8444-444444444444", message: "确认写入", materials: [], batchId: batch.id, revision: batch.revision };
  const mismatch = await f.post("/api/ai/backfill/chat", { ...body, batchId: "other-draft" });
  assert.equal(mismatch.status, 409);
  const stale = await f.post("/api/ai/backfill/chat", { ...body, revision: batch.revision + 1 });
  assert.equal(stale.status, 409);
  assert.equal((await f.detail(id)).messages.length, 0, "invalid binding or revision persists no user turn");

  const unbound = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  const unboundWithBatch = await f.post("/api/ai/backfill/chat", { ...body, conversationId: unbound, turnId: "55555555-5555-4555-8555-555555555555" });
  assert.equal(unboundWithBatch.status, 409, "an unbound conversation cannot borrow another draft");
  assert.equal((await f.detail(unbound)).messages.length, 0);

  const committed = await f.post("/api/ai/backfill/chat", body);
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const firstAnswer = committed.body as { batch: BackfillBatch; action: string };
  assert.equal(firstAnswer.action, "commit");
  assert.equal(firstAnswer.batch.status, "committed");
  assert.equal(firstAnswer.batch.revision, 2);
  const beforeReplay = f.openStore();
  try { assert.equal(beforeReplay.list().length, 1); }
  finally { beforeReplay.close(); }

  const replay = await f.post("/api/ai/backfill/chat", body);
  assert.equal(replay.status, 200);
  assert.equal((replay.body as { batch: BackfillBatch }).batch.revision, 2, "replay receives the current safe revision");
  assert.equal((replay.body as { batch: BackfillBatch }).batch.recordIds?.length, 1);
  assert.equal((await f.detail(id)).messages.length, 2);
  const afterReplay = f.openStore();
  try { assert.equal(afterReplay.list().length, 1, "commit is not executed twice"); }
  finally { afterReplay.close(); }
});

test("chat attachments persist only tenant asset references and protect photos from collection", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  const store = f.openStore();
  try {
    store.insertAsset({ id: "photo-history-1", kind: "photo", originalName: "窗边.jpg", storageRefs: [{ sourceId: "test", sourceRef: "photo-history-1.jpg" }] });
  } finally { store.close(); }
  const id = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  const turn = "66666666-6666-4666-8666-666666666666";
  const body = { conversationId: id, turnId: turn, message: "看看这张照片", materials: [{ assetId: "photo-history-1", name: "窗边.jpg", text: "", imageData: "data:image/jpeg;base64,AAAA" }], batchId: null, revision: null };
  const first = await f.post("/api/ai/backfill/chat", body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const changedDataUri = await f.post("/api/ai/backfill/chat", { ...body, materials: [{ ...body.materials[0], imageData: "data:image/jpeg;base64,BBBB" }] });
  assert.equal(changedDataUri.status, 200, "rehydrated image bytes do not alter the asset-keyed idempotency request");
  const detail = await f.detail(id);
  assert.deepEqual(detail.messages[0]!.attachments, [{ assetId: "photo-history-1", name: "窗边.jpg" }]);
  assert.equal(JSON.stringify(detail).includes("imageData"), false);
  const referenceStore = f.openStore();
  try { assert.equal(referenceStore.referencedAssetIds().has("photo-history-1"), true); }
  finally { referenceStore.close(); }
  const invalid = await f.post("/api/ai/backfill/chat", { ...body, turnId: "77777777-7777-4777-8777-777777777777", materials: [{ assetId: "from-another-tenant", name: "missing.jpg", text: "" }] });
  assert.equal(invalid.status, 400, "asset ids are validated against this repository");
});

test("clearing while a turn is running hides its late reply and a new current survives it", async (t) => {
  const f = await fixture({ mockAi: true });
  t.after(() => f.close());
  let providerStartedResolve!: () => void;
  const providerStarted = new Promise<void>((resolve) => { providerStartedResolve = resolve; });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  installMockProvider(t, async () => {
    providerStartedResolve();
    await providerGate;
    return JSON.stringify({ action: "reply", reply: "迟到回复" });
  });
  const idA = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  const body = { conversationId: idA, turnId: "88888888-8888-4888-8888-888888888888", message: "旧对话提问", materials: [], batchId: null, revision: null };
  const response = f.post("/api/ai/backfill/chat", body);
  await providerStarted;
  assert.equal((await f.post(`/api/ai/assistant/history/${idA}/clear`, {})).status, 200);
  const idB = ((await f.post("/api/ai/assistant/history/new", {})).body as { conversationId: string }).conversationId;
  releaseProvider();
  assert.equal((await response).status, 200);
  const current = (await f.current()).conversation!;
  assert.equal(current.id, idB);
  assert.equal(current.messages.length, 0);
  const old = await f.detail(idA);
  assert.equal(old.messages.length, 1, "the late answer does not slip past the clear seq boundary");
  assert.equal(old.messages[0]!.turnStatus, "completed");
});
