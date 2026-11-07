import type { SqliteRecordRepository } from "./repository.js";

export const RECORD_SUMMARY_SWEEP_TIME_ZONE = "Asia/Shanghai";
export const RECORD_SUMMARY_SWEEP_HOUR = 3;
export const RECORD_SUMMARY_SWEEP_MINUTE = 35;
const STARTUP_CATCH_UP_DELAY_MS = 2_000;

type ZonedParts = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };

function zonedParts(value: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RECORD_SUMMARY_SWEEP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function shanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RECORD_SUMMARY_SWEEP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

/** Next 03:35 occurrence in Shanghai; the zone has no daylight-saving shift. */
export function nextRecordSummarySweepAt(now: Date): Date {
  const current = zonedParts(now);
  let candidate = Date.UTC(current.year, current.month - 1, current.day, RECORD_SUMMARY_SWEEP_HOUR, RECORD_SUMMARY_SWEEP_MINUTE) - 8 * 60 * 60 * 1000;
  if (candidate <= now.getTime()) candidate += 24 * 60 * 60 * 1000;
  return new Date(candidate);
}

export interface RecordSummarySchedulerOptions {
  readonly repository: SqliteRecordRepository;
  readonly run: (date: string) => Promise<unknown>;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

// Tenants get separate repositories and markers, while their jobs share this
// process-wide serial queue so the 03:35 fan-out cannot create unbounded model
// concurrency when many accounts are enabled.
let serialSweepQueue: Promise<unknown> = Promise.resolve();
function enqueueSerialSweep<T>(task: () => Promise<T>): Promise<T> {
  const next = serialSweepQueue.catch(() => undefined).then(task);
  serialSweepQueue = next.then(() => undefined, () => undefined);
  return next;
}

export class RecordSummaryScheduler {
  readonly #repository: SqliteRecordRepository;
  readonly #run: RecordSummarySchedulerOptions["run"];
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #startupTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #running = false;
  #inFlight = false;

  public constructor(options: RecordSummarySchedulerOptions) {
    this.#repository = options.repository;
    this.#run = options.run;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => {});
  }

  public start(): void {
    if (this.#running) return;
    this.#running = true;
    const now = this.#now();
    const state = this.#repository.initializeRecordSummaryAutomation(now.toISOString());
    const date = shanghaiDate(now);
    const parts = zonedParts(now);
    const pastRunTime = parts.hour * 60 + parts.minute >= RECORD_SUMMARY_SWEEP_HOUR * 60 + RECORD_SUMMARY_SWEEP_MINUTE;
    // Catch up only if the first scheduled run actually fell due while this
    // feature was already enabled. A first install after 03:35 waits until tomorrow.
    const firstScheduledDate = shanghaiDate(nextRecordSummarySweepAt(new Date(Date.parse(state.enabledSince))));
    if (pastRunTime && firstScheduledDate <= date && state.lastAttemptedDate !== date) {
      this.#startupTimer = setTimeout(() => {
        this.#startupTimer = undefined;
        void this.#runDate(date);
      }, STARTUP_CATCH_UP_DELAY_MS);
      this.#startupTimer.unref();
    }
    this.#arm();
  }

  public stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
    this.#timer = undefined;
    this.#startupTimer = undefined;
  }

  #arm(): void {
    if (!this.#running) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const now = this.#now();
    const target = nextRecordSummarySweepAt(now);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const current = this.#now();
      void this.#runDate(shanghaiDate(current));
      this.#arm();
    }, Math.max(1, target.getTime() - now.getTime()));
    this.#timer.unref();
  }

  async #runDate(date: string): Promise<void> {
    if (!this.#running || this.#inFlight) return;
    this.#inFlight = true;
    try {
      await enqueueSerialSweep(async () => {
        if (!this.#running || shanghaiDate(this.#now()) !== date) return;
        const state = this.#repository.initializeRecordSummaryAutomation(this.#now().toISOString());
        if (state.lastAttemptedDate === date) return;
        // Persist before calling a model. A crash or provider failure must not
        // repeat the same tenant's batch on the same local date after restart.
        this.#repository.markRecordSummarySweepAttempted(date);
        await this.#run(date);
      });
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#inFlight = false;
    }
  }
}
