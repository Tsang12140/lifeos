import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createInstant, PHOTO_WALL_ENABLED, PHOTO_WALL_DEFAULTS, photoWallLayout, type Asset, type TimelineRecord } from "@lifeos/core";
import { renderCalendarPhotoWall } from "../src/calendar-background-renderer.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { CalendarBackgrounds, backgroundTier, nextBackgroundNight } from "../src/calendar-backgrounds.js";
import { calendarAssetVersion } from "../src/calendar-days.js";
import { backgroundNamespace, backgroundSourceVersion, legacyBackgroundNamespaces } from "../src/calendar-background-source.js";

const now = new Date("2026-10-10T04:00:00Z");
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lifeos-month-background-"));
  const repository = new SqliteRecordRepository(join(root, "lifeos.sqlite"));
  const photo = join(root, "small.webp");
  await sharp({ create: { width: 400, height: 300, channels: 3, background: "#cf9274" } }).webp().toFile(photo);
  let calls = 0;
  // Keep the shelved scheduler covered through an explicit fixture-only opt-in.
  const options = { enabled: true, automaticGeneration: true, repository, assetVersion: (asset: Asset) => JSON.stringify(asset.storageRefs), thumbnail: async (_id: string) => { calls++; return photo; } };
  const service = new CalendarBackgrounds(root, options);
  const add = (n: number, month = "2026-10", extra: Partial<TimelineRecord> = {}) => {
    const start = repository.listAssets().length;
    const ids = Array.from({ length: n }, (_, i) => `p${start + i}`);
    for (const id of ids) repository.insertAsset({ id, kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: `${id}.webp` }] });
    const id = `r${start}`;
    repository.insert({ id, kind: "journal", body: { original: "x".repeat(100_000) }, createdAt: createInstant("2026-10-01T00:00:00Z"),
      occurredAt: { kind: "date", value: month + "-02" }, entityRefs: [], assetRefs: ids.map(assetId => ({ assetId, role: "photo" })), relatedRecordIds: [], aiDerived: [], ...extra } as TimelineRecord);
    return repository.findById(id)!;
  };
  return { root, service, repository, add, options, calls: () => calls, close() {
    service.close(); repository.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + "lifeos-month-background-"));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

test("night schedule uses Shanghai time and real source-photo tier thresholds", () => {
  assert.equal(nextBackgroundNight(new Date("2026-10-10T15:59:59Z")), Date.parse("2026-10-10T16:00:00Z"));
  assert.equal(nextBackgroundNight(new Date("2026-10-10T16:00:00Z")), Date.parse("2026-10-11T16:00:00Z"));
  assert.deepEqual([0, 8, 9, 10, 12, 14, 15, 18, 20, 21, 26, 27, 47, 60, 63, 100].map(backgroundTier), [0, 0, 9, 9, 9, 9, 15, 15, 15, 21, 21, 27, 45, 57, 63, 99]);
});

test("with the photo wall explicitly enabled, its scheduler is still shelved by default and cached/manual/privacy behavior survives", async () => {
  const f = await fixture(); let paused: CalendarBackgrounds | undefined, reopened: CalendarBackgrounds | undefined;
  try {
    const record = f.add(9);
    const first = await f.service.generateNow("2026-10", false, now);
    const image = f.service.file("2026-10", false, first.version!, now)!;
    const bytes = readFileSync(image);
    f.add(6);
    const scheduled = f.service.status("2026-10", false, now);
    assert.equal(scheduled.automaticGeneration, true); assert.ok(scheduled.dueAt);
    f.service.close();
    const { automaticGeneration: _fixtureOptIn, ...options } = f.options;
    paused = new CalendarBackgrounds(f.root, options); paused.start();
    const state = join(f.root, "derived", "calendar-backgrounds", "state.json");
    assert.ok(JSON.parse(readFileSync(state, "utf8")).every((entry: { dueAt?: number; retryAt?: number }) => entry.dueAt === undefined && entry.retryAt === undefined));
    const parked = paused.status("2026-10", false, now);
    assert.equal(parked.automaticGeneration, false); assert.equal(parked.pending, false); assert.equal(parked.dueAt, null);
    assert.equal(parked.count, 15); assert.equal(parked.version, first.version); assert.deepEqual(readFileSync(image), bytes);
    const before = f.calls();
    await paused.tick(new Date(scheduled.dueAt!)); await paused.tick(new Date(scheduled.dueAt! + 30 * 86_400_000));
    paused.changed(); await new Promise(resolve => setTimeout(resolve, 350));
    paused.savePreferences({ ...PHOTO_WALL_DEFAULTS, seed: 2 }, now);
    assert.equal(f.calls(), before); assert.equal(paused.status("2026-10", false, now).pending, false);
    assert.equal(paused.status("2026-10", false, now).version, first.version);
    const manual = await paused.generateNow("2026-10", false, now);
    assert.equal(manual.renderedPhotos, 15); assert.equal(manual.pending, false); assert.equal(manual.automaticGeneration, false);
    assert.equal(f.calls(), before + 15); assert.notEqual(manual.version, first.version);
    paused.close(); reopened = new CalendarBackgrounds(f.root, options); reopened.start();
    assert.equal(reopened.status("2026-10", false, now).version, manual.version);
    f.repository.update({ ...record, isPrivate: true }, record.revision);
    const privateStatus = reopened.status("2026-10", false, now, manual.version!);
    assert.equal(privateStatus.imageUrl, null); assert.equal(privateStatus.valid, false); assert.equal(privateStatus.pending, false);
    assert.equal(reopened.file("2026-10", false, manual.version!, now), null);
  } finally { reopened?.close(); paused?.close(); f.close(); }
});

