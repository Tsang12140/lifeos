import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { Asset } from "@lifeos/core";
import type { ApiConfig } from "../src/config.js";
import { createThumbnailCache } from "../src/derived-thumbs.js";
import { buildRecord } from "../src/record-builders.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { cleanPhotoDescription, describePhotoLibrary } from "../src/photo-description.js";

/**
 * These tests never touch the network. The describer is injected, so the whole pass —
 * hashing, deduplication, thumbnail derivation, storage — is exercised against a
 * stand-in that simply returns a sentence. The owner's own key is never involved.
 */

const CONTENT_HASH = { algorithm: "sha256", value: "a".repeat(64) } as const;

interface Fixture {
  readonly root: string;
  readonly config: ApiConfig;
  readonly repository: SqliteRecordRepository;
  readonly thumbnails: ReturnType<typeof createThumbnailCache>;
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "lifeos-photo-desc-"));
  const assetRoot = join(root, "assets");
  mkdirSync(join(assetRoot, "uploads"), { recursive: true });
  // A real raster file, because the thumbnail pass actually decodes it.
  const bytes = await sharp({ create: { width: 48, height: 36, channels: 3, background: { r: 190, g: 120, b: 80 } } }).jpeg().toBuffer();
  writeFileSync(join(assetRoot, "uploads", "shot.jpg"), bytes);

  const config = {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "lifeos.sqlite"),
    dataDirectory: root,
    webDirectory: join(root, "web"),
    backupDirectory: join(root, "backups"),
    allowedOrigins: [],
    cookieSecure: false,
    bodyLimitBytes: 1024 * 1024,
    assetUploadLimitBytes: 25 * 1024 * 1024,
    assetOrphanGraceDays: 7,
    assetTrashDays: 30,
    deepseekModel: "deepseek-flash",
    deepseekBaseUrl: "https://api.deepseek.com",
    qweatherHost: "devapi.qweather.com",
    assetRoot,
  } as unknown as ApiConfig;

  const repository = new SqliteRecordRepository(":memory:");
  repository.insertAsset({
    id: "asset_photo",
    kind: "photo",
    mediaType: "image/jpeg",
    storageRefs: [{ sourceId: "local", sourceRef: "uploads/shot.jpg", mediaType: "image/jpeg", contentHash: CONTENT_HASH }],
  } as Asset);

  return { root, config, repository, thumbnails: createThumbnailCache(root) };
}

function journalWithPhoto(repository: SqliteRecordRepository, content: string, assetId = "asset_photo") {
  return buildRecord({ kind: "journal", content, occurredAt: { kind: "instant", value: "2026-10-15T00:00:00.000Z" }, assetRefs: [{ assetId, role: "photo" }] }, repository);
}

test("a photo shared by two records is read once and written to both", async (t) => {
  const fx = await makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));

  const first = journalWithPhoto(fx.repository, "今天喝了一杯");
  const second = journalWithPhoto(fx.repository, "同一张图又发了一次");
  fx.repository.insert(first);
  fx.repository.insert(second);

  let calls = 0;
  const run = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    describe: async ({ imageDataUrl }) => {
      calls += 1;
      assert.ok(imageDataUrl.startsWith("data:image/webp;base64,"), "发送的应是 webp 缩略图");
      return "一杯拿铁，白色瓷杯，奶泡没成型";
    },
  });

  assert.equal(calls, 1, "同一个内容哈希只应问模型一次");
  assert.equal(run.photos, 1);
  assert.equal(run.described, 1);
  assert.equal(run.recordsUpdated, 2);

  const stored = fx.repository.findById(first.id);
  assert.ok(stored !== null);
  assert.equal(stored.body.original, "今天喝了一杯", "正文不得被改动");
  assert.equal(stored.aiDerived.length, 1);
  assert.equal(stored.aiDerived[0]!.kind, "summary");
  assert.equal(stored.aiDerived[0]!.provider, "lifeos-photo");
  assert.equal((stored.aiDerived[0]!.value as { text: string }).text, "一杯拿铁，白色瓷杯，奶泡没成型");
  assert.equal(stored.aiDerived[0]!.sourceRevision, `sha256:${CONTENT_HASH.value}`);

  const other = fx.repository.findById(second.id);
  assert.ok(other !== null);
  assert.equal(other.aiDerived.length, 1);
});

test("a second pass costs nothing: the same picture is never read twice", async (t) => {
  const fx = await makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  fx.repository.insert(journalWithPhoto(fx.repository, "今天喝了一杯"));

  const run = { repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails };
  await describePhotoLibrary({ ...run, describe: async () => "一杯拿铁" });

  const again = await describePhotoLibrary({
    ...run,
    describe: async () => {
      throw new Error("已经描述过的照片不应该再次调用模型");
    },
  });
  assert.equal(again.photos, 1);
  assert.equal(again.alreadyDescribed, 1);
  assert.equal(again.described, 0);
  assert.equal(again.remaining, 0);

  const stored = fx.repository.list()[0]!;
  assert.equal(stored.aiDerived.length, 1, "不得重复写入");
});

