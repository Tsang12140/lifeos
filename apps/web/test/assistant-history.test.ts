import test from "node:test";
import assert from "node:assert/strict";
import { assistantHistoryDayLabel, assistantHistoryPreview, countHistoryMatches, groupConversationsByDay, splitHistoryMatches, type AssistantConversationSummary } from "@lifeos/core";

const conversation = (id: string, day: string, messageCount = 2): AssistantConversationSummary => ({ id, day, startedAt: `${day}T04:00:00.000Z`, updatedAt: `${day}T04:00:00.000Z`, messageCount, preview: id });

test("the archive pins 今天 and 昨天 above older days, newest day first", () => {
  const groups = groupConversationsByDay([
    conversation("continued-old-thread", "2026-06-03"),
    conversation("this-morning", "2026-10-10"),
    conversation("last-night", "2026-10-09"),
    conversation("june-later", "2026-06-18"),
  ], "2026-10-10");

  assert.deepEqual(groups.map((group) => group.label), ["今天", "昨天", "2026年6月18日", "2026年6月3日"]);
  assert.deepEqual(groups.map((group) => group.key), ["today", "yesterday", "day:2026-06-18", "day:2026-06-03"]);
  // A conversation continued today still belongs to the day it started.
  assert.deepEqual(groups[2]!.items.map((item) => item.id), ["june-later"]);
  assert.deepEqual(groups[3]!.items.map((item) => item.id), ["continued-old-thread"]);
});

test("an archive with nothing today starts at the days that exist", () => {
  const groups = groupConversationsByDay([conversation("only-old", "2026-06-03")], "2026-10-10");
  assert.deepEqual(groups.map((group) => group.label), ["2026年6月3日"]);
  assert.equal(groups[0]!.key, "day:2026-06-03");
});

test("a missing or malformed day never invents a date", () => {
  assert.equal(assistantHistoryDayLabel(""), "日期未知");
  assert.equal(assistantHistoryDayLabel("2026-6-3"), "日期未知");
  const groups = groupConversationsByDay([conversation("broken", "")], "2026-10-10");
  assert.equal(groups[0]!.label, "日期未知");
  assert.equal(groups[0]!.key, "day:");
});

test("search hits are marked without touching the original wording", () => {
  const segments = splitHistoryMatches("去年6月买咖啡机打了 50% 折扣", "咖啡机");
  assert.deepEqual(segments, [
    { text: "去年6月买", match: false },
    { text: "咖啡机", match: true },
    { text: "打了 50% 折扣", match: false },
  ]);
  assert.equal(segments.map((segment) => segment.text).join(""), "去年6月买咖啡机打了 50% 折扣");
  assert.equal(countHistoryMatches("去年6月买咖啡机打了 50% 折扣", "咖啡机"), 1);
});

test("every occurrence is marked, and case is folded for matching only", () => {
  assert.deepEqual(splitHistoryMatches("Cafe cafe CAFE", "cafe"), [
    { text: "Cafe", match: true },
    { text: " ", match: false },
    { text: "cafe", match: true },
    { text: " ", match: false },
    { text: "CAFE", match: true },
  ]);
  assert.equal(countHistoryMatches("Cafe cafe CAFE", "cafe"), 3);
});

test("an empty or absent keyword returns the message untouched", () => {
  assert.deepEqual(splitHistoryMatches("随便一句话", ""), [{ text: "随便一句话", match: false }]);
  assert.deepEqual(splitHistoryMatches("随便一句话", "   "), [{ text: "随便一句话", match: false }]);
  assert.equal(countHistoryMatches("随便一句话", "没写过的词"), 0);
  assert.deepEqual(splitHistoryMatches("", "咖啡"), [{ text: "", match: false }]);
});

test("search excerpts retain late and long literal hits without changing original case", () => {
  const text = "前文".repeat(100) + "Cafe" + "后文".repeat(100);
  const preview = assistantHistoryPreview(text, "cafe");
  assert.ok(preview.startsWith("…") && preview.endsWith("…"));
  assert.ok(preview.includes("Cafe"));
  assert.ok(preview.length <= 82);
  const longNeedle = "罕".repeat(160);
  assert.ok(assistantHistoryPreview("前".repeat(90) + longNeedle + "后".repeat(90), longNeedle).includes(longNeedle));
  assert.equal(assistantHistoryPreview("短消息"), "短消息");
});
