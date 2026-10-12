import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { analyzePhotoPixels, coverFromAnalysis, storyWeight, type Asset, type CalendarPresentation, type CalendarPhoto, type PhotoAnalysis } from "@lifeos/core";
import type { RecordView, SqliteRecordRepository } from "./repository.js";
import { dateForTime } from "./timeline-query.js";
import type { ThumbnailWidth } from "./derived-thumbs.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const calendarToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
/** The namespace prevents an identical asset id in another tenant from sharing a private cached URL. */
export function calendarAssetVersion(namespace: string, asset: Asset, localStamp?: string): string {
  return hash([namespace, asset.id, asset.storageRefs, localStamp]);
}
export function nextCalendarMidnight(now: Date): number {
  const day = calendarToday(now);
  return Date.parse(`${day}T00:00:00+08:00`) + 86_400_000;
}
interface Options {
  readonly repository: SqliteRecordRepository;
  readonly assetVersion?: (asset: Asset) => string;
  readonly thumbnail: (assetId: string, width: ThumbnailWidth) => Promise<string>;
  readonly summaries: (dates: readonly string[], now: Date) => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
}

/** One durable choice per day/profile. Browsing reads the choice; it never scores photos in a browser. */
export class CalendarDays {
  readonly #db: DatabaseSync;
  readonly #options: Options;
  readonly #namespace: string;
  #tail: Promise<unknown> = Promise.resolve();
  #timer?: ReturnType<typeof setTimeout>;
  #refreshTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  constructor(databasePath: string, options: Options) {
    this.#namespace = databasePath;
    this.#options = options;
    this.#db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.#db.exec(`CREATE TABLE IF NOT EXISTS calendar_days (day TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS calendar_photo_analysis (version TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT;`);
  }
  start(): void {
    this.schedule();
    const arm = () => {
      this.#timer = setTimeout(() => { this.schedule(0); arm(); }, nextCalendarMidnight(new Date()) - Date.now() + 20);
      this.#timer.unref();
    };
    arm();
  }
  schedule(delay = 750): void {
    if (this.#closed) return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => { void this.refresh().catch(this.#options.onError ?? (() => {})); }, delay);
    this.#refreshTimer.unref();
  }
  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer); clearTimeout(this.#refreshTimer);
    this.#db.close();
  }
  async refresh(now = new Date()): Promise<void> {
    if (this.#closed) return;
    const dates = new Set(this.#options.repository.list({ kind: "journal" }).map(r => dateForTime(r.occurredAt ?? r.createdAt, "Asia/Shanghai")));
    for (const row of this.#db.prepare("SELECT value_json FROM calendar_days").all()) dates.add((JSON.parse(String(row.value_json)) as CalendarPresentation).date);
    const pastAndToday = [...dates].filter(date => date <= calendarToday(now)).sort();
    for (const date of pastAndToday) {
      if (this.#closed) return;
      await this.resolve([date], now);
      await this.resolve([date], now, true);
    }
    if (!this.#closed) await this.#options.summaries(pastAndToday, now);
  }
  resolve(dates: readonly string[], now = new Date(), hideDemo = false): Promise<readonly CalendarPresentation[]> {
    const run = this.#tail.catch(() => undefined).then(() => this.#resolve(dates, now, hideDemo));
    this.#tail = run;
    return run;
  }
  #state() { return { assets: new Map(this.#options.repository.listAssets().map(a => [a.id, a])), records: this.#options.repository.list({ kind: "journal" }) }; }
  #inputs(date: string, today: string, hideDemo: boolean, state = this.#state(), preferred?: string) {
    const { assets } = state;
    const photos = (r: RecordView) => r.assetRefs.filter(ref => ref.role === "photo" && assets.get(ref.assetId)?.kind === "photo" && assets.get(ref.assetId)!.storageRefs.some(s => s.sourceId === "local" || s.sourceId === "lifeos-pool")).map(ref => assets.get(ref.assetId)!);
    const records = state.records.filter(r => r.isPrivate !== true && (!hideDemo || r.isDemo !== true) && dateForTime(r.occurredAt ?? r.createdAt, "Asia/Shanghai") === date);
    records.sort((a, b) => a.createdAt.value.localeCompare(b.createdAt.value) || a.id.localeCompare(b.id));
    const phase = date === today ? "provisional" as const : "final" as const;
    // Later additions, including backdated additions today, do not change the first photo diary.
    const first = records.find(r => r.id === preferred && photos(r).length > 0) ?? records.find(r => photos(r).length > 0);
    if (phase === "final") records.sort((a, b) => (a.occurredAt ?? a.createdAt).value.localeCompare((b.occurredAt ?? b.createdAt).value) || a.createdAt.value.localeCompare(b.createdAt.value) || a.id.localeCompare(b.id));
    const sources = phase === "provisional" ? (first === undefined ? [] : [first]) : records;
    const candidates = sources.flatMap(r => photos(r).map(asset => ({ asset, story: storyWeight((r.body.edited ?? r.body.original).length, r.entityRefs.length) })));
    const sourceHash = hash(["calendar:v1", phase, sources.map(r => [r.id, r.body, r.entityRefs, r.assetRefs]), candidates.map(c => [c.asset.id, this.#version(c.asset), c.asset.originalName, c.asset.photoMetadata?.width, c.asset.photoMetadata?.height, c.asset.photoMetadata?.cameraEvidence, c.story])]);
    return { phase, first, candidates, sourceHash };
  }
  #version(asset: Asset): string { return this.#options.assetVersion?.(asset) ?? calendarAssetVersion(this.#namespace, asset); }
  async #analysis(asset: Asset): Promise<PhotoAnalysis> {
    const version = this.#version(asset);
    const row = this.#db.prepare("SELECT value_json FROM calendar_photo_analysis WHERE version=?").get(version);
    if (row) { const saved = JSON.parse(String(row.value_json)); return { ...saved, attention: new Float32Array(saved.attention) }; }
    const file = await this.#options.thumbnail(asset.id, 400);
    const { data, info } = await sharp(readFileSync(file)).rotate().resize({ width: 192, height: 192, fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const analysis = analyzePhotoPixels(new Uint8ClampedArray(data), info.width, info.height);
    if (!this.#closed) this.#db.prepare("INSERT OR REPLACE INTO calendar_photo_analysis VALUES (?,?)").run(version, JSON.stringify({ ...analysis, attention: [...analysis.attention] }));
    return analysis;
  }
  async #resolve(dates: readonly string[], now: Date, hideDemo: boolean): Promise<readonly CalendarPresentation[]> {
    if (this.#closed) return [];
    const today = calendarToday(now), result: CalendarPresentation[] = [];
    const state = this.#state();
    for (const date of dates) {
      if (this.#closed || date > today) continue;
      const key = `${hideDemo ? "personal" : "all"}:${date}`;
      const row = this.#db.prepare("SELECT value_json FROM calendar_days WHERE day=?").get(key);
      const cached = row ? JSON.parse(String(row.value_json)) as CalendarPresentation : undefined;
      const input = this.#inputs(date, today, hideDemo, state, cached?.firstRecordId);
      if (cached?.sourceHash === input.sourceHash && (cached.retryAfter === undefined || cached.retryAfter > now.getTime())) { result.push(cached); continue; }
      let best: Asset | undefined, bestAnalysis: PhotoAnalysis | undefined, bestScore = -Infinity, failed = false;
      const available: Asset[] = [];
      // Server work is serialized and each unique image analysis is durable across days and restarts.
      for (const candidate of input.candidates) {
        if (this.#closed) return result;
        let analysis: PhotoAnalysis | undefined;
        try { analysis = await this.#analysis(candidate.asset); } catch { failed = true; continue; }
        available.push(candidate.asset);
        const score = coverFromAnalysis(analysis, candidate.asset, 1).score + candidate.story * 3;
        if (score > bestScore) { best = candidate.asset; bestAnalysis = analysis; bestScore = score; }
      }
      const photo = (asset: Asset): CalendarPhoto => ({ assetId: asset.id, version: this.#version(asset) });
      const unique = [...new Map(available.map(asset => [asset.id, asset])).values()];
      const week = unique.length <= 4 ? unique : Array.from({ length: 4 }, (_, i) => unique[Math.round(i * (unique.length - 1) / 3)]!);
      const monthCovers: Record<string, { position: string; score: number; textPenalty: number }> = {};
      if (bestAnalysis && best) for (const aspect of [0.5, 0.75, 1, 1.5, 2, 3, 4]) {
        const cover = coverFromAnalysis(bestAnalysis, best, aspect);
        monthCovers[String(aspect)] = { position: cover.position, score: cover.score, textPenalty: cover.textPenalty };
      }
      // Warm only the selected, small artwork. Both calendar modes share these bytes.
      for (const asset of new Map([...(best ? [best] : []), ...week].map(a => [a.id, a])).values()) {
        if (this.#closed) return result;
        try { await this.#options.thumbnail(asset.id, 400); } catch { failed = true; }
      }
      if (this.#closed) return result;
      // A delete/privacy/edit during decoding must not publish an obsolete choice.
      if (this.#inputs(date, today, hideDemo, undefined, input.first?.id).sourceHash !== input.sourceHash) {
        this.schedule(0);
        result.push({ date, phase: input.phase, sourceHash: "pending", monthCovers: {}, weekPhotos: [], updatedAt: now.toISOString(), retryAfter: now.getTime() + 1000 });
        continue;
      }
      const day: CalendarPresentation = { date, phase: input.phase, sourceHash: input.sourceHash,
        ...(input.phase === "provisional" && input.first ? { firstRecordId: input.first.id } : {}),
        ...(best ? { monthPhoto: photo(best) } : {}), monthCovers, weekPhotos: week.map(photo), updatedAt: now.toISOString(),
        ...(failed ? { retryAfter: now.getTime() + 60_000 } : {}) };
      this.#db.prepare("INSERT OR REPLACE INTO calendar_days VALUES (?,?)").run(key, JSON.stringify(day));
      result.push(day);
      if (failed) this.schedule(60_000);
    }
    return result;
  }
}