test("the whole photo wall is shelved by default without deleting saved settings or cached artwork", async () => {
  const f = await fixture(); let parked: CalendarBackgrounds | undefined;
  try {
    assert.equal(PHOTO_WALL_ENABLED, false);
    f.add(15);
    f.service.savePreferences({ ...PHOTO_WALL_DEFAULTS, veil: 78 }, now);
    const ready = await f.service.generateNow("2026-10", false, now);
    const file = f.service.file("2026-10", false, ready.version!, now)!;
    const bytes = readFileSync(file), settings = readFileSync(join(f.root, "calendar-background-config.json"));
    f.service.close();
    const { enabled: _fixtureOptIn, ...options } = f.options;
    parked = new CalendarBackgrounds(f.root, options); parked.start();
    assert.equal(parked.enabled, false);
    const status = parked.status("2026-10", false, now, ready.version!);
    assert.equal(status.enabled, false); assert.equal(status.imageUrl, null); assert.equal(status.version, null); assert.equal(status.valid, false);
    assert.equal(status.automaticGeneration, false); assert.equal(status.pending, false); assert.equal(status.dueAt, null);
    assert.equal(parked.file("2026-10", false, ready.version!, now), null);
    assert.throws(() => parked!.savePreferences(PHOTO_WALL_DEFAULTS, now), /background_disabled/);
    await assert.rejects(parked.preview("2026-10", false, now), /background_disabled/);
    await assert.rejects(parked.generateNow("2026-10", false, now), /background_disabled/);
    const before = f.calls(); parked.changed(); await parked.tick(new Date(nextBackgroundNight(now)));
    assert.equal(f.calls(), before); assert.deepEqual(readFileSync(file), bytes);
    assert.deepEqual(readFileSync(join(f.root, "calendar-background-config.json")), settings);
    const entry = JSON.parse(readFileSync(join(f.root, "derived", "calendar-backgrounds", "state.json"), "utf8"))[0];
    assert.equal(entry.image.version, ready.version); assert.equal(entry.image.sources.length, 15);
  } finally { parked?.close(); f.close(); }
});

test("background identities normalize Windows spelling only and use actual content rather than reference metadata", () => {
  const upper = "E:\\Projects\\LifeOS\\data\\lifeos.sqlite", lower = "e:\\projects\\lifeos\\data\\lifeos.sqlite";
  assert.equal(backgroundNamespace(upper, "win32"), backgroundNamespace(lower, "win32"));
  assert.notEqual(backgroundNamespace("/spaces/A/lifeos.sqlite", "linux"), backgroundNamespace("/spaces/a/lifeos.sqlite", "linux"));
  assert.notEqual(backgroundNamespace("E:\\spaces\\a", "win32"), backgroundNamespace("E:\\spaces\\b", "win32"));
  assert.ok(legacyBackgroundNamespaces(upper, "win32").includes(upper.replace(/^E:/, "e:")));
  const asset: Asset = { id: "photo", kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: "photo.webp", contentHash: { algorithm: "sha256", value: "a".repeat(64) } }] };
  const version = backgroundSourceVersion(asset, "old-path");
  assert.equal(backgroundSourceVersion({ ...asset, storageRefs: [{ ...asset.storageRefs[0]!, mediaType: "image/webp" }] }, "new-path"), version);
  assert.notEqual(backgroundSourceVersion({ ...asset, storageRefs: [{ ...asset.storageRefs[0]!, contentHash: { algorithm: "sha256", value: "b".repeat(64) } }] }, "new-path"), version);
  assert.equal(backgroundSourceVersion({ ...asset, storageRefs: [{ sourceId: "local", sourceRef: "photo.webp" }] }, "file-stat-version"), "file-stat-version");
});

