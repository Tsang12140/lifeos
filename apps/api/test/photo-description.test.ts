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
import { saveRuntimePhotoTextConfig } from "../src/photo-text-config.js";

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

/**
 * Removes a fixture directory, tolerating a lag that is an artefact of the platform rather
 * than of the code under test: on Windows libvips (sharp) lets go of the files it decoded
 * slightly after the call that used them returns, so an immediate `rmSync` can raise EPERM.
 * Node's own `maxRetries` backs off and retries exactly that error. If it still will not go,
 * the directory is left behind — it is a throwaway temp dir, and a leftover must never be
 * the thing that turns a passing test red.
 */
function cleanupFixture(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Leftover temp directory; harmless, and not evidence about the pass.
  }
}

test("a photo shared by two records is read once and written to both", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));

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
  t.after(() => cleanupFixture(fx.root));
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
  t.after(() => cleanupFixture(fx.root));
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
  t.after(() => cleanupFixture(fx.root));
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
  t.after(() => cleanupFixture(fx.root));
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
  t.after(() => cleanupFixture(fx.root));
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
  t.after(() => cleanupFixture(fx.root));

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

test("the context pass re-reads an already-captioned photo and hands the record's own words over", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  const journal = journalWithPhoto(fx.repository, "今天用的是浅烘豆，奶泡还是没打起来");
  fx.repository.insert(journal);

  // 第一遍：只看图。不传背景。（断言放在 describe 之外——describe 抛错会被 pass 里的
  // try/catch 当成「模型答不出」吞掉，那样测试会以另一种面目失败，误导排查。）
  const plainSeen: (string | undefined)[] = [];
  const first = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    describe: async ({ background }) => {
      plainSeen.push(background);
      return "一杯拿铁，白色瓷杯";
    },
  });
  assert.deepEqual(plainSeen, [undefined], "plain 档不得携带背景");
  assert.equal(first.variant, "plain");

  const seen: (string | undefined)[] = [];
  const second = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    variant: "context",
    describe: async ({ background }) => {
      seen.push(background);
      return "一杯拿铁，白色瓷杯，奶泡未成型";
    },
  });

  assert.equal(seen.length, 1, "换档位重跑必须真的再读一次，而不是当成已描述跳过");
  assert.equal(seen[0], "今天用的是浅烘豆，奶泡还是没打起来", "该条记录的正文应作为背景送出");
  assert.equal(second.alreadyDescribed, 0);
  assert.equal(second.described, 1);

  const stored = fx.repository.findById(journal.id)!;
  assert.equal(stored.body.original, "今天用的是浅烘豆，奶泡还是没打起来", "正文不得被改动");
  assert.equal(stored.aiDerived.length, 2, "两档结果并存，互不覆盖");
  assert.deepEqual(
    stored.aiDerived.map((item) => (item.value as { variant?: string }).variant).sort(),
    ["context", "plain"],
  );

  // 各档位各自去重：换回 plain 也不该再花钱。
  const third = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    describe: async () => {
      throw new Error("同一档位不得重复读取");
    },
  });
  assert.equal(third.alreadyDescribed, 1);
});

test("高成本档 = 中成本档 ＋ 思考，且与中成本档各自记账", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  const journal = journalWithPhoto(fx.repository, "今天用的是浅烘豆，奶泡还是没打起来");
  fx.repository.insert(journal);

  // 高成本档与中成本档的唯一差别是「让不让模型先想」——那是网络层的事，断言在跑批日志里
  // （effort=high / direct）。这里测的是另外两件必须成立的事：它一样看得见正文背景，
  // 并且与中成本档各自去重，不会互相把对方当成「已跑过」。
  const seen: (string | undefined)[] = [];
  const high = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    variant: "context-thinking",
    describe: async ({ background }) => {
      seen.push(background);
      return "一杯拿铁，白色瓷杯，奶泡未成型";
    },
  });

  assert.equal(high.variant, "context-thinking");
  assert.equal(seen.length, 1, "换档位重跑必须真的再读一次，而不是当成已描述跳过");
  assert.equal(seen[0], "今天用的是浅烘豆，奶泡还是没打起来", "高成本档应和中成本档一样拿到正文背景");
  assert.equal(high.described, 1);

  const stored = fx.repository.findById(journal.id)!;
  assert.equal(stored.body.original, "今天用的是浅烘豆，奶泡还是没打起来", "正文不得被改动");
  assert.equal(stored.aiDerived.length, 1);
  assert.equal((stored.aiDerived[0]!.value as { variant?: string }).variant, "context-thinking");

  const mid = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    variant: "context",
    describe: async ({ background }) => {
      seen.push(background);
      return "一杯拿铁";
    },
  });
  assert.equal(mid.described, 1, "高成本档写过的图，中成本档仍应各自再读一次");
  assert.equal(fx.repository.findById(journal.id)!.aiDerived.length, 2, "两档结果并存，互不覆盖");
});

