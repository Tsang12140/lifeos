import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ApiConfig } from "./config.js";
import type { ThumbnailCache, ThumbnailWidth } from "./derived-thumbs.js";
import type { RecordView, SqliteRecordRepository } from "./repository.js";
import { resolveAssetOriginal } from "./asset-static.js";
import { readRuntimeAiConfig } from "./ai-config.js";
import { askDeepSeek } from "./assistant.js";
import { nowInstant } from "./field-validate.js";

/**
 * Photo descriptions — one machine-written line per photo, so that a picture the
 * owner never typed a word about ("sent a coffee photo, said nothing") is still
 * findable later.
 *
 * Four rules shape this module, and each one answers something the owner asked for:
 *
 *   · **Derived, never theirs.** The sentence lands in `aiDerived`; `body` is never
 *     touched. A wrong guess must stay distinguishable from what she wrote.
 *   · **Identified by what the picture *is*.** The key is the photo's content hash,
 *     which is the same value the thumbnail cache is already filed under — so one
 *     photo appearing in three records is read once and shared, and re-running the
 *     pass costs nothing for pictures already done.
 *   · **Cheap on purpose.** Thinking is forced off and the 1200px thumbnail is sent
 *     instead of the original: the answer is one short sentence, not a reasoning
 *     exercise, and the thumbnail keeps bytes off the wire.
 *   · **Private records are never sent.** That is the owner's red line.
 */

/** 1200 is the widest thumbnail that still reaches the model's per-image token cap; anything larger is paid for and thrown away. */
export const PHOTO_DESCRIPTION_WIDTH: ThumbnailWidth = 1200;
export const PHOTO_DESCRIPTION_PROVIDER = "lifeos-photo";
const PHOTO_DESCRIPTION_VALUE_TYPE = "photo-description";
/** A first pass is meant to be looked at, not to drain a month's budget in one click. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 500;
const CONCURRENCY = 4;

export const PHOTO_DESCRIPTION_SYSTEM = [
  "你在为一个私人生活记录应用看照片，用一句中文写清这张照片是什么，最多40字。",
  "只写画面里看得见的东西：主体、场景、以及画面中可读的文字。",
  "画面里有招牌、菜单、书名、票据或界面文字时，把原文照抄进引号——那是硬信息。",
  "不评价好不好、不猜为什么拍、不补看不见的信息。",
  "确实看不出内容时，只回答：NONE",
].join("\n");

const PHOTO_DESCRIPTION_PROMPT = "描述这张照片。";

export type PhotoDescriber = (input: { readonly imageDataUrl: string }) => Promise<string | null>;

export interface PhotoDescriptionRunOptions {
  readonly repository: SqliteRecordRepository;
  readonly config: ApiConfig;
  readonly thumbnails: ThumbnailCache;
  /** How many *new* photos to read this run. Already-described photos never count. */
  readonly limit?: number;
  /** Read and report, write nothing. The safe way to look before committing. */
  readonly dryRun?: boolean;
  /** Restrict the pass to a single record — used when checking one entry by hand. */
  readonly recordId?: string;
  /** Injectable so a test can exercise the whole pass without touching the network. */
  readonly describe?: PhotoDescriber;
}

export interface PhotoDescriptionSample {
  readonly recordId: string;
  readonly assetId: string;
  readonly key: string;
  readonly text: string;
}

export interface PhotoDescriptionRun {
  /** Distinct photos referenced by the scanned records. */
  readonly photos: number;
  readonly described: number;
  readonly alreadyDescribed: number;
  /** Pictures the model saw but could not name. Left blank on purpose rather than guessed at. */
  readonly noDescription: number;
  /** Photos whose file could not be read (missing local copy, remote-only pool object). */
  readonly unreadable: number;
  /** Records skipped because they are private; their photos were never sent. */
  readonly skippedPrivate: number;
  readonly recordsUpdated: number;
  /** New photos still waiting after this run's limit. */
  readonly remaining: number;
  readonly written: boolean;
  readonly samples: readonly PhotoDescriptionSample[];
}

interface PhotoTarget {
  readonly key: string;
  readonly assetId: string;
  readonly recordIds: string[];
}

/**
 * The key a description is filed under. A photo with a content hash uses it — the
 * same value the thumbnail cache uses, so the two stay in agreement. A hand-registered
 * local file may carry no hash at all, and then the asset id stands in: weaker (it
 * cannot recognise the same picture filed twice) but never wrong.
 */
function targetKey(hash: { readonly algorithm: string; readonly value: string } | undefined, assetId: string): string {
  return hash === undefined ? `asset:${assetId}` : `${hash.algorithm}:${hash.value}`;
}

function collectKnownDescriptions(records: readonly RecordView[]): ReadonlySet<string> {
  const known = new Set<string>();
  for (const record of records) {
    for (const item of record.aiDerived) {
      if (item.kind !== "summary" || item.provider !== PHOTO_DESCRIPTION_PROVIDER) continue;
      const value = item.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const fields = value as Record<string, unknown>;
      if (fields.type !== PHOTO_DESCRIPTION_VALUE_TYPE || typeof fields.key !== "string") continue;
      known.add(fields.key);
    }
  }
  return known;
}

/**
 * Turns a model answer into the one line worth storing, or "" when there is nothing
 * to store. Fenced blocks, bullet prefixes and trailing chatter are stripped; a
 * refusal is not a description and must not be filed as one.
 */