test("manual generation uses the current completed six-photo tier, ignores legacy caps and exceeds 60 photos", async () => {
  const f = await fixture(); let reopened: CalendarBackgrounds | undefined;
  try {
    assert.equal(PHOTO_WALL_DEFAULTS.veil, 96);
    writeFileSync(join(f.root, "calendar-background-config.json"), JSON.stringify({ ...PHOTO_WALL_DEFAULTS, veil: 78, seed: 2, maxPhotos: 12 }));
    reopened = new CalendarBackgrounds(f.root, f.options);
    assert.deepEqual(reopened.preferences(), { ...PHOTO_WALL_DEFAULTS, veil: 78, seed: 2 });
    f.add(18);
    const first = await reopened.generateNow("2026-10", false, now);
    assert.equal(first.count, 18); assert.equal(first.tierPhotos, 15); assert.equal(first.renderedPhotos, 15); assert.equal(first.nextTier, 21); assert.equal(f.calls(), 15);
    f.add(3);
    const crossed = reopened.status("2026-10", false, now);
    assert.equal(crossed.version, first.version); assert.equal(crossed.pending, true); assert.equal(crossed.dueAt, nextBackgroundNight(now));
    const second = await reopened.generateNow("2026-10", false, now);
    assert.equal(second.renderedPhotos, 21); assert.equal(second.pending, false); assert.equal(f.calls(), 36);
    f.add(44);
    const large = await reopened.generateNow("2026-10", false, now);
    assert.equal(large.count, 65); assert.equal(large.tierPhotos, 63); assert.equal(large.renderedPhotos, 63); assert.equal(f.calls(), 99);
    const info = await sharp(readFileSync(reopened.file("2026-10", false, large.version!, now)!)).metadata();
    assert.ok(info.width! <= 1600 && info.height! <= 1600);
    reopened.savePreferences({ ...PHOTO_WALL_DEFAULTS, maxPhotos: 12 }, now);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "calendar-background-config.json"), "utf8")), PHOTO_WALL_DEFAULTS);
  } finally { reopened?.close(); f.close(); }
});

test("legacy capped artwork stays available while its old 03:30 deadline advances to midnight", async () => {
  const f = await fixture(); let reopened: CalendarBackgrounds | undefined;
  try {
    const record = f.add(20);
    const candidates = record.assetRefs.map(ref => {
      const asset = f.repository.findAssetById(ref.assetId)!;
      return { id: asset.id, version: f.options.assetVersion(asset) };
    });
    const { veil: _veil, ...render } = PHOTO_WALL_DEFAULTS;
    const legacy = { version: createHash("sha256").update("legacy-capped-wall").digest("hex"), sources: candidates,
      renderKey: createHash("sha256").update(JSON.stringify(["photo-wall-v2", { ...render, maxPhotos: 12 }])).digest("hex"), generatedAt: now.getTime(), final: false };
    // Obtain the derived directory without decoding photos, then install a genuine old 12-photo artifact.
    f.service.status("2026-10", false, now); f.service.close();
    const directory = join(f.root, "derived", "calendar-backgrounds");
    writeFileSync(join(directory, `${legacy.version}.webp`), await renderCalendarPhotoWall(Array.from({ length: 12 }, () => readFileSync(join(f.root, "small.webp"))), { ...PHOTO_WALL_DEFAULTS }, async () => {}));
    writeFileSync(join(directory, "state.json"), JSON.stringify([{ month: "2026-10", hideDemo: false, image: legacy, dueAt: Date.parse("2026-10-10T19:30:00Z") }]));
    reopened = new CalendarBackgrounds(f.root, f.options);
    const kept = reopened.status("2026-10", false, now, legacy.version);
    assert.equal(kept.version, legacy.version); assert.equal(kept.valid, true); assert.equal(kept.renderedPhotos, 12);
    assert.equal(kept.tierPhotos, 15); assert.equal(kept.dueAt, Date.parse("2026-10-10T16:00:00Z")); assert.equal(f.calls(), 0);
    const migrated = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"))[0].image;
    assert.equal(migrated.sources.length, 12); assert.equal(migrated.candidates.length, 20);
    const unused = record.assetRefs.find(ref => !migrated.sources.some((s: { id: string }) => s.id === ref.assetId))!;
    f.repository.update({ ...record, assetRefs: record.assetRefs.filter(ref => ref.assetId !== unused.assetId) }, record.revision);
    assert.equal(reopened.status("2026-10", false, now, legacy.version).valid, true);
    await reopened.tick(new Date(kept.dueAt!));
    assert.equal(reopened.status("2026-10", false, new Date(kept.dueAt!)).renderedPhotos, 15);
  } finally { reopened?.close(); f.close(); }
});

test("a month meeting the threshold queues automatically without a prior calendar visit", async () => {
  const f = await fixture();
  try {
    f.add(8); await f.service.tick(now);
    assert.equal(existsSync(join(f.root, "derived", "calendar-backgrounds", "state.json")), false);
    f.add(1); await f.service.tick(now);
    const entries = JSON.parse(readFileSync(join(f.root, "derived", "calendar-backgrounds", "state.json"), "utf8"));
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry: { dueAt: number; image?: unknown }) => entry.dueAt === nextBackgroundNight(now) && !entry.image));
    assert.equal(f.calls(), 0);
    await f.service.tick(new Date(nextBackgroundNight(now)));
    assert.equal(f.service.status("2026-10", false, now).renderedPhotos, 9);
  } finally { f.close(); }
});

