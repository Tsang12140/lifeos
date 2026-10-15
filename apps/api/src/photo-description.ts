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
 * Five rules shape this module, and each one answers something the owner asked for:
 *
 *   · **Derived, never theirs.** The sentence lands in `aiDerived`; `body` is never
 *     touched. A wrong guess must stay distinguishable from what she wrote.
 *   · **Identified by what the picture *is*.** The key is the photo's content hash,
 *     which is the same value the thumbnail cache is already filed under — so one
 *     photo appearing in three records is read once and shared, and re-running the
 *     pass costs nothing for pictures already done.
 *   · **Cheap by default.** Thinking is off for the ordinary passes and the 1200px
 *     thumbnail is sent instead of the original: the answer is one short sentence, not a
 *     reasoning exercise, and the thumbnail keeps bytes off the wire. The one pass that
 *     does think exists to be priced, not to be the default.
 *   · **Private records are never sent.** That is the owner's red line.
 *   · **A pass is labelled.** Several passes are kept for comparison (see `variant`), so
 *     the same picture can carry a bare caption, a context-aware one and a reasoning one
 *     without any overwriting another, and without re-paying for work already done.
 */

/** 1200 is the widest thumbnail that still reaches the model's per-image token cap; anything larger is paid for and thrown away. */
export const PHOTO_DESCRIPTION_WIDTH: ThumbnailWidth = 1200;
export const PHOTO_DESCRIPTION_PROVIDER = "lifeos-photo";
const PHOTO_DESCRIPTION_VALUE_TYPE = "photo-description";
/** A first pass is meant to be looked at, not to drain a month's budget in one click. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 500;
const CONCURRENCY = 4;

/**
 * Which pass produced a description. Three passes are kept so the owner can price the
 * same picture three ways (cheap / mid / high) before deciding which one is worth paying
 * for, and so a later pass over an already-captioned library finds work instead of
 * finding everything "already done".
 *
 *   · `plain`            — the picture on its own. Cheapest, and the baseline the owner
 *                          reads first when judging whether the sentences are worth it.
 *   · `context`          — the picture plus the text of its record, so the model can tell
 *                          what the entry was *about* (which picture "图二" refers to,
 *                          which detail she was pointing at).
 *   · `context-thinking` — exactly `context`, with the model allowed to think first. It
 *                          exists to be *measured*, not because reasoning is expected to
 *                          help: the answer is one short sentence, and reasoning tokens
 *                          bill at the output rate.
 */
export type PhotoDescriptionVariant = "plain" | "context" | "context-thinking";
export const PHOTO_DESCRIPTION_VARIANTS: readonly PhotoDescriptionVariant[] = ["plain", "context", "context-thinking"];

/** Passes that hand the record's own words to the model. `plain` never sees them. */
function seesBackground(variant: PhotoDescriptionVariant): boolean {
  return variant !== "plain";
}

/** Passes that let the model reason before it answers. Only the high-cost pass does. */
function thinks(variant: PhotoDescriptionVariant): boolean {
  return variant === "context-thinking";
}

/** Narrows a stored `variant` field back to a known pass. Anything else reads as `plain`. */
function parseVariant(raw: unknown): PhotoDescriptionVariant {
  return raw === "context" || raw === "context-thinking" ? raw : "plain";
}

export const PHOTO_DESCRIPTION_SYSTEM = [
  "你在为一个私人生活记录应用看照片，用一句中文写清这张照片是什么，最多40字。",
  "只写画面里看得见的东西：主体、场景、以及画面中可读的文字。",
  "画面里有招牌、菜单、书名、票据或界面文字时，把原文照抄进引号——那是硬信息。",
  "不评价好不好、不猜为什么拍、不补看不见的信息。",
  "确实看不出内容时，只回答：NONE",
].join("\n");

/**
 * The extra wording the `context` pass needs, and nothing more.
 *
 * The record's own text is a lamp, not an answer: it may say where to look, never what
 * something is. The model is told to drop anything the picture does not show, to let
 * the picture win any disagreement, and — the case that matters most — that the text
 * may have nothing to do with this photo at all, so it must not invent a connection.
 * The wording stays abstract on purpose: naming an example object here would put that
 * object in the model's mouth on every future run.
 */