export function cleanPhotoDescription(raw: string | null): string {
  if (raw === null) return "";
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  text = text.replace(/^[-*•]\s*/, "");
  text = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
  if (text.toUpperCase() === "NONE" || text === "无" || text === "无法识别") return "";
  return text.replace(/\s+/g, " ").slice(0, 120);
}

function defaultDescriber(config: ApiConfig): PhotoDescriber {
  const runtime = readRuntimeAiConfig(config);
  // Thinking on this task buys nothing and bills its reasoning tokens at the output
  // rate, which would dwarf the picture itself. Send the cheap version regardless of
  // what the owner's global AI setting says.
  const thrifty = { ...runtime, thinking: false };
  return ({ imageDataUrl }) => askDeepSeek(config, thrifty, PHOTO_DESCRIPTION_SYSTEM, [], PHOTO_DESCRIPTION_PROMPT, [imageDataUrl]);
}

/**
 * Reads every photo the records point at and files a one-line description for each
 * one that does not have it yet. Returns a report; writes only `aiDerived`.
 */
export async function describePhotoLibrary(options: PhotoDescriptionRunOptions): Promise<PhotoDescriptionRun> {
  const { repository, config, thumbnails } = options;
  const dryRun = options.dryRun === true;
  // A limit of 0 is meaningful: it surveys the library without reading a picture,
  // which is what the read-only endpoint reports.
  const limit = Math.max(0, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const everyone = repository.list();
  const known = collectKnownDescriptions(everyone);
  const scanned = options.recordId === undefined ? everyone : everyone.filter((record) => record.id === options.recordId);

  const targets = new Map<string, PhotoTarget>();
  let skippedPrivate = 0;
  for (const record of scanned) {
    if (record.isPrivate === true) {
      skippedPrivate += 1;
      continue;
    }
    for (const ref of record.assetRefs) {
      const asset = repository.findAssetById(ref.assetId);
      if (asset === null || asset.kind !== "photo") continue;
      const hash = asset.storageRefs.find((reference) => reference.contentHash !== undefined)?.contentHash;
      const key = targetKey(hash, asset.id);
      const existing = targets.get(key);
      if (existing === undefined) targets.set(key, { key, assetId: asset.id, recordIds: [record.id] });
      else if (!existing.recordIds.includes(record.id)) existing.recordIds.push(record.id);
    }
  }

  const pending = [...targets.values()].filter((target) => !known.has(target.key));
  const queue = pending.slice(0, limit);
  const byId = new Map(everyone.map((record) => [record.id, record]));
  const describe = options.describe ?? defaultDescriber(config);

  const samples: PhotoDescriptionSample[] = [];
  const additions = new Map<string, { readonly key: string; readonly assetId: string; readonly text: string }[]>();
  let described = 0;
  let noDescription = 0;
  let unreadable = 0;

  const read = async (target: PhotoTarget): Promise<{ readonly target: PhotoTarget; readonly text: string; readonly unreadable: boolean }> => {
    let imageDataUrl: string;
    try {
      const original = resolveAssetOriginal(config, repository, target.assetId);
      const file = await thumbnails.ensure(original.reference, original.file, PHOTO_DESCRIPTION_WIDTH);
      imageDataUrl = `data:image/webp;base64,${readFileSync(file).toString("base64")}`;
    } catch {
      return { target, text: "", unreadable: true };
    }
    try {
      return { target, text: cleanPhotoDescription(await describe({ imageDataUrl })), unreadable: false };
    } catch {
      return { target, text: "", unreadable: false };
    }
  };

  for (let start = 0; start < queue.length; start += CONCURRENCY) {
    const batch = queue.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map((target) => read(target)));
    for (const result of results) {
      if (result.unreadable) {
        unreadable += 1;
        continue;
      }
      if (result.text === "") {
        noDescription += 1;
        continue;
      }
      described += 1;
      for (const recordId of result.target.recordIds) {
        const list = additions.get(recordId) ?? [];
        list.push({ key: result.target.key, assetId: result.target.assetId, text: result.text });
        additions.set(recordId, list);
        samples.push({ recordId, assetId: result.target.assetId, key: result.target.key, text: result.text });
      }
    }
  }

  let recordsUpdated = 0;
  if (!dryRun) {
    for (const [recordId, items] of additions) {
      const record = byId.get(recordId);
      if (record === undefined) continue;
      const generatedAt = nowInstant();
      const aiDerived = items.map((item) => ({
        id: randomUUID(),
        kind: "summary" as const,
        provider: PHOTO_DESCRIPTION_PROVIDER,
        model: readRuntimeAiConfig(config).model,
        generatedAt,
        sourceRecordId: record.id,
        // The picture's own identity is what this description is a statement about:
        // replace the file and the old sentence stops matching its source.
        sourceRevision: item.key,
        value: { type: PHOTO_DESCRIPTION_VALUE_TYPE, key: item.key, assetId: item.assetId, width: PHOTO_DESCRIPTION_WIDTH, text: item.text },
      }));
      if (repository.update({ ...record, aiDerived: [...record.aiDerived, ...aiDerived] }, record.revision)) recordsUpdated += 1;
    }
  } else {
    recordsUpdated = additions.size;
  }

  return {
    photos: targets.size,
    described,
    alreadyDescribed: targets.size - pending.length,
    noDescription,
    unreadable,
    skippedPrivate,
    recordsUpdated,
    remaining: pending.length - queue.length,
    written: !dryRun,
    samples,
  };
}