test("existing Windows manifests survive a drive-case restart and migrate all candidates to actual drawn dependencies", async () => {
  const f = await fixture(); let reopened: CalendarBackgrounds | undefined;
  try {
    f.add(20);
    const ready = await f.service.generateNow("2026-10", false, now);
    const state = join(f.root, "derived", "calendar-backgrounds", "state.json");
    const entries = JSON.parse(readFileSync(state, "utf8"));
    const image = entries[0].image;
    const upper = "E:\\Projects\\LifeOS\\data\\lifeos.sqlite";
    // Exactly the pre-fix format: all candidates, old opaque namespace versions.
    image.sources = image.candidates.map((s: { id: string }) => {
      const asset = f.repository.findAssetById(s.id)!;
      return { id: s.id, version: calendarAssetVersion(upper, asset) };
    });
    delete image.candidates;
    writeFileSync(state, JSON.stringify(entries));
    f.service.close();
    const lower = upper.replace(/^E:/, "e:");
    reopened = new CalendarBackgrounds(f.root, { ...f.options,
      assetVersion: asset => calendarAssetVersion(backgroundNamespace(lower, "win32"), asset),
      legacyAssetVersions: asset => legacyBackgroundNamespaces(lower, "win32").map(n => calendarAssetVersion(n, asset)),
    });
    const kept = reopened.status("2026-10", false, now, ready.version!);
    assert.equal(kept.version, ready.version); assert.equal(kept.valid, true); assert.equal(kept.pending, false);
    assert.equal(f.calls(), 15); assert.ok(reopened.file("2026-10", false, ready.version!, now));
    const migrated = JSON.parse(readFileSync(state, "utf8"))[0].image;
    assert.equal(migrated.sources.length, 15); assert.equal(migrated.candidates.length, 20);
  } finally { reopened?.close(); f.close(); }
});

test("a photo-wall keeps its old artwork for additions, unselected removals and same-content metadata, but revokes drawn photos", async () => {
  const f = await fixture();
  try {
    const record = f.add(20);
    for (const ref of record.assetRefs) {
      const asset = f.repository.findAssetById(ref.assetId)!;
      f.repository.updateAsset({ ...asset, storageRefs: [{ ...asset.storageRefs[0]!, contentHash: { algorithm: "sha256", value: createHash("sha256").update(asset.id).digest("hex") } }] });
    }
    const ready = await f.service.generateNow("2026-10", false, now);
    const state = JSON.parse(readFileSync(join(f.root, "derived", "calendar-backgrounds", "state.json"), "utf8"));
    const drawn = new Set<string>(state[0].image.sources.map((s: { id: string }) => s.id));
    assert.equal(drawn.size, 15);
    const unused = record.assetRefs.find(ref => !drawn.has(ref.assetId))!;
    f.repository.update({ ...record, assetRefs: record.assetRefs.filter(ref => ref.assetId !== unused.assetId) }, record.revision);
    const kept = f.service.status("2026-10", false, now, ready.version!);
    assert.equal(kept.count, 19); assert.equal(kept.version, ready.version); assert.equal(kept.valid, true);
    const selected = f.repository.findAssetById([...drawn][0]!)!;
    f.repository.updateAsset({ ...selected, storageRefs: [{ ...selected.storageRefs[0]!, mediaType: "image/webp" }] });
    assert.equal(f.service.status("2026-10", false, now).version, ready.version);
    f.add(1);
    const added = f.service.status("2026-10", false, now, ready.version!);
    assert.equal(added.count, 20); assert.equal(added.version, ready.version); assert.equal(added.valid, true); assert.equal(added.pending, false);
    assert.equal(f.calls(), 15);
    const fiveDays = new Date(now.getTime() + 5 * 86_400_000);
    assert.equal(f.service.status("2026-10", false, fiveDays).pending, false);
    const file = f.service.file("2026-10", false, ready.version!, now)!;
    const latest = f.repository.findById(record.id)!;
    f.repository.update({ ...latest, assetRefs: latest.assetRefs.filter(ref => ref.assetId !== selected.id) }, latest.revision);
    const revoked = f.service.status("2026-10", false, now, ready.version!);
    assert.equal(revoked.count, 19); assert.equal(revoked.imageUrl, null); assert.equal(revoked.valid, false); assert.equal(existsSync(file), false);
  } finally { f.close(); }
});

test("a genuinely replaced drawn photo still invalidates its artwork even with enough other photos", async () => {
  const f = await fixture();
  try {
    f.add(20);
    const ready = await f.service.generateNow("2026-10", false, now);
    const state = JSON.parse(readFileSync(join(f.root, "derived", "calendar-backgrounds", "state.json"), "utf8"));
    const asset = f.repository.findAssetById(state[0].image.sources[0].id)!;
    f.repository.updateAsset({ ...asset, storageRefs: [{ sourceId: "local", sourceRef: "replacement.webp" }] });
    const revoked = f.service.status("2026-10", false, now, ready.version!);
    assert.equal(revoked.count, 20); assert.equal(revoked.imageUrl, null); assert.equal(revoked.valid, false);
  } finally { f.close(); }
});

