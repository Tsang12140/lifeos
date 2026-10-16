import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { assertValidAsset, type Asset } from "@lifeos/core";
import { createHttpServer } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { buildRecord } from "../src/record-builders.js";
import { createThumbnailCache } from "../src/derived-thumbs.js";
import { describePhotoLibrary } from "../src/photo-description.js";

test("photo display rotation preserves originals, descriptions, reuse and EXIF; rejects stale writers", async () => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-photo-rotation-"));
  mkdirSync(join(root, "assets"));
  const config = readConfig({ LIFEOS_DATA_DIR: root, LIFEOS_DB_PATH: join(root, "lifeos.sqlite"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_HOST: "127.0.0.1", LIFEOS_PORT: "3099" });
  const { server, app } = createHttpServer(config);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const json = (body: unknown) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // EXIF 6 makes 80x40 source pixels an upright 40x80 portrait before user rotation.
    const bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const upload = await fetch(base + "/api/assets/uploads?name=" + encodeURIComponent('菜单 "照片".jpg'), { method: "POST", headers: { "content-type": "image/jpeg" }, body: bytes });
    equal(upload.status, 201); const asset = await upload.json() as Asset;
    const record = buildRecord({ kind: "journal", content: "菜单照片", occurredAt: { kind: "date", value: "2026-10-14" }, assetRefs: [{ assetId: asset.id, role: "photo" }] }, app.repository);
    app.repository.insert(record);
    let recognitionCalls = 0;
    const recognize = { config, repository: app.repository, thumbnails: createThumbnailCache(root), describe: async () => { recognitionCalls++; return "菜单上的菜名与价格"; } };
    await describePhotoLibrary(recognize); equal(recognitionCalls, 1);
    const recordBefore = JSON.stringify(app.repository.list());
    const path = base + "/api/assets/" + asset.id;
    const original = async () => Buffer.from(await (await fetch(path + "/content")).arrayBuffer());
    const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const beforeHash = hash(await original()); equal(beforeHash, hash(bytes));
    const oldMetadata = asset.photoMetadata, oldRefs = asset.storageRefs;
    const normal = Buffer.from(await (await fetch(path + "/thumbnail?w=400")).arrayBuffer());
    const normalMeta = await sharp(normal).metadata(); equal(normalMeta.width, 40); equal(normalMeta.height, 80);
    const response = await fetch(path + "/rotation", json({ rotation: 90, expectedRotation: 0 }));
    equal(response.status, 200); const rotated = await response.json() as Asset;
    equal(rotated.displayRotation, 90); deepEqual(rotated.storageRefs, oldRefs); deepEqual(rotated.photoMetadata, oldMetadata);
    await describePhotoLibrary(recognize); equal(recognitionCalls, 1, "rotation must reuse the existing description without recognition");
    equal(JSON.stringify(app.repository.list()), recordBefore, "rotation cannot rewrite diary text, revision or recognized content");
    const thumbnail = await fetch(path + "/thumbnail?w=400&r=90"); equal(thumbnail.status, 200);
    const rotatedMeta = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata(); equal(rotatedMeta.width, 80); equal(rotatedMeta.height, 40);
    const rawPreview = await sharp(Buffer.from(await (await fetch(path + "/thumbnail?w=2048&upright=1")).arrayBuffer())).metadata();
    equal(rawPreview.width, 40); equal(rawPreview.height, 80);
    equal(hash(await original()), beforeHash);
    for (const rotation of [-90, 45, 360, "90", null]) equal((await fetch(path + "/rotation", json({ rotation, expectedRotation: 90 }))).status, 400);
    equal((await fetch(path + "/rotation", json({ rotation: 180, expectedRotation: 0 }))).status, 409);
    equal((await fetch(path + "/rotation", json({ rotation: 180, expectedRotation: 90, storageRefs: [] }))).status, 400);
    const races = await Promise.all([180, 270].map(rotation => fetch(path + "/rotation", json({ rotation, expectedRotation: 90 }))));
    deepEqual(races.map(r => r.status).sort(), [200, 409]);
    const current = await (await fetch(path)).json() as Asset;
    const resolve = await fetch(base + "/api/assets/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(asset.storageRefs[0]!.contentHash) });
    const match = await resolve.json() as { matched: boolean; asset: Asset }; ok(match.matched); equal(match.asset.id, asset.id); equal(match.asset.displayRotation, current.displayRotation);
    const download = await fetch(path + "/content?download=1");
    ok(download.headers.get("content-disposition")!.startsWith("attachment;")); ok(download.headers.get("content-disposition")!.includes("filename*=UTF-8''")); equal(hash(Buffer.from(await download.arrayBuffer())), beforeHash);
    equal(app.repository.findAssetById(asset.id)?.displayRotation, current.displayRotation);
    equal((await fetch(path + "/rotation", json({ rotation: 0, expectedRotation: current.displayRotation }))).status, 200);
    equal(hash(Buffer.from(await (await fetch(path + "/thumbnail?w=400")).arrayBuffer())), hash(normal));
    // Persisted/exported asset objects retain the optional field under core validation.
    assertValidAsset(JSON.parse(JSON.stringify(app.repository.findAssetById(asset.id))));
    equal(app.repository.exportData().assets.find(a => a.id === asset.id)?.displayRotation, 0);
    await new Promise<void>((r, reject) => server.close(error => error ? reject(error) : r()));
    const restarted = createHttpServer(config);
    await new Promise<void>(r => restarted.server.listen(0, "127.0.0.1", r));
    try {
      const origin = `http://127.0.0.1:${(restarted.server.address() as { port: number }).port}`;
      equal(((await (await fetch(origin + "/api/assets/" + asset.id)).json()) as Asset).displayRotation, 0);
      equal(JSON.stringify(restarted.app.repository.list()), recordBefore);
    } finally { await new Promise<void>(r => restarted.server.close(() => r())); }
  } finally {
    if (server.listening) await new Promise<void>((r, reject) => server.close(error => error ? reject(error) : r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("photo display rotation validates type and does not extend to other attachments", () => {
  const asset = { id: "photo", kind: "photo", storageRefs: [] };
  for (const angle of [0,90,180,270]) assertValidAsset({ ...asset, displayRotation: angle });
  for (const angle of [45,"90",null,NaN]) throws(() => assertValidAsset({ ...asset, displayRotation: angle }));
  throws(() => assertValidAsset({ ...asset, kind: "file", displayRotation: 90 }));
});
