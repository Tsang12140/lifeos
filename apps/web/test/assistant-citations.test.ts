import test from "node:test";
import assert from "node:assert/strict";
import type { UiOffer } from "@lifeos/core";
import { citationParts } from "../src/assistant-citations-model.ts";
import { assistantCitationRanges, hasOrphanAssistantCitation } from "@lifeos/core";

test("only verified complete citations become controls; repeated numbers keep the same record", () => {
  const offers: UiOffer[] = [{ label: "来源 1 2026-10-18", command: { type: "record.focus", params: { recordId: "actual" } } }];
  const parts = citationParts("事实[1]，再次引用[1]；[2]不存在，[2026]是普通文字。", offers);
  assert.deepEqual(parts.filter(p => p.source).map(p => p.source?.command), [offers[0]!.command, offers[0]!.command]);
  assert(parts.some(p => p.text.includes("不存在，[2026]")));
  assert.deepEqual(citationParts("未完成[1", offers), [{ text: "未完成[1" }]);
  assert.deepEqual(citationParts("普通聊天[1]"), [{ text: "普通聊天" }]);
  assert.deepEqual(citationParts("已核实[1]，缺映射[2]。", offers), [
    { text: "已核实" }, { text: "[1]", source: offers[0] }, { text: "，缺映射" }, { text: "。" },
  ]);
});

test("orphan source markers are structural warnings, while code and links remain content", () => {
  for (const text of ["[1]。只剩评价。", "**[2]**接着说。", "先有正文。\n\n[1]", "正文已经说完。\n[1][2]。\n接下来。"]) assert(hasOrphanAssistantCitation(text), text);
  for (const text of ["事情已经讲清楚[1]。", "第一行事实\n第二行事实[2]。", "示例：`[1]`。", "```json\n[1]\n\n[2]\n```", "[1](https://example.test)", "\\[1]", "[2026]不是出处号"]) assert.equal(hasOrphanAssistantCitation(text), false, text);
  const example = "示例 `[1]`。\n```js\n[2]\n```\n实际事实[3]。";
  assert.deepEqual(assistantCitationRanges(example).map(r => r.number), [3]);
  assert.equal(citationParts(example).map(p=>p.text).join(""), "示例 `[1]`。\n```js\n[2]\n```\n实际事实。");
});
