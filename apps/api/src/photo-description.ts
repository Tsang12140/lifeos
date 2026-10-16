import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { ApiConfig } from "./config.js";
import type { ThumbnailCache, ThumbnailWidth } from "./derived-thumbs.js";
import type { RecordView, SqliteRecordRepository } from "./repository.js";
import { resolveAssetOriginal } from "./asset-static.js";
import { readRuntimeAiConfig } from "./ai-config.js";
import { askDeepSeek } from "./assistant.js";
import { OCR_TEXT_MAX_CHARS, type PhotoTextRecognizer } from "./tencent-ocr.js";
import { createPhotoTextChain, parseOcrActions, type PhotoTextChain } from "./photo-text-chain.js";
import { isPhotoTextCapabilityEnabled, type PhotoTextCapability } from "./photo-text-config.js";
import { nowInstant } from "./field-validate.js";

/**
 * Photos turned into text — one machine-written record per picture, so that an image the
 * owner never typed a word about ("sent a coffee photo, said nothing") is still findable
 * later. Two families live here, and they answer different questions:
 *
 *   · the **caption** passes ask a vision model *what is this a photo of* and get one
 *     summarising sentence back;
 *   · the **text** pass runs OCR and gets *what does it say*, verbatim.
 *
 * Six rules shape this module, and each one answers something the owner asked for:
 *
 *   · **Derived, never theirs.** The sentence lands in `aiDerived`; `body` is never
 *     touched. A wrong guess must stay distinguishable from what she wrote.
 *   · **Identified by what the picture *is*.** The key is the photo's content hash,
 *     which is the same value the thumbnail cache is already filed under — so one
 *     photo appearing in three records is read once and shared, and re-running the
 *     pass costs nothing for pictures already done.
 *   · **Cheap by default.** Thinking is off for the ordinary passes and a thumbnail is
 *     sent instead of the original: the answer is one short sentence, not a reasoning
 *     exercise. The one caption pass that does think exists to be priced, not to be the
 *     default. The OCR pass is cheaper still — it costs no model tokens at all.
 *   · **Private records are never sent.** That is the owner's red line, and it covers
 *     both families: the OCR pass leaves through the same door as the caption pass.
 *   · **A pass is labelled.** Several passes are kept for comparison (see `variant`), so
 *     the same picture can carry a bare caption, a context-aware one, a reasoning one
 *     and a transcription without any overwriting another.
 *   · **Reading is not summarising.** OCR output is stored with a type of its own
 *     (`photo-ocr`) rather than folded into a caption: a transcription that got truncated
 *     to one tidy line would be worse than useless for search, which is what it is for.
 */

/** 1200 is the widest thumbnail that still reaches the model's per-image token cap; anything larger is paid for and thrown away. */
export const PHOTO_DESCRIPTION_WIDTH: ThumbnailWidth = 1200;
/**
 * OCR reads pixels, not meaning: small print needs resolution, and the service advises
 * at least 600×800. 2048 is the largest derived width that already exists (it was built
 * for the opened-photo preview), so this costs no new cache entry — and a 2048px JPEG is
 * still around a megabyte, an order of magnitude under the service's 10 MB limit.
 */
export const PHOTO_OCR_WIDTH: ThumbnailWidth = 2048;
export const PHOTO_DESCRIPTION_PROVIDER = "lifeos-photo";
const PHOTO_DESCRIPTION_VALUE_TYPE = "photo-description";
/** The value type the OCR pass writes. Kept apart so the two families never overwrite each other. */
const PHOTO_OCR_VALUE_TYPE = "photo-ocr";
/** A first pass is meant to be looked at, not to drain a month's budget in one click. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 500;
const CONCURRENCY = 4;

/**
 * Which pass produced an entry. Passes are kept side by side so the owner can price the
 * same picture several ways (cheap / mid / high / verbatim) before deciding which ones are
 * worth keeping, and so a later pass over an already-captioned library finds work instead
 * of finding everything "already done".
 *
 *   · `plain`            — the picture on its own. Cheapest caption, and the baseline the
 *                          owner reads first when judging whether the sentences are worth it.
 *   · `context`          — the picture plus the text of its record, so the model can tell
 *                          what the entry was *about* (which picture "图二" refers to,
 *                          which detail she was pointing at).
 *   · `context-thinking` — exactly `context`, with the model allowed to think first. It
 *                          exists to be *measured*, not because reasoning is expected to
 *                          help: the answer is one short sentence, and reasoning tokens
 *                          bill at the output rate.
 *   · `ocr`              — not a caption at all: the words printed *in* the picture, copied
 *                          out by OCR. It is a pass like the others so that it shares their
 *                          machinery (keying, skip-if-done, privacy, forced re-runs) while
 *                          storing a type of its own.
 */
