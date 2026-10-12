import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createInstant, PHOTO_WALL_DEFAULTS, photoWallLayout, type Asset, type TimelineRecord } from "@lifeos/core";
import { renderCalendarPhotoWall } from "../src/calendar-background-renderer.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { CalendarBackgrounds, backgroundTier, nextBackgroundNight } from "../src/calendar-backgrounds.js";

const now = new Date("2026-10-10T04:00:00Z");
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lifeos-month-background-"));
  const repository = new SqliteRecordRepository(join(root, "lifeos.sqlite"));
  const photo = join(root, "small.webp");
  await sharp({ create: { width: 400, height: 300, channels: 3, background: "#cf9274" } }).webp().toFile(photo);
  let calls = 0;
  const options = { repository, assetVersion: (asset: Asset) => JSON.stringify(asset.storageRefs), thumbnail: async (_id: string) => { calls++; return photo; } };
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
  assert.equal(nextBackgroundNight(new Date("2026-10-10T19:29:59Z")), Date.parse("2026-10-10T19:30:00Z"));
  assert.equal(nextBackgroundNight(new Date("2026-10-10T19:30:00Z")), Date.parse("2026-10-11T19:30:00Z"));
  assert.deepEqual([0, 9, 10, 11, 12, 19, 20, 29, 30, 41, 42, 56].map(backgroundTier), [0, 0, 0, 0, 12, 12, 20, 20, 30, 30, 42, 56]);
});

test("manual generation enforces the real-photo threshold, bypasses viewing and reuses the completed cache", async () => {
  const f = await fixture();
  try {
    f.add(11);
    // The date-cell glyph/filler is presentation only, never an asset reference.
    const insufficient = f.service.status("2026-10", false, now);
    assert.equal(insufficient.count, 11); assert.equal(insufficient.minPhotos, 12);
    await assert.rejects(f.service.generateNow("2026-10", false, now), /background_not_enough_photos/);
    assert.equal(f.calls(), 0);
    f.add(1); f.service.viewing("manual-viewer", true);
    const ready = await f.service.generateNow("2026-10", false, now);
    assert.ok(ready.imageUrl); assert.equal(ready.pending, false); assert.equal(f.calls(), 12);
    assert.ok(f.service.file("2026-10", false, ready.version!, now));
    const reused = await f.service.generateNow("2026-10", false, now);
    assert.equal(reused.version, ready.version); assert.equal(f.calls(), 12);
    const reopened = new CalendarBackgrounds(f.root, f.options);
    try { assert.equal(reopened.status("2026-10", false, now).version, ready.version); } finally { reopened.close(); }
    // Live server counts win over a previously enabled button.
    const row = f.repository.findById("r11")!;
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
    f.add(11);
    assert.equal(f.service.status("2026-10", false, now).pending, false);
    f.add(1);
    const initial = f.service.status("2026-10", false, now);
    assert.equal(initial.imageUrl, null); assert.equal(initial.count, 12); assert.equal(initial.dueAt, nextBackgroundNight(now)); assert.equal(f.calls(), 0);
    await f.service.tick(new Date(initial.dueAt! - 1)); assert.equal(f.calls(), 0);
    reopened = new CalendarBackgrounds(f.root, f.options);
    assert.equal(reopened.status("2026-10", false, now).dueAt, initial.dueAt);
    reopened.viewing("viewer", true, initial.dueAt!);
    await reopened.tick(new Date(initial.dueAt!)); assert.equal(f.calls(), 0);
    reopened.viewing("viewer", false);
    await reopened.tick(new Date(initial.dueAt!));
    const ready = reopened.status("2026-10", false, new Date(initial.dueAt!));
    assert.ok(ready.imageUrl); assert.equal(ready.pending, false); assert.equal(f.calls(), 12);
    const file = reopened.file("2026-10", false, ready.version!, new Date(initial.dueAt!))!;
    const info = await sharp(readFileSync(file)).metadata(); assert.equal(info.width, 1600); assert.equal(info.height, 900); assert.equal(info.format, "webp");
    const before = f.calls(); reopened.status("2026-10", false, new Date(initial.dueAt! + 1000));
    await reopened.tick(new Date(initial.dueAt! + 1000)); assert.equal(f.calls(), before);
  } finally { reopened?.close(); f.close(); }
});