test("manual generation enforces the real-photo threshold, bypasses viewing and reuses the completed cache", async () => {
  const f = await fixture();
  try {
    f.add(8);
    // The date-cell glyph/filler is presentation only, never an asset reference.
    const insufficient = f.service.status("2026-10", false, now);
    assert.equal(insufficient.count, 8); assert.equal(insufficient.minPhotos, 9);
    await assert.rejects(f.service.generateNow("2026-10", false, now), /background_not_enough_photos/);
    assert.equal(f.calls(), 0);
    f.add(1); f.service.viewing("manual-viewer", true);
    const ready = await f.service.generateNow("2026-10", false, now);
    assert.ok(ready.imageUrl); assert.equal(ready.pending, false); assert.equal(f.calls(), 9);
    assert.ok(f.service.file("2026-10", false, ready.version!, now));
    const reused = await f.service.generateNow("2026-10", false, now);
    assert.equal(reused.version, ready.version); assert.equal(f.calls(), 9);
    const reopened = new CalendarBackgrounds(f.root, f.options);
    try { assert.equal(reopened.status("2026-10", false, now).version, ready.version); } finally { reopened.close(); }
    // Live server counts win over a previously enabled button.
    const row = f.repository.findById("r8")!;
    f.repository.update({ ...row, isPrivate: true }, row.revision);
    await assert.rejects(f.service.generateNow("2026-10", false, now), /background_not_enough_photos/);
    assert.equal(f.service.status("2026-10", false, now).imageUrl, null);
  } finally { f.close(); }
});

test("manual generation rejects concurrent work and source changes without publishing a partial image", async () => {
  const f = await fixture(); let service: CalendarBackgrounds | undefined;
  try {
    const row = f.add(12);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    service = new CalendarBackgrounds(f.root, { ...f.options, thumbnail: async id => { entered(); await gate; return f.options.thumbnail(id); } });
    const first = service.generateNow("2026-10", false, now);
    await started;
    await assert.rejects(f.service.generateNow("2026-10", false, now), /background_busy/);
    f.repository.update({ ...row, isPrivate: true }, row.revision);
    release();
    await assert.rejects(first, /background_changed/);
    assert.equal(service.status("2026-10", false, now).imageUrl, null);
    assert.equal(readdirSync(join(f.root, "derived", "calendar-backgrounds")).filter(file => file.endsWith(".webp")).length, 0);
  } finally { service?.close(); f.close(); }
});

test("opening does no photo work; midnight queue survives restart, viewers defer it, output is one bounded WebP", async () => {
  const f = await fixture(); let reopened: CalendarBackgrounds | undefined;
  try {
    f.add(8);
    assert.equal(f.service.status("2026-10", false, now).pending, false);
    f.add(1);
    const initial = f.service.status("2026-10", false, now);
    assert.equal(initial.imageUrl, null); assert.equal(initial.count, 9); assert.equal(initial.dueAt, nextBackgroundNight(now)); assert.equal(f.calls(), 0);
    await f.service.tick(new Date(initial.dueAt! - 1)); assert.equal(f.calls(), 0);
    reopened = new CalendarBackgrounds(f.root, f.options);
    assert.equal(reopened.status("2026-10", false, now).dueAt, initial.dueAt);
    reopened.viewing("viewer", true, initial.dueAt!);
    await reopened.tick(new Date(initial.dueAt!)); assert.equal(f.calls(), 0);
    reopened.viewing("viewer", false);
    await reopened.tick(new Date(initial.dueAt!));
    const ready = reopened.status("2026-10", false, new Date(initial.dueAt!));
    assert.ok(ready.imageUrl); assert.equal(ready.pending, false); assert.equal(f.calls(), 9);
    const file = reopened.file("2026-10", false, ready.version!, new Date(initial.dueAt!))!;
    const info = await sharp(readFileSync(file)).metadata(); assert.equal(info.width, 1600); assert.ok(info.height! <= 1600); assert.equal(info.format, "webp");
    // The independently filtered profile also has one midnight job; drain it before checking idempotence.
    await reopened.tick(new Date(initial.dueAt!));
    const before = f.calls(); reopened.status("2026-10", false, new Date(initial.dueAt! + 1000));
    await reopened.tick(new Date(initial.dueAt! + 1000)); assert.equal(f.calls(), before);
  } finally { reopened?.close(); f.close(); }
});