export type PhotoDescriptionVariant = "plain" | "context" | "context-thinking" | "ocr";
export const PHOTO_DESCRIPTION_VARIANTS: readonly PhotoDescriptionVariant[] = ["plain", "context", "context-thinking", "ocr"];

/** The OCR pass, as opposed to the caption passes. */
function isTextPass(variant: PhotoDescriptionVariant): boolean {
  return variant === "ocr";
}

/**
 * Which settings switch governs a pass. All three caption variants share one — to the owner
 * they are one feature at three price tags, not three features — and the text pass has its
 * own.
 */
export function capabilityFor(variant: PhotoDescriptionVariant): PhotoTextCapability {
  return isTextPass(variant) ? "ocr" : "caption";
}

/** The value type an entry of this pass is filed under. */
function valueTypeFor(variant: PhotoDescriptionVariant): string {
  return isTextPass(variant) ? PHOTO_OCR_VALUE_TYPE : PHOTO_DESCRIPTION_VALUE_TYPE;
}

/** Caption passes that hand the record's own words to the model. `plain` never sees them, and neither does OCR. */
function seesBackground(variant: PhotoDescriptionVariant): boolean {
  return variant === "context" || variant === "context-thinking";
}

/** Passes that let the model reason before it answers. Only the high-cost caption pass does. */
function thinks(variant: PhotoDescriptionVariant): boolean {
  return variant === "context-thinking";
}