test("强制重跑会替换同档位的旧描述，而不是堆成两条", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  const journal = journalWithPhoto(fx.repository, "今天喝了一杯");
  fx.repository.insert(journal);

  const run = { repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails };
  await describePhotoLibrary({ ...run, describe: async () => "第一版描述" });

  // 不强制：同一档位必须零调用地跳过。
  const skipped = await describePhotoLibrary({
    ...run,
    describe: async () => {
      throw new Error("未强制时不应重复调用模型");
    },
  });
  assert.equal(skipped.alreadyDescribed, 1);
  assert.equal(skipped.described, 0);

  // 强制：真的再读一次，并且把旧的那条换掉。
  let calls = 0;
  const forced = await describePhotoLibrary({
    ...run,
    force: true,
    describe: async () => {
      calls += 1;
      return "第二版描述";
    },
  });
  assert.equal(calls, 1, "强制重跑必须真的再读一次");
  assert.equal(forced.described, 1);
  assert.equal(forced.alreadyDescribed, 0, "强制重跑没有「已完成」一说");

  const stored = fx.repository.findById(journal.id)!;
  assert.equal(stored.body.original, "今天喝了一杯", "正文不得被改动");
  assert.equal(stored.aiDerived.length, 1, "同档位旧描述应被替换，不得堆叠");
  assert.equal((stored.aiDerived[0]!.value as { text: string }).text, "第二版描述");
});

test("强制重跑只换自己那一档，别的档位一字不动", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  const journal = journalWithPhoto(fx.repository, "今天用的是浅烘豆");
  fx.repository.insert(journal);

  const run = { repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails };
  await describePhotoLibrary({ ...run, describe: async () => "便宜档描述" });
  await describePhotoLibrary({ ...run, variant: "context", describe: async () => "中档描述" });

  await describePhotoLibrary({ ...run, variant: "context", force: true, describe: async () => "中档描述·第二版" });

  const stored = fx.repository.findById(journal.id)!;
  const byVariant = new Map(stored.aiDerived.map((item) => [(item.value as { variant?: string }).variant ?? "plain", (item.value as { text: string }).text]));
  assert.equal(stored.aiDerived.length, 2, "强制只作用于本档位，不应增加或减少条目");
  assert.equal(byVariant.get("plain"), "便宜档描述", "别的档位不得被碰");
  assert.equal(byVariant.get("context"), "中档描述·第二版", "本档位应被换成新的一条");
});

test("an OCR pass that finds no words files an empty marker, and the next run skips it", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  fx.repository.insert(journalWithPhoto(fx.repository, "拍了张没有字的照片"));

  const run = { repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails, variant: "ocr" as const };
  let calls = 0;
  const first = await describePhotoLibrary({
    ...run,
    recognize: async () => {
      calls += 1;
      return { kind: "blank" as const, engine: "GeneralBasicOCR" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(first.described, 0, "没有文本就不该算「读到了字」");
  assert.equal(first.noDescription, 1);
  assert.equal(first.unread, 0, "服务回答了「没有字」，这不是「没问成」");

  const stored = fx.repository.list()[0]!;
  const entries = stored.aiDerived.filter((item) => (item.value as Record<string, unknown>).type === "photo-ocr");
  assert.equal(entries.length, 1, "空标记必须落库 —— 否则这张图每点一次都会被重问一遍");
  assert.equal((entries[0]!.value as Record<string, unknown>).text, "");
  assert.equal(entries[0]!.model, "GeneralBasicOCR", "标记要记下是哪一档确认的");

  // 第二次：不注入 recognize，直接把「再调用」判成失败。
  const again = await describePhotoLibrary({
    ...run,
    recognize: async () => {
      throw new Error("已标记为「没有字」的照片不该被再次识别");
    },
  });
  assert.equal(again.alreadyDescribed, 1, "空标记也算「这张问过了」");
  assert.equal(again.noDescription, 0, "它不该再进待办");
  assert.equal(again.described, 0);
});

test("an empty marker matches no search term", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  fx.repository.insert(journalWithPhoto(fx.repository, "干净正文，没有关键词"));

  await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    variant: "ocr",
    recognize: async () => ({ kind: "blank" as const, engine: "GeneralBasicOCR" }),
  });

  // 搜索是子串匹配：空文本命中不了任何词，所以标记不会把记录塞进别人的结果里。
  assert.deepEqual(fx.repository.list({ q: "拿铁" }), [], "空标记不得命中任何关键词");
  assert.deepEqual(fx.repository.list({ q: "zzz" }), []);
  assert.equal(fx.repository.list({ q: "干净正文" }).length, 1, "正文本身照旧能搜到");
});

