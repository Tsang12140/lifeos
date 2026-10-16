import { describePhotoLibrary, type PhotoDescriptionRun } from "./photo-description.js";
import { isPhotoTextCapabilityEnabled } from "./photo-text-config.js";
import type { ApiConfig } from "./config.js";
import type { SqliteRecordRepository } from "./repository.js";
import type { ThumbnailCache } from "./route-context.js";

/**
 * The pause that lets a burst of saves collapse into a single pass. An entry is not
 * written once: photos land one at a time, the text gets revised, the date gets fixed —
 * and every one of those saves looks identical from here.
 */
export const PHOTO_TEXT_DEBOUNCE_MS = 5_000;

/** New photos read in one slice: a few seconds of work, not a minute. */
const DEFAULT_SLICE = 20;

/**
 * The breath between slices — and the reason this is not merely a time limit.
 *
 * Reading a photo is mostly waiting on the network, which costs the process nothing. The
 * expensive part is `sharp` re-encoding the pixels before they leave, and that happens on
 * this process's CPU, in the same event loop that is answering the browser. A slice reads
 * four at a time; between slices the loop gets a clear gap to serve whatever she is doing
 * next. Only a library with more than one slice of new photos ever reaches this line.
 */
const SLICE_GAP_MS = 1_500;

/**
 * Slices in one pass. A ceiling, not an expectation: the ordinary pass has one slice
 * with nothing in it. It exists so that a first-ever run over a large library cannot
 * turn a single save into an hour of background traffic.
 */
const MAX_SLICES = 5;

export interface PhotoTextPassReport {
  /** Photos that were answered and filed this pass — words, or a "no words" marker. */
  readonly read: number;
  /** Photos the service would not answer. Nothing was filed, so the next pass retries. */
  readonly unread: number;
  readonly remaining: number;
  readonly slices: number;
  readonly engines: readonly string[];
}

type RunPass = (options: Parameters<typeof describePhotoLibrary>[0]) => Promise<PhotoDescriptionRun>;

export interface PhotoTextTriggerOptions {
  readonly repository: SqliteRecordRepository;
  readonly config: ApiConfig;
  readonly thumbnails: ThumbnailCache;
  readonly debounceMs?: number;
  readonly slice?: number;
  readonly sliceGapMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly onError?: (error: unknown) => void;
  readonly onReport?: (report: PhotoTextPassReport) => void;
  /** Injectable so a test can drive the whole mechanism without a network or a timer. */
  readonly run?: RunPass;
}

/**
 * Reads the words off newly filed photos *right after the entry is saved*, instead of
 * waiting for someone to remember to press a button.
 *
 * Three deliberate choices, all in service of one property — a save must never get slower,
 * and a save must never fail, because of this:
 *
 *   · **Off the request path.** The write answers first and this runs behind it. OCR is a
 *     network round trip per picture; no entry is going to wait on the internet to be saved.
 *   · **Debounced and single-flight.** A burst of saves collapses into one pass, and a pass
 *     already running absorbs the next ask rather than stacking another one behind it.
 *     Ten photos uploaded one by one are one pass, not ten passes over the library.
 *   · **Cheap when there is nothing to do, because the pass itself is idempotent.** A photo
 *     already carrying an answer for this pass is skipped by `describePhotoLibrary`, so a
 *     pass with no new pictures spends zero calls — which is the only reason "run on every
 *     save" is affordable at all. That idempotence is inherited, never re-implemented here.
 *
 * It also never *decides*: which photos to read, whether a picture is private, whether the
 * month's allowance is spent, whether a fallback engine answers — all of that belongs to
 * the pass, and is asked fresh each time. Nothing here is remembered between runs, so a
 * changed configuration is picked up on the next save without a restart.
 */
export class PhotoTextTrigger {
  readonly #repository: SqliteRecordRepository;
  readonly #config: ApiConfig;
  readonly #thumbnails: ThumbnailCache;
  readonly #debounceMs: number;
  readonly #slice: number;
  readonly #sliceGapMs: number;
  readonly #setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly #clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onReport: (report: PhotoTextPassReport) => void;
  readonly #run: RunPass;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #inFlight = false;
  /** An ask that arrived while a pass was running. One flag, not a queue: the pass reads
   *  the library fresh, so "something changed since you looked" is all the next one needs. */
  #pending = false;
  #stopped = false;

