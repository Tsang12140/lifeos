import test from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_IDLE_RESET_MS, assistantIdleResetDue } from "../src/assistant-idle.ts";

/** 固定一个「现在」，免得测试跟着系统时钟漂。 */
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

test("默认阈值就是两小时", () => {
  assert.equal(ASSISTANT_IDLE_RESET_MS, 2 * 60 * 60 * 1000);
});

test("刚好两小时没聊就翻篇", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: at(120), visibleMessageCount: 2, now: NOW }), true);
});

test("差一分钟还不翻篇", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: at(119), visibleMessageCount: 2, now: NOW }), false);
});

test("隔了一整晚当然翻篇", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: at(60 * 14), visibleMessageCount: 9, now: NOW }), true);
});

test("屏幕本来就是空的，不再多开一段", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: at(60 * 14), visibleMessageCount: 0, now: NOW }), false);
});

test("没有时间戳就不动它", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: undefined, visibleMessageCount: 3, now: NOW }), false);
});

test("时间读不出来也不动它", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: "昨天下午", visibleMessageCount: 3, now: NOW }), false);
});

test("时间落在未来（服务端时钟偏差）不翻篇", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: at(-30), visibleMessageCount: 3, now: NOW }), false);
});

test("阈值可以按需收短", () => {
  assert.equal(assistantIdleResetDue({ lastMessageAt: at(31), visibleMessageCount: 1, now: NOW, thresholdMs: 30 * 60_000 }), true);
  assert.equal(assistantIdleResetDue({ lastMessageAt: at(29), visibleMessageCount: 1, now: NOW, thresholdMs: 30 * 60_000 }), false);
});