test("six-photo tiers coalesce at midnight and keep old artwork, without five-day or month-end redraws", async () => {
  const f = await fixture();
  try {
    const r = f.add(9);
    const first = f.service.status("2026-10", false, now);
    await f.service.tick(new Date(first.dueAt!));
    await f.service.tick(new Date(first.dueAt!));
    const generated = new Date(first.dueAt! + 1000), initial = f.service.status("2026-10", false, generated);
    f.repository.update({ ...r, body: { original: "文字改动" } }, r.revision);
    assert.equal(f.service.status("2026-10", false, generated).pending, false);
    f.add(5);
    assert.equal(f.service.status("2026-10", false, generated).pending, false);
    assert.equal(f.service.status("2026-10", false, new Date(first.dueAt! + 5 * 86_400_000)).pending, false);
    f.add(1);
    const queued = f.service.status("2026-10", false, generated);
    assert.equal(queued.imageUrl, initial.imageUrl); assert.equal(queued.pending, true);
    const due = queued.dueAt!;
    assert.equal(queued.tierPhotos, 15); assert.equal(queued.renderedPhotos, 9); assert.equal(queued.nextTier, 21);
    f.add(3); // More additions before midnight still produce only the current completed tier.
    assert.equal(f.service.status("2026-10", false, generated).dueAt, due);
    assert.equal(f.service.status("2026-10", false, generated).tierPhotos, 15);
    await f.service.tick(new Date(due - 1));
    assert.equal(f.service.status("2026-10", false, generated).version, initial.version);
    await f.service.tick(new Date(due));
    const second = f.service.status("2026-10", false, new Date(due + 1000));
    assert.notEqual(second.version, initial.version);
    assert.equal(f.service.file("2026-10", false, initial.version!, new Date(due + 1000)), null);
    assert.equal(second.renderedPhotos, 15); assert.equal(second.pending, false);
    await f.service.tick(new Date(due)); // Complete the other independently filtered profile.
    f.add(1);
    const end = f.service.status("2026-10", false, new Date("2026-10-31T16:00:00Z"));
    assert.equal(end.count, 19); assert.equal(end.pending, false);
    const calls = f.calls();
    assert.equal(f.service.status("2026-10", false, new Date("2026-11-03T00:00:00Z")).pending, false);
    await f.service.tick(new Date("2026-11-03T00:00:00Z")); assert.equal(f.calls(), calls);
    f.add(2);
    assert.equal(f.service.status("2026-10", false, new Date("2026-11-03T00:00:00Z")).pending, true);
  } finally { f.close(); }
});

test("private, demo, duplicate, future and non-journal photos are excluded; removals revoke cached images immediately", async () => {
  const f = await fixture();
  try {
    const r = f.add(12);
    f.add(4, "2026-10", { isPrivate: true }); f.add(3, "2026-10", { isDemo: true });
    f.add(2, "2026-10", { kind: "note" }); f.add(2, "2026-11");
    assert.equal(f.service.status("2026-10", true, now).count, 12);
    assert.equal(f.service.status("2026-10", false, now).count, 15);
    const personal = f.service.status("2026-10", true, now);
    await f.service.tick(new Date(personal.dueAt!)); await f.service.tick(new Date(personal.dueAt!));
    const image = f.service.status("2026-10", true, new Date(personal.dueAt!)); assert.ok(image.imageUrl);
    const file = f.service.file("2026-10", true, image.version!, new Date(personal.dueAt!))!;
    f.repository.update({ ...r, isPrivate: true }, r.revision);
    const revoked = f.service.status("2026-10", true, new Date(personal.dueAt!), image.version!);
    assert.equal(revoked.imageUrl, null); assert.equal(revoked.valid, false); assert.equal(revoked.pending, false); assert.equal(existsSync(file), false);
    assert.equal(f.service.file("2026-10", true, image.version!, new Date(personal.dueAt!)), null);
    assert.equal(f.service.status("2026-11", false, now).count, 0);
    const duplicate = f.add(12, "2026-09");
    for (const ref of duplicate.assetRefs) { const a = f.repository.findAssetById(ref.assetId)!; f.repository.updateAsset({ ...a, storageRefs: [{ ...a.storageRefs[0]!, contentHash: { algorithm: "sha256", value: "a".repeat(64) } }] }); }
    assert.equal(f.service.status("2026-09", false, now).count, 1);
  } finally { f.close(); }
});

test("explicit test preview shares the renderer but does not publish a formal background", async () => {
  const f = await fixture();
  try {
    f.add(17, "2026-09");
    const url = await f.service.preview("2026-09", false, now); assert.ok(url);
    assert.equal(f.service.status("2026-09", false, now).imageUrl, null);
    assert.equal(await f.service.preview("2026-09", false, now), url); assert.equal(f.calls(), 15);
    const other = new CalendarBackgrounds(f.root, f.options);
    try { assert.equal(await other.preview("2026-09", false, now), url); assert.equal(f.calls(), 15); } finally { other.close(); }
  } finally { f.close(); }
});