test("dryRun reads the photograph but writes nothing", async (t) => {
  const fx = await makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  fx.repository.insert(journalWithPhoto(fx.repository, "今天喝了一杯"));

  const run = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    dryRun: true,
    describe: async () => "一杯拿铁",
  });

  assert.equal(run.written, false);
  assert.equal(run.described, 1);
  assert.deepEqual(run.samples.map((sample) => sample.text), ["一杯拿铁"]);
  assert.equal(fx.repository.list()[0]!.aiDerived.length, 0, "dryRun 不得写库");
});

test("a private record's photo is never sent anywhere", async (t) => {
  const fx = await makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  fx.repository.insert(buildRecord({ kind: "journal", content: "私密的一杯", occurredAt: { kind: "instant", value: "2026-10-15T00:00:00.000Z" }, isPrivate: true, assetRefs: [{ assetId: "asset_photo", role: "photo" }] }, fx.repository));

  const run = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    describe: async () => {
      throw new Error("私密记录的照片不应发出");
    },
  });

  assert.equal(run.skippedPrivate, 1);
  assert.equal(run.photos, 0);
  assert.equal(fx.repository.list()[0]!.aiDerived.length, 0);
});

test("limit bounds one pass and reports what is left", async (t) => {
  const fx = await makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  for (const [index, name] of ["b", "c", "d"].entries()) {
    const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10 * index, g: 60, b: 90 } } }).jpeg().toBuffer();
    writeFileSync(join(fx.root, "assets", "uploads", `${name}.jpg`), bytes);
    fx.repository.insertAsset({
      id: `asset_${name}`,
      kind: "photo",
      mediaType: "image/jpeg",
      storageRefs: [{ sourceId: "local", sourceRef: `uploads/${name}.jpg`, mediaType: "image/jpeg", contentHash: { algorithm: "sha256", value: name.repeat(64).slice(0, 64) } }],
    } as Asset);
    fx.repository.insert(journalWithPhoto(fx.repository, `第 ${name} 张`, `asset_${name}`));
  }

  const run = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    limit: 2,
    describe: async () => "一张照片",
  });

  assert.equal(run.photos, 3);
  assert.equal(run.described, 2);
  assert.equal(run.remaining, 1);
});

test("limit 0 surveys without reading a picture", async (t) => {
  const fx = await makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  fx.repository.insert(journalWithPhoto(fx.repository, "今天喝了一杯"));

  const run = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    limit: 0,
    dryRun: true,
    describe: async () => {
      throw new Error("limit 0 时不应读取任何照片");
    },
  });

  assert.equal(run.photos, 1);
  assert.equal(run.remaining, 1);
  assert.equal(run.described, 0);
});

test("cleanPhotoDescription drops fences, bullets and refusals", () => {
  assert.equal(cleanPhotoDescription("```\n一杯拿铁\n```"), "一杯拿铁");
  assert.equal(cleanPhotoDescription("- 一杯拿铁"), "一杯拿铁");
  assert.equal(cleanPhotoDescription("一杯拿铁\n第二行会被丢掉"), "一杯拿铁");
  assert.equal(cleanPhotoDescription("NONE"), "");
  assert.equal(cleanPhotoDescription("   "), "");
  assert.equal(cleanPhotoDescription(null), "");
});

test("kinds keeps screenshots filed as tasks out of the pass", async (t) => {
  const fx = await makeFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));

  // 第二张图挂在一条 task 上，代表「截图那类」；本轮只应处理 journal 的那一张。
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 20, g: 200, b: 20 } } }).jpeg().toBuffer();
  writeFileSync(join(fx.root, "assets", "uploads", "task.jpg"), bytes);
  fx.repository.insertAsset({
    id: "asset_task",
    kind: "photo",
    mediaType: "image/jpeg",
    storageRefs: [{ sourceId: "local", sourceRef: "uploads/task.jpg", mediaType: "image/jpeg", contentHash: { algorithm: "sha256", value: "b".repeat(64) } }],
  } as Asset);

  const journal = journalWithPhoto(fx.repository, "今天喝了一杯");
  const task = buildRecord({ kind: "task", content: "这个也要改改", occurredAt: { kind: "instant", value: "2026-10-15T00:00:00.000Z" }, assetRefs: [{ assetId: "asset_task", role: "photo" }] }, fx.repository);
  fx.repository.insert(journal);
  fx.repository.insert(task);

  const run = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    kinds: ["journal"],
    describe: async () => "一杯拿铁",
  });

  assert.equal(run.photos, 1, "task 的截图不应进入本轮清点");
  assert.equal(run.described, 1);
  assert.equal(run.recordsUpdated, 1);
  assert.equal(fx.repository.findById(task.id)!.aiDerived.length, 0, "task 记录不得被写入");
  assert.equal(fx.repository.findById(journal.id)!.aiDerived.length, 1);
});
