import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * This file gets its own process (see the `test` script in package.json).
 *
 * These cases stub `globalThis.fetch` to drive the provider failure paths, and
 * `--test-isolation=none` runs the other files in the same process — where
 * `api.test.ts` patches and restores `globalThis.fetch` by hand. Sharing a
 * process makes one file's restore land in the middle of another's attempt, and
 * the symptom is subtle: a second attempt that suddenly looks like a network
 * error instead of the stubbed one, so only one row gets recorded.
 */
import type { RuntimeAiConfig } from "../src/ai-config.js";
import type { ApiConfig } from "../src/config.js";
import { ATTEMPT_RAW_LIMIT, clipRawOutput, recordSummaryAttemptFailure, repositoryAttemptRecorder, summaryFailureStage } from "../src/assistant-attempt-log.js";
import { askAssistantJson } from "../src/assistant-json.js";
import { SqliteRecordRepository } from "../src/repository.js";

/** Only reached when the runtime is a shared key, which these fixtures never are. */
const CONFIG = {} as ApiConfig;
const RUNTIME: RuntimeAiConfig = {
  enabled: true,
  provider: "deepseek",
  baseUrl: "https://example.invalid",
  model: "test-model",
  thinking: false,
  preset: "quick",
  apiKey: "test-key",
  source: "file",
};

