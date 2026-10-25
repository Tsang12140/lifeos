import assert from "node:assert/strict";
import test from "node:test";
import { wrapShareParagraph, type ShareWrapToken } from "../src/assistant-share-wrap.ts";

const tokens = (text: string): ShareWrapToken[] => [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(text)].map(({ segment }) => ({ text: segment, kind: "text" }));
function layout(text: string, width: number, title = false, canTrack = true) {
  const parts = tokens(text);
  const result = wrapShareParagraph(parts, width, (start, end, tracking) => (end - start) * (10 + tracking), 10, title, canTrack);
  return { ...result, text: result.lines.map(line => parts.slice(line.start, line.end).map(part => part.text).join("")) };
}
test("two-line heading pauses at punctuation instead of stranding its last character", () => {
  const title = "从我的这个月的日记里，找个有意思的小事儿";
  assert.deepEqual(layout(title, 190, true).text, ["从我的这个月的日记里，", "找个有意思的小事儿"]);
});
test("four-line paragraph may contract slightly to three full lines, never balanced stairs", () => {
  const text = "字".repeat(70);
  const result = layout(text, 239);
  assert.equal(result.lines.length, 3);
  assert.ok(result.tracking < 0 && result.tracking >= -.2);
  assert.deepEqual(result.text.map(line => line.length), [24, 24, 22]);
  assert.equal(result.text.join(""), text);
});
test("when tightening cannot remove a line, move at most two characters from the preceding line", () => {
  const text = "字".repeat(61), result = layout(text, 200);
  assert.equal(result.tracking, 0);
  assert.deepEqual(result.text.map(line => line.length), [20, 20, 18, 3]);
  assert.equal(result.text.join(""), text);
  assert.deepEqual(layout("字".repeat(70), 230, false, false).text.map(line => line.length), [23, 23, 21, 3]);
});
test("closing punctuation stays with preceding text and opening punctuation with following text", () => {
  for (const text of ["字".repeat(20) + "”，继续说完。", "字".repeat(19) + "“接着说完。", "字".repeat(20) + "？！继续说完。"] ) {
    const result = layout(text, 200);
    assert.equal(result.text.join(""), text);
    assert.ok(result.text.every(line => !/^[”，？！]/u.test(line) && !/“$/u.test(line)), result.text.join("/"));
  }
});
test("moving two content characters also carries attached closing punctuation", () => {
  const text = "字".repeat(18) + "”，尾", result = layout(text, 200);
  assert.deepEqual(result.text, ["字".repeat(16), "字字”，尾"]);
  assert.equal(result.text.join(""), text);
});
test("ordinary paragraphs keep natural tracking and grapheme boundaries", () => {
  const text = "今天很安静。👩‍👩‍👧‍👦";
  const result = layout(text, 60);
  assert.equal(result.tracking, 0);
  assert.equal(result.text.join(""), text);
  assert.ok(result.text.some(line => line.includes("👩‍👩‍👧‍👦")));
});
