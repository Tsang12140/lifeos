import test from "node:test";
import assert from "node:assert/strict";
import { contactJournalExcerpt, contactJournalPreviews } from "../src/contact-dossier-model.ts";
import type { RecordView } from "../src/api.ts";

function journal(id: string, value: string, extra: Partial<RecordView> = {}): RecordView {
  return { id, kind: "journal", revision: 1, body: { original: id }, createdAt: { kind: "instant", value: "2026-10-16T00:00:00Z" }, occurredAt: { kind: "instant", value }, entityRefs: [{ entityId: "person-a", entityType: "person" }], assetRefs: [], ...extra } as RecordView;
}

test("long journal excerpts have bounded DOM text without splitting Unicode code points", () => {
  const source = "🦊".repeat(300_000);
  const excerpt = contactJournalExcerpt(source);
  assert.equal(excerpt, "🦊".repeat(180) + "…");
  assert.equal([...excerpt].length, 181);
  assert.equal(contactJournalExcerpt("  短日记\n "), "短日记");
  assert.equal(contactJournalExcerpt(" \n "), "");
  assert.equal(contactJournalExcerpt("字".repeat(180)), "字".repeat(180));
});
test("contact preview chooses actual journal life time, independent of backfill order, with second precision", () => {
  const old = journal("old-backfill", "2025-01-01T00:00:00Z");
  const earlier = journal("z-earlier", "2026-10-15T16:01:01Z");
  const latest = journal("a-latest", "2026-10-15T16:01:02Z");
  for (const list of [[old, latest, earlier], [earlier, old, latest]]) assert.equal(contactJournalPreviews(list, false, false).get("person-a")?.id, latest.id);
});
test("contact previews filter private/demo data and exclude tasks/notes", () => {
  const publicRecord = journal("public", "2026-10-12T00:00:00Z");
  const privateRecord = journal("private", "2026-10-13T00:00:00Z", { isPrivate: true });
  const demo = journal("demo", "2026-10-14T00:00:00Z", { isDemo: true });
  const records = [publicRecord, privateRecord, demo, journal("task", "2026-10-16T00:00:00Z", { kind: "task" }), journal("note", "2026-10-16T00:00:00Z", { kind: "note" })];
  assert.equal(contactJournalPreviews(records, false, true).get("person-a")?.id, "public");
  assert.equal(contactJournalPreviews(records, true, true).get("person-a")?.id, "private");
  assert.equal(contactJournalPreviews(records, false, false).get("person-a")?.id, "demo");
});
test("Shanghai calendar dates and local wall clocks compare consistently across UTC midnight", () => {
  const dated = journal("date", "", { occurredAt: { kind: "date", value: "2026-10-16" } });
  const before = journal("before", "2026-10-15T15:59:59Z");
  const local = journal("local", "", { occurredAt: { kind: "local", value: "2026-10-16T00:00:01" } });
  assert.equal(contactJournalPreviews([before, dated], false, false).get("person-a")?.id, "date");
  assert.equal(contactJournalPreviews([dated, before, local], false, false).get("person-a")?.id, "local");
});
test("a shared journal reaches each linked person but never a place or unknown contact", () => {
  const shared = journal("shared", "2026-10-16T00:00:00Z", { entityRefs: [{ entityType: "person", entityId: "person-a" }, { entityType: "person", entityId: "person-b" }, { entityType: "place", entityId: "place" }] });
  const result = contactJournalPreviews([shared], false, false);
  assert.deepEqual([...result.keys()], ["person-a", "person-b"]);
  assert.equal(result.get("unused"), undefined);
});