test("recovered reply diagnostics preserve raw whitespace and turn identity without counting a failed turn",t=>{
  const root=mkdtempSync(join(tmpdir(),"lifeos-reply-diagnostic-")),old=process.env.LIFEOS_LOG_DIR;
  process.env.LIFEOS_LOG_DIR=root;
  const repository=new SqliteRecordRepository(":memory:");
  t.after(()=>{repository.close();if(old===undefined)delete process.env.LIFEOS_LOG_DIR;else process.env.LIFEOS_LOG_DIR=old;rmSync(root,{recursive:true,force:true,maxRetries:5});});
  const recorder=repositoryAttemptRecorder(repository,"c-fixture","t-fixture");
  const raw=' \n正常正文。\n```lifeos\n{"sourceIds":';
  recorder.diagnose!({stage:"format",errorCode:"ai_reply_metadata_ignored",errorDetail:"附加信息未采用",receivedChars:raw.length,rawText:raw});
  recorder.flush();assert.equal(repository.assistantAttempts({limit:10}).length,0);
  const event=JSON.parse(readFileSync(join(root,readdirSync(root)[0]!),"utf8").trim());
  assert.equal(event.event,"assistant_reply_diagnostic");assert.equal(event.conversationId,"c-fixture");assert.equal(event.turnId,"t-fixture");
  assert.equal(event.rawText,raw);assert.equal(event.rawChars,raw.length);assert.equal(event.rawTruncated,false);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Per-test, auto-restored. A hand-rolled global patch leaks into whichever test
 * happens to be in flight, which shows up as a service error recorded where a
 * syntax error was expected.
 */
function stubFetch(t: TestContext, handler: (call: number) => Response): void {
  let calls = 0;
  t.mock.method(globalThis, "fetch", (() => Promise.resolve(handler(calls++))) as unknown as typeof fetch);
}

function attemptInput(overrides: Partial<Parameters<SqliteRecordRepository["recordAssistantAttempt"]>[0]> = {}) {
  return {
    id: "a1", conversationId: "c1", turnId: "t1", attempt: 1,
    stage: "format" as const, errorCode: "ai_json_syntax", errorDetail: "断在第 3 字",
    httpStatus: null, model: "test-model", effort: "direct",
    receivedChars: 3, rawChars: 3, rawTruncated: false, rawText: "abc",
    startedAt: "2026-10-16T00:00:00.000Z", finishedAt: "2026-10-16T00:00:01.000Z", durationMs: 1000,
    ...overrides,
  };
}

test("raw output keeps both ends past the storage limit", () => {
  assert.deepEqual(clipRawOutput("abc"), { text: "abc", chars: 3, truncated: false });
  assert.deepEqual(clipRawOutput(""), { text: null, chars: 0, truncated: false });
  const long = `${"A".repeat(ATTEMPT_RAW_LIMIT)}TAILMARK`;
  const clipped = clipRawOutput(long);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.chars, long.length);
  // The interesting part of a broken reply is where it broke — the end.
  assert.ok(clipped.text!.startsWith("A"));
  assert.ok(clipped.text!.endsWith("TAILMARK"), "the tail must survive, or the break point is lost");
  assert.ok(clipped.text!.includes(`中间省略 ${long.length - ATTEMPT_RAW_LIMIT} 字`));
});

test("attempt rows round-trip newest first, then prune and clear", () => {
  const repository = new SqliteRecordRepository(":memory:");
  repository.recordAssistantAttempt(attemptInput());
  repository.recordAssistantAttempt(attemptInput({ id: "a2", attempt: 2, stage: "connection", errorCode: "ai_stream_interrupted", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.000Z" }));

  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, "a1", "newest finished_at first");
  assert.equal(rows[0]!.rawText, "abc");
  assert.equal(rows[0]!.rawTruncated, false);
  assert.equal(rows[0]!.userText, null, "no transcript row means no question to show");

  assert.deepEqual({ ...repository.assistantAttemptCounts("2026-06-01T00:00:00.000Z") }, { connection: 0, format: 1, service: 0 });
  assert.equal(repository.pruneAssistantAttempts("2026-06-01T00:00:00.000Z"), 1);
  assert.equal(repository.assistantAttempts({ limit: 10 }).length, 1);
  assert.equal(repository.clearAssistantAttempts(), 1);
  assert.equal(repository.assistantAttempts({ limit: 10 }).length, 0);
});

test("a syntax failure buffers one row per attempt and writes nothing until flush", async (t) => {
  const repository = new SqliteRecordRepository(":memory:");
  stubFetch(t, () => jsonResponse({ choices: [{ message: { content: "这不是 JSON" }, finish_reason: "stop" }] }));
  const recorder = repositoryAttemptRecorder(repository, "c1", "t1");
  await assert.rejects(
    askAssistantJson(CONFIG, RUNTIME, "sys", [], "hi", [], () => { throw new Error("unreachable"); }, undefined, undefined, recorder),
    { code: "invalid_ai_reply" },
  );
  assert.equal(repository.assistantAttempts({ limit: 10 }).length, 0, "nothing is written before the turn is known to have failed");

  recorder.flush();
  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows.length, 2, "both attempts are kept; the retry does not overwrite the first");
  assert.equal(rows[0]!.attempt, 2);
  assert.equal(rows[1]!.attempt, 1);
  assert.equal(rows[0]!.stage, "format");
  assert.equal(rows[0]!.errorCode, "ai_json_syntax");
  assert.equal(rows[0]!.rawText, "这不是 JSON");
  assert.equal(rows[0]!.model, "test-model");
  assert.equal(rows[0]!.effort, "direct");
  assert.equal(rows[0]!.receivedChars, "这不是 JSON".length);
});

test("an attempt the repair retry recovered from is not a failure", async (t) => {
  const repository = new SqliteRecordRepository(":memory:");
  stubFetch(t, (call) => call === 0
    ? jsonResponse({ choices: [{ message: { content: "坏掉的" }, finish_reason: "stop" }] })
    : jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "reply", reply: "好了" }) }, finish_reason: "stop" }] }));
  const recorder = repositoryAttemptRecorder(repository, "c1", "t1");
  const value = await askAssistantJson<{ readonly reply: string }>(CONFIG, RUNTIME, "sys", [], "hi", [], (raw) => raw as { readonly reply: string }, undefined, undefined, recorder);
  assert.equal(value?.reply, "好了");
  // Production never flushes a successful turn: the recorder is per-turn and is
  // simply dropped. The flush afterwards proves the failure was buffered all
  // along, so the zero above is "not written", not "not recorded".
  assert.equal(repository.assistantAttempts({ limit: 10 }).length, 0, "the owner never saw a failure, so there is nothing to log");
  recorder.flush();
  assert.equal(repository.assistantAttempts({ limit: 10 }).length, 1, "the recovered attempt was buffered and would have been written had the turn failed");
});

test("a truncated stream is a connection failure carrying what did arrive", async (t) => {
  const repository = new SqliteRecordRepository(":memory:");
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reply":"半句话' } }] })}\n\n`;
  stubFetch(t, () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const recorder = repositoryAttemptRecorder(repository, "c1", "t1");
  await assert.rejects(
    askAssistantJson(CONFIG, RUNTIME, "sys", [], "hi", [], () => { throw new Error("unreachable"); }, () => {}, undefined, recorder),
    { code: "invalid_ai_reply" },
  );
  recorder.flush();
  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.stage, "connection");
  assert.equal(rows[0]!.errorCode, "ai_stream_interrupted");
  assert.ok(rows[0]!.rawText!.includes("半句话"), "the half-written reply must be kept, not discarded");
  assert.equal(rows[0]!.receivedChars, rows[0]!.rawText!.length);
});

