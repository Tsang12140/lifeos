import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { setTimeout as yieldWork } from "node:timers/promises";
import { PHOTO_WALL_ENABLED, PHOTO_WALL_DEFAULTS, PHOTO_WALL_MIN_PHOTOS, PHOTO_WALL_PHOTOS_PER_TIER, photoWallPhotoTier, photoWallPreferences, type Asset, type PhotoWallPreferences } from "@lifeos/core";
import { renderCalendarPhotoWall } from "./calendar-background-renderer.js";
import type { SqliteRecordRepository } from "./repository.js";
import { calendarToday } from "./calendar-days.js";
import { backgroundNamespace, backgroundSourceVersion } from "./calendar-background-source.js";

const DAY = 86_400_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const BACKGROUND_MIN_PHOTOS = PHOTO_WALL_MIN_PHOTOS;
// Shelved by the owner on 2026-10-15. Keep the scheduler for an explicit future revival.
export const BACKGROUND_AUTOMATIC_GENERATION_ENABLED = false;
// Only one montage is decoded at a time, including in account mode with multiple tenants.
let generating = false;
export function backgroundTier(count: number): number {
  return photoWallPhotoTier(count);
}
export function nextBackgroundNight(now: Date): number {
  return Date.parse(`${calendarToday(now)}T00:00:00+08:00`) + DAY;
}
interface Source { id: string; version: string }
interface CurrentSource extends Source { acceptedVersions: readonly string[] }
interface Artwork { version: string; sources: Source[]; candidates?: Source[]; generatedAt: number; final: boolean; renderKey?: string }
interface Entry { month: string; hideDemo: boolean; image?: Artwork; preview?: Artwork; retired?: Artwork[]; dueAt?: number; retryAt?: number }
interface Options {
  /** Internal opt-in for retained implementation tests; runtime uses the shared feature gate. */
  enabled?: boolean;
  /** Internal rollout/test gate. Runtime callers leave the shelved scheduler disabled. */
  automaticGeneration?: boolean;
  repository: SqliteRecordRepository;
  assetVersion: (asset: Asset) => string;
  legacyAssetVersions?: (asset: Asset) => readonly string[];
  thumbnail: (id: string) => Promise<string>;
  onError?: (error: unknown) => void;
}
export interface BackgroundStatus { enabled: boolean; imageUrl: string | null; version: string | null; count: number; minPhotos: number; tierPhotos: number; nextTier: number; renderedPhotos: number; automaticGeneration: boolean; pending: boolean; dueAt: number | null; valid: boolean }
class Deferred extends Error {}

