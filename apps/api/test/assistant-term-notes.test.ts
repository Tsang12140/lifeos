import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TimelineRecord } from "@lifeos/core";
import { readConfig } from "../src/config.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { matchesJournalTerm, retrieveJournals } from "../src/journal-retrieval.js";
import { applyTermNote, assistantTermContext, recordTermAsks, unexplainedTokens } from "../src/assistant-term-notes.js";

const record = (id: string, text: string, extra: Partial<TimelineRecord> = {}): TimelineRecord => ({ id, kind: "journal", body: { original: text }, createdAt: { kind: "instant", value: "2026-10-01T00:00:00Z" }, occurredAt: { kind: "date", value: "2026-10-02" }, entityRefs: [], relatedRecordIds: [], assetRefs: [], aiDerived: [], ...extra } as TimelineRecord);

function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-term-notes-"));
  const repository = new SqliteRecordRepository(join(root, "lifeos.sqlite"));
  const config = readConfig({ LIFEOS_DATA_DIR: root, LIFEOS_ASSET_ROOT: join(root, "assets") });
  t.after(() => { repository.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { repository, config };
}

test("an ASCII term matches on word boundaries so one shorthand cannot widen into unrelated English", () => {
  assert.equal(matchesJournalTerm("he likes words and funds", "ds"), false);
  assert.equal(matchesJournalTerm("今天 ds 了两次", "ds"), true);
  assert.equal(matchesJournalTerm("今天DS了两次".toLowerCase(), "ds"), true);
  assert.equal(matchesJournalTerm("ds5 不算", "ds"), false);
  // Chinese has no separators, so it stays a substring test.
  assert.equal(matchesJournalTerm("我最近读书很稳定", "读书"), true);
});

test("an unexplained shorthand is offered once per day and never becomes an explanation on its own", async t => {
  const { repository } = fixture(t);
  const first = assistantTermContext(repository, "我最近 DS 了几次", "2026-11-06");
  assert.deepEqual(first.unknownTokens, ["DS"]);
  assert.deepEqual(first.notes, []);
  // Nothing was confirmed, so nothing is expanded: guessing is how counts go wrong.
  assert.deepEqual(first.expansionTerms, []);

  recordTermAsks(repository, first.unknownTokens, "2026-11-06");
  assert.deepEqual(assistantTermContext(repository, "我最近 DS 了几次", "2026-11-06").unknownTokens, []);
  // A new day is allowed to surface it again.
  assert.deepEqual(assistantTermContext(repository, "我最近 DS 了几次", "2026-11-07").unknownTokens, ["DS"]);
});

test("a confirmed phrase is injected only when the message touches it, in both directions", async t => {
  const { repository } = fixture(t);
  repository.saveTermNote({ term: "ds", displayTerm: "DS", meaning: "读书", at: "2026-11-06" });

  const byShorthand = assistantTermContext(repository, "我最近 DS 了几次", "2026-11-06");
  assert.deepEqual(byShorthand.notes, [{ term: "DS", meaning: "读书" }]);
  assert.deepEqual(byShorthand.unknownTokens, []);
  assert.deepEqual(byShorthand.expansionTerms, ["读书"]);

  const byMeaning = assistantTermContext(repository, "我最近读书怎么样", "2026-11-06");
  assert.deepEqual(byMeaning.notes, [{ term: "DS", meaning: "读书" }]);
  assert.deepEqual(byMeaning.expansionTerms, ["ds"]);

  // An unrelated question carries nothing: that is the whole point of the table.
  const unrelated = assistantTermContext(repository, "上一次亲密是什么时候", "2026-11-06");
  assert.deepEqual(unrelated.notes, []);
  assert.deepEqual(unrelated.expansionTerms, []);
});

test("a name the owner already gave an object is not treated as a shorthand", async t => {
  const { repository } = fixture(t);
  const current = repository.cycleIntimacyModule().config;
  repository.writeCycleIntimacyConfig({ ...current, habits: [{ id: "h1", name: "DS", icon: "BookOpen", revision: 1, dates: ["2026-10-02"] }] });
  assert.deepEqual(assistantTermContext(repository, "我最近 DS 打卡了吗", "2026-11-06").unknownTokens, []);
});

test("a shorthand found in a record outranks ordinary English words in the same record", async t => {
  const { repository } = fixture(t);
  // The model reads `token` and `exif` without help; a caps fragment is what it
  // would actually have to ask about, so that one has to survive the cap.
  const tokens = unexplainedTokens(repository, ["顺手调了下 token 和 exif，今天 DS 了两次，RE 又去了"], "2026-11-06");
  assert.deepEqual(tokens.slice(0, 2), ["DS", "RE"]);
});

test("a term note is written only when the owner's own message contains the shorthand", async t => {
  const { repository } = fixture(t);
  const invented = applyTermNote(repository, { term: "RE", meaning: "跑步" }, "我最近读书怎么样", "2026-11-06");
  assert.equal(invented, undefined);
  assert.deepEqual(repository.listTermNotes(), []);

  const told = applyTermNote(repository, { term: "RE", meaning: "跑步" }, "RE 就是跑步，记一下", "2026-11-06");
  assert.ok(told?.includes("RE ＝ 跑步"));
  assert.deepEqual(repository.listTermNotes().map(note => [note.term, note.meaning]), [["re", "跑步"]]);

  // Saying it again corrects it instead of adding a second meaning.
  applyTermNote(repository, { term: "RE", meaning: "骑车" }, "说错了，RE 是骑车", "2026-11-07");
  assert.deepEqual(repository.listTermNotes().map(note => note.meaning), ["骑车"]);
  assert.equal(repository.deleteTermNote("re"), true);
  assert.deepEqual(repository.listTermNotes(), []);
});

test("a confirmed shorthand lets a question in plain words reach a record written only in shorthand", async t => {
  const { repository, config } = fixture(t);
  repository.insert(record("shorthand", "今天 DS 了两次，第二章看完了"));
  repository.insert(record("noise", "买了个 words 键盘，funds 也到账了"));

  const withoutExpansion = await retrieveJournals(config, repository, "我最近读书怎么样", "2026-11-06");
  assert.equal(withoutExpansion.candidates.length, 0);

  const withExpansion = await retrieveJournals(config, repository, "我最近读书怎么样", "2026-11-06", undefined, false, false, undefined, ["ds"]);
  assert.deepEqual(withExpansion.candidates.map(hit => hit.id), ["shorthand"]);
});