test("a provider error is a service failure carrying the status", async (t) => {
  const repository = new SqliteRecordRepository(":memory:");
  stubFetch(t, () => new Response("nope", { status: 503 }));
  const recorder = repositoryAttemptRecorder(repository, "c1", "t1");
  await assert.rejects(
    askAssistantJson(CONFIG, RUNTIME, "sys", [], "hi", [], () => { throw new Error("unreachable"); }, undefined, undefined, recorder),
    { code: "ai_service_unavailable" },
  );
  recorder.flush();
  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows.length, 1, "a service error is not retried, so it is a single attempt");
  assert.equal(rows[0]!.stage, "service");
  assert.equal(rows[0]!.httpStatus, 503);
  assert.equal(rows[0]!.rawText, null);
});

test("a schema failure records why the validator rejected the reply", async (t) => {
  const repository = new SqliteRecordRepository(":memory:");
  stubFetch(t, () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ action: "nope" }) }, finish_reason: "stop" }] }));
  const recorder = repositoryAttemptRecorder(repository, "c1", "t1");
  await assert.rejects(
    askAssistantJson(CONFIG, RUNTIME, "sys", [], "hi", [], () => { throw new Error("bad envelope"); }, undefined, undefined, recorder),
    { code: "invalid_ai_reply" },
  );
  recorder.flush();
  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows[0]!.stage, "format");
  assert.equal(rows[0]!.errorCode, "ai_schema_invalid");
  assert.ok(rows[0]!.errorDetail.includes("action缺失或取值不正确"), rows[0]!.errorDetail);
  assert.equal(rows[0]!.rawText, JSON.stringify({ action: "nope" }));
});

test("a thinking-only turn keeps its reasoning, or the failure says nothing", async (t) => {
  // 2026-10-17 生产现场（对话 bb4872be…，问题「开心的呢」）：模型把预算全花在
  // 思考上、正文一个字没写，服务商照样以 finish_reason=stop 收尾。旧行为记下的
  // 是"服务商没有返回可用的正文" + 空 rawText——主人拿到手上等于没有任何线索。
  const body = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "我该回答什么呢" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  const repository = new SqliteRecordRepository(":memory:");
  stubFetch(t, () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const recorder = repositoryAttemptRecorder(repository, "c1", "t1");
  await assert.rejects(
    askAssistantJson(CONFIG, RUNTIME, "sys", [], "hi", [], () => { throw new Error("unreachable"); }, () => {}, undefined, recorder),
    { code: "invalid_ai_reply" },
  );
  recorder.flush();
  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows[0]!.stage, "format");
  assert.equal(rows[0]!.errorCode, "ai_reply_empty");
  assert.equal(rows[0]!.receivedChars, 0, "正文确实是空的");
  assert.ok(rows[0]!.rawText!.includes("我该回答什么呢"), `思考必须留下来，否则无从判断模型做了什么：${rows[0]!.rawText}`);
  assert.ok(rows[0]!.errorDetail.includes("只返回了思考"), rows[0]!.errorDetail);
});

test("an empty body retries with thinking off instead of repeating the same call", async (t) => {
  const THINKING_RUNTIME: RuntimeAiConfig = { ...RUNTIME, thinking: true, reasoningEffort: "high" };
  const sse = (content: string, reasoning: string) => new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: reasoning ? { reasoning_content: reasoning } : { content } }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });

  const bodies: string[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", ((_url: unknown, init?: { readonly body?: unknown }) => {
    const index = calls++;
    bodies.push(String(init?.body ?? ""));
    // First attempt: thinking only, no body — exactly what production saw.
    // Second: the downgraded call finally writes an answer.
    return Promise.resolve(index === 0
      ? sse("", "想了很久")
      : sse(JSON.stringify({ action: "reply", reply: "这次写了" }), ""));
  }) as unknown as typeof fetch);

  const repository = new SqliteRecordRepository(":memory:");
  const recorder = repositoryAttemptRecorder(repository, "c1", "t1");
  const value = await askAssistantJson<{ readonly reply: string }>(
    CONFIG, THINKING_RUNTIME, "sys", [], "hi", [], (raw) => raw as { readonly reply: string }, () => {}, undefined, recorder,
  );
  assert.equal(value?.reply, "这次写了");
  assert.equal(bodies.length, 2, "空正文必须触发第二次尝试");
  assert.equal(JSON.parse(bodies[0]!).thinking.type, "enabled", "第一次按主人的档位思考");
  assert.equal(JSON.parse(bodies[1]!).thinking.type, "disabled", "重试必须关掉思考，否则和第一次一样是白试");
  assert.ok(!bodies[1]!.includes("reasoning_effort"), "降级后不该再带推理强度");
  assert.ok(bodies[1]!.includes("请直接输出正文"), "重试要说明上次为什么失败");

  recorder.flush();
  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows.length, 1, "恢复的那次不算失败，但第一次的空正文要留档");
  assert.equal(rows[0]!.effort, "high", "留档的是第一次尝试的档位");
  assert.equal(rows[0]!.errorCode, "ai_reply_empty");
  assert.ok(rows[0]!.rawText!.includes("想了很久"), "第一次的思考也要留档");
});

