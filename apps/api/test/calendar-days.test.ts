import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createInstant, type Asset, type TimelineRecord, type DaySummary } from "@lifeos/core";
import { SqliteRecordRepository } from "../src/repository.js";
import { CalendarDays, calendarAssetVersion, nextCalendarMidnight } from "../src/calendar-days.js";
import { resolveDaySummaries } from "../src/summary.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lifeos-calendar-days-")), path = join(root, "lifeos.sqlite");
  const repository = new SqliteRecordRepository(path);
  const image = join(root, "image.webp");
  await sharp({ create: { width: 192, height: 144, channels: 3, background: "orange" } }).webp().toFile(image);
  const calls: Array<[string, number]> = [];
  const options = { repository, thumbnail: async (id: string, width: number) => { calls.push([id, width]); return image; }, summaries: async () => {} };
  const service = new CalendarDays(path, options);
  const asset = (id: string) => { const a: Asset = { id, kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: id + ".webp" }] }; repository.insertAsset(a); return a; };
  const diary = (id: string, ids: string[], at: string, extra: Partial<TimelineRecord> = {}) => {
    const r = { id, kind: "journal", createdAt: createInstant(at), occurredAt: { kind: "date", value: "2026-10-09" }, body: { original: id }, entityRefs: [], relatedRecordIds: [], assetRefs: ids.map(assetId => ({ assetId, role: "photo" })), aiDerived: [], ...extra } as TimelineRecord;
    repository.insert(r); return repository.findById(id)!;
  };
  return { root, path, repository, service, options, calls, asset, diary,
    close: () => { service.close(); repository.close(); if (!root.startsWith(join(tmpdir(), "lifeos-calendar-days-"))) throw Error("test cleanup escaped"); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test("daily artwork freezes the first photo diary, finalizes once, and survives restart without decoding", async () => {
  const f = await fixture();
  try {
    const photos = Array.from({ length: 8 }, (_, i) => f.asset("p" + i));
    f.diary("text-first", [], "2026-10-09T00:00:00Z");
    f.diary("private-first", ["p7"], "2026-10-09T00:01:00Z", { isPrivate: true });
    f.diary("photo-first", ["p0", "p1"], "2026-10-09T00:02:00Z");
    const initial = (await f.service.resolve(["2026-10-09"], new Date("2026-10-09T15:00:00Z")))[0]!;
    assert.equal(initial.phase, "provisional"); assert.equal(initial.firstRecordId, "photo-first");
    assert.deepEqual(initial.weekPhotos.map(p => p.assetId), ["p0", "p1"]);
    const calls = f.calls.length;
    f.repository.updateAsset({ ...photos[0]!, lastUsedAt: createInstant("2026-10-09T02:00:00Z") });
    assert.deepEqual(await f.service.resolve(["2026-10-09"], new Date("2026-10-09T15:30:00Z")), [initial], "reusing an upload only changes lastUsedAt, never the frozen cover");
    assert.equal(f.calls.length, calls);
    f.diary("later", photos.slice(2).map(p => p.id), "2026-10-09T01:00:00Z");
    const again = (await f.service.resolve(["2026-10-09"], new Date("2026-10-09T15:59:59Z")))[0]!;
    assert.deepEqual(again, initial); assert.equal(f.calls.length, calls, "later diary adds zero thumbnail work");
    const final = (await f.service.resolve(["2026-10-09"], new Date("2026-10-09T16:00:00Z")))[0]!;
    assert.equal(final.phase, "final"); assert.notEqual(final.sourceHash, initial.sourceHash);
    assert.deepEqual(final.weekPhotos.map(p => p.assetId), ["p0", "p2", "p5", "p7"]);
    assert.ok(final.monthPhoto); assert.equal(Object.keys(final.monthCovers).length, 7);
    const after = f.calls.length;
    assert.deepEqual(await f.service.resolve(["2026-10-09"], new Date("2026-10-11T00:00:00Z")), [final]);
    assert.equal(f.calls.length, after);
    const reopened = new CalendarDays(f.path, f.options);
    try { assert.deepEqual(await reopened.resolve(["2026-10-09"], new Date("2026-10-11T00:00:00Z")), [final]); assert.equal(f.calls.length, after, "restart does not score or warm again"); } finally { reopened.close(); }
  } finally { f.close(); }
});

test("history edits, privacy, deletion, hidden demos and tenant versions invalidate only their sources", async () => {
  const f = await fixture();
  try {
    const a = f.asset("a"), b = f.asset("b");
    const r = f.diary("owner", [a.id], "2026-10-09T00:00:00Z");
    f.diary("demo", [b.id], "2026-10-09T01:00:00Z", { isDemo: true });
    const now = new Date("2026-10-10T00:00:00Z");
    const hidden = (await f.service.resolve(["2026-10-09"], now, true))[0]!;
    assert.deepEqual(hidden.weekPhotos.map(p => p.assetId), [a.id]);
    assert.equal((await f.service.resolve(["2026-10-09"], now))[0]!.weekPhotos.length, 2);
    f.repository.update({ ...r, isPrivate: true }, r.revision);
    const privateDay = (await f.service.resolve(["2026-10-09"], now, true))[0]!;
    assert.equal(privateDay.monthPhoto, undefined); assert.equal(privateDay.weekPhotos.length, 0);
    const latest = f.repository.findById(r.id)!;
    f.repository.update({ ...latest, isPrivate: false, assetRefs: [{ assetId: b.id, role: "photo" }] }, latest.revision);
    const changed = (await f.service.resolve(["2026-10-09"], now, true))[0]!;
    assert.equal(changed.monthPhoto?.assetId, b.id); assert.notEqual(changed.sourceHash, hidden.sourceHash);
    assert.notEqual(calendarAssetVersion("tenant-a", a), calendarAssetVersion("tenant-b", a));
    assert.notEqual(calendarAssetVersion("tenant-a", a), calendarAssetVersion("tenant-a", { ...a, storageRefs: b.storageRefs }));
    f.repository.softDelete(r.id, f.repository.findById(r.id)!.revision, JSON.stringify(createInstant(now.toISOString())));
    assert.equal((await f.service.resolve(["2026-10-09"], now, true))[0]!.monthPhoto, undefined);
    assert.equal((await f.service.resolve(["2026-10-11"], now)).length, 0, "future is never generated");
  } finally { f.close(); }
});

test("a privacy change during photo decoding cannot publish the old photo", async () => {
  const f = await fixture();
  let racing: CalendarDays | undefined;
  try {
    f.asset("a"); const r = f.diary("race", ["a"], "2026-10-09T00:00:00Z");
    let once = false;
    racing = new CalendarDays(f.path, { ...f.options, thumbnail: async (id, width) => {
      if (!once) { once = true; f.repository.update({ ...r, isPrivate: true }, r.revision); }
      return f.options.thumbnail(id, width);
    } });
    const interrupted = (await racing.resolve(["2026-10-09"], new Date("2026-10-10T00:00:00Z")))[0]!;
    assert.equal(interrupted.monthPhoto, undefined); assert.ok(interrupted.retryAfter);
    assert.equal((await racing.resolve(["2026-10-09"], new Date("2026-10-10T00:00:00Z")))[0]!.monthPhoto, undefined);
  } finally { racing?.close(); f.close(); }
});

test("Shanghai rollover is exact and the provisional text is persisted until the final review", async () => {
  assert.equal(nextCalendarMidnight(new Date("2026-10-09T15:59:59Z")), Date.parse("2026-10-09T16:00:00Z"));
  assert.equal(nextCalendarMidnight(new Date("2026-10-09T16:00:00Z")), Date.parse("2026-10-10T16:00:00Z"));
  const f = await fixture();
  try {
    const first = f.diary("first", [], "2026-10-09T00:00:00Z");
    const second = f.diary("second", [], "2026-10-09T01:00:00Z");
    let sources = [first], calls = 0;
    const request = { dates: ["2026-10-09"], cache: f.repository, recordsForDate: () => sources, provider: { providerId: "fake", kind: "ai" as const, summarizeDays: async () => { calls++; return [{ date: "2026-10-09", text: "完整的一天" }]; } } };
    const initial = await resolveDaySummaries({ ...request, today: "2026-10-09" });
    assert.equal(calls, 0); assert.ok(f.repository.readDaySummary("2026-10-09"));
    sources = [second, first];
    assert.deepEqual(await resolveDaySummaries({ ...request, today: "2026-10-09" }), initial);
    const explicit = await resolveDaySummaries({ ...request, today: "2026-10-09", force: true });
    assert.equal(calls, 1);
    assert.deepEqual(await resolveDaySummaries({ ...request, today: "2026-10-09" }), explicit, "explicit regeneration survives browsing today");
    const final = await resolveDaySummaries({ ...request, today: "2026-10-10" });
    assert.equal(calls, 2); assert.equal(final[0]!.text, "完整的一天");
    assert.deepEqual(await resolveDaySummaries({ ...request, today: "2026-10-11" }), final); assert.equal(calls, 2);
    const manual = { ...final[0]!, status: "manual", provider: "manual", text: "我手写的" } as DaySummary;
    f.repository.writeDaySummary(manual);
    assert.deepEqual(await resolveDaySummaries({ ...request, today: "2026-10-11" }), [manual]);
  } finally { f.close(); }
});

test("slow summary generation cannot restore text after the source becomes private", async () => {
  const f = await fixture();
  try {
    const record = f.diary("private-race", [], "2026-10-09T00:00:00Z");
    let latest = [record];
    const items = await resolveDaySummaries({ dates: ["2026-10-09"], today: "2026-10-10", cache: f.repository,
      recordsForDate: () => [record], latestRecordsForDate: () => latest,
      provider: { providerId: "fake", kind: "ai", summarizeDays: async () => { latest = []; return [{ date: "2026-10-09", text: "不该再出现的内容" }]; } } });
    assert.deepEqual(items, []); assert.equal(f.repository.readDaySummary("2026-10-09"), null);
  } finally { f.close(); }
});