export const PHOTO_DESCRIPTION_CONTEXT_RULE = [
  "另外会给你这张照片所属记录的文字背景。",
  "背景只用来提示该留意什么，不能用来决定这是什么；",
  "背景里提到、画面里却没有的东西，一个字都不要写；",
  "背景与画面冲突时以画面为准；",
  "背景可能跟这张照片根本无关，不要为了呼应它而编内容。",
].join("");

export const PHOTO_DESCRIPTION_SYSTEM_CONTEXT = `${PHOTO_DESCRIPTION_SYSTEM}\n${PHOTO_DESCRIPTION_CONTEXT_RULE}`;

/** Long enough to carry what she was writing about, short enough not to sway the caption. */
export const PHOTO_DESCRIPTION_BACKGROUND_CHARS = 200;

const PHOTO_DESCRIPTION_PROMPT = "描述这张照片。";

export type PhotoDescriber = (input: { readonly imageDataUrl: string; readonly background?: string }) => Promise<string | null>;

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
  /**
   * Restrict the pass to these record kinds. Journals only, say, leaving the screenshots
   * that were filed as tasks alone — a screenshot of one's own UI is not a memory worth
   * paying a vision model to caption.
   */
  readonly kinds?: readonly string[];
  /** Which pass this is. Defaults to `plain`; see `PhotoDescriptionVariant`. */
  readonly variant?: PhotoDescriptionVariant;
  /**
   * Re-caption photos that already carry a description for this pass, replacing the old
   * sentence instead of skipping it.
   *
   * Off by default, and deliberately so: captioning the library once costs real money, and
   * a second run over the same pass must never spend it again by accident. Turn this on
   * only when the *wording* is meant to change — a new prompt, a different model, a pass
   * being re-measured on purpose — where the old captions are worth discarding.
   */
  readonly force?: boolean;
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
  readonly variant: PhotoDescriptionVariant;
  readonly written: boolean;
  readonly samples: readonly PhotoDescriptionSample[];
}

