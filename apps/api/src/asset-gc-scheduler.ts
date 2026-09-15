import { runAssetGc, type AssetGcReport } from "./asset-gc.js";
import type { ApiConfig } from "./config.js";
import type { SqliteRecordRepository } from "./repository.js";

/** The collector runs at a quiet hour: backups own 02:00, so it takes 03:30. */
export const ASSET_GC_TIME_ZONE = "Asia/Shanghai";
export const ASSET_GC_HOUR = 3;
export const ASSET_GC_MINUTE = 30;

type ZonedParts = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };

function zonedParts(value: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ASSET_GC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

/** Next 03:30 occurrence in Shanghai, independent of the host timezone. */
export function nextAssetGcAt(now: Date, hour = ASSET_GC_HOUR, minute = ASSET_GC_MINUTE): Date {
  const current = zonedParts(now);
  let candidate = Date.UTC(current.year, current.month - 1, current.day, hour, minute, 0, 0) - 8 * 60 * 60 * 1000;
  if (candidate <= now.getTime()) candidate += 24 * 60 * 60 * 1000;
  return new Date(candidate);
}

export interface AssetGcSchedulerOptions {
  readonly repository: SqliteRecordRepository;
  readonly config: ApiConfig;
  readonly now?: () => Date;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly onError?: (error: unknown) => void;
  readonly onReport?: (report: AssetGcReport) => void;
}

/**
 * Reclaiming unreferenced uploads is deliberately separate from backup
 * scheduling: it is a file-system chore, not a durability guarantee, and a
 * failure here must never touch the backup path.
 *
 * Every pass is safe to run at any time — including on startup and from tests —
 * because the three collection conditions are re-derived from the database,
 * never from remembered state.
 */
export class AssetGcScheduler {
  readonly #repository: SqliteRecordRepository;
  readonly #config: ApiConfig;
  readonly #now: () => Date;
  readonly #setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly #clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onReport: (report: AssetGcReport) => void;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #running = false;
  #inFlight = false;

  public constructor(options: AssetGcSchedulerOptions) {
    this.#repository = options.repository;
    this.#config = options.config;
    this.#now = options.now ?? (() => new Date());
    this.#setTimeout = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#clearTimeout = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.#onError = options.onError ?? (() => {});
    this.#onReport = options.onReport ?? (() => {});
  }

  public start(): void {
    if (this.#running) return;
    this.#running = true;
    // A long-running install may not have been restarted for weeks, so the
    // first pass happens immediately instead of waiting for 03:30.
    void this.runOnce(this.#now());
    this.#arm();
  }

  public stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Explicit test/operator hook. Re-entrant calls are ignored, not queued. */
  public runOnce(now: Date = this.#now()): AssetGcReport | null {
    if (this.#inFlight) return null;
    this.#inFlight = true;
    try {
      const report = runAssetGc(this.#config, this.#repository, now);
      this.#onReport(report);
      return report;
    } catch (error) {
      this.#onError(error);
      return null;
    } finally {
      this.#inFlight = false;
    }
  }

  #arm(): void {
    if (!this.#running) return;
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer);
    const target = nextAssetGcAt(this.#now());
    const delay = Math.max(1, target.getTime() - this.#now().getTime());
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      // Re-read the clock when the callback actually fires: a suspended machine
      // may wake hours late, and the collector's correctness depends on `now`.
      this.runOnce(this.#now());
      this.#arm();
    }, delay);
  }
}
