import test from "node:test";
import assert from "node:assert/strict";
import { mergeBodies } from "../src/edit-conflict.ts";

test("identical bodies need no decision", () => {
  assert.deepEqual(mergeBodies("a", "a", "a"), { kind: "same" });
  assert.deepEqual(mergeBodies("a", "a\nb", "a\nb"), { kind: "same" });
});

test("a body this device never touched takes the other side's text", () => {
  // The reported case: the phone added a photo and never edited the words, the
  // computer added a sentence. The sentence has to survive the save.
  assert.deepEqual(mergeBodies("原文", "原文", "原文\n电脑加的一句话"), { kind: "take-theirs", text: "原文\n电脑加的一句话" });
});

test("a body the other side never touched keeps this draft", () => {
  assert.deepEqual(mergeBodies("原文", "原文\n手机加的图注", "原文"), { kind: "keep-mine" });
});

test("two-sided body edits stay a conflict instead of picking a winner", () => {
  assert.deepEqual(mergeBodies("原文", "原文\n手机写的", "原文\n电脑写的"), { kind: "conflict" });
});

test("an empty base is still compared, not treated as unset", () => {
  assert.deepEqual(mergeBodies("", "", "别处写的第一句"), { kind: "take-theirs", text: "别处写的第一句" });
  assert.deepEqual(mergeBodies("", "我写的第一句", ""), { kind: "keep-mine" });
  assert.deepEqual(mergeBodies("", "我写的", "别处写的"), { kind: "conflict" });
});

test("whitespace differences count as real edits", () => {
  assert.deepEqual(mergeBodies("原文", "原文 ", "原文"), { kind: "keep-mine" });
  assert.deepEqual(mergeBodies("原文", "原文", "原文 "), { kind: "take-theirs", text: "原文 " });
});