/** Narrows a stored `variant` field back to a known pass. Anything else reads as `plain`. */
function parseVariant(raw: unknown): PhotoDescriptionVariant {
  return raw === "context" || raw === "context-thinking" || raw === "ocr" ? raw : "plain";
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
  /** Injectable OCR, for the same reason. Unset means "use the configured provider, if any". */
  readonly recognize?: PhotoTextRecognizer;
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
  /**
   * Pictures that were looked at and produced no text: a caption pass that could not name
   * what it saw, or an OCR pass that found no words printed in the picture. The OCR case
   * leaves an **empty marker** behind; the caption case leaves nothing, because "the model
   * had no words" is not the claim "this picture has none".
   */
  readonly noDescription: number;
  /**
   * Photos the recogniser was asked about but could not answer at all — a rate limit, a
   * timeout, a spent package, no credentials configured. **Nothing is written for these**,
   * so the next run tries them again; the count exists so that a pass which quietly read
   * nothing is visible, instead of looking like a library with no words in it.
   */
  readonly unread: number;
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
  /**
   * The OCR engines that actually produced text this run, in order of first use. With a
   * downgrade chain the configured preference and this list can differ, and a fallback
   * quietly changes what the library will be able to find later — so it is reported.
   */
  readonly engines?: readonly string[];
  /**
   * The owner has switched this capability off, so the pass did nothing at all — no photo
   * was re-encoded, no model was called. Distinct from a pass that ran and found no work:
   * the counts are zero here because nothing was attempted, not because nothing was left.
   */
  readonly disabled?: boolean;
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
  const wanted = valueTypeFor(variant);
  const known = new Set<string>();
  for (const record of records) {
    for (const item of record.aiDerived) {
      if (item.kind !== "summary" || item.provider !== PHOTO_DESCRIPTION_PROVIDER) continue;
      const value = item.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const fields = value as Record<string, unknown>;
      if (fields.type !== wanted || typeof fields.key !== "string") continue;
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

/**
 * The OCR pass is not a caption, so it is not squeezed into one line: every recognised
 * line is kept, in the order it appeared, because search matches on substrings and the
 * thing being searched for may well sit on line nine. Only the total length is capped.
 */
export function cleanOcrText(raw: string | null): string {
  if (raw === null) return "";
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.join("\n").slice(0, OCR_TEXT_MAX_CHARS);
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
  const system = seesBackground(variant) ? PHOTO_DESCRIPTION_SYSTEM_CONTEXT : PHOTO_DESCRIPTION_SYSTEM;
  return ({ imageDataUrl, background }) => {
    const prompt = background === undefined
      ? PHOTO_DESCRIPTION_PROMPT
      : `${PHOTO_DESCRIPTION_PROMPT}\n\n<背景>\n${background}\n</背景>`;
    return askDeepSeek(config, effort, system, [], prompt, [imageDataUrl]);
  };
}

/**
 * The OCR recogniser in force. With no credentials configured this is a recogniser that
 * answers `null` — the pass then runs and finds nothing, rather than failing, which is
 * what keeps "OCR is switched off" from looking like "the library is broken".
 *
 * With credentials it is the **downgrade chain** (§11): the preferred action answers, and
 * only a service-level refusal — the package is spent, the account is in arrears, the
 * service was never opened — moves the pass to the next one. A blip (rate limit, timeout,
 * one undecodable picture) skips that photo instead, because a demotion is permanent in
 * practice: photos already read are skipped next time and would keep the worse engine's
 * transcription for good.
 *
 * The chain is held per configuration, in process memory, not rebuilt per run. A pass
 * that ran out of its package must not be forgotten between two clicks of the same
 * button, or every batch would begin by failing once on the top tier. It forgets on the
 * 1st of the month, when the free allowance is reissued.
 */
let sharedOcrChain: { readonly key: string; readonly chain: PhotoTextChain } | null = null;

function recognizerFor(config: ApiConfig, variant: PhotoDescriptionVariant): PhotoTextRecognizer {
  // `unread`, never `blank`. With no credentials there is nothing to ask, and answering
  // "blank" here would file an empty marker for every photo in the library the first time
  // the pass ran — permanently, since a filed marker is what makes the next run skip.
  if (!isTextPass(variant) || config.tencentOcr === undefined) return async () => ({ kind: "unread" });
  const { secretId, secretKey, region, actions } = config.tencentOcr;
  const key = [secretId, region, actions].join("\u0000");
  if (sharedOcrChain === null || sharedOcrChain.key !== key) {
    sharedOcrChain = {
      key,
      chain: createPhotoTextChain({ credentials: { secretId, secretKey, region }, actions: parseOcrActions(actions) }),
    };
  }
  return sharedOcrChain.chain.recognize;
}

/** What the chain did this month — "spent, fell back to X" is worth saying out loud. */
export function ocrChainEvents(): readonly string[] {
  return sharedOcrChain?.chain.events ?? [];
}

/**
 * Reads every photo the records point at and files one line (or one transcription) for each
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

  // A limit of 0 is the read-only survey the settings panel counts with, and that one keeps
  // answering even when the capability is off — otherwise switching a feature off would also
  // hide how much is left to do in it. Every other limit would read a picture, and a
  // switched-off feature must not read one through *any* door: the panel's button, the
  // save-time trigger, or a script. This is the last of those doors, and it is shut before
  // the library is even scanned, so a refused pass costs nothing at all.
  if (limit > 0 && !isPhotoTextCapabilityEnabled(config, capabilityFor(variant))) {
    return {
      photos: 0,
      described: 0,
      alreadyDescribed: 0,
      noDescription: 0,
      unread: 0,
      unreadable: 0,
      skippedPrivate: 0,
      recordsUpdated: 0,
      remaining: 0,
      variant,
      written: false,
      samples: [],
      disabled: true,
    };
  }

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
    // owner is paying to compare them. OCR is never given them: the words it reads come
    // off the picture itself, and background text could only invite it to hallucinate.
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
  const recognize = options.recognize ?? recognizerFor(config, variant);
  const textPass = isTextPass(variant);

  const samples: PhotoDescriptionSample[] = [];
  const additions = new Map<string, { readonly key: string; readonly assetId: string; readonly text: string; readonly engine?: string }[]>();
  let described = 0;
  let noDescription = 0;
  let unreadable = 0;
  let unread = 0;
  /** Which engines answered, in first-use order — see `PhotoDescriptionRun.engines`. */
  const engines: string[] = [];

  /**
   * What one photo produced, in five outcomes rather than two. The pass treats them three
   * different ways, and telling the middle two apart is the whole point:
   *
   *   · `text`     — a transcription (OCR) or a caption; filed as an entry;
   *   · `blank`    — OCR read the picture and **there are no words in it**. Filed as an
   *                  **empty marker**, so the next pass skips this picture instead of
   *                  paying to be told the same nothing again. An empty transcription
   *                  matches no search term — search is a substring test — so the marker
   *                  cannot leak into results, and replacing the file re-keys the picture
   *                  and earns it a fresh read;
   *   · `nameless` — a caption pass looked and could not name the picture. Nothing is
   *                  filed: "the model had no words" is not the claim "this picture has
   *                  none", and only the latter is worth remembering;
   *   · `unread`   — the picture was never read at all (a blip, a spent package, no
   *                  credentials). Nothing is filed, so the next run picks it up again;
   *   · `broken`   — the bytes could not even be produced (missing local copy).
   */
  type PhotoRead = {
    readonly target: PhotoTarget;
    readonly kind: "text" | "blank" | "nameless" | "unread" | "broken";
    readonly text: string;
    readonly engine?: string;
  };

  const read = async (target: PhotoTarget): Promise<PhotoRead> => {
    let imageDataUrl = "";
    let imageBytes: Buffer | undefined;
    try {
      const original = resolveAssetOriginal(config, repository, target.assetId);
      if (textPass) {
        // The service reads PNG/JPG/JPEG/BMP and does not list WebP — and every derived
        // thumbnail here *is* WebP — so the pixels are re-encoded before they leave.
        const wide = await thumbnails.ensure(original.reference, original.file, PHOTO_OCR_WIDTH);
        imageBytes = await sharp(wide).jpeg({ quality: 88 }).toBuffer();
      } else {
        const file = await thumbnails.ensure(original.reference, original.file, PHOTO_DESCRIPTION_WIDTH);
        imageDataUrl = `data:image/webp;base64,${readFileSync(file).toString("base64")}`;
      }
    } catch {
      return { target, kind: "broken", text: "" };
    }
    try {
      if (textPass) {
        const outcome = await recognize({ image: imageBytes ?? Buffer.alloc(0), mime: "image/jpeg" });
        // `engine` records the tier that actually answered. With a chain in place the
        // configured preference and the engine used can differ, and that gap is precisely
        // what a later reader needs in order to tell a full-precision pass from a fallback.
        if (outcome.kind === "unread") return { target, kind: "unread", text: "" };
        if (outcome.kind === "blank") return { target, kind: "blank", text: "", engine: outcome.engine };
        return { target, kind: "text", text: cleanOcrText(outcome.text), engine: outcome.engine };
      }
      const answer = await describe({ imageDataUrl, ...(target.background === undefined ? {} : { background: target.background }) });
      const text = cleanPhotoDescription(answer);
      return text === "" ? { target, kind: "nameless", text: "" } : { target, kind: "text", text };
    } catch {
      // The model or the network let us down — that is "not read", never "no words here".
      return { target, kind: "unread", text: "" };
    }
  };

  for (let start = 0; start < queue.length; start += CONCURRENCY) {
    const batch = queue.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map((target) => read(target)));
    for (const result of results) {
      if (result.kind === "broken") {
        unreadable += 1;
        continue;
      }
      if (result.kind === "unread") {
        unread += 1;
        continue;
      }
      if (result.kind === "nameless") {
        noDescription += 1;
        continue;
      }
      // `text` and `blank` are both answers and both get written; they differ only in
      // whether there are words to keep.
      if (result.kind === "blank") noDescription += 1;
      else described += 1;
      if (result.kind === "text" && result.engine !== undefined && !engines.includes(result.engine)) engines.push(result.engine);
      for (const recordId of result.target.recordIds) {
        const list = additions.get(recordId) ?? [];
        list.push({
          key: result.target.key,
          assetId: result.target.assetId,
          text: result.text,
          ...(result.engine === undefined ? {} : { engine: result.engine }),
        });
        additions.set(recordId, list);
        // `samples` is what the pass read; an empty marker has nothing to show, so it
        // stays out of the samples while still being written to the record.
        if (result.kind === "text") samples.push({ recordId, assetId: result.target.assetId, key: result.target.key, text: result.text });
      }
    }
  }

  let recordsUpdated = 0;
  if (!dryRun) {
    // Every caption in this run comes from the same model, so it is read once rather than
    // re-derived record by record.
    const captionModel = readRuntimeAiConfig(config).model;
    for (const [recordId, items] of additions) {
      const record = byId.get(recordId);
      if (record === undefined) continue;
      const generatedAt = nowInstant();
      const aiDerived = items.map((item) => ({
        id: randomUUID(),
        kind: "summary" as const,
        provider: PHOTO_DESCRIPTION_PROVIDER,
        // An OCR transcription is not written by the language model and must not be
        // labelled as if it were: the engine name is what tells a later reader which
        // machinery read these words — and, with a downgrade chain in place, whether they
        // came from the preferred engine or from a fallback.
        model: textPass ? (item.engine ?? config.tencentOcr?.actions ?? "ocr") : captionModel,
        generatedAt,
        sourceRecordId: record.id,
        // The picture's own identity is what this description is a statement about:
        // replace the file and the old sentence stops matching its source.
        sourceRevision: item.key,
        value: {
          type: valueTypeFor(variant),
          variant,
          key: item.key,
          assetId: item.assetId,
          width: textPass ? PHOTO_OCR_WIDTH : PHOTO_DESCRIPTION_WIDTH,
          text: item.text,
        },
      }));
      // A forced run replaces this pass's old sentence for every picture it re-read.
      // Appending instead would leave two versions of the same pass in one record, and a
      // later read would pick whichever happens to sit last.
      const wanted = valueTypeFor(variant);
      const replaced = new Set(items.map((item) => item.key));
      const kept = force
        ? record.aiDerived.filter((entry) => {
          const value = entry.value as Record<string, unknown> | undefined;
          if (value === undefined || value.type !== wanted) return true;
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
    unread,
    unreadable,
    skippedPrivate,
    recordsUpdated,
    remaining: pending.length - queue.length,
    variant,
    written: !dryRun,
    samples,
    ...(engines.length === 0 ? {} : { engines }),
  };
}
