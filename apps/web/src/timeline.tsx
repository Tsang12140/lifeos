import { isAiAssisted, isBackfilled } from "@lifeos/core";
import { PhotoInformation, photoSummary, usePhotoInfo } from "./photo-info";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  CircleHelp,
  CloudSun,
  Dumbbell,
  Edit3,
  Eraser,
  Film,
  Heart,
  History,
  Link2,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  Moon,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  SUMMARY_MAX_LENGTH,
  clampSummaryText,
  trimSummaryText,
  type Asset,
  type AssetLink,
  type AssetRole,
  type CycleIntimacyEventKind,
  type CycleIntimacyModuleConfig,
  type CycleIntimacyModuleData,
  type DaySummary,
  type Entity,
  type EntityRef,
  type RelationKind,
  type TaskStatus,
  type WeatherAttachment,
} from "@lifeos/core";
import {
  apiRequest,
  type AiStatus,
  type MovieEntity,
  type RecordView,
  type TaskRecordView,
} from "./api";
import type { AppView, CalendarMode, ComposerKind, CreateEntity, SettingsPageId } from "./app-types";
import { calendarDayInfo } from "./calendarData";
import { peekCover, peekScore, photoSourceScore, storyWeight, type PhotoHints } from "./photoScore";
import { getWeatherEmoji, type WeatherCategory, type WeatherDay, type WeatherPhase } from "./weather";
import { weatherLocationDisplayName } from "./weather-locations";
import { MoviePrompt } from "./movie";
import { DateField, WEEKDAY_LABELS } from "./date-field";
import {
  ASSET_ROLE_LABEL,
  COMPOSER_META,
  DEMO_HIDDEN_STORAGE_KEY,
  ENTITY_META,
  RELATION_META,
  SELF_ENTITY_ID,
  assetRoleFor,
  asCoreEntity,
  emptyCopy,
  entityRefKey,
  errorMessage,
  formatBytes,
  isDemoRecord,
  isLocalAsset,
  isMovieEntity,
  isMovieRef,
  isTaskRecord,
  mentionVocabulary,
  recordLabel,
  recordText,
  relationKindFor,
  statusLabel,
  timelineHeading,
  weekCardRecords,
} from "./app-meta";
import { RecordText } from "./mention";
import { JournalText } from "./journal-text";
import { DiagnosticsDrawer, EmptyState, ErrorState, LoadingState } from "./timeline-states";
import type { TaskUndoEntry } from "./task-summary";
import {
  USER_TIME_ZONE,
  dateKeyForRecord,
  datesOfWeek,
  dayLabel,
  displayDate,
  lifeTimeDate,
  lifeTimeTime,
  localDateToday,
  monthGridDates,
  monthTitle,
  shiftDate,
  shiftMonth,
  shortDate,
  weekdayShort,
} from "./time";

// re-export for calendar-view and others
export type { TaskUndoEntry };

export function groupRecords(records: readonly RecordView[], fallbackDate: string): readonly { date: string; records: readonly RecordView[] }[] {
  const groups = new Map<string, RecordView[]>();
  for (const record of records) { const date = dateKeyForRecord(record.occurredAt, record.createdAt) ?? fallbackDate; const group = groups.get(date); if (group) group.push(record); else groups.set(date, [record]); }
  return [...groups.entries()].map(([date, items]) => ({ date, records: items }));
}

export function Timeline({ records, assets, entities, loading, refreshing, error, selectedDate, activeView, searchQuery, movieEnabled, moviePromptHidden, onMovieAttachToRecord, onMoviePromptSuppress, onRetry, onDemo, creatingDemo, onEdit, onDelete, onTaskStatus, onPreviewAsset, onOpenEntity, interactionDisabled, dataCurrent }: { records: readonly RecordView[] | null; assets: readonly Asset[]; entities: readonly Entity[]; loading: boolean; refreshing: boolean; error: string | null; selectedDate: string; activeView: AppView; searchQuery: string; movieEnabled: boolean; moviePromptHidden: boolean; onMovieAttachToRecord: (record: RecordView, movie: MovieEntity) => void; onMoviePromptSuppress: () => void; onRetry: () => void; onDemo: () => void; creatingDemo: boolean; onEdit: (record: RecordView) => void; onDelete: (record: RecordView) => void; onTaskStatus: (record: TaskRecordView, status: TaskStatus) => void; onPreviewAsset: (assetIds: readonly string[], index: number) => void; onOpenEntity: (entity: Entity) => void; interactionDisabled: boolean; dataCurrent: boolean }) {
  const title = timelineHeading(activeView);
  const empty = emptyCopy(activeView, selectedDate, Boolean(searchQuery));
  const groups = records ? groupRecords(records, selectedDate) : [];
  const initialLoading = loading && records === null;
  const showUpdating = error === null && records !== null && (refreshing || !dataCurrent);
  const showEmpty = !initialLoading && dataCurrent && !error && records !== null && records.length === 0;
  /* `data-view` lets the compact rules tell the three surfaces apart without the
     component having to thread a class name through every branch. */
  return <section className="timeline-section" data-view={activeView} aria-labelledby="timeline-title" aria-busy={showUpdating ? "true" : undefined}><div className="section-heading"><div><h2 id="timeline-title">{title}</h2></div>{records && records.length > 0 ? <span className="record-count">{records.length} 条</span> : null}</div>{initialLoading ? <LoadingState /> : null}{showUpdating ? <div className="timeline-refresh-state" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /><span>正在读取目标日期…</span></div> : null}{error ? <ErrorState message={error} onRetry={onRetry} /> : null}{showEmpty ? <EmptyState {...empty} onDemo={onDemo} creatingDemo={creatingDemo} /> : null}{!initialLoading && records && records.length > 0 ? <div className={`timeline-list ${interactionDisabled ? "is-stale" : ""}`}>{groups.map((group) => <div className="timeline-group" key={group.date}><h3 className="timeline-group-title">{group.date === localDateToday() ? `今天，${shortDate(group.date)}` : displayDate(group.date)}</h3>{group.records.map((record) => <TimelineItem key={record.id} record={record} assets={assets} entities={entities} movieEnabled={movieEnabled} moviePromptHidden={moviePromptHidden} onMovieAttachToRecord={onMovieAttachToRecord} onMoviePromptSuppress={onMoviePromptSuppress} onEdit={onEdit} onDelete={onDelete} onTaskStatus={onTaskStatus} onPreviewAsset={onPreviewAsset} onOpenEntity={onOpenEntity} interactionDisabled={interactionDisabled} />)}</div>)}</div> : null}</section>;
}