test("privacy changes and a returning viewer during generation prevent publication", async () => {
  const f = await fixture(); let race: CalendarBackgrounds | undefined;
  try {
    const r = f.add(12);
    let first = true;
    race = new CalendarBackgrounds(f.root, { ...f.options, thumbnail: async id => {
      if (first) { first = false; f.repository.update({ ...r, isPrivate: true }, r.revision); }
      return f.options.thumbnail(id);
    } });
    const pending = race.status("2026-10", false, now); await race.tick(new Date(pending.dueAt!));
    assert.equal(race.status("2026-10", false, now).imageUrl, null);
    assert.equal(readdirSync(join(f.root, "derived", "calendar-backgrounds")).some(n => n.endsWith(".webp")), false);
    race.close();
    const latest = f.repository.findById(r.id)!; f.repository.update({ ...latest, isPrivate: false }, latest.revision);
    let calls = 0;
    race = new CalendarBackgrounds(f.root, { ...f.options, thumbnail: async id => { calls++; race!.viewing("returning-viewer", true); return f.options.thumbnail(id); } });
    const retry = race.status("2026-10", false, now); await race.tick(new Date(retry.dueAt!));
    assert.equal(calls, 1); assert.equal(race.status("2026-10", false, now).imageUrl, null); assert.equal(race.status("2026-10", false, now).pending, true);
  } finally { race?.close(); f.close(); }
});

test("saved photo-wall settings survive restart, validate strictly and keep veil-only saves out of the render queue", async () => {
  const f = await fixture(); let reopened: CalendarBackgrounds | undefined;
  try {
    f.add(20);
    assert.deepEqual(f.service.preferences(), PHOTO_WALL_DEFAULTS);
    const first = await f.service.generateNow("2026-10", false, now);
    assert.equal(f.calls(), 15, "20 candidates produce the completed 15-photo tier");
    assert.equal(first.count, 20);
    const preferences = { ...PHOTO_WALL_DEFAULTS, veil: 78 };
    f.service.savePreferences(preferences, now);
    assert.equal(f.service.status("2026-10", false, now).pending, false);
    assert.equal(f.service.status("2026-10", false, now).version, first.version);
    await f.service.generateNow("2026-10", false, now); assert.equal(f.calls(), 15);
    for (const invalid of [{ ...preferences, veil: 101 }, { ...preferences, shadow: NaN }, { ...preferences, seed: 0 }, { ...preferences, tilt: 1.3 }, { ...preferences, extra: true }, { ...preferences, layout: "invalid" }]) assert.throws(() => f.service.savePreferences(invalid, now));
    assert.deepEqual(f.service.preferences(), preferences);
    reopened = new CalendarBackgrounds(f.root, f.options); assert.deepEqual(reopened.preferences(), preferences);
    reopened.savePreferences({ ...preferences, gap: 12, border: 4 }, now);
    const staged = reopened.status("2026-10", false, now, first.version!);
    assert.equal(staged.dueAt, nextBackgroundNight(now)); assert.equal(staged.version, first.version); assert.equal(staged.valid, true); assert.equal(f.calls(), 15);
    reopened.viewing("reader", true, staged.dueAt!); await reopened.tick(new Date(staged.dueAt!)); assert.equal(f.calls(), 15);
    reopened.viewing("reader", false); await reopened.tick(new Date(staged.dueAt!));
    assert.equal(f.calls(), 30); assert.notEqual(reopened.status("2026-10", false, now).version, first.version);
  } finally { reopened?.close(); f.close(); }
});

test("a settings change during decoding cannot publish an image with stale appearance", async () => {
  const f = await fixture(); let service: CalendarBackgrounds | undefined;
  try {
    f.add(12); let first = true;
    service = new CalendarBackgrounds(f.root, { ...f.options, thumbnail: async id => {
      if (first) { first = false; service!.savePreferences({ ...PHOTO_WALL_DEFAULTS, seed: 2 }, now); }
      return f.options.thumbnail(id);
    } });
    await assert.rejects(service.generateNow("2026-10", false, now), /background_changed/);
    assert.equal(service.status("2026-10", false, now).imageUrl, null);
    assert.equal(readdirSync(join(f.root, "derived", "calendar-backgrounds")).filter(n => n.endsWith(".webp")).length, 0);
    assert.ok((await service.generateNow("2026-10", false, now)).imageUrl);
  } finally { service?.close(); f.close(); }
});

