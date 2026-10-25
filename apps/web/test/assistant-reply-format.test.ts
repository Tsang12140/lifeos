import test from "node:test";
import assert from "node:assert/strict";
import { replyParagraphs } from "../src/assistant-reply-format.ts";
import { citationParts } from "../src/assistant-citations-model.ts";
import type { UiOffer } from "@lifeos/core";

test("reply paragraphs preserve single line breaks, literal backslash-n and citation order across emphasis", () => {
  const paragraphs = replyParagraphs("先说**关键[1]判断**。\r\n\r\n依据在这里[1]。\n接着读。\n \n建议保留。");
  assert.equal(paragraphs.length, 3);
  assert.equal(paragraphs[1]!.map(run => run.text).join(""), "依据在这里[1]。\n接着读。");
  const offers: UiOffer[] = [{ label: "来源 1 2026-10-18", command: { type: "record.focus", params: { recordId: "actual" } } }];
  const citations = paragraphs.flatMap(paragraph => paragraph.flatMap(run => citationParts(run.text, offers))).filter(part => part.source);
  assert.deepEqual(citations.map(part => part.source), [offers[0], offers[0]]);
  assert.equal(paragraphs[0]!.find(run => run.strong)?.text, "关键[1]判断");
  assert.equal(replyParagraphs("路径\\n\\n不是换段").length, 1);
});

test("emphasis stays sparse across the whole reply; whole paragraphs and long spans remain ordinary text", () => {
  const paragraphs = replyParagraphs("**整段强调**\n\n先**一处**，再**两处**。\n\n还有**第三处**。" + "**" + "长".repeat(41) + "**");
  assert.deepEqual(paragraphs.flatMap(paragraph => paragraph.filter(run => run.strong).map(run => run.text)), ["一处", "两处"]);
  assert(paragraphs.flat().every(run => !run.text.includes("**")));
  assert.equal(paragraphs[0]![0]!.strong, false);
});

test("stream fragments and untrusted HTML remain text; empty streaming frames create no blank paragraphs", () => {
  assert.deepEqual(replyParagraphs("\n\n  \n"), []);
  assert.deepEqual(replyParagraphs("**未完成[1"), [[{ text: "**未完成[1", strong: false }]]);
  assert.deepEqual(replyParagraphs("<img src=x onerror=alert(1)>\n\n<script>bad()</script>"), [[{ text: "<img src=x onerror=alert(1)>", strong: false }], [{ text: "<script>bad()</script>", strong: false }]]);
});