test("increment tiers, five changed days, historical additions and month-end finalization coalesce without body edits", async () => {
  const f = await fixture();
  try {
    const r = f.add(12);
    const first = f.service.status("2026-10", false, now);
    await f.service.tick(new Date(first.dueAt!));
    const generated = new Date(first.dueAt! + 1000), initial = f.service.status("2026-10", false, generated);
    f.repository.update({ ...r, body: { original: "文字改动" } }, r.revision);
    assert.equal(f.service.status("2026-10", false, generated).pending, false);
    f.add(3);
    assert.equal(f.service.status("2026-10", false, generated).pending, false);
    assert.equal(f.service.status("2026-10", false, new Date(first.dueAt! + 5 * 86_400_000)).pending, true);
    f.add(5);
    const queued = f.service.status("2026-10", false, generated);
    assert.equal(queued.imageUrl, initial.imageUrl); assert.equal(queued.pending, true);
    const due = queued.dueAt!;
    await f.service.tick(new Date(due));
    const second = f.service.status("2026-10", false, new Date(due + 1000));
    assert.notEqual(second.version, initial.version);
    assert.equal(f.service.file("2026-10", false, initial.version!, new Date(due + 1000)), null);
    assert.equal(readdirSync(join(f.root, "derived", "calendar-backgrounds")).filter(n => n.endsWith(".webp")).length, 1);
    f.add(1);
    const end = f.service.status("2026-10", false, new Date("2026-10-31T16:00:00Z"));
    assert.equal(end.pending, true); await f.service.tick(new Date(end.dueAt!));
    const calls = f.calls();
    assert.equal(f.service.status("2026-10", false, new Date("2026-11-03T00:00:00Z")).pending, false);
    await f.service.tick(new Date("2026-11-03T00:00:00Z")); assert.equal(f.calls(), calls);
    f.add(1);
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
    f.service.savePreferences({ ...PHOTO_WALL_DEFAULTS, maxPhotos: 17 }, now);
    const url = await f.service.preview("2026-09", false, now); assert.ok(url);
    assert.equal(f.service.status("2026-09", false, now).imageUrl, null);
    assert.equal(await f.service.preview("2026-09", false, now), url); assert.equal(f.calls(), 17);
    const other = new CalendarBackgrounds(f.root, f.options);
    try { assert.equal(await other.preview("2026-09", false, now), url); assert.equal(f.calls(), 17); } finally { other.close(); }
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
    assert.equal(f.calls(), 12, "photo count limits composition, not valid monthly source count");
    assert.equal(first.count, 20);
    const preferences = { ...PHOTO_WALL_DEFAULTS, veil: 78 };
    f.service.savePreferences(preferences, now);
    assert.equal(f.service.status("2026-10", false, now).pending, false);
    assert.equal(f.service.status("2026-10", false, now).version, first.version);
    await f.service.generateNow("2026-10", false, now); assert.equal(f.calls(), 12);
    for (const invalid of [{ ...preferences, veil: 101 }, { ...preferences, shadow: NaN }, { ...preferences, seed: 0 }, { ...preferences, tilt: 1.3 }, { ...preferences, maxPhotos: 11 }, { ...preferences, extra: true }, { ...preferences, layout: "invalid" }]) assert.throws(() => f.service.savePreferences(invalid, now));
    assert.deepEqual(f.service.preferences(), preferences);
    reopened = new CalendarBackgrounds(f.root, f.options); assert.deepEqual(reopened.preferences(), preferences);
    reopened.savePreferences({ ...preferences, maxPhotos: 20, gap: 12, border: 4 }, now);
    const staged = reopened.status("2026-10", false, now, first.version!);
    assert.equal(staged.dueAt, nextBackgroundNight(now)); assert.equal(staged.version, first.version); assert.equal(staged.valid, true); assert.equal(f.calls(), 12);
    reopened.viewing("reader", true, staged.dueAt!); await reopened.tick(new Date(staged.dueAt!)); assert.equal(f.calls(), 12);
    reopened.viewing("reader", false); await reopened.tick(new Date(staged.dueAt!));
    assert.equal(f.calls(), 32); assert.notEqual(reopened.status("2026-10", false, now).version, first.version);
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
  const tall = photoWallLayout(Array.from({ length: 60 }, () => ({ width: 80, height: 8000 })), { ...PHOTO_WALL_DEFAULTS, maxPhotos: 60 });
  assert.ok(tall.width <= 1600 && tall.height <= 1600 && tall.cells.length === 60 && tall.cells.every(c => Number.isFinite(c.x + c.y + c.w + c.h) && c.w > 0 && c.h > 0));
  for (const mode of ["masonry", "scattered"] as const) {
    const variant = await renderCalendarPhotoWall(images, { ...PHOTO_WALL_DEFAULTS, layout: mode, border: 16, gap: 32, tilt: 8 }, async () => {});
    const info = await sharp(variant).metadata(); assert.ok(info.width! <= 1600 && info.height! <= 1600);
  }
});

test("photo-wall settings require login and remain isolated between account spaces", async () => {
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