  public constructor(options: PhotoTextTriggerOptions) {
    this.#repository = options.repository;
    this.#config = options.config;
    this.#thumbnails = options.thumbnails;
    this.#debounceMs = options.debounceMs ?? PHOTO_TEXT_DEBOUNCE_MS;
    this.#slice = options.slice ?? DEFAULT_SLICE;
    this.#sliceGapMs = options.sliceGapMs ?? SLICE_GAP_MS;
    this.#setTimeout = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#clearTimeout = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.#onError = options.onError ?? (() => {});
    this.#onReport = options.onReport ?? (() => {});
    this.#run = options.run ?? describePhotoLibrary;
  }

  /**
   * "An entry was just saved." Says nothing about whether it had photos, whether they are
   * new, or whether they are worth reading — the pass answers all three, and asking here
   * would only mean guessing twice.
   */
  public notify(): void {
    if (this.#stopped) return;
    // Nothing to read with, or nothing to read *for*: see `#canRead`. A machine without a
    // key should not be scheduling work at all, and neither should one whose owner has
    // switched the feature off — in that case every photo would come back `unread` anyway.
    if (!this.#canRead()) return;
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer);
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      void this.runOnce();
    }, this.#debounceMs);
  }

  /** Explicit operator/test hook. Waits for the pass, unlike `notify`. */
  public async runOnce(): Promise<PhotoTextPassReport | null> {
    if (this.#stopped) return null;
    if (this.#inFlight) {
      this.#pending = true;
      return null;
    }
    this.#inFlight = true;
    try {
      return await this.#pass();
    } catch (error) {
      // Nothing here is worth failing a save over, and nothing here is worth a retry
      // storm either: the next save (or the next pass) will find the same work waiting.
      this.#onError(error);
      return null;
    } finally {
      this.#inFlight = false;
      if (this.#pending) {
        this.#pending = false;
        this.notify();
      }
    }
  }

  public stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * May this machine read at all — credentials present, and the owner's switch on?
   *
   * Both halves are asked here rather than relying on the pass to refuse, because a refused
   * pass is still a timer that fires, a library that gets scanned and a log line that says
   * something happened. Switching the feature off should mean the machine is quiet, not that
   * it wakes up to do nothing. The switch is read fresh on every save, so flipping it in the
   * settings panel takes effect on the very next one — no restart.
   */
  #canRead(): boolean {
    return this.#config.tencentOcr !== undefined && isPhotoTextCapabilityEnabled(this.#config, "ocr");
  }

  /** Hands the event loop back between slices — see `SLICE_GAP_MS`. */
  #gap(): Promise<void> {
    if (this.#sliceGapMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#setTimeout(() => resolve(), this.#sliceGapMs);
    });
  }

  async #pass(): Promise<PhotoTextPassReport> {
    let read = 0;
    let unread = 0;
    let remaining = 0;
    let slices = 0;
    const engines: string[] = [];
    for (let slice = 0; slice < MAX_SLICES; slice += 1) {
      const run = await this.#run({
        repository: this.#repository,
        config: this.#config,
        thumbnails: this.#thumbnails,
        variant: "ocr",
        limit: this.#slice,
      });
      slices += 1;
      const moved = run.described + run.noDescription;
      read += moved;
      unread += run.unread;
      remaining = run.remaining;
      for (const engine of run.engines ?? []) {
        if (!engines.includes(engine)) engines.push(engine);
      }
      if (run.remaining === 0) break;
      // Work is left but nothing moved: the recogniser is refusing (a spent package, a
      // rejected key, no credentials) and the next slice would fail the same way. Stop
      // and let the counters say what is still waiting, instead of hammering a closed door.
      if (moved === 0) break;
      await this.#gap();
    }
    const report: PhotoTextPassReport = { read, unread, remaining, slices, engines };
    this.#onReport(report);
    return report;
  }
}