/*
 * 2026-10-20：日历里「用 AI 生成小结」的失败也写进这张表，`source='summary'`。
 * 主人的诉求是「AI 相关的日志放一块」——所以这里断言的重点不是格式，而是
 * 两类失败确实同表、可区分、且都带得走（subject / errorDetail 足以让另一个 AI 接手）。
 */
test("a summary failure is recorded in the same log under its own source", (t) => {
  // 这个函数同时写一份按天切的文件日志，测试里必须把它指到临时目录，别落到仓库的 logs/。
  const logDirectory = mkdtempSync(join(tmpdir(), "lifeos-summary-attempt-"));
  const previousLogDirectory = process.env.LIFEOS_LOG_DIR;
  process.env.LIFEOS_LOG_DIR = logDirectory;
  t.after(() => {
    if (previousLogDirectory === undefined) delete process.env.LIFEOS_LOG_DIR;
    else process.env.LIFEOS_LOG_DIR = previousLogDirectory;
    rmSync(logDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const repository = new SqliteRecordRepository(":memory:");
  repository.recordAssistantAttempt(attemptInput());
  recordSummaryAttemptFailure(
    repository,
    "calendar_read",
    { provider: "deepseek", model: "deepseek-flash", dates: ["2026-10-19", "2026-10-20"], reason: "http_error", httpStatus: 503 },
    new Date("2026-10-20T10:00:00.000Z"),
  );

  const rows = repository.assistantAttempts({ limit: 10 });
  assert.equal(rows.length, 2, "对话失败与小结失败在同一张表里");
  assert.equal(rows[0]!.source, "summary", "最新的一条是小结");
  assert.equal(rows[0]!.stage, "connection", "5xx 是「等一下重试」，不是凭据问题");
  assert.equal(rows[0]!.errorCode, "day_summary_http_error");
  assert.equal(rows[0]!.httpStatus, 503);
  assert.equal(rows[0]!.conversationId, "", "小结不属于任何一段对话");
  assert.equal(rows[0]!.userText, null, "没有消息可回填");
  assert.ok(rows[0]!.subject!.includes("翻看日历"), rows[0]!.subject!);
  assert.ok(rows[0]!.subject!.includes("2026-10-19"), rows[0]!.subject!);
  assert.ok(rows[0]!.errorDetail.includes("已退回离线规则小结"), rows[0]!.errorDetail);
  assert.ok(rows[0]!.errorDetail.includes("2026-10-20"), rows[0]!.errorDetail);
  assert.equal(rows[0]!.rawText, null, "小结失败没有半截正文可留");

  assert.equal(rows[1]!.source, "chat", "老行默认还是对话，不用迁移就认得出来");
  assert.deepEqual({ ...repository.assistantAttemptSourceCounts("2026-10-01T00:00:00.000Z") }, { chat: 1, summary: 1 });
  assert.equal(repository.assistantAttempts({ source: "chat", limit: 10 }).length, 1);
  assert.equal(repository.assistantAttempts({ source: "summary", limit: 10 }).length, 1);
  assert.equal(repository.assistantAttempts({ source: "summary", stage: "format", limit: 10 }).length, 0, "两个筛选项是叠加的");
});

test("a summary failure is sorted into the same three remedies as a chat failure", () => {
  // 分类不是给主人看的词，是给「下一步做什么」用的：重试 / 改提示词 / 改配置。
  assert.equal(summaryFailureStage({ reason: "timeout" }), "connection");
  assert.equal(summaryFailureStage({ reason: "network_error" }), "connection");
  assert.equal(summaryFailureStage({ reason: "http_error", httpStatus: 503 }), "connection");
  assert.equal(summaryFailureStage({ reason: "http_error", httpStatus: 429 }), "connection", "限流是等一下，不是凭据坏了");
  assert.equal(summaryFailureStage({ reason: "http_error", httpStatus: 401 }), "service");
  assert.equal(summaryFailureStage({ reason: "http_error", httpStatus: 404 }), "service");
  assert.equal(summaryFailureStage({ reason: "invalid_json" }), "format");
  assert.equal(summaryFailureStage({ reason: "invalid_response" }), "format");
  assert.equal(summaryFailureStage({ reason: "missing_date" }), "format");
  assert.equal(summaryFailureStage({ reason: "provider_error" }), "service");
});