interface PhotoTarget {
  readonly key: string;
  readonly assetId: string;
  readonly recordIds: string[];
  /**
   * Text of the first record that referenced this picture. When one photo is filed under
   * several entries they can only carry one background — de-duplicating by picture is what
   * keeps the pass from paying twice for the same pixels, and this is the price of that.
   */
  readonly background?: string;
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

/** Reads the pass label off a stored entry. Entries written before passes existed are `plain`. */
function variantOf(value: object): PhotoDescriptionVariant {
  return parseVariant((value as Record<string, unknown>).variant);
}

function collectKnownDescriptions(records: readonly RecordView[], variant: PhotoDescriptionVariant): ReadonlySet<string> {
  const known = new Set<string>();
  for (const record of records) {
    for (const item of record.aiDerived) {
      if (item.kind !== "summary" || item.provider !== PHOTO_DESCRIPTION_PROVIDER) continue;
      const value = item.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const fields = value as Record<string, unknown>;
      if (fields.type !== PHOTO_DESCRIPTION_VALUE_TYPE || typeof fields.key !== "string") continue;
      if (variantOf(value) !== variant) continue;
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

/** The record's own words, trimmed to the length the context pass is allowed to see. */
function backgroundFor(record: RecordView): string | undefined {
  const text = (record.body.edited ?? record.body.original).trim();
  if (text === "") return undefined;
  return [...text].slice(0, PHOTO_DESCRIPTION_BACKGROUND_CHARS).join("");
}

function defaultDescriber(config: ApiConfig, variant: PhotoDescriptionVariant): PhotoDescriber {
  const runtime = readRuntimeAiConfig(config);
  // The ordinary passes keep thinking off regardless of the owner's global AI setting:
  // the answer is one short sentence, and reasoning tokens bill at the output rate,
  // which would dwarf the picture itself. The high-cost pass is the one exception — its
  // whole reason to exist is to price what thinking adds — so it too ignores the global
  // setting, in the other direction.
  const effort = { ...runtime, thinking: thinks(variant) };
  const system = variant === "plain" ? PHOTO_DESCRIPTION_SYSTEM : PHOTO_DESCRIPTION_SYSTEM_CONTEXT;
  return ({ imageDataUrl, background }) => {
    const prompt = background === undefined
      ? PHOTO_DESCRIPTION_PROMPT
      : `${PHOTO_DESCRIPTION_PROMPT}\n\n<背景>\n${background}\n</背景>`;
    return askDeepSeek(config, effort, system, [], prompt, [imageDataUrl]);
  };
}

/**
 * Reads every photo the records point at and files a one-line description for each
 * one that does not have it yet. Returns a report; writes only `aiDerived`.
 */
export async function describePhotoLibrary(options: PhotoDescriptionRunOptions): Promise<PhotoDescriptionRun> {
  const { repository, config, thumbnails } = options;
  const dryRun = options.dryRun === true;
  const variant = options.variant ?? "plain";
  const force = options.force === true;
  // A limit of 0 is meaningful: it surveys the library without reading a picture,
  // which is what the read-only endpoint reports.
  const limit = Math.max(0, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const everyone = repository.list();
  const known = collectKnownDescriptions(everyone, variant);
  const scanned = everyone.filter((record) =>
    (options.recordId === undefined || record.id === options.recordId)
    && (options.kinds === undefined || options.kinds.includes(record.kind)));

  const targets = new Map<string, PhotoTarget>();
  let skippedPrivate = 0;
  for (const record of scanned) {
    if (record.isPrivate === true) {
      skippedPrivate += 1;
      continue;
    }
    // Only the context passes are allowed to see the record's words. Handing them to the
    // plain pass too would quietly turn the passes into the same experiment, and the
    // owner is paying to compare them.
    const background = seesBackground(variant) ? backgroundFor(record) : undefined;
    for (const ref of record.assetRefs) {
      const asset = repository.findAssetById(ref.assetId);
      if (asset === null || asset.kind !== "photo") continue;
      const hash = asset.storageRefs.find((reference) => reference.contentHash !== undefined)?.contentHash;
      const key = targetKey(hash, asset.id);
      const existing = targets.get(key);
      if (existing === undefined) {
        targets.set(key, { key, assetId: asset.id, recordIds: [record.id], ...(background === undefined ? {} : { background }) });
      } else if (!existing.recordIds.includes(record.id)) {
        existing.recordIds.push(record.id);
      }
    }
  }

  // A forced run re-reads this pass on purpose. Without it, a photo that already carries
  // this pass's sentence is left alone — which is what stops a second run from spending
  // her credits twice for the same picture.
  const pending = [...targets.values()].filter((target) => force || !known.has(target.key));
  const queue = pending.slice(0, limit);
  const byId = new Map(everyone.map((record) => [record.id, record]));
  const describe = options.describe ?? defaultDescriber(config, variant);

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
      const answer = await describe({ imageDataUrl, ...(target.background === undefined ? {} : { background: target.background }) });
      return { target, text: cleanPhotoDescription(answer), unreadable: false };
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
        value: { type: PHOTO_DESCRIPTION_VALUE_TYPE, variant, key: item.key, assetId: item.assetId, width: PHOTO_DESCRIPTION_WIDTH, text: item.text },
      }));
      // A forced run replaces this pass's old sentence for every picture it re-read.
      // Appending instead would leave two versions of the same pass in one record, and a
      // later read would pick whichever happens to sit last.
      const replaced = new Set(items.map((item) => item.key));
      const kept = force
        ? record.aiDerived.filter((entry) => {
          const value = entry.value as Record<string, unknown> | undefined;
          if (value === undefined || value.type !== PHOTO_DESCRIPTION_VALUE_TYPE) return true;
          if (variantOf(value) !== variant) return true;
          return !(typeof value.key === "string" && replaced.has(value.key));
        })
        : record.aiDerived;
      if (repository.update({ ...record, aiDerived: [...kept, ...aiDerived] }, record.revision)) recordsUpdated += 1;
    }
  } else {
    recordsUpdated = additions.size;
  }

  return {
    photos: targets.size,
    described,
    // A forced run has no notion of "already described": every target was re-read on purpose.
    alreadyDescribed: force ? 0 : targets.size - pending.length,
    noDescription,
    unreadable,
    skippedPrivate,
    recordsUpdated,
    remaining: pending.length - queue.length,
    variant,
    written: !dryRun,
    samples,
  };
}
