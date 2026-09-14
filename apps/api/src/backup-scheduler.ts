import type { ApiConfig } from "./config.js";
import { createDualBackup } from "./backup.js";
import type { BackupSchedule, SqliteRecordRepository } from "./repository.js";

export const BACKUP_TIME_ZONE = "Asia/Shanghai";

type ZonedParts = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };

function zonedParts(value: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BACKUP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

/** Stable China/Shanghai day key used for scheduler de-duplication and UI. */
export function shanghaiDateKey(value: Date): string {
  const parts = zonedParts(value);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * Return the next wall-clock occurrence of a daily schedule in Shanghai. The
 * zone has no DST, but constructing from explicit UTC parts still avoids the
 * host machine's local timezone leaking into the result.
 */
export function nextDailyBackupAt(now: Date, hour: number, minute: number): Date {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("备份小时必须在 0 到 23 之间");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("备份分钟必须在 0 到 59 之间");
  const current = zonedParts(now);
  let candidate = Date.UTC(current.year, current.month - 1, current.day, hour, minute, 0, 0) - 8 * 60 * 60 * 1000;
  if (candidate <= now.getTime()) candidate += 24 * 60 * 60 * 1000;
  return new Date(candidate);
}

export function backupScheduleRunKey(value: Date, hour: number, minute: number): string {
  return `${shanghaiDateKey(value)}-${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
}

export function publicNextBackupAt(schedule: BackupSchedule, now = new Date()): string | null {
  return schedule.enabled ? nextDailyBackupAt(now, schedule.hour, schedule.minute).toISOString() : null;
}

export interface BackupSchedulerOptions {
  readonly repository: SqliteRecordRepository;
  readonly config: ApiConfig;
  readonly now?: () => Date;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Small dependency-free daily scheduler. It reads persisted settings on start,
 * uses a single timer, and claims each Shanghai date/time in SQLite before
 * executing so a restart or duplicate timer cannot create two runs.
 */
export class BackupScheduler {
  readonly #repository: SqliteRecordRepository;
  readonly #config: ApiConfig;
  readonly #now: () => Date;
  readonly #setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly #clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #running = false;
  #schedule: BackupSchedule;
  #inFlight = false;

  public constructor(options: BackupSchedulerOptions) {
    this.#repository = options.repository;
    this.#config = options.config;
    this.#now = options.now ?? (() => new Date());
    this.#setTimeout = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#clearTimeout = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.#onError = options.onError ?? (() => {});
    this.#schedule = this.#repository.getBackupSchedule();
  }

  public get schedule(): BackupSchedule {
    return this.#schedule;
  }

  public nextRunAt(now = this.#now()): Date | null {
    return this.#schedule.enabled ? nextDailyBackupAt(now, this.#schedule.hour, this.#schedule.minute) : null;
  }

  public update(schedule: BackupSchedule): void {
    this.#schedule = schedule;
    if (this.#running) this.#arm();
  }

  public start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#arm();
  }

  public stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Test hook and an explicit way for an operator to run the supplied slot now. */
  public async runOnce(now = this.#now()): Promise<boolean> {
    if (!this.#schedule.enabled || this.#inFlight) return false;
    return this.#runAt(now);
  }

  #arm(): void {
    if (!this.#running) return;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const target = this.nextRunAt();
    if (target === null) return;
    const delay = Math.max(1, target.getTime() - this.#now().getTime());
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      void this.#runAt(target).finally(() => this.#arm());
    }, delay);
  }

  async #runAt(target: Date): Promise<boolean> {
    if (this.#inFlight) return false;
    const key = backupScheduleRunKey(target, this.#schedule.hour, this.#schedule.minute);
    if (!this.#repository.claimBackupScheduleRun(key)) return false;
    this.#inFlight = true;
    try {
      await createDualBackup(this.#config, this.#repository, "scheduled");
      return true;
    } catch (error) {
      // createDualBackup normally returns partial/local failures as data; this
      // guard is for unexpected programming/runtime errors in the scheduler.
      this.#onError(error);
      return false;
    } finally {
      this.#inFlight = false;
    }
  }
}