test("a recogniser that could not answer writes nothing and is retried next run", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  fx.repository.insert(journalWithPhoto(fx.repository, "那次网络断了"));

  const run = { repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails, variant: "ocr" as const };
  const first = await describePhotoLibrary({ ...run, recognize: async () => ({ kind: "unread" as const }) });
  assert.equal(first.unread, 1);
  assert.equal(first.noDescription, 0, "「没问成」不是「图里没有字」");
  assert.equal(first.recordsUpdated, 0, "没问成就不该写任何条目");
  assert.equal(fx.repository.list()[0]!.aiDerived.length, 0);

  // 没有标记挡路，下一轮自然会重问这张。
  let calls = 0;
  const second = await describePhotoLibrary({
    ...run,
    recognize: async () => {
      calls += 1;
      return { kind: "text" as const, text: "补上的字", engine: "GeneralBasicOCR" };
    },
  });
  assert.equal(calls, 1, "上一轮没问成，这一轮必须重问");
  assert.equal(second.described, 1);
});

test("with no OCR credentials nothing is marked — the library is never called wordless", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  fx.repository.insert(journalWithPhoto(fx.repository, "还没配 key 的时候"));

  // 不注入 recognize，配置里也没有 tencentOcr：这正是「OCR 还没开」的样子。
  const run = await describePhotoLibrary({ repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails, variant: "ocr" });
  assert.equal(run.unread, 1, "没凭证 = 没问成");
  assert.equal(run.noDescription, 0, "绝不能读成「这张图没有字」");
  assert.equal(run.recordsUpdated, 0);
  assert.equal(fx.repository.list()[0]!.aiDerived.length, 0, "否则第一次跑就会把全库标记成没有字，且永久跳过");
});

test("a caption pass that cannot name the picture still writes nothing", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  fx.repository.insert(journalWithPhoto(fx.repository, "一张看不出是什么的图"));

  const run = await describePhotoLibrary({ repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails, describe: async () => "NONE" });
  assert.equal(run.noDescription, 1);
  assert.equal(run.unread, 0, "模型答了，只是答不出");
  assert.equal(run.recordsUpdated, 0, "「模型说不出」不等于「这张图没有字」，不落标记");
  assert.equal(fx.repository.list()[0]!.aiDerived.length, 0);
});

test("关掉一个能力之后，任何调用方都读不到这张照片", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  fx.repository.insert(journalWithPhoto(fx.repository, "这张照片不该被送去识别"));

  saveRuntimePhotoTextConfig(fx.config, { ocr: false, caption: false });

  let ocrAsked = 0;
  let captionAsked = 0;
  const ocr = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    variant: "ocr",
    recognize: async () => { ocrAsked += 1; return { kind: "text" as const, text: "不该出现", engine: "GeneralBasicOCR" }; },
  });
  const caption = await describePhotoLibrary({
    repository: fx.repository,
    config: fx.config,
    thumbnails: fx.thumbnails,
    describe: async () => { captionAsked += 1; return "不该出现"; },
  });

  // `disabled` and not merely `described: 0`: "nothing was attempted" must stay tellable
  // apart from "attempted and found nothing", or a switched-off feature reads as a bug.
  assert.equal(ocr.disabled, true);
  assert.equal(caption.disabled, true);
  assert.equal(ocrAsked, 0, "关掉之后一次请求都不许发");
  assert.equal(captionAsked, 0);
  assert.equal(fx.repository.list()[0]!.aiDerived.length, 0, "也不许留下任何东西");

  // The read-only survey still answers: switching a feature off must not also hide how much
  // is waiting inside it, which is exactly what she needs to decide about switching it back.
  const survey = await describePhotoLibrary({ repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails, variant: "ocr", limit: 0, dryRun: true });
  assert.equal(survey.disabled, undefined);
  assert.equal(survey.photos, 1);
  assert.equal(survey.remaining, 1);
});

test("force re-reads a picture that was marked wordless", async (t) => {
  const fx = await makeFixture();
  t.after(() => cleanupFixture(fx.root));
  fx.repository.insert(journalWithPhoto(fx.repository, "换引擎之后想再问一次"));

  const run = { repository: fx.repository, config: fx.config, thumbnails: fx.thumbnails, variant: "ocr" as const };
  await describePhotoLibrary({ ...run, recognize: async () => ({ kind: "blank" as const, engine: "GeneralBasicOCR" }) });

  const forced = await describePhotoLibrary({
    ...run,
    force: true,
    recognize: async () => ({ kind: "text" as const, text: "现在读出了字", engine: "GeneralAccurateOCR" }),
  });
  assert.equal(forced.described, 1, "强制重跑要能覆盖空标记，换引擎后才有补救的路");
  const stored = fx.repository.list()[0]!;
  const entries = stored.aiDerived.filter((item) => (item.value as Record<string, unknown>).type === "photo-ocr");
  assert.equal(entries.length, 1, "旧的空标记应被替换，不得堆成两条");
  assert.equal((entries[0]!.value as Record<string, unknown>).text, "现在读出了字");
  assert.equal(entries[0]!.model, "GeneralAccurateOCR");
});