/** Durable, regenerable private artwork. Metadata reads never decode or fetch a photo. */
export class CalendarBackgrounds {
  readonly #directory: string;
  readonly #namespace: string;
  readonly #preferencesFile: string;
  #preferences: PhotoWallPreferences = { ...PHOTO_WALL_DEFAULTS };
  readonly #options: Options;
  readonly #entries = new Map<string, Entry>();
  readonly #viewers = new Map<string, number>();
  #timer?: ReturnType<typeof setTimeout>;
  #changeTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  constructor(dataDirectory: string, options: Options) {
    this.#directory = join(dataDirectory, "derived", "calendar-backgrounds");
    this.#namespace = backgroundNamespace(dataDirectory);
    this.#preferencesFile = join(dataDirectory, "calendar-background-config.json");
    try { this.#preferences = photoWallPreferences(JSON.parse(readFileSync(this.#preferencesFile, "utf8"))); } catch { /* Missing/invalid configuration uses the chosen defaults. */ }
    this.#options = options;
    try {
      const saved: unknown = JSON.parse(readFileSync(join(this.#directory, "state.json"), "utf8"));
      if (Array.isArray(saved)) for (const item of saved) {
        if (item && /^\d{4}-(0[1-9]|1[0-2])$/.test(item.month) && typeof item.hideDemo === "boolean") {
          const validSources = (sources: Source[]) => Array.isArray(sources) && sources.every(s => s && typeof s.id === "string" && typeof s.version === "string");
          const validImage = (image: Artwork | undefined) => image && /^[a-f0-9]{64}$/.test(image.version) && validSources(image.sources) && (image.candidates === undefined || validSources(image.candidates)) && Number.isFinite(image.generatedAt);
          const entry: Entry = { month: item.month, hideDemo: item.hideDemo,
            ...(validImage(item.image) ? { image: item.image } : {}), ...(validImage(item.preview) ? { preview: item.preview } : {}),
            ...(Array.isArray(item.retired) ? { retired: item.retired.filter(validImage).slice(-8) } : {}),
            // Advance the old 03:30 job to midnight on its already scheduled day.
            ...(Number.isFinite(item.dueAt) ? { dueAt: Date.parse(`${calendarToday(new Date(item.dueAt))}T00:00:00+08:00`) } : {}) };
          this.#entries.set(this.#key(entry.month, entry.hideDemo), entry);
        }
      }
    } catch { /* A missing/invalid derived manifest safely falls back to plain canvas. */ }
  }
  #key(month: string, hideDemo: boolean) { return `${hideDemo ? "personal" : "all"}:${month}`; }
  get enabled() { return this.#options.enabled ?? PHOTO_WALL_ENABLED; }
  get #automaticGeneration() { return this.enabled && (this.#options.automaticGeneration ?? BACKGROUND_AUTOMATIC_GENERATION_ENABLED); }
  preferences(): PhotoWallPreferences { return { ...this.#preferences }; }
  #renderKey() { const { veil: _veil, ...render } = this.#preferences; return digest(["photo-wall-v3", render]); }
  savePreferences(value: unknown, now = new Date()): PhotoWallPreferences {
    if (!this.enabled) throw new Error("background_disabled");
    const preferences = photoWallPreferences(value);
    const temporary = `${this.#preferencesFile}.${randomUUID()}.part`;
    try { writeFileSync(temporary, JSON.stringify(preferences), { flag: "wx" }); renameSync(temporary, this.#preferencesFile); }
    finally { rmSync(temporary, { force: true }); }
    this.#preferences = preferences;
    for (const entry of this.#entries.values()) this.#inspect(entry, now);
    return this.preferences();
  }
  #file(version: string) { return join(this.#directory, `${version}.webp`); }
  #save() {
    if (this.#closed) return;
    mkdirSync(this.#directory, { recursive: true });
    const temporary = join(this.#directory, `state.${randomUUID()}.part`);
    try { writeFileSync(temporary, JSON.stringify([...this.#entries.values()])); renameSync(temporary, join(this.#directory, "state.json")); }
    finally { rmSync(temporary, { force: true }); }
  }
  #remove(image?: Artwork) {
    if (image && ![...this.#entries.values()].some(e => e.image?.version === image.version || e.preview?.version === image.version)) rmSync(this.#file(image.version), { force: true });
  }
  #sources(month: string, hideDemo: boolean, now: Date): CurrentSource[] {
    if (month > calendarToday(now).slice(0, 7)) return [];
    const seen = new Set<string>();
    return this.#options.repository.calendarBackgroundAssets(month, hideDemo, calendarToday(now)).flatMap(asset => {
      const content = asset.storageRefs.find(ref => ref.contentHash)?.contentHash;
      const identity = content ? `${content.algorithm}:${content.value}` : asset.id;
      if (seen.has(identity)) return [];
      seen.add(identity);
      const fallback = this.#options.assetVersion(asset);
      return [{ id: asset.id, version: backgroundSourceVersion(asset, fallback), acceptedVersions: [fallback, ...(this.#options.legacyAssetVersions?.(asset) ?? [])] }];
    });
  }
  #matches(old: Source, current: CurrentSource | undefined) {
    return current !== undefined && (old.version === current.version || current.acceptedVersions.includes(old.version));
  }
  #safeSources(image: Artwork, sources: CurrentSource[]) {
    const available = new Map(sources.map(s => [s.id, s]));
    return sources.length >= BACKGROUND_MIN_PHOTOS && image.sources.every(s => this.#matches(s, available.get(s.id)));
  }
  #safe(image: Artwork, sources: CurrentSource[]) { return this.#safeSources(image, sources) && existsSync(this.#file(image.version)); }
  #compact(sources: Source[]): Source[] { return sources.map(({ id, version }) => ({ id, version })); }
  #selected<T extends Source>(sources: T[], preferences: PhotoWallPreferences, count = backgroundTier(sources.length)): T[] {
    return sources.map((source, index) => ({ source, order: Math.sin((index + 1) * 73.31 + preferences.seed * 17.57) }))
      .sort((a, b) => a.order - b.order).slice(0, count).map(item => item.source);
  }
  #legacySelectionCount(image: Artwork): number | undefined {
    if (image.renderKey === this.#renderKey()) return backgroundTier(image.sources.length);
    const { veil: _veil, ...render } = this.#preferences;
    // Recover the exact historical cap from its render key; never reinterpret old pixels using a new tier.
    for (let maxPhotos = 12; maxPhotos <= 60; maxPhotos++) {
      if (image.renderKey === digest(["photo-wall-v2", { ...render, maxPhotos }])) return maxPhotos;
    }
    return undefined;
  }
  #candidateFingerprint(image: Artwork, sources: CurrentSource[]) {
    const current = new Map(sources.map(s => [s.id, s]));
    return digest((image.candidates ?? image.sources).map(old => {
      const available = current.get(old.id);
      return this.#matches(old, available) ? { id: old.id, version: available!.version } : old;
    }));
  }
  #inspect(entry: Entry, now: Date): CurrentSource[] {
    const sources = this.#sources(entry.month, entry.hideDemo, now);
    const before = JSON.stringify(entry);
    for (const field of ["image", "preview"] as const) {
      const old = entry[field];
      // Previous photo-wall manifests stored all candidates as dependencies. When
      // their render settings are known, recover precisely the photos actually drawn.
      if (old && old.candidates === undefined) {
        const count = this.#legacySelectionCount(old);
        if (count !== undefined) {
          old.candidates = old.sources;
          old.sources = this.#compact(this.#selected(old.sources, this.#preferences, count));
        }
      }
      if (old && !this.#safe(old, sources)) { delete entry[field]; this.#remove(old); }
    }
    if (entry.retired) entry.retired = entry.retired.filter(image => this.#safeSources(image, sources));
    if (!this.#automaticGeneration || sources.length < BACKGROUND_MIN_PHOTOS) { delete entry.dueAt; delete entry.retryAt; }
    else {
      const image = entry.image;
      const renderChanged = image?.renderKey !== this.#renderKey();
      const changed = !image || renderChanged || image.sources.length !== backgroundTier(sources.length);
      const past = entry.month < calendarToday(now).slice(0, 7);
      if (!changed) {
        delete entry.dueAt; delete entry.retryAt;
        if (image && past) image.final = true;
      } else {
        entry.dueAt ??= nextBackgroundNight(now);
      }
    }
    if (before !== JSON.stringify(entry)) this.#save();
    return sources;
  }
  status(month: string, hideDemo = false, now = new Date(), viewedVersion?: string): BackgroundStatus {
    if (!this.enabled) return { enabled: false, imageUrl: null, version: null, count: 0, minPhotos: BACKGROUND_MIN_PHOTOS,
      tierPhotos: 0, nextTier: BACKGROUND_MIN_PHOTOS, renderedPhotos: 0, automaticGeneration: false, pending: false, dueAt: null, valid: false };
    const key = this.#key(month, hideDemo);
    let entry = this.#entries.get(key);
    if (!entry) { entry = { month, hideDemo }; this.#entries.set(key, entry); this.#save(); }
    const sources = this.#inspect(entry, now);
    // An old loaded version may stay on screen after a normal additive update, but never after removal/privacy/version changes.
    const viewed = viewedVersion ? [entry.image, entry.preview, ...(entry.retired ?? [])].find(i => i?.version === viewedVersion) : undefined;
    return { enabled: true, imageUrl: entry.image ? this.#url(entry, entry.image) : null, version: entry.image?.version ?? null,
      count: sources.length, minPhotos: BACKGROUND_MIN_PHOTOS, tierPhotos: backgroundTier(sources.length),
      nextTier: sources.length < BACKGROUND_MIN_PHOTOS ? BACKGROUND_MIN_PHOTOS : backgroundTier(sources.length) + PHOTO_WALL_PHOTOS_PER_TIER,
      renderedPhotos: entry.image?.sources.length ?? 0, automaticGeneration: this.#automaticGeneration, pending: entry.dueAt !== undefined, dueAt: entry.dueAt ?? null,
      valid: !viewedVersion || (viewed ? this.#safeSources(viewed, sources) : false) };
  }
  #url(entry: Entry, image: Artwork) { return `/api/calendar/background/image?month=${entry.month}&hideDemo=${entry.hideDemo ? "1" : "0"}&v=${image.version}`; }
  file(month: string, hideDemo: boolean, version: string, now = new Date()): string | null {
    if (!this.enabled) return null;
    const entry = this.#entries.get(this.#key(month, hideDemo));
    if (!entry) return null;
    const sources = this.#inspect(entry, now);
    const image = [entry.image, entry.preview].find(i => i?.version === version);
    return image && this.#safe(image, sources) ? this.#file(version) : null;
  }
  viewing(token: string, active: boolean, now = Date.now()): void {
    if (active) {
      if (this.#viewers.size >= 1000 && !this.#viewers.has(token)) return;
      this.#viewers.set(token, now + 75_000);
    } else this.#viewers.delete(token);
  }
  #isViewed(now = Date.now()): boolean {
    for (const [token, until] of this.#viewers) if (until <= now) this.#viewers.delete(token);
    return this.#viewers.size > 0;
  }
  #registerCurrentMonth(now: Date): void {
    const month = calendarToday(now).slice(0, 7);
    // Reaching the threshold must schedule work even before the first calendar visit.
    for (const hideDemo of [false, true]) {
      if (this.#entries.has(this.#key(month, hideDemo)) || this.#sources(month, hideDemo, now).length >= BACKGROUND_MIN_PHOTOS) this.status(month, hideDemo, now);
    }
  }
  changed(): void {
    if (this.#closed || !this.enabled) return;
    clearTimeout(this.#changeTimer);
    this.#changeTimer = setTimeout(() => {
      if (this.#closed) return;
      try {
        const now = new Date(); if (this.#automaticGeneration) this.#registerCurrentMonth(now);
        for (const entry of this.#entries.values()) this.#inspect(entry, now);
      } catch (error) { this.#options.onError?.(error); }
    }, 300);
    this.#changeTimer.unref();
  }
  start(): void {
    if (!this.#automaticGeneration) {
      clearTimeout(this.#timer);
      let cancelled = false;
      for (const entry of this.#entries.values()) {
        if (entry.dueAt !== undefined || entry.retryAt !== undefined) {
          delete entry.dueAt; delete entry.retryAt; cancelled = true;
        }
      }
      if (cancelled) this.#save();
      return;
    }
    // A persistent dueAt survives restarts; missed nights are serviced here, never in a page request.
    this.#registerCurrentMonth(new Date());
    const arm = () => {
      if (this.#closed) return;
      const delay = Math.min(60_000, nextBackgroundNight(new Date()) - Date.now() + 20);
      this.#timer = setTimeout(() => { void this.tick().catch(error => this.#options.onError?.(error)).finally(arm); }, Math.max(20, delay));
      this.#timer.unref();
    };
    arm();
  }
  close(): void { this.#closed = true; clearTimeout(this.#timer); clearTimeout(this.#changeTimer); }
  async tick(now = new Date()): Promise<void> {
    if (this.#closed || !this.#automaticGeneration) return;
    this.#registerCurrentMonth(now);
    if (generating || this.#isViewed(now.getTime())) return;
    for (const entry of this.#entries.values()) {
      this.#inspect(entry, now);
      if (entry.dueAt === undefined || entry.dueAt > now.getTime() || (entry.retryAt ?? 0) > now.getTime()) continue;
      if (this.#closed || generating || this.#isViewed(now.getTime())) return;
      generating = true;
      try { await this.#generate(entry, now, false); }
      catch (error) {
        if (!(error instanceof Deferred)) { entry.retryAt = now.getTime() + 15 * 60_000; this.#save(); this.#options.onError?.(error); }
      } finally { generating = false; }
      return; // Yield between months; never process an entire library in one burst.
    }
  }
  async preview(month: string, hideDemo = false, now = new Date()): Promise<string | null> {
    if (!this.enabled) throw new Error("background_disabled");
    this.status(month, hideDemo, now);
    const entry = this.#entries.get(this.#key(month, hideDemo))!;
    const sources = this.#sources(month, hideDemo, now);
    if (sources.length < BACKGROUND_MIN_PHOTOS) return null;
    if (entry.preview && entry.preview.renderKey === this.#renderKey() && this.#candidateFingerprint(entry.preview, sources) === digest(this.#compact(sources))) return this.#url(entry, entry.preview);
    if (generating) throw new Error("background_busy");
    generating = true;
    try { return await this.#generate(entry, now, true); } finally { generating = false; }
  }
  /** Explicit user action may run during viewing; automatic jobs still yield to viewers. */
  async generateNow(month: string, hideDemo = false, now = new Date()): Promise<BackgroundStatus> {
    if (!this.enabled) throw new Error("background_disabled");
    const status = this.status(month, hideDemo, now);
    if (status.count < BACKGROUND_MIN_PHOTOS) throw new Error("background_not_enough_photos");
    if (generating) throw new Error("background_busy");
    generating = true;
    try {
      await this.#generate(this.#entries.get(this.#key(month, hideDemo))!, now, false, true);
      return this.status(month, hideDemo, now);
    } catch (error) {
      if (error instanceof Deferred) throw new Error("background_changed");
      throw error;
    } finally { generating = false; }
  }
  async #generate(entry: Entry, now: Date, preview: boolean, manual = false): Promise<string | null> {
    const sources = this.#sources(entry.month, entry.hideDemo, now);
    if (sources.length < BACKGROUND_MIN_PHOTOS) return null;
    const preferences = this.preferences(), renderKey = this.#renderKey();
    const version = digest(["photo-wall-v3", this.#namespace, entry.month, entry.hideDemo, renderKey, this.#compact(sources)]);
    const file = this.#file(version);
    const selected = this.#selected(sources, preferences);
    const interrupted = () => this.#closed || (!preview && !manual && this.#isViewed());
    if (!existsSync(file)) {
      const images: Buffer[] = [];
      for (const source of selected) {
        if (interrupted()) throw new Deferred();
        const thumbnail = await this.#options.thumbnail(source.id);
        if (interrupted()) throw new Deferred();
        images.push(await readFile(thumbnail));
        await yieldWork(15);
      }
      if (interrupted()) throw new Deferred();
      const bytes = await renderCalendarPhotoWall(images, preferences, async () => { if (interrupted()) throw new Deferred(); await yieldWork(15); });
      if (interrupted()) throw new Deferred();
      mkdirSync(this.#directory, { recursive: true });
      const temporary = join(this.#directory, `${version}.${randomUUID()}.part`);
      try { writeFileSync(temporary, bytes, { flag: "wx" }); renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
    }
    if (interrupted()) throw new Deferred();
    if (renderKey !== this.#renderKey() || digest(this.#compact(sources)) !== digest(this.#compact(this.#sources(entry.month, entry.hideDemo, now)))) {
      if (![...this.#entries.values()].some(e => e.image?.version === version || e.preview?.version === version)) rmSync(file, { force: true });
      this.#inspect(entry, now);
      throw new Deferred();
    }
    const field = preview ? "preview" : "image", old = entry[field];
    if (old && old.version !== version) entry.retired = [...(entry.retired ?? []), old].slice(-8);
    entry[field] = { version, sources: this.#compact(selected), candidates: this.#compact(sources), renderKey, generatedAt: now.getTime(), final: entry.month < calendarToday(now).slice(0, 7) };
    if (!preview) { delete entry.dueAt; delete entry.retryAt; }
    this.#save(); this.#remove(old);
    return this.#url(entry, entry[field]!);
  }
}