test("mixed portrait and landscape photo walls preserve both ends of every image and stay bounded for very tall screenshots", async () => {
  const photos = Array.from({ length: 12 }, (_, i) => i % 2 ? { width: 200, height: 80 } : { width: 80, height: 200 });
  const images: Buffer[] = [];
  for (const photo of photos) {
    const pixels = Buffer.alloc(photo.width * photo.height * 3);
    for (let y = 0; y < photo.height; y++) for (let x = 0; x < photo.width; x++) { const offset = (y * photo.width + x) * 3; pixels[offset] = y < photo.height / 2 ? 230 : 20; pixels[offset + 1] = 35; pixels[offset + 2] = y < photo.height / 2 ? 20 : 230; }
    images.push(await sharp(pixels, { raw: { ...photo, channels: 3 } }).png().toBuffer());
  }
  const layout = photoWallLayout(photos, { ...PHOTO_WALL_DEFAULTS });
  const rendered = await renderCalendarPhotoWall(images, { ...PHOTO_WALL_DEFAULTS }, async () => {});
  const raw = await sharp(rendered).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.width, layout.width); assert.equal(raw.info.height, layout.height);
  for (const c of layout.cells) {
    assert.ok(Math.abs(c.w / c.h - photos[c.index]!.width / photos[c.index]!.height) < 1e-6);
    const pixel = (fraction: number) => (Math.floor(c.y + c.h * fraction) * raw.info.width + Math.floor(c.x + c.w / 2)) * 3;
    const top = pixel(.2), bottom = pixel(.8);
    assert.ok(raw.data[top]! > 190 && raw.data[top + 2]! < 60, `top of photo ${c.index} preserved`);
    assert.ok(raw.data[bottom]! < 60 && raw.data[bottom + 2]! > 190, `bottom of photo ${c.index} preserved`);
  }
  const tall = photoWallLayout(Array.from({ length: 63 }, () => ({ width: 80, height: 8000 })), { ...PHOTO_WALL_DEFAULTS });
  assert.ok(tall.width <= 1600 && tall.height <= 1600 && tall.cells.length === 63 && tall.cells.every(c => Number.isFinite(c.x + c.y + c.w + c.h) && c.w > 0 && c.h > 0));
  for (const mode of ["masonry", "scattered"] as const) {
    const variant = await renderCalendarPhotoWall(images, { ...PHOTO_WALL_DEFAULTS, layout: mode, border: 16, gap: 32, tilt: 8 }, async () => {});
    const info = await sharp(variant).metadata(); assert.ok(info.width! <= 1600 && info.height! <= 1600);
  }
});

test("photo-wall endpoints enforce login and the feature gate before private account settings", async () => {
  const { createHttpServer } = await import("../src/server.js");
  const { readConfig } = await import("../src/config.js");
  const dir = mkdtempSync(join(tmpdir(), "lifeos-wall-account-"));
  const config = readConfig({ LIFEOS_ACCOUNT_MODE: "1", LIFEOS_PASSWORD: "wall-owner-password", LIFEOS_OWNER_USERNAME: "owner", LIFEOS_COOKIE_SECURE: "true", LIFEOS_ALLOWED_ORIGINS: "https://lifeos.test", LIFEOS_DATA_DIR: join(dir, "data"), LIFEOS_ASSET_ROOT: join(dir, "assets") });
  const { server, app } = createHttpServer(config);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, cookie?: string, body?: unknown, method = "POST") => fetch(base + path, { ...(body === undefined ? {} : { method, body: JSON.stringify(body) }), headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) } });
  const login = async (username: string, password: string) => { const response = await request("/api/auth/login", undefined, { username, password }); assert.equal(response.status, 200); return response.headers.get("set-cookie")!.split(";")[0]!; };
  try {
    assert.equal((await request("/api/calendar/background/settings")).status, 401);
    assert.equal((await request("/api/calendar/background/settings", undefined, PHOTO_WALL_DEFAULTS, "PUT")).status, 401);
    const owner = await login("owner", "wall-owner-password");
    const created = await request("/api/admin/accounts", owner, { username: "member", password: "wall-member-password", displayName: "成员", spaceName: "成员空间" }); assert.equal(created.status, 201);
    const member = await login("member", "wall-member-password");
    if (!PHOTO_WALL_ENABLED) {
      for (const cookie of [owner, member]) {
        assert.equal((await request("/api/calendar/background/settings", cookie)).status, 503);
        assert.equal((await request("/api/calendar/background/settings", cookie, PHOTO_WALL_DEFAULTS, "PUT")).status, 503);
        assert.equal((await request("/api/calendar/background/generate?month=2026-10", cookie, {})).status, 503);
        assert.equal((await request("/api/calendar/background/preview?month=2026-10", cookie, {})).status, 503);
        const hidden = await (await request("/api/calendar/background?month=2026-10", cookie)).json() as { enabled: boolean; imageUrl: string | null; valid: boolean };
        assert.equal(hidden.enabled, false); assert.equal(hidden.imageUrl, null); assert.equal(hidden.valid, false);
      }
      return;
    }
    assert.equal((await request("/api/calendar/background/settings", owner, { ...PHOTO_WALL_DEFAULTS, veil: 77, seed: 7 }, "PUT")).status, 200);
    assert.deepEqual(await (await request("/api/calendar/background/settings", member)).json(), PHOTO_WALL_DEFAULTS);
    assert.equal((await request("/api/calendar/background/settings", member, { ...PHOTO_WALL_DEFAULTS, veil: 65 }, "PUT")).status, 200);
    const ownerValue = await (await request("/api/calendar/background/settings", owner)).json() as { veil: number; seed: number };
    assert.equal(ownerValue.veil, 77); assert.equal(ownerValue.seed, 7);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); app.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + "lifeos-wall-account-")); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
