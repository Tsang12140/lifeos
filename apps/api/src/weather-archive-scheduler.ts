import type { ApiConfig } from "./config.js";
import { archiveWeatherDay } from "./weather.js";
import { readRuntimeWeatherConfig, readWeatherProfile, type WeatherLocationOverride } from "./weather-config.js";
import type { SqliteRecordRepository } from "./repository.js";

export const WEATHER_ARCHIVE_TIME_ZONE = "Asia/Shanghai";
export const WEATHER_ARCHIVE_HOUR = 23;
export const WEATHER_ARCHIVE_MINUTE = 55;

type ZonedParts = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };

function zonedParts(value: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WEATHER_ARCHIVE_TIME_ZONE,
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

export function shanghaiWeatherDateKey(value: Date): string {
  const parts = zonedParts(value);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftDate(date: string, amount: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + amount));
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/** Next 23:55 occurrence in Shanghai, independent of the host timezone. */
export function nextWeatherArchiveAt(now: Date, hour = WEATHER_ARCHIVE_HOUR, minute = WEATHER_ARCHIVE_MINUTE): Date {
  const current = zonedParts(now);
  let candidate = Date.UTC(current.year, current.month - 1, current.day, hour, minute, 0, 0) - 8 * 60 * 60 * 1000;
  if (candidate <= now.getTime()) candidate += 24 * 60 * 60 * 1000;
  return new Date(candidate);
}

export interface WeatherArchiveSchedulerOptions {
  readonly repository: SqliteRecordRepository;
  readonly config: ApiConfig;
  readonly now?: () => Date;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Daily weather archiving is deliberately separate from backup scheduling.
 * Cache rows are the durable de-duplication primitive: an already archived
 * date/location is never fetched again, while a failed attempt remains
 * retryable on the next startup or timer tick.
 */
export class WeatherArchiveScheduler {
  readonly #repository: SqliteRecordRepository;
  readonly #config: ApiConfig;
  readonly #now: () => Date;
  readonly #setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly #clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #running = false;
  #inFlight = false;

  public constructor(options: WeatherArchiveSchedulerOptions) {
    this.#repository = options.repository;
    this.#config = options.config;
    this.#now = options.now ?? (() => new Date());
    this.#setTimeout = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#clearTimeout = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.#onError = options.onError ?? (() => {});
  }

  public start(): void {
    if (this.#running) return;
    this.#running = true;
    // A restart at any time checks yesterday. If it happens after 23:55 it
    // also checks today's final snapshot instead of waiting another day.
    void this.#runDue(this.#now());
    this.#arm();
  }

  public stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Explicit test/operator hook; it uses the same due-date rules as startup. */
  public async runOnce(now = this.#now()): Promise<boolean> {
    if (this.#inFlight) return false;
    return this.#runDue(now);
  }

  #targets(): readonly (WeatherLocationOverride | undefined)[] {
    const targets: (WeatherLocationOverride | undefined)[] = [undefined];
    const seen = new Set<string>();
    const defaultRuntime = readRuntimeWeatherConfig(this.#config);
    // Cache de-duplication is location-scoped, not profile/device-scoped. Two
    // profiles pointing at the same QWeather location should not make two
    // external calls for the same archived day.
    seen.add(`${defaultRuntime.locationId}|${defaultRuntime.city}`);
    for (const device of this.#repository.listWeatherDeviceLocations()) {
      if (device.profileId !== undefined) {
        const profile = readWeatherProfile(this.#config, device.profileId);
        if (profile !== null) {
          const key = `${profile.locationId}|${profile.city}`;
          if (!seen.has(key)) {
            seen.add(key);
            targets.push({ profileId: device.profileId, locationId: profile.locationId, city: profile.city, apiHost: profile.apiHost, apiKey: profile.apiKey ?? null });
          }
          continue;
        }
      }
      const key = `${device.locationId}|${device.city}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ locationId: device.locationId, city: device.city });
    }
    return targets;
  }

  #arm(): void {
    if (!this.#running) return;
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer);
    const target = nextWeatherArchiveAt(this.#now());
    const delay = Math.max(1, target.getTime() - this.#now().getTime());
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      // Re-read the clock when the callback actually fires. A suspended
      // process may wake after midnight, and the wall-clock date—not the old
      // timer target—determines which archive is due.
      void this.#runDue(this.#now()).finally(() => this.#arm());
    }, delay);
  }

  async #runDue(now: Date): Promise<boolean> {
    if (this.#inFlight) return false;
    this.#inFlight = true;
    let archivedAny = false;
    try {
      const today = shanghaiWeatherDateKey(now);
      const parts = zonedParts(now);
      const dates = [shiftDate(today, -1), ...(parts.hour > WEATHER_ARCHIVE_HOUR || (parts.hour === WEATHER_ARCHIVE_HOUR && parts.minute >= WEATHER_ARCHIVE_MINUTE) ? [today] : [])];
      for (const date of dates) {
        for (const target of this.#targets()) {
          try {
            const archived = await archiveWeatherDay(this.#config, date, target, this.#repository);
            archivedAny = archivedAny || archived;
          } catch (error) {
            this.#onError(error);
          }
        }
      }
      return archivedAny;
    } finally {
      this.#inFlight = false;
    }
  }
}