/**
 * The records that landed on each day of the window the calendar is showing.
 * Insertion order is kept, because the API already ordered the list newest
 * first — re-sorting here would only risk disagreeing with the timeline.
 */
export function recordsByDate(dates: readonly string[], records: readonly RecordView[]): ReadonlyMap<string, readonly RecordView[]> {
  const wanted = new Set(dates);
  const buckets = new Map<string, RecordView[]>();
  for (const record of records) {
    const date = dateKeyForRecord(record.occurredAt, record.createdAt);
    if (date === undefined || !wanted.has(date)) continue;
    const bucket = buckets.get(date);
    if (bucket === undefined) buckets.set(date, [record]);
    else bucket.push(record);
  }
  return buckets;
}

/** The original bytes, requested explicitly from the photo viewer. */
export function assetContentUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/content`;
}

/** The API's grid/card sizes and its 2048px long-edge photo preview. */
export type ThumbnailWidth = 400 | 1200 | 2048;

/**
 * The derived thumbnail covering `width` px of paint. The API builds it from the
 * original on first request and files it under the data directory, which is what stops
 * a 130px square from costing a whole 3.9 MB original — and the same picture also backs
 * the week-card and calendar backgrounds.
 *
 * Note the scorer in `photoScore.ts` fetches the *same* URL the month cell renders, so
 * the browser still downloads each photo once and shares it between the <img> and the
 * score instead of paying for it twice at two different sizes.
 */
export function assetThumbUrl(assetId: string, width: ThumbnailWidth): string {
  return `/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=${width}`;
}

/**
 * The day's photos in the order they were taken (records arrive newest
 * first, so walk the day backwards), each carrying the free story signal:
 * how much text and how many entity refs the owning record has.
 *
 * "Photo" has to mean here exactly what it means in the timeline grid —
 * `isPhotoAsset`, i.e. a *local* image we can actually draw. A record can hold
 * a `photo` ref whose asset is remote (`sourceId: "remote"`, no bytes on this
 * machine); asking `/thumbnail` for one answers 404, so anything built from it
 * renders as a hole. The ref's role alone does not tell you that.
 */
export interface DayPhotoCandidate { readonly assetId: string; readonly story: number; readonly hints?: PhotoHints }

export function dayPhotoCandidates(items: readonly RecordView[], assets: readonly Asset[]): readonly DayPhotoCandidate[] {
  const found: DayPhotoCandidate[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const record = items[index];
    for (const ref of record.assetRefs) {
      if (ref.role !== "photo") continue;
      const asset = assets.find((candidate) => candidate.id === ref.assetId);
      if (!isPhotoAsset(asset)) continue;
      found.push({ assetId: ref.assetId, story: storyWeight(recordText(record).length, record.entityRefs.length), hints: asset });
    }
  }
  return found;
}

/**
 * Photos for a week card's background, in shooting order. More than four
 * photos keeps only four — the first shot, the last shot, and evenly spaced
 * shots between them — with no "and N more" badge, because the background is
 * a texture, not an inventory.
 */
export function dayPhotoIds(items: readonly RecordView[], assets: readonly Asset[]): readonly string[] {
  const ids = dayPhotoCandidates(items, assets).map((candidate) => candidate.assetId);
  if (ids.length <= 4) return ids;
  const picked: string[] = [];
  for (let band = 0; band < 4; band += 1) {
    const id = ids[Math.round((band * (ids.length - 1)) / 3)];
    if (!picked.includes(id)) picked.push(id);
  }
  return picked;
}

/**
 * Choose once the whole day's batch is ready; before that use cheap source hints.
 * Chronological order breaks ties. Failed decodes cannot beat a measured photo.
 */
export function monthCellPhoto(candidates: readonly DayPhotoCandidate[], aspect = 1): string | undefined {
  if (candidates.length === 0) return undefined;
  let bestId = candidates[0].assetId;
  let bestScore = -Infinity;
  const ready = candidates.every((candidate) => peekScore(assetThumbUrl(candidate.assetId, 1200), candidate.hints, aspect) !== undefined);
  for (const candidate of candidates) {
    const cover = ready ? peekCover(assetThumbUrl(candidate.assetId, 1200), candidate.hints, aspect) : undefined;
    if (ready && cover === undefined) continue;
    const hints = candidate.hints ?? {};
    const total = (cover?.score ?? photoSourceScore(hints, hints.photoMetadata?.width ?? 0, hints.photoMetadata?.height ?? 0)) + candidate.story * 3;
    if (total > bestScore) {
      bestScore = total;
      bestId = candidate.assetId;
    }
  }
  return bestId;
}

export interface PeriodRun {
  readonly start: string;
  readonly end: string;
}

export interface PeriodMoonMarker {
  readonly forecast: boolean;
}

/**
 * One run per recorded start, or a single run from the configured anchor when
 * nothing has been recorded yet. A recorded end cuts the run short — confirm it
 * on day five and days six and seven are gone — while the configured duration
 * closes whatever is left open.
 */
export function periodRuns(module: CycleIntimacyModuleData | null): readonly PeriodRun[] {
  if (!module?.config.enabled) return [];
  const { periodLength, anchorStart } = module.config;
  const starts = module.events.filter((event) => event.kind === "period_start").map((event) => event.date).sort();
  const ends = module.events.filter((event) => event.kind === "period_end").map((event) => event.date).sort();
  const runs: PeriodRun[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const nextStart = starts[index + 1];
    const explicitEnd = ends.find((end) => end >= start && (nextStart === undefined || end < nextStart));
    let end = explicitEnd ?? shiftDate(start, periodLength - 1);
    if (nextStart !== undefined && end >= nextStart) end = shiftDate(nextStart, -1);
    runs.push({ start, end });
  }
  if (runs.length === 0 && anchorStart !== undefined) runs.push({ start: anchorStart, end: shiftDate(anchorStart, periodLength - 1) });
  return runs;
}

/**
 * A moon stays honest about what it knows. Inside a run, days up to and
 * including today are solid — the day arrived, so the period did — while the
 * days still ahead are pale predictions that turn solid by themselves as the
 * calendar moves forward. The interval is start-to-start: a seven-day period
 * with a 28-day interval predicts the next start 28 days after its start,
 * not 28 days after its end.
 */
export function periodMoonForDate(date: string, today: string, module: CycleIntimacyModuleData | null): PeriodMoonMarker | undefined {
  if (!module?.config.enabled) return undefined;
  const { cycleLength, periodLength } = module.config;
  const runs = periodRuns(module);
  const last = runs[runs.length - 1];
  if (last === undefined) return undefined;
  if (date <= last.end) {
    const inside = runs.some((run) => date >= run.start && date <= run.end);
    return inside ? { forecast: date > today } : undefined;
  }
  const predicted = shiftDate(last.start, cycleLength);
  return date >= predicted && date <= shiftDate(predicted, periodLength - 1)
    ? { forecast: date > today }
    : undefined;
}

/** The next predicted start — one interval after the last recorded start. */
export function nextPredictedStart(module: CycleIntimacyModuleData | null, today: string): string | undefined {
  if (!module?.config.enabled) return undefined;
  const { cycleLength } = module.config;
  const runs = periodRuns(module);
  const last = runs[runs.length - 1];
  if (last === undefined) return undefined;
  let start = shiftDate(last.start, cycleLength);
  // `start === today` is a legitimate answer: the prediction landed exactly on today, and the
  // panel should say so. Only strictly-past predictions get rolled forward to the next cycle.
  for (let guard = 0; start < today && guard < 240; guard += 1) start = shiftDate(start, cycleLength);
  return start;
}

export interface CalendarMarker { readonly id: string; readonly label: string; readonly content: ReactNode; }

/** Four reserved bottom-right slots: a single marker hugs the corner; new ones grow left. */
export function CalendarDayMarkers({ date, today, module }: { readonly date: string; readonly today: string; readonly module: CycleIntimacyModuleData | null }) {
  if (!module?.config.enabled) return null;
  const period = periodMoonForDate(date, today, module);
  const intimate = module.events.some((event) => event.date === date && event.kind === "intimacy");
  const fitness = module.events.some((event) => event.date === date && event.kind === "fitness");
  const markers: CalendarMarker[] = [];
  if (period !== undefined) markers.push({ id: `period-${date}`, label: period.forecast ? "预测经期" : "已记录经期", content: <Moon className={`calendar-moon ${period.forecast ? "is-forecast" : ""}`} size={13} strokeWidth={1.9} aria-hidden="true" /> });
  if (intimate) markers.push({ id: `intimacy-${date}`, label: "已记录亲密", content: <Heart className="calendar-heart" size={13} strokeWidth={1.9} aria-hidden="true" /> });
  if (fitness) markers.push({ id: `fitness-${date}`, label: "已记录健身", content: <Dumbbell className="calendar-fitness" size={13} strokeWidth={1.9} aria-hidden="true" /> });
  const visible = markers.length > 4 ? [...markers.slice(0, 3), { id: `more-${date}`, label: `还有 ${markers.length - 3} 个日历事件`, content: <span className="calendar-marker-more" aria-hidden="true">+{markers.length - 3}</span> }] : markers;
  if (visible.length === 0) return null;
  return <span className="calendar-day-markers" aria-label={visible.map((marker) => marker.label).join("，")}>{visible.map((marker, index) => <span className="calendar-day-marker" key={marker.id} style={{ gridColumnStart: 5 - visible.length + index }}>{marker.content}</span>)}</span>;
}

export interface CalendarWeather {
  readonly text: string;
  readonly icon: string;
  readonly tempMin: string;
  readonly tempMax: string;
}

export function weatherFromArchiveValue(value: unknown, date: string): CalendarWeather | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const snapshot = (value as { readonly weatherSnapshot?: unknown }).weatherSnapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return undefined;
  const candidate = snapshot as { readonly today?: unknown; readonly days?: unknown };
  const days = Array.isArray(candidate.days) ? candidate.days : [];
  const all = [candidate.today, ...days];
  const day = all.find((item) => typeof item === "object" && item !== null && !Array.isArray(item) && (item as { readonly fxDate?: unknown }).fxDate === date) ?? all.find((item) => typeof item === "object" && item !== null && !Array.isArray(item));
  if (typeof day !== "object" || day === null || Array.isArray(day)) return undefined;
  const item = day as Partial<WeatherDay>;
  if (typeof item.textDay !== "string" || typeof item.iconDay !== "string") return undefined;
  return { text: item.textDay, icon: item.iconDay, tempMin: typeof item.tempMin === "string" ? item.tempMin : "—", tempMax: typeof item.tempMax === "string" ? item.tempMax : "—" };
}

/**
 * The calendar's own settings, behind the gear beside the cycle button.
 *
 * Only two things live here: how the calendar's summaries are produced, and
 * whether its text is editable. The prompt is shown in full on purpose — it is
 * the one knob that changes what every cell says, and hiding it behind a rebuild
 * would make tuning it a code change.
 */
export interface PreviewImage { readonly id: string; readonly url: string; readonly name?: string; readonly localInfo?: import("./photo-info").PhotoInfo; }
export function AssetPreview({ assetIds, index, assets, images, onClose, onIndexChange }: { assetIds: readonly string[]; index: number; assets: readonly Asset[]; images?: readonly PreviewImage[]; onClose: () => void; onIndexChange: (index: number) => void }) {
  const assetId = assetIds[index] ?? assetIds[0] ?? "";
  const asset = assets.find((candidate) => candidate.id === assetId);
  const image = images?.find(candidate => candidate.id === assetId);
  const [previewMode, setPreviewMode] = useState({ assetId, original: false });
  // Reset before rendering a different photo, including returning to an earlier
  // one. An effect would briefly start that photo's old original request first.
  if (previewMode.assetId !== assetId) setPreviewMode({ assetId, original: false });
  const hasDerivedPreview = image === undefined && (asset === undefined || asset.kind === "photo" || asset.mediaType?.startsWith("image/"));
  const showOriginal = previewMode.assetId === assetId && previewMode.original;
  const previewUrl = image?.url ?? (hasDerivedPreview && !showOriginal ? assetThumbUrl(assetId, 2048) : assetContentUrl(assetId));
  // Reuse the grid's cached thumbnail. Both layers use contain, so switching
  // resolution never crops or stretches a portrait into the landscape frame.
  const placeholderUrl = image?.url ?? (hasDerivedPreview ? assetThumbUrl(assetId, 400) : previewUrl);
  const previewImageRef = useRef<HTMLImageElement>(null);
  const [imageAttempt, setImageAttempt] = useState(0);
  const [imageState, setImageState] = useState<{ url: string; status: "loading" | "loaded" | "error" }>({ url: previewUrl, status: "loading" });
  const imageStatus = imageState.url === previewUrl ? imageState.status : "loading";
  const imageFailed = useCallback(() => {
    if (hasDerivedPreview && !showOriginal) setPreviewMode(current => current.assetId === assetId ? { assetId, original: true } : current);
    else setImageState({ url: previewUrl, status: "error" });
  }, [assetId, hasDerivedPreview, previewUrl, showOriginal]);
  useEffect(() => {
    // A cached image may already be complete when the preview mounts. Check the
    // actual element as well as its events; complete also includes failed loads.
    const element = previewImageRef.current;
    if (!element?.complete) return;
    if (element.naturalWidth > 0) setImageState({ url: previewUrl, status: "loaded" });
    else imageFailed();
  }, [previewUrl, imageAttempt, imageFailed]);
  const name = image?.name ?? asset?.originalName;
  const many = assetIds.length > 1;
  const [infoOpen, setInfoOpen] = useState(true);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const showInfo = mobile ? mobileInfoOpen : infoOpen;
  const photoInfo = usePhotoInfo({ asset, assetId, localInfo: image?.localInfo });
  const summary = photoSummary(photoInfo.value);
  const summaryStatus = photoInfo.loading ? "正在读取照片信息…" : photoInfo.error ? "照片信息读取失败" : undefined;
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { setMobileInfoOpen(false); }, [assetId]);
  const previewDialogRef = useRef<HTMLDialogElement>(null);
  const backdropGesture = useRef<{ x: number; y: number; blank: boolean; moved: boolean } | null>(null);
  const swipeGesture = useRef<{ pointerId: number; x: number; y: number; assetId: string } | null>(null);
  const isPreviewContent = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".asset-preview img, .asset-preview figcaption, .asset-preview-status, .photo-information, .asset-preview button"));
  const step = useCallback((delta: number) => { onIndexChange(Math.min(assetIds.length - 1, Math.max(0, index + delta))); }, [assetIds.length, index, onIndexChange]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    document.documentElement.classList.add("has-asset-preview");
    if (previewDialogRef.current && !previewDialogRef.current.open) previewDialogRef.current.showModal();
    // A background page must not scroll behind the photo.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      document.documentElement.classList.remove("has-asset-preview");
    };
  }, [onClose, step]);
  return <dialog ref={previewDialogRef} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} className={`asset-preview ${!mobile && infoOpen ? "has-photo-information" : ""} ${mobile && mobileInfoOpen ? "has-mobile-photo-information" : ""}`} aria-modal="true" aria-label={name ?? "照片预览"}
    onPointerDown={event => {
      backdropGesture.current = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, blank: !isPreviewContent(event.target), moved: false } : null;
      // A second finger cancels navigation; let Safari handle pinch zoom.
      if (!event.isPrimary) { swipeGesture.current = null; return; }
      const surface = event.target instanceof Element && event.target.closest(".asset-preview-figure");
      swipeGesture.current = mobile && many && !mobileInfoOpen && surface && event.pointerType === "touch"
        && (window.visualViewport?.scale ?? 1) <= 1.01
        ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, assetId } : null;
    }}
    onPointerMove={event => { const gesture = backdropGesture.current; if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6) gesture.moved = true; }}
    onPointerUp={event => {
      const gesture = swipeGesture.current;
      swipeGesture.current = null;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.assetId !== assetId) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5 && (window.visualViewport?.scale ?? 1) <= 1.01) {
        backdropGesture.current = null;
        step(dx < 0 ? 1 : -1);
      }
    }}
    onPointerCancel={() => { backdropGesture.current = null; swipeGesture.current = null; }}
    onWheel={() => { backdropGesture.current = null; }}
    onClick={event => {
      const gesture = backdropGesture.current;
      backdropGesture.current = null;
      // The figure and scrolling host include empty space. Protect the content,
      // and require a stationary blank-to-blank gesture so selecting text or
      // dragging/scrolling across its edge cannot dismiss the photo.
      if (gesture?.blank && !gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 6 && !isPreviewContent(event.target)) {
        if (mobile && mobileInfoOpen) setMobileInfoOpen(false);
        else onClose();
      }
    }}>
    <span className="asset-preview-backdrop" aria-hidden="true" style={{ "--preview-photo": imageStatus === "loaded" ? `url(${JSON.stringify(previewUrl)})` : "none" } as CSSProperties} />
    <div className="asset-preview-top-actions">
      {hasDerivedPreview ? <button className="asset-preview-original-toggle" type="button" onClick={event => { event.stopPropagation(); setPreviewMode({ assetId, original: !showOriginal }); }}>{showOriginal ? "返回预览" : "查看原图"}</button> : null}
      <button className="asset-preview-close" type="button" onClick={onClose} aria-label="关闭预览"><X size={20} strokeWidth={1.9} aria-hidden="true" /></button>
    </div>
    {many && index > 0 ? <button className="asset-preview-nav asset-preview-nav-prev" type="button" onClick={(event) => { event.stopPropagation(); step(-1); }} aria-label="上一张"><ChevronLeft size={22} strokeWidth={1.8} aria-hidden="true" /></button> : null}
    {many && index < assetIds.length - 1 ? <button className="asset-preview-nav asset-preview-nav-next" type="button" onClick={(event) => { event.stopPropagation(); step(1); }} aria-label="下一张"><ChevronRight size={22} strokeWidth={1.8} aria-hidden="true" /></button> : null}
    <button className={`asset-preview-info-toggle ${mobile ? "is-mobile" : ""}`} type="button" data-summary-count={summary.length} data-has-capture-time={summary.some(item => item.kind === "time")} aria-expanded={showInfo} aria-controls={showInfo ? "photo-information-panel" : undefined} aria-label={mobile ? `${showInfo ? "收起" : "查看"}照片信息${summary.length ? `，${summary.map(item => `${item.label} ${item.text}`).join("，")}` : summaryStatus ? `，${summaryStatus}` : ""}` : undefined} onClick={event => { event.stopPropagation(); if (mobile) setMobileInfoOpen(v => !v); else setInfoOpen(v => !v); }}>
      {mobile ? <>{summary.map(item => <span key={item.kind} className={`photo-summary-item photo-summary-${item.kind}`} title={`${item.label} ${item.text}`}>{item.text}</span>)}{!summary.length && summaryStatus ? <span className="photo-summary-status">{summaryStatus}</span> : null}<Info size={18} strokeWidth={1.6} aria-hidden="true" /></> : infoOpen ? "隐藏信息" : "照片信息"}
    </button>
    <figure className="asset-preview-figure" data-load-state={imageStatus} aria-label={name ?? "照片"} aria-busy={imageStatus === "loading"}>
      {/* Upload previews retain their existing Blob URL. Stored photos default to
          a regenerable preview; only an explicit request loads the original. */}
      <div className="asset-preview-image-stage">
      <img className="asset-preview-placeholder" key={placeholderUrl} src={placeholderUrl} alt="" aria-hidden="true" draggable={false} onError={event => { event.currentTarget.style.visibility = "hidden"; }} />
      <img className="asset-preview-full" ref={previewImageRef} key={`${previewUrl}:${imageAttempt}`} src={previewUrl} alt={name ?? "照片"} draggable={false}
        onLoad={event => { if (previewImageRef.current === event.currentTarget) setImageState({ url: previewUrl, status: "loaded" }); }}
        onError={event => { if (previewImageRef.current === event.currentTarget) imageFailed(); }} />
      </div>
      {many ? <figcaption aria-label={`第 ${index + 1} 张，共 ${assetIds.length} 张`}>{index + 1} / {assetIds.length}</figcaption> : null}
      {imageStatus === "loading" ? <span className="asset-preview-loading" role="status" aria-label="正在加载照片"><LoaderCircle className="spin" size={18} aria-hidden="true" /></span> : null}
    </figure>
    {imageStatus === "error" ? <div className="asset-preview-status" role="status" aria-live="polite">
      <span>照片未能加载，请重试</span>
      {imageStatus === "error" ? <button className="secondary-button" type="button" onClick={event => { event.stopPropagation(); setImageState({ url: previewUrl, status: "loading" }); setImageAttempt(attempt => attempt + 1); }}>重试</button> : null}
    </div> : null}
    {showInfo ? <div id="photo-information-panel" className="photo-information-host"><PhotoInformation key={assetId} info={photoInfo} mobile={mobile} /></div> : null}
  </dialog>;
}

export function PrivacyMask({ onReveal, className = "" }: { onReveal: () => void; className?: string }) {
  return <button className={`privacy-mask ${className}`.trim()} type="button" onClick={onReveal} aria-label="隐私记录已隐藏，点击显示">****</button>;
}

export function TimelineEntityChip({ refItem, entity, relationKind, onOpenEntity }: { refItem: EntityRef; entity: Entity | undefined; relationKind: RelationKind | undefined; onOpenEntity: (entity: Entity) => void }) {
  const movie = isMovieEntity(entity);
  const KindIcon = movie ? Film : relationKind === undefined ? (ENTITY_META[refItem.entityType]?.icon ?? Tag) : RELATION_META[relationKind].icon;
  const label = movie ? `《${entity.name}》` : refItem.label ?? refItem.entityId;
  const className = `relation-chip ${entity?.type === "person" ? "relation-chip-person" : ""} ${movie ? "relation-chip-movie" : ""} ${relationKind === undefined ? "relation-kind-none" : `relation-kind-${relationKind}`}`.trim();
  const content = <><KindIcon size={12} strokeWidth={1.9} aria-hidden="true" /><span>{label}</span></>;
  if (entity?.type !== "person" && !movie) return <span className={className}>{content}</span>;
  return <button className={className} type="button" onClick={() => onOpenEntity(movie ? asCoreEntity(entity) : entity)} aria-label={movie ? `查看${entity.name}的电影卡片` : `查看${entity.name}的人物卡片`}>{content}</button>;
}

/** Moments caps the grid at nine squares; the ninth announces what it hides. */
export const PHOTO_GRID_LIMIT = 9;

/** A photo means a real local image. Recordings and attachments keep their chip. */
export function isPhotoAsset(asset: Asset | undefined): boolean {
  return asset?.kind === "photo" && isLocalAsset(asset);
}

/**
 * A record's photos, laid out the way Moments lays out a post: one large, two and
 * four as a pair, three across from three up. The filename is deliberately absent —
 * `image_225.png` says nothing to the owner, and the chip it used to live in squeezed
 * the thumbnail down to 22px. The name still earns its place in the preview caption
 * and in the aria-label, where it helps rather than clutters.
 */
export function RecordPhotoGrid({ assetIds, assets, onPreview }: { assetIds: readonly string[]; assets: readonly Asset[]; onPreview: (assetIds: readonly string[], index: number) => void }) {
  const shown = assetIds.slice(0, PHOTO_GRID_LIMIT);
  const hidden = assetIds.length - shown.length;
  return <div className="record-photo-grid" data-shown={shown.length}>
    {shown.map((assetId, index) => { const asset = assets.find((candidate) => candidate.id === assetId); return <button className="record-photo-cell" key={assetId} type="button" onClick={() => onPreview(assetIds, index)} aria-label={`放大查看 ${asset?.originalName ?? assetId}`}>
      <img src={assetThumbUrl(assetId, 400)} alt="" loading="lazy" decoding="async" />
      {hidden > 0 && index === shown.length - 1 ? <span className="record-photo-more">+{hidden}</span> : null}
    </button>; })}
  </div>;
}

export function TimelineItem({ record, assets, entities, movieEnabled, moviePromptHidden, onMovieAttachToRecord, onMoviePromptSuppress, onEdit, onDelete, onTaskStatus, onPreviewAsset, onOpenEntity, interactionDisabled }: { record: RecordView; assets: readonly Asset[]; entities: readonly Entity[]; movieEnabled: boolean; moviePromptHidden: boolean; onMovieAttachToRecord: (record: RecordView, movie: MovieEntity) => void; onMoviePromptSuppress: () => void; onEdit: (record: RecordView) => void; onDelete: (record: RecordView) => void; onTaskStatus: (record: TaskRecordView, status: TaskStatus) => void; onPreviewAsset: (assetIds: readonly string[], index: number) => void; onOpenEntity: (entity: Entity) => void; interactionDisabled: boolean }) {
  const Icon = COMPOSER_META[record.kind].icon;
  const movies = record.entityRefs.flatMap((ref) => { const e = entities.find((entity) => entity.id === ref.entityId); return e?.type === "movie" ? [e] : []; });
  const task = isTaskRecord(record) ? record : undefined;
  const [revealed, setRevealed] = useState(record.isPrivate !== true);
  const masked = record.isPrivate === true && !revealed;
  const reveal = () => setRevealed(true);
  const nextStatus: TaskStatus = task?.task.status === "done" ? "todo" : "done";
  const photoAssetIds = record.assetRefs.filter((ref) => isPhotoAsset(assets.find((candidate) => candidate.id === ref.assetId))).map((ref) => ref.assetId);
  const chipAssetRefs = record.assetRefs.filter((ref) => !photoAssetIds.includes(ref.assetId));
  const relationCount = record.entityRefs.length + record.relatedRecordIds.length + chipAssetRefs.length;
  const vocabulary = useMemo(() => mentionVocabulary(record, entities), [record, entities]);
  const bodyText = recordText(record);
  const showMoviePrompt = !masked && movieEnabled && !moviePromptHidden && record.kind === "journal" && bodyText.includes("电影") && !record.entityRefs.some(isMovieRef);
  const journalLayoutKey = `${record.id}\u0000${bodyText}\u0000${JSON.stringify(vocabulary)}`;
  const noteDetails = record.kind === "note" ? record.note : undefined;
  const noteLine = noteDetails !== undefined && (noteDetails.title || noteDetails.source)
    ? <div className="timeline-note-metadata">{masked ? <PrivacyMask onReveal={reveal} /> : <>{noteDetails.title ? <strong className="timeline-note-title">{noteDetails.title}</strong> : null}{noteDetails.source ? <span className="timeline-note-source">出处：{noteDetails.source}</span> : null}</>}</div>
    : null;
  const photoLine = masked || photoAssetIds.length === 0 ? null : <RecordPhotoGrid assetIds={photoAssetIds} assets={assets} onPreview={onPreviewAsset} />;
  const relationLine = relationCount > 0 ? masked
    ? <div className="relation-row" aria-label="关联"><PrivacyMask onReveal={reveal} className="relation-mask" /></div>
    : <div className="relation-row" aria-label="关联">{record.entityRefs.map((ref) => <TimelineEntityChip key={`entity-${entityRefKey(ref)}`} refItem={ref} entity={entities.find((candidate) => candidate.id === ref.entityId)} relationKind={ref.entityType === "person" ? relationKindFor(ref.entityId, entities) : undefined} onOpenEntity={onOpenEntity} />)}{record.relatedRecordIds.length > 0 ? <span className="relation-chip"><Link2 size={12} strokeWidth={1.9} aria-hidden="true" />关联 {record.relatedRecordIds.length} 条记录</span> : null}{chipAssetRefs.map((ref) => { const asset = assets.find((candidate) => candidate.id === ref.assetId); return <span className="relation-chip" key={`asset-${ref.assetId}`}><ImageIcon size={12} strokeWidth={1.9} aria-hidden="true" />{asset?.originalName ?? ref.assetId}</span>; })}</div> : null;
  const weatherLine = record.weather === undefined || masked ? null : <div className="record-weather-row" aria-label="记录天气"><span className={`weather-record-chip weather-record-chip--${record.weather.mode}`}><CloudSun size={13} strokeWidth={1.8} aria-hidden="true" /><span>{record.weather.mode === "realtime" ? "现场" : "当天"}，{record.weather.text}</span>{record.weather.temperature ? <strong>{record.weather.temperature}°</strong> : record.weather.tempMin || record.weather.tempMax ? <strong>{record.weather.tempMin ?? "—"}~{record.weather.tempMax ?? "—"}°</strong> : null}<small>{weatherLocationDisplayName({ id: record.weather.locationId, name: record.weather.city })}</small></span></div>;
  return <article className={`timeline-item ${interactionDisabled ? "is-stale" : ""}`} data-record-id={record.id}><div className="timeline-time"><time dateTime={record.occurredAt?.value ?? record.createdAt.value}>{lifeTimeTime(record.occurredAt ?? record.createdAt)}</time></div><div className="timeline-marker" aria-hidden="true"><span /></div><div className="timeline-content"><div className="timeline-meta"><span className={`kind-tag kind-${record.kind}`}><Icon size={13} strokeWidth={1.8} aria-hidden="true" />{recordLabel(record.kind)}</span>{isAiAssisted(record) ? <span className="backfill-tag assisted-tag"><History size={12} aria-hidden="true" />辅记</span> : null}{isBackfilled(record) ? <span className="backfill-tag"><History size={12} aria-hidden="true" />补记</span> : null}{record.isPrivate === true ? <span className="privacy-tag"><LockKeyhole size={12} aria-hidden="true" />隐私</span> : null}{record.body.edited ? <span className="edited-tag">已编辑</span> : null}</div>{noteLine}<div className="timeline-text" data-expandable={!masked && record.kind === "journal" ? "true" : undefined}>{masked ? <PrivacyMask onReveal={reveal} /> : record.kind === "journal" ? <><JournalText contentKey={journalLayoutKey}><RecordText text={bodyText} entities={vocabulary} decisions={record.body.entityMentions} /></JournalText>{showMoviePrompt ? <MoviePrompt enabled={movieEnabled} onAttach={(movie) => { if (!interactionDisabled) onMovieAttachToRecord(record, movie); }} onSuppress={onMoviePromptSuppress} /> : null}</> : <RecordText text={bodyText} entities={vocabulary} decisions={record.body.entityMentions} />}</div>{!masked && movies.length ? <div className="timeline-movie-cards">{movies.map((movie) => <button className="timeline-movie-card" type="button" key={movie.id} disabled={interactionDisabled} onClick={() => onOpenEntity(movie)}>{movie.posterUrl ? <img src={movie.posterUrl} alt={`${movie.name} 海报`} loading="lazy" onError={(e) => { e.currentTarget.hidden = true; }} /> : <span className="movie-poster-placeholder"><Film size={20} /></span>}<span><strong>{movie.name}</strong><small>{movie.releaseYear} {movie.watched || movie.watchedAt ? "已看" : ""}</small></span></button>)}</div> : null}{record.assetRefs.some((ref) => ref.role === "attachment") && !masked ? <div className="record-attachments">{record.assetRefs.filter((ref) => ref.role === "attachment").map((ref) => <a key={ref.assetId} href={`/api/assets/${encodeURIComponent(ref.assetId)}/content`} download>{assets.find((a) => a.id === ref.assetId)?.originalName ?? "附件"}</a>)}</div> : null}{photoLine}{weatherLine}{task ? (masked ? <div className="timeline-status"><PrivacyMask onReveal={reveal} /></div> : <span className={`timeline-status status-${task.task.status}`}>{statusLabel(task.task.status)}</span>) : null}<div className="timeline-footer">{relationLine}<div className="timeline-actions" aria-label="记录操作">{task ? <><button className={`record-action task-action ${task.task.status === "done" ? "" : "task-action-complete"}`} type="button" onClick={() => onTaskStatus(task, nextStatus)} disabled={interactionDisabled}>{task.task.status === "done" ? <RotateCcw size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}{task.task.status === "done" ? "恢复待办" : "完成"}</button>{task.task.status !== "cancelled" && task.task.status !== "done" ? <button className="record-action" type="button" onClick={() => onTaskStatus(task, "cancelled")} disabled={interactionDisabled}><XCircle size={14} aria-hidden="true" />取消</button> : null}</> : null}<button className="record-action record-action-icon" type="button" onClick={() => onEdit(record)} disabled={interactionDisabled} aria-label="编辑记录" title="编辑记录"><Edit3 size={14} aria-hidden="true" /></button><button className="record-action record-action-icon record-action-danger" type="button" onClick={() => onDelete(record)} disabled={interactionDisabled} aria-label="删除记录" title="删除记录"><Trash2 size={14} aria-hidden="true" /></button></div></div></div></article>;
}
