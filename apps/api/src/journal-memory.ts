import { createHash } from "node:crypto";
import type { ApiConfig } from "./config.js";
import type { RecordView, SqliteRecordRepository } from "./repository.js";
import { embedJournalTexts, embeddingIdentity } from "./journal-embedding.js";

export const journalText = (record: RecordView): string => record.body.edited ?? record.body.original;
export const eligibleJournal = (record: RecordView | null): record is RecordView => !!record && record.kind === "journal" && !record.isPrivate && !record.isDemo;
export function journalChunks(record: RecordView): readonly { index: number; text: string; hash: string }[] {
  const chars = Array.from(journalText(record));
  const chunks = [];
  for (let start = 0; start < chars.length; start += 1000) {
    const text = chars.slice(start, start + 1200).join("");
    if (text.trim()) chunks.push({ index: start / 1000, text, hash: createHash("sha256").update(text).digest("hex") });
    if (start + 1200 >= chars.length) break;
  }
  return chunks;
}

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
/** Fixed Beijing 03:00, independent of the server's local time zone. */
export function nextJournalMemorySweep(now = Date.now()): number {
  const today = dayFormat.format(new Date(now));
  const tonight = Date.parse(`${today}T03:00:00+08:00`);
  return tonight > now ? tonight : tonight + 86_400_000;
}

/** Bounded work behind saves. Resume from persisted hashes; shutdown cancels late writes. */
export class JournalMemoryIndexer {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nightTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #running = false;
  #dirty = false;
  #retryAt = 0;
  #notBefore = 0;
  #controller = new AbortController();
  constructor(private readonly config: ApiConfig, private readonly repository: SqliteRecordRepository) {}
  start(): void {
    if (this.#closed || this.#nightTimer || !this.config.journalEmbedding) return;
    this.schedule();
    this.#scheduleNight();
  }
  /** Coalesce saves until thirty seconds after the latest completed mutation. */
  schedule(): void {
    if (this.#closed || !this.config.journalEmbedding) return;
    this.#notBefore = Date.now() + 30_000;
    this.#queue();
  }
  #queue(delay = 0): void {
    if (this.#closed) return;
    if (this.#running) { this.#dirty = true; return; }
    clearTimeout(this.#timer);
    const due = Math.max(Date.now() + delay, this.#notBefore, this.#retryAt);
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.runSlice(); }, Math.max(0, due - Date.now()));
    this.#timer.unref();
  }
  #scheduleNight(): void {
    const due = nextJournalMemorySweep();
    this.#nightTimer = setTimeout(() => {
      this.#nightTimer = undefined;
      if (this.#closed) return;
      // If the machine slept through the night, do not catch up in daytime.
      if (Date.now() < due + 3 * 60 * 60_000) this.#queue();
      this.#scheduleNight();
    }, due - Date.now());
    this.#nightTimer.unref();
  }
  async runSlice(): Promise<number> {
    if (this.#closed || this.#running || !this.config.journalEmbedding || Date.now() < this.#retryAt) return 0;
    clearTimeout(this.#timer); this.#timer = undefined;
    this.#running = true;
    this.#dirty = false;
    let stored = 0, more = false;
    try {
      const config = this.config.journalEmbedding, key = embeddingIdentity(config);
      const known = new Map(this.repository.journalMemory.list(key).map(row => [`${row.recordId}/${row.index}`, row.hash]));
      const pending: { recordId: string; index: number; text: string; hash: string }[] = [];
      outer: for (const record of this.repository.list({ kind: "journal" })) {
        if (!eligibleJournal(record)) continue;
        for (const chunk of journalChunks(record)) {
          if (known.get(`${record.id}/${chunk.index}`) === chunk.hash) continue;
          if (pending.length === 10) { more = true; break outer; }
          pending.push({ ...chunk, recordId: record.id });
        }
      }
      if (!pending.length) return 0;
      const vectors = await embedJournalTexts(config, pending.map(chunk => chunk.text), this.#controller.signal);
      if (this.#closed) return 0;
      for (const [i, chunk] of pending.entries()) {
        const current = this.repository.findById(chunk.recordId);
        if (!eligibleJournal(current) || journalChunks(current).find(value => value.index === chunk.index)?.hash !== chunk.hash) continue;
        this.repository.journalMemory.put(chunk.recordId, chunk.index, chunk.hash, key, vectors[i]!); stored++;
      }
    } catch {
      if (!this.#closed) { this.#retryAt = Date.now() + 60_000; console.error("[journal-memory] indexing paused after provider failure; retry in 60s"); }
    } finally {
      this.#running = false;
      // Continue a large import promptly; new saves still keep their thirty-second grace.
      // Retry failures independently of the nightly sweep, so an outage cannot stall a whole day.
      if (!this.#closed && (more || this.#dirty || Date.now() < this.#retryAt)) this.#queue(more ? 500 : 0);
    }
    return stored;
  }
  stop(): void { this.#closed = true; clearTimeout(this.#timer); clearTimeout(this.#nightTimer); this.#controller.abort(); }
}
