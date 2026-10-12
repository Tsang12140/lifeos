import test from "node:test";
import assert from "node:assert/strict";
import { findEntityCandidates, type Entity } from "@lifeos/core";
import { groupMentionContexts } from "../src/entity-mention-groups.ts";

const entities: Entity[] = [{ id: "person", type: "person", name: "小李" }, { id: "place", type: "place", name: "小院" }];
const groups = (text: string) => groupMentionContexts(text, findEntityCandidates(text, entities));

test("nearby people and places share one excerpt without deduplicating repeated names", () => {
  const text = "小李今天去了小院，后来小李也在那里吃饭。";
  const result = groups(text);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]!.candidates.map(c => [c.text, c.start, c.end]), [["小李", 0, 2], ["小院", 6, 8], ["小李", 11, 13]]);
  assert.equal(text.slice(result[0]!.start, result[0]!.end), text);
});

test("sentence boundaries, paragraphs and distant occurrences stay separate", () => {
  for (const separator of ["。", "！", "？", "!", "?", "\n", "\r\n", "很远".repeat(40)]) {
    assert.equal(groups(`小李${separator}小院`).length, 2, JSON.stringify(separator));
  }
  const result = groups("前一段\n今天小李去了小院\n后一段");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.start, 4);
  assert.equal(result[0]!.end, 12);
});

test("chained nearby matches cannot grow into a whole diary excerpt", () => {
  const text = Array.from({ length: 30 }, () => "小李" + "其他正文".repeat(8)).join("");
  const result = groups(text);
  assert.ok(result.length > 1);
  assert.equal(result.flatMap(g => g.candidates).length, 30);
  for (const group of result) {
    assert.ok(group.end - group.start <= 160);
    assert.ok(group.candidates[group.candidates.length - 1]!.end - group.candidates[0]!.start <= 96);
  }
});

test("source order, explicit markers and emoji offsets survive grouping", () => {
  const text = "🌿今天@小李去了#小院，@小李很开心";
  const candidates = findEntityCandidates(text, entities);
  const reversed = [...candidates].reverse();
  const result = groupMentionContexts(text, reversed);
  assert.deepEqual(result.flatMap(g => g.candidates), candidates);
  assert.deepEqual(reversed, [...candidates].reverse());
  for (const candidate of result[0]!.candidates) assert.equal(text.slice(candidate.start, candidate.end), candidate.text);
  assert.deepEqual(groupMentionContexts("没有标记", []), []);
});
