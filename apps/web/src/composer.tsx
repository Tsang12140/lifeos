import { PlaceSearch, placeDetailsOf } from "./place-search";
import { ArchiveCheckIcon } from "./icon-archive";
import { hasSavableRecordContent } from "./record-content";
import { applyPlaceWording } from "./place-mention-wording";
import type { VideoUpload } from "./video-ui";
import { usePhotoInput } from "./photo-input";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps, type Dispatch, type SetStateAction } from "react";
import {
  CalendarDays,
  Camera,
  Check,
  Film,
  History,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  NotebookPen,
  Plus,
  Send,
  Sparkles,
  User,
  MapPin,
  X,
} from "lucide-react";
import type { Asset, AssetLink, Entity, EntityCandidate, TextEntityDecision, EntityRef, NoteFormat, PlacePeriod, PlaceRole, TaskStatus, WeatherAttachment } from "@lifeos/core";
import { PLACE_MARKER, cleanMovieQuery, entitySearchTerms, normalizeEntitySearchTerm, findEntityCandidates, rebaseEntityDecisions } from "@lifeos/core";
import type { ApiUploadProgress, MovieEntity, RecordView } from "./api";
import type { ComposerKind, CreateEntity, EntityCreateRequest } from "./app-types";
import type { ModuleCommand } from "./movie";
import { DreamIcon } from "./dream-icon";
import { DateField } from "./date-field";
import { TaskScheduleField } from "./task-schedule";
import {
  CJK_PATTERN,
  COMPOSER_META,
  ENTITY_META,
  MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH,
  NOTE_FORMATS,
  asCoreEntity,
  entityRefKey,
  isMovieEntity,
  isMovieRef,
} from "./app-meta";
import { entityHint, mentionQueryAt, mentionSuggestions, slashQueryAt, slashSuggestions, type MentionQuery } from "./mention";
import { localDateToday } from "./time";
import { enabledModuleCommands, movieMentionDecisions, movieRef, MovieAddPanel } from "./movie";
import { EntityCreateForm, MentionBox, type ContextAction } from "./entity-forms";
import { ShotDropZone, type ShotDropZoneHandle, type ShotUpload } from "./shot-drop-zone";
import { EntityMentionReview } from "./entity-mention-review";
import { ContactMentionAvatar } from "./contact-avatar";
import { VideoScopeContext } from "./video-ui";
import { compressInWorker } from "./video/client";
import { saveOriginal } from "./video/originals";

export interface NoteEditMeta { format: NoteFormat; title: string; source: string; metadataTouched: boolean; }

/** Two-sided body edits that could not be merged automatically. */
export interface ComposerConflictActions { readonly theirsText: string; readonly useLatest: () => void; readonly keepMine: () => void; }

interface MentionReviewProps { decisions: readonly TextEntityDecision[]; onDecisionsChange: (decisions: readonly TextEntityDecision[]) => void; }

export interface ComposerProps extends MentionReviewProps { mobilePage?: boolean; mobileFields?: ReactNode; onExitBlockedChange?: (blocked: boolean) => void; dream?: boolean; onOpenJournal?: () => void; searchControl?: ReactNode; kind: ComposerKind; content: string; occurredAt: string; occurredDirty?: boolean; photoTimeHint?: { readonly value: string; readonly count: number } | null; onUseNow?: () => void; dueAt: string; isPrivate: boolean; isBackfill: boolean; weather: WeatherAttachment | null; weatherBusy: boolean; selectedDate: string; saving: boolean; dismissible: boolean; editing?: boolean; error?: string | null; onReloadLatest?: () => void; conflictActions?: ComposerConflictActions | null; taskStatus?: TaskStatus; onTaskStatusChange?: (status: TaskStatus) => void; noteMeta?: NoteEditMeta | null; onNoteMetaChange?: (meta: NoteEditMeta) => void; entities: readonly Entity[]; recentPlaceIds?: readonly string[]; placeIncludePrivate?: boolean; placeHideDemo?: boolean; movieEnabled: boolean; movieRefs: readonly EntityRef[]; onMovieRefsChange: (refs: readonly EntityRef[]) => void; onMovieEntity: (movie: MovieEntity) => void; onCreateEntity: CreateEntity; onKindChange: (kind: ComposerKind) => void; onContentChange: (content: string, editRange?: { start: number; end: number }) => void; onOccurredAtChange: (value: string) => void; onDueAtChange: (value: string) => void; onPrivateChange: (value: boolean) => void; onBackfillChange: (value: boolean) => void; onCaptureWeather: () => void; onClearWeather: () => void; onSubmit: () => void; onClose: () => void; assets: readonly Asset[]; onUploadVideo: VideoUpload; shots: readonly AssetLink[]; onShotsChange: Dispatch<SetStateAction<readonly AssetLink[]>>; shotScopeKey: string; onShotSubmissionState: (scopeKey: string, state: "active" | "failed" | null) => void; onUploadShot: (file: File, signal: AbortSignal, onProgress: (progress: ApiUploadProgress) => void) => Promise<ShotUpload>; onNotify: (message: string, tone?: "ok" | "warn") => void; onShotsCleared: (cleared: readonly AssetLink[], restore: () => boolean, cancelledPending: number) => void; }

interface ComposerSelection { readonly start: number; readonly end: number; readonly text: string; }
interface SmartMentionPrompt { readonly source: "person" | "place" | "universal"; readonly selection: ComposerSelection; readonly personMatches: readonly Entity[]; readonly placeMatches: readonly Entity[]; }

function ComposerBody({ mobile, children }: { mobile: boolean; children: ReactNode }) { return mobile ? <div className="mobile-composer-scroll">{children}</div> : <>{children}</>; }

export function Composer({ mobilePage = false, mobileFields, onExitBlockedChange, dream = false, onOpenJournal, searchControl, decisions, onDecisionsChange, kind, content, occurredAt, photoTimeHint = null, onUseNow, dueAt, isPrivate, isBackfill, weather, weatherBusy, selectedDate, saving, dismissible, editing = false, error, onReloadLatest, conflictActions = null, taskStatus, onTaskStatusChange, noteMeta, onNoteMetaChange, entities, recentPlaceIds = [], placeIncludePrivate = false, placeHideDemo = false, movieEnabled, movieRefs, onMovieRefsChange, onMovieEntity, onCreateEntity, onKindChange, onContentChange, onOccurredAtChange, onDueAtChange, onPrivateChange, onBackfillChange, onCaptureWeather, onClearWeather, onSubmit, onClose, assets, onUploadVideo, shots, onShotsChange, shotScopeKey, onShotSubmissionState, onUploadShot, onNotify, onShotsCleared }: ComposerProps) {
  const activeMeta = dream ? { ...COMPOSER_META.journal, label: "梦境", icon: DreamIcon } : COMPOSER_META[kind];
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const candidates = useMemo(() => {
    const found = [...findEntityCandidates(content, entities)];
    for (const decision of decisions) {
      if (decision.entityId === null || content.slice(decision.start, decision.end) !== decision.text) continue;
      const entity = entities.find((item) => item.id === decision.entityId);
      if (!entity) continue;
      const sameRange = found.find(item => item.start === decision.start && item.end === decision.end);
      const options = [entity, ...(sameRange?.entities ?? []).filter(item => item.id !== entity.id)];
      // A newly reused alias must not displace the already confirmed owner
      // in the editor either. Alternatives remain available for explicit fixes.
      for (let i = found.length - 1; i >= 0; i--) if (found[i]!.start < decision.end && decision.start < found[i]!.end) found.splice(i, 1);
      found.push({ start: decision.start, end: decision.end, text: decision.text, entities: options });
    }
    return found.sort((a, b) => a.start - b.start);
  }, [content, entities, decisions]);
  const [review, setReview] = useState<{ text: string; candidates: readonly EntityCandidate[]; entity?: Entity; selection?: ComposerSelection; wording?: string } | null>(null);
  const uncheckedCandidates = candidates.filter((candidate) => !decisions.some((decision) => decision.start === candidate.start && decision.end === candidate.end));
  const pendingPeople = new Set(uncheckedCandidates.flatMap((candidate) => candidate.entities.filter((entity) => entity.type === "person").map((entity) => entity.id))).size;
  const pendingPlaces = new Set(uncheckedCandidates.flatMap((candidate) => candidate.entities.filter((entity) => entity.type === "place").map((entity) => entity.id))).size;
  // Without this the reminder strip still appears (it keys off
  // uncheckedCandidates.length) but would say 「发现 可关联」 with no number.
  const pendingMovies = new Set(uncheckedCandidates.flatMap((candidate) => candidate.entities.filter((entity) => entity.type === "movie").map((entity) => entity.id))).size;
  const reviewEntity = (entity: Entity, text = content, selection?: ComposerSelection) => {
    const vocabulary = entities.some((item) => item.id === entity.id) ? entities : [...entities, entity];
    const occurrences = (text === content ? candidates : findEntityCandidates(text, vocabulary)).filter((candidate) => candidate.entities.some((item) => item.id === entity.id));
    let fresh = occurrences.length > 0 ? occurrences : findEntityCandidates(text, vocabulary).filter((candidate) => candidate.entities.some((item) => item.id === entity.id));
    // An explicit selection identifies this occurrence even when the provider's
    // full name differs from the author's wording. Do not add a global alias.
    if (selection && text.slice(selection.start, selection.end) === selection.text) {
      fresh = [...fresh.filter(candidate => candidate.end <= selection.start || candidate.start >= selection.end), { ...selection, entities: [entity] }].sort((a, b) => a.start - b.start);
    }
    if (fresh.length === 0) { resetMentionTools(); onNotify("正文中没有找到可关联的文字，请选中文字后重试", "warn"); return; }
    setReview({ text, candidates: fresh, entity, selection, ...(entity.type === "place" && selection ? { wording: selection.text } : {}) });
    resetMentionTools();
  };
  /**
   * Creating a person or place from text that is already on screen *is* the
   * decision about that occurrence, so it gets marked on the spot instead of
   * opening the review dialog. The dialog judges against a snapshot of the body
   * and refuses once the text has moved on, so demanding it before the record is
   * finished only means doing the same work twice. Other occurrences stay
   * unmarked and reach the reminder strip, where 检查标记 is one click whenever
   * the writing is actually done.
   */
  const markCreatedEntity = (entity: Entity, nextText: string, occurrence: ComposerSelection, editRange?: { start: number; end: number }, textAlreadyApplied = false): boolean => {
    if (nextText.slice(occurrence.start, occurrence.end) !== occurrence.text) {
      // The body moved under the selection; marking whatever now sits at those
      // offsets would be guessing. Say so instead of linking the wrong words.
      if (!textAlreadyApplied && nextText !== content) onContentChange(nextText, editRange);
      resetMentionTools();
      onNotify("正文已变化，未自动标记。写完可以点上方提醒条核对", "warn");
      return false;
    }
    const base = rebaseEntityDecisions(content, nextText, decisions, editRange);
    const kept = base.filter((decision) => decision.end <= occurrence.start || occurrence.end <= decision.start);
    // The @-picker has already pushed the new text up; rebasing it twice would
    // shift the surviving decisions twice as well.
    if (!textAlreadyApplied && nextText !== content) onContentChange(nextText, editRange);
    onDecisionsChange([...kept, { start: occurrence.start, end: occurrence.end, text: occurrence.text, entityId: entity.id, entityType: entity.type === "place" ? "place" as const : entity.type === "movie" ? "movie" as const : "person" as const }].sort((a, b) => a.start - b.start));
    resetMentionTools();
    onNotify(`已关联「${entity.name}」`);
    return true;
  };
  const shotZoneRef = useRef<ShotDropZoneHandle>(null);
  const [photoToolbarTarget, setPhotoToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [shotUploading, setShotUploading] = useState(false);
  const [shotSubmissionState, setShotSubmissionState] = useState<"active" | "failed" | null>(null);
  const shotSubmissionStateRef = useRef<"active" | "failed" | null>(null);
  const currentShotScopeRef = useRef(shotScopeKey);
  currentShotScopeRef.current = shotScopeKey;
  const handleShotSubmissionState = (scope: string, state: "active" | "failed" | null) => {
    if (scope !== currentShotScopeRef.current) return;
    shotSubmissionStateRef.current = state;
    setShotSubmissionState(state);
    onExitBlockedChange?.(state !== null);
    onShotSubmissionState(scope, state);
  };
  const futureJournal = kind === "journal" && (occurredAt.slice(0, 10) || selectedDate) > localDateToday();
  const hasContent = hasSavableRecordContent(kind, content, shots, assets);
  const canSave = !futureJournal && hasContent && !saving && !shotUploading && shotSubmissionState === null && (noteMeta?.format !== "article" || noteMeta.title.trim().length > 0);
  const submitIfReady = () => {
    if (futureJournal) { onNotify("未来日期不能写日记，请选择今天或之前的日期", "warn"); return; }
    const state = shotSubmissionStateRef.current;
    if (state !== null) {
      onNotify(state === "failed" ? "有附件未上传，请重试或移除后保存" : "附件正在处理，请完成后再保存", "warn");
      return;
    }
    if (!saving && hasContent) onSubmit();
  };
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const { draggingFiles, handlers: entryDragHandlers } = usePhotoInput(shotZoneRef, saving);
  const videoScope = useContext(VideoScopeContext);
  const uploadVideo = useCallback<NonNullable<ComponentProps<typeof ShotDropZone>["onUploadVideo"]>>(async (file, signal, progress) => {
    const compressed = await compressInWorker(file, { signal, onProgress: value => progress({ loaded: Math.floor(value * 80), total: 100 }) });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const body = new File([compressed.bytes], file.name.replace(/\.[^.]+$/, "") + ".mp4", { type: "video/mp4" });
    const asset = await onUploadVideo(body, signal, value => progress({ loaded: 80 + Math.floor((value.loaded / Math.max(1, value.total)) * 20), total: 100 }));
    try { await saveOriginal(videoScope, asset.id, file); }
    catch { onNotify("视频已上传，但本机原片保存失败，请保留设备相册中的源文件", "warn"); }
    return { asset, reused: false };
  }, [onUploadVideo, videoScope, onNotify]);
  const [pickerKind, setPickerKind] = useState<"person" | "place" | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [smartMentionPrompt, setSmartMentionPrompt] = useState<SmartMentionPrompt | null>(null);
  const [smartHintVisible, setSmartHintVisible] = useState(false);
  const [moviePanelOpen, setMoviePanelOpen] = useState(false);
  const [movieQuery, setMovieQuery] = useState<string | undefined>(undefined);
  // The words the panel was opened on. Picking a film marks them, so this has
  // to outlive the panel's own state and be cleared with it.
  const [movieSelection, setMovieSelection] = useState<ComposerSelection | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  const smartHintTimerRef = useRef<number | null>(null);
  const selectionRef = useRef<ComposerSelection | null>(null);
  const isBackfillDate = selectedDate !== localDateToday();
  // Selecting existing text opens the occurrence review. With no selection,
  // the picker inserts the chosen name and reviews it before linking.
  const currentMonth = localDateToday().slice(0, 7);
  const pickerOptions = useMemo(() => {
    if (pickerKind === null) return [];
    const pool = entities.filter((entity) => entity.type === pickerKind);
    const needle = normalizeEntitySearchTerm(pickerSearch);
    const filtered = needle.length === 0 ? pool : pool.filter((entity) => entitySearchTerms(entity).some((term) => normalizeEntitySearchTerm(term).includes(needle)));
    const isCurrent = (entity: Entity) => {
      if (entity.type !== "place") return true;
      const { period } = entity;
      if (period === undefined) return true;
      if (period.from !== undefined && period.from > currentMonth) return false;
      if (period.until !== undefined && period.until < currentMonth) return false;
      return true;
    };
    // Recently used wins outright -- the place you were last written about is
    // the one you most likely mean again, and no other signal beats that. "Still
    // current" only breaks ties among places you have never used, so one whose
    // period ended does not get buried under one you have never been to.
    const rank = new Map(recentPlaceIds.map((id, index) => [id, index]));
    return [...filtered]
      .sort((left, right) => {
        const leftRank = rank.get(left.id);
        const rightRank = rank.get(right.id);
        if (leftRank !== undefined || rightRank !== undefined) {
          if (leftRank === undefined) return 1;
          if (rightRank === undefined) return -1;
          return leftRank - rightRank;
        }
        return Number(isCurrent(right)) - Number(isCurrent(left));
      })
      .slice(0, 10);
  }, [entities, pickerKind, pickerSearch, currentMonth, recentPlaceIds]);
  const exactEntityMatches = (type: "person" | "place", text: string): Entity[] => {
    const needle = normalizeEntitySearchTerm(text);
    return entities.filter((entity) => entity.type === type && entitySearchTerms(entity).some((term) => normalizeEntitySearchTerm(term) === needle));
  };
  const rememberSelection = (): ComposerSelection | null => {
    const element = inputRef.current;
    if (element === null) {
      selectionRef.current = null;
      return null;
    }
    const rawStart = Math.min(element.selectionStart ?? content.length, element.selectionEnd ?? content.length);
    const rawEnd = Math.max(element.selectionStart ?? content.length, element.selectionEnd ?? content.length);
    const raw = content.slice(rawStart, rawEnd), text = raw.trim();
    const start = rawStart + raw.indexOf(text), end = start + text.length;
    const selection = text.length === 0 ? null : { start, end, text };
    selectionRef.current = selection;
    return selection;
  };
  const resetMentionTools = () => {
    setPickerKind(null);
    setPickerSearch("");
    setCreateOpen(false);
    setSmartMentionPrompt(null);
    setSmartHintVisible(false);
  };
  const showSmartHint = () => {
    if (smartHintTimerRef.current !== null) window.clearTimeout(smartHintTimerRef.current);
    setSmartHintVisible(true);
    smartHintTimerRef.current = window.setTimeout(() => {
      setSmartHintVisible(false);
      smartHintTimerRef.current = null;
    }, 2200);
  };
  useEffect(() => () => {
    if (smartHintTimerRef.current !== null) window.clearTimeout(smartHintTimerRef.current);
  }, []);
  useEffect(() => {
    if (pickerKind === null && smartMentionPrompt === null && !smartHintVisible) return undefined;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && composerRef.current?.contains(target) !== true) resetMentionTools();
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [pickerKind, smartMentionPrompt, smartHintVisible]);
  const closePicker = resetMentionTools;
  const openSmartMention = (source: "person" | "place" | "universal") => {
    const selection = rememberSelection();
    if (selection === null) {
      setPickerKind(null);
      setCreateOpen(false);
      setSmartMentionPrompt(null);
      showSmartHint();
      return;
    }
    setSmartHintVisible(false);
    const personMatches = exactEntityMatches("person", selection.text);
    const placeMatches = exactEntityMatches("place", selection.text);
    if (source === "person" && personMatches.length === 1) {
      reviewEntity(personMatches[0]!, content, selection);
      return;
    }
    if (source === "place" && placeMatches.length === 1) {
      reviewEntity(placeMatches[0]!, content, selection);
      return;
    }
    if (source === "universal" && personMatches.length === 1 && placeMatches.length === 0) {
      reviewEntity(personMatches[0]!, content, selection);
      return;
    }
    if (source === "universal" && placeMatches.length === 1 && personMatches.length === 0) {
      reviewEntity(placeMatches[0]!, content, selection);
      return;
    }
    setPickerKind(null);
    setCreateOpen(false);
    setSmartMentionPrompt({ source, selection, personMatches, placeMatches });
  };
  const beginSmartCreate = (type: "person" | "place") => {
    const selection = smartMentionPrompt?.selection;
    if (selection === null || selection === undefined) return;
    setSmartMentionPrompt(null);
    setPickerKind(type);
    setPickerSearch(selection.text);
    setCreateOpen(true);
  };
  const submitCreateForm = async (request: EntityCreateRequest): Promise<boolean> => {
    const { type, name, ...extras } = request;
    const entity = await onCreateEntity(type, name, extras);
    if (entity === null) return false;
    const selection = selectionRef.current;
    if (selection !== null) {
      markCreatedEntity(entity, content, selection);
      return true;
    }
    const caret = inputRef.current?.selectionStart ?? content.length;
    const next = `${content.slice(0, caret)}${entity.name}${content.slice(caret)}`;
    markCreatedEntity(entity, next, { start: caret, end: caret + entity.name.length, text: entity.name }, { start: caret, end: caret });
    return true;
  };
  const smartPromptOpen = smartMentionPrompt !== null;
  const smartSelectionText = smartMentionPrompt?.selection.text ?? "";
  const smartChoices = smartMentionPrompt === null ? [] : [
    ...(smartMentionPrompt.source !== "place" ? smartMentionPrompt.personMatches.map((entity) => ({ entity, type: "person" as const })) : []),
    ...(smartMentionPrompt.source !== "person" ? smartMentionPrompt.placeMatches.map((entity) => ({ entity, type: "place" as const })) : []),
  ];
  const smartCreateTypes: readonly ("person" | "place")[] = smartMentionPrompt?.source === "universal" ? ["person", "place"] : smartMentionPrompt?.source === "person" ? ["person"] : ["place"];
  const smartPromptTitle = smartMentionPrompt?.source === "person"
      ? `要把「${smartSelectionText}」新建为人物吗？`
      : smartMentionPrompt?.source === "place"
        ? `要把「${smartSelectionText}」新建为地点吗？`
        : smartChoices.length > 0
          ? `「${smartSelectionText}」匹配到多个关联对象`
          : `把「${smartSelectionText}」存成？`;
  const moduleCommands = useMemo(() => enabledModuleCommands(movieEnabled), [movieEnabled]);
  /**
   * The composer's right-click menu. Selecting text and right-clicking is the one
   * gesture that needs no explaining, so the cleaning step rides along with it:
   * the selection goes through `cleanMovieQuery` and the hint spells out the term
   * that will actually be searched for, so nothing is cleaned behind the owner's
   * back. The text in the box is never rewritten — his prose is his, and a menu
   * entry that silently edited it would be the worst kind of surprise.
   */
  const movieContextActions = useCallback((text: string): readonly ContextAction[] => {
    if (!movieEnabled) return [];
    const keyword = cleanMovieQuery(text);
    // A one-character "title" is not a title; searching it returns noise and
    // would read as the feature being broken. Say why instead of greying out.
    const usable = Array.from(keyword).length >= 2;
    const shown = Array.from(keyword).length > 16 ? `${Array.from(keyword).slice(0, 16).join("")}…` : keyword;
    return [{
      id: "movie-identify",
      label: "识别为影片",
      hint: usable ? `用「${shown}」搜索` : "先选中一段片名",
      disabled: !usable,
      onSelect: (selected, range) => { setMovieQuery(cleanMovieQuery(selected)); setMovieSelection({ ...range, text: selected }); setMoviePanelOpen(true); },
    }];
  }, [movieEnabled]);
  const attachMovie = (movie: MovieEntity) => {
    const ref = movieRef(movie) as unknown as EntityRef;
    onMovieRefsChange([...movieRefs.filter((item) => !isMovieRef(item)), ref]);
    onMovieEntity(movie);
    // Naming the film is the mark: the words that pointed at it get their
    // decision now, so 「检查标记」 is never asked to confirm the same thing twice.
    const marked = movieMentionDecisions(content, entities, decisions, asCoreEntity(movie), movieSelection);
    if (marked !== null) {
      onDecisionsChange(marked);
      onNotify(`已标记为影片《${movie.name}》`);
    }
    setMoviePanelOpen(false);
    setMovieQuery(undefined);
    setMovieSelection(null);
  };
  const removeMovie = (id: string) => onMovieRefsChange(movieRefs.filter((item) => !(isMovieRef(item) && item.entityId === id)));
  return <section ref={composerRef} className={`composer surface composer-kind-${kind} ${editing ? "is-editing" : ""} ${mobilePage ? "is-mobile-composer" : ""}`} aria-label="记录编辑器">
    {!mobilePage ? <div className="composer-toolbar">
      {editing ? <strong className="composer-edit-title">编辑{activeMeta.label}</strong> : <div className="kind-switcher" role={dream ? "group" : "tablist"} aria-label={dream ? "梦境记录与页面导航" : "记录类型"}>
        {dream ? <><button className="kind-option is-active" type="button" aria-pressed={true} disabled={saving}><DreamIcon size={15} /><span>梦境</span></button><button className="kind-option" type="button" onClick={onOpenJournal} disabled={saving || !onOpenJournal} aria-label="前往日记页面"><NotebookPen size={15} strokeWidth={1.8} aria-hidden="true" /><span>日记</span></button></> : (["journal", "task"] as const).map((item) => {
          const Icon = COMPOSER_META[item].icon;
          return <button className={`kind-option ${kind === item ? "is-active" : ""}`} key={item} type="button" role="tab" aria-selected={kind === item} onClick={() => onKindChange(item)}><Icon size={15} strokeWidth={1.8} aria-hidden="true" /><span>{COMPOSER_META[item].label}</span></button>;
        })}
      </div>}
      <div className={`composer-toolbar-actions ${searchControl ? "has-search" : ""}`}>
        {searchControl}
        {dismissible ? <button className={editing ? "secondary-button composer-edit-cancel" : "icon-button compact-icon-button composer-close"} type="button" onClick={onClose} aria-label={editing ? "取消编辑" : "关闭记录编辑器"}>{editing ? "取消" : <X size={17} strokeWidth={1.9} aria-hidden="true" />}</button> : null}
      </div>
    </div> : null}
    <ComposerBody mobile={mobilePage}>
    {editing && kind === "note" && noteMeta && onNoteMetaChange ? <div className="composer-note-fields">
      <div className="note-format-picker" role="tablist" aria-label="笔记格式">{NOTE_FORMATS.map((item) => <button className={`note-format-option ${noteMeta.format === item.value ? "is-active" : ""}`} data-note-format={item.value} type="button" role="tab" aria-selected={noteMeta.format === item.value} key={item.value} onClick={() => onNoteMetaChange({ ...noteMeta, format: item.value, metadataTouched: true })}><span className="note-format-option-title">{item.label}</span><small>{item.hint}</small></button>)}</div>
      {noteMeta.format === "article" ? <label className="composer-note-field"><span>标题</span><input data-note-title value={noteMeta.title} maxLength={300} onChange={(event) => onNoteMetaChange({ ...noteMeta, title: event.target.value, metadataTouched: true })} /></label> : null}
    </div> : null}
    <div className={`composer-entry ${draggingFiles ? "is-dragging" : ""}`} {...entryDragHandlers}>
    {/* Two collapsed rows. The fan used to be the reason for three — a turned
        square grows its box by about 1.3x, so a deep hand was paid for in height
        as well as width. The strip below is a flat 44px row and needs none of
        that, so the field goes back to two rows (about 81px) and the band adds
        its own height underneath. */}
    <MentionBox disabled={saving} className="composer-input" value={content} onChange={onContentChange} entities={entities} candidates={candidates} decisions={decisions} onPickEntity={(entity, text, occurrence, editRange) => occurrence === undefined ? reviewEntity(entity, text) : markCreatedEntity(entity, text, { start: occurrence.start, end: occurrence.end, text: text.slice(occurrence.start, occurrence.end) }, editRange, true)} onInspectCandidate={(candidate) => setReview({ text: content, candidates: candidates.filter((item) => item.entities.some((entity) => candidate.entities.some((option) => option.id === entity.id))) })} recentPlaceIds={recentPlaceIds} onCreateEntity={onCreateEntity} textareaRef={inputRef} rows={1} autoGrow autoGrowRows={mobilePage ? 5 : 2} ariaLabel={`${activeMeta.label}内容`} moduleCommands={moduleCommands} onSlashCommand={() => { setMovieQuery(undefined); setMoviePanelOpen(true); }} contextActions={movieContextActions} />
    {uncheckedCandidates.length > 0 ? <div className="mention-review-reminder"><span>发现 {[{ n: pendingPeople, unit: "位人物" }, { n: pendingPlaces, unit: "处地点" }, { n: pendingMovies, unit: "部影片" }].filter((item) => item.n > 0).map((item) => `${item.n} ${item.unit}`).join("、")}可关联</span><button className="text-button" type="button" disabled={saving} onClick={() => setReview({ text: content, candidates })}>检查标记</button></div> : candidates.length > 0 ? <div className="mention-review-reminder is-reviewed"><span>人物、地点与影片已核对</span><button className="text-button" type="button" disabled={saving} onClick={() => setReview({ text: content, candidates })}>检查标记</button></div> : null}
      {/* The photos sit flush under the text block, not under the room. The
          textarea is inset from the room's top by its own padding, so a floor on
          the room leaves that same inset stranded below the text instead — the
          gap moves, it does not go away. Cancelling the entry's slack here is
          what actually closes it. */}
      <div className="composer-mobile-action-row">
        <ShotDropZone ref={shotZoneRef} toolbarTarget={photoToolbarTarget} scopeKey={shotScopeKey} disabled={saving} shots={shots} assets={assets} onShotsChange={onShotsChange} onUpload={onUploadShot} onUploadVideo={uploadVideo} onNotify={onNotify} onCleared={onShotsCleared} onBusyChange={setShotUploading} onSubmissionState={handleShotSubmissionState} />
      </div>
    </div>
    {editing && kind === "note" && noteMeta?.format === "quote" && onNoteMetaChange ? <label className="composer-note-field composer-note-source"><span>出处（可选）</span><input data-note-source value={noteMeta.source} maxLength={1000} onChange={(event) => onNoteMetaChange({ ...noteMeta, source: event.target.value, metadataTouched: true })} /></label> : null}
    {error ? <div className="composer-edit-error" role="alert"><span>{error}</span>{onReloadLatest ? <button type="button" onClick={onReloadLatest}>读取最新版本</button> : null}</div> : null}
    {/* Both sides changed the body. The server text is shown verbatim so the choice
        is made against what is actually there, not against a summary of it. */}
    {conflictActions ? <div className="composer-conflict" role="group" aria-label="正文冲突">
      <div className="composer-conflict-body"><strong>最新服务端正文</strong><p>{conflictActions.theirsText || "（空）"}</p></div>
      <div className="composer-conflict-actions">
        <button type="button" className="secondary-button" onClick={conflictActions.useLatest} disabled={saving}>用最新版本正文</button>
        <button type="button" className="secondary-button" onClick={conflictActions.keepMine} disabled={saving}>保留我的正文</button>
      </div>
    </div> : null}
    {movieRefs.filter(isMovieRef).length > 0 ? <div className="composer-movie-refs" aria-label="已添加电影">{movieRefs.filter(isMovieRef).map((ref) => { const entity = entities.find((item) => item.id === ref.entityId); const movie = isMovieEntity(entity) ? entity : undefined; return <span className="movie-ref-chip" key={entityRefKey(ref)}><Film size={13} aria-hidden="true" /><span>{movie?.name ?? ref.label ?? ref.entityId}</span><button type="button" onClick={() => removeMovie(ref.entityId)} aria-label={`移除电影 ${movie?.name ?? ref.label ?? ref.entityId}`}><X size={12} aria-hidden="true" /></button></span>; })}</div> : null}
    {mobilePage ? mobileFields : <div className="composer-footer">
      <div className="composer-fields">
        <div className="composer-photo-slot" ref={setPhotoToolbarTarget} />
        <div className="place-anchor">
          <button className={`icon-button compact-icon-button ${pickerKind === "person" ? "is-active-tool" : ""}`} type="button" onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => { if (selectionRef.current !== null) openSmartMention("person"); else { setPickerKind((current) => (current === "person" ? null : "person")); setCreateOpen(false); setSmartMentionPrompt(null); } }} disabled={saving} aria-label="插入人物" aria-expanded={pickerKind === "person"}><User size={15} strokeWidth={1.9} aria-hidden="true" /></button>
          <button className={`icon-button compact-icon-button ${pickerKind === "place" ? "is-active-tool" : ""}`} type="button" onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => { setPickerSearch(selectionRef.current?.text ?? ""); setPickerKind((current) => (current === "place" ? null : "place")); setCreateOpen(false); setSmartMentionPrompt(null); }} disabled={saving} aria-label="插入地点" aria-expanded={pickerKind === "place"}><MapPin size={15} strokeWidth={1.9} aria-hidden="true" /></button>
          {/* 影片入口就长在地点旁边：同一个动作族（往这条记录上挂一样东西），
              只是影片不在本地词表里，得先联网认一次，所以开的是识别面板而不是
              下拉候选。选中一段文字再点，会把那段当成片名带进搜索框。 */}
          {movieEnabled ? <button className={`icon-button compact-icon-button ${moviePanelOpen ? "is-active-tool" : ""}`} type="button" onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => { if (moviePanelOpen) { setMoviePanelOpen(false); setMovieQuery(undefined); setMovieSelection(null); return; } const selection = selectionRef.current; const picked = cleanMovieQuery(selection?.text ?? ""); setMovieQuery(picked === "" ? undefined : picked); setMovieSelection(picked === "" ? null : selection); setMoviePanelOpen(true); setPickerKind(null); setCreateOpen(false); setSmartMentionPrompt(null); }} disabled={saving} aria-label="插入影片" aria-expanded={moviePanelOpen}><Film size={15} strokeWidth={1.9} aria-hidden="true" /></button> : null}
          {/* 影片面板跟地点走同一条浮层路子：锚在这排按钮下面、只有一列宽。
              它原先挂在 footer 上方当整条长条，宽度跟着输入框一路撑开，「搜一部
              片」被画得比整条记录还重（主人 2026-11-08：要下拉、不要太宽）。 */}
          {moviePanelOpen ? <div className="place-popover entity-picker-popover movie-popover" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setMoviePanelOpen(false); setMovieQuery(undefined); setMovieSelection(null); } }}><MovieAddPanel enabled={movieEnabled} onAttach={attachMovie} onClose={() => { setMoviePanelOpen(false); setMovieQuery(undefined); setMovieSelection(null); }} initialQuery={movieQuery} /></div> : null}
          {smartHintVisible ? <p className="smart-mention-toast" role="status">先选中一段文字，再关联人物或地点</p> : null}
          {smartPromptOpen ? <div className="place-popover smart-mention-popover"><div className="smart-mention-header"><Sparkles size={14} aria-hidden="true" /><strong>{smartPromptTitle}</strong></div>{smartChoices.length > 0 ? <div className="smart-choice-grid">{smartChoices.map(({ entity, type }) => { const KindIcon = type === "person" ? User : MapPin; const detail = entityHint(entity, entities) || (type === "person" ? "@ 人物" : "# 地点"); return <button className="smart-choice" key={`${type}-${entity.id}`} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => reviewEntity(entity, content, smartMentionPrompt?.selection)}>{type === "person" ? <ContactMentionAvatar entity={entity} /> : <KindIcon size={15} strokeWidth={1.9} aria-hidden="true" />}<span><strong>{entity.name}</strong><small>{detail}</small></span></button>; })}</div> : <div className="smart-choice-grid">{smartCreateTypes.map((type) => { const KindIcon = type === "person" ? User : MapPin; return <button className={`smart-choice smart-choice-${type}`} key={type} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => beginSmartCreate(type)}><KindIcon size={15} strokeWidth={1.9} aria-hidden="true" /><span><strong>{type === "person" ? "人物" : "地点"}，{smartSelectionText}</strong><small>新建并标记这一处</small></span></button>; })}</div>}</div> : null}
          {pickerKind === "place" && !createOpen ? <div className="place-popover entity-picker-popover" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closePicker(); } }}><PlaceSearch onDismiss={closePicker} entities={entities} initialQuery={pickerSearch} recentPlaceIds={recentPlaceIds} includePrivate={placeIncludePrivate} hideDemo={placeHideDemo} onManual={name => { setPickerSearch(name); setCreateOpen(true); }} onPick={async choice => { if ("id" in choice) { if (selectionRef.current !== null) { reviewEntity(choice, content, selectionRef.current); return; } const caret = inputRef.current?.selectionStart ?? content.length; const next = content.slice(0, caret) + choice.name + content.slice(caret); onContentChange(next); reviewEntity(choice, next, { start: caret, end: caret + choice.name.length, text: choice.name }); } else { if (!await submitCreateForm({ type: "place", name: choice.name, address: choice.address, role: choice.role, ...placeDetailsOf(choice) })) throw new Error("地点未能保存，请重试"); } }} /></div> : pickerKind !== null ? <div className="place-popover entity-picker-popover"><input className="place-search" type="text" value={pickerSearch} onChange={(event) => setPickerSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closePicker(); }} aria-label={`查找${pickerKind === "place" ? "地点" : "人物"}`} autoFocus />{createOpen ? <EntityCreateForm defaultType={pickerKind} defaultName={pickerSearch} onCreate={submitCreateForm} onCancel={() => setCreateOpen(false)} submitLabel="创建" /> : <><div className="place-options">{pickerOptions.map((entity) => { const KindIcon = ENTITY_META[entity.type].icon; return <button className="place-option" key={entity.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { const caret = inputRef.current?.selectionStart ?? content.length; const next = content.slice(0, caret) + entity.name + content.slice(caret); onContentChange(next); reviewEntity(entity, next); }}>{entity.type === "person" ? <ContactMentionAvatar entity={entity} /> : <KindIcon size={13} strokeWidth={1.8} aria-hidden="true" />}<span>{entity.name}</span>{entityHint(entity, entities) ? <small>{entityHint(entity, entities)}</small> : null}</button>; })}{pickerOptions.length === 0 ? <p className="place-empty">没有匹配的{pickerKind === "place" ? "地点" : "人物"}</p> : null}</div><button className="mention-option mention-option-create" type="button" disabled={createOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setCreateOpen(true)}><Plus size={13} aria-hidden="true" /><span className="mention-option-name">新建{pickerKind === "place" ? "地点" : "人物"}「{pickerSearch.trim() || "…"}」…</span></button></>}</div> : null}
        </div>
        {/* A task gets the range picker instead: both ends of a task can be in
            the future, and the occurrence field's cap at "now" is exactly what
            made "starts next month" unsettable. Every other kind keeps the
            single-day field, which is capped because a journal records what has
            already happened. */}
        <div className="composer-metadata">
        {kind === "task"
          ? <TaskScheduleField start={occurredAt} end={dueAt} onStartChange={onOccurredAtChange} onEndChange={onDueAtChange} />
          : <><DateField value={occurredAt} onChange={onOccurredAtChange} label={dream ? "醒来时间" : "发生时间"} showTime capped />{photoTimeHint !== null && onUseNow !== undefined ? <button className="composer-time-source" type="button" onClick={onUseNow} disabled={saving} title="改用现在的时间"><Camera size={12} strokeWidth={1.9} aria-hidden="true" /><span>来自照片 · 改回现在</span></button> : null}</>}
        {editing && kind === "task" && taskStatus && onTaskStatusChange ? <label className="composer-status-field"><span>状态</span><select value={taskStatus === "done" ? "done" : "todo"} onChange={(event) => onTaskStatusChange(event.target.value as TaskStatus)}><option value="todo">未完成</option><option value="done">已完成</option></select></label> : null}
        {kind === "journal" && isBackfillDate ? <label className={`backfill-toggle ${isBackfill ? "is-on" : ""}`} title="将这条记录标记为补记"><input type="checkbox" checked={isBackfill} onChange={(event) => onBackfillChange(event.target.checked)} /><History size={14} strokeWidth={1.9} aria-hidden="true" /><span>补记</span></label> : null}
        <label className={`privacy-toggle ${isPrivate ? "is-on" : ""}`} title="隐私记录"><input type="checkbox" checked={isPrivate} onChange={(event) => onPrivateChange(event.target.checked)} /><LockKeyhole size={14} strokeWidth={1.9} aria-hidden="true" /><span>隐私</span></label>
        </div>
      </div>
      <button className="primary-button composer-desktop-save" type="button" disabled={!canSave} onClick={submitIfReady}>{saving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : editing ? <Check size={17} strokeWidth={1.8} aria-hidden="true" /> : <Send size={17} strokeWidth={1.8} aria-hidden="true" />}<span>{saving ? "保存中" : editing ? "保存修改" : kind === "task" ? "添加" : "保存"}</span></button>
    </div>}
    </ComposerBody>
    {mobilePage ? <footer className="mobile-composer-save"><button type="button" disabled={!canSave} onClick={submitIfReady}>{saving ? <LoaderCircle className="spin" size={17} /> : <ArchiveCheckIcon />}<span>{saving ? "保存中" : kind === "task" ? "添加任务" : "保存"}</span></button></footer> : null}
    {review !== null ? <EntityMentionReview text={review.text} candidates={review.candidates} decisions={review.selection ? decisions.filter(decision => decision.end <= review.selection!.start || decision.start >= review.selection!.end) : decisions} preferredEntity={review.entity} wording={review.wording === undefined ? undefined : { value: review.wording, onChange: value => setReview(current => current ? { ...current, wording: value } : null) }} onClose={() => setReview(null)} onConfirm={(next) => { if (content !== review.text) { setReview(null); onNotify("正文已变化，请重新检查标记", "warn"); return; } const result = review.wording !== undefined && review.selection ? applyPlaceWording(review.text, review.selection, review.wording, next) : { text: review.text, decisions: next }; if (result.text !== content) onContentChange(result.text, review.selection); onDecisionsChange(result.decisions); setReview(null); onNotify("人物与地点已核对"); }} /> : null}
  </section>;
}

/** Matches the height transition in styles.css. */
const REVIEW_EXPAND_MS = 300;

/**
 * Past-date composer. The collapsed bar is a single, compact entry point: it
 * names the journal, keeps a short draft preview, and offers 补记. The whole
 * row is one click target; the real editor remains unchanged once expanded.
 */
export function ReviewComposer(props: ComposerProps) {
  const [expanded, setExpanded] = useState(false);
  // Mounted on first expansion and kept afterwards: the collapse animation needs
  // something to measure.
  const [bodyMounted, setBodyMounted] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);

  // Written straight to the element rather than through React state. State would
  // let the two height writes land in the same frame, and then the browser sees a
  // single change from `auto` to the target — no transition, a hard snap. The
  // forced reflow between the writes is what makes the starting value real.
  // `useLayoutEffect` so the first paint already has height 0 and the editor
  // never flashes open at full size.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const node = bodyRef.current;
    if (slot === null || node === null || !bodyMounted) return;
    slot.style.overflow = "hidden";
    if (!expanded) {
      slot.style.height = `${node.getBoundingClientRect().height}px`;
      void slot.offsetHeight;
      slot.style.height = "0px";
      return;
    }
    slot.style.height = "0px";
    void slot.offsetHeight;
    slot.style.height = `${node.scrollHeight}px`;
    // Hand the height back to `auto` once it has arrived, and drop the clipping
    // with it: the date panel and the mention list are absolutely positioned
    // inside the editor and must not be cut off.
    const settle = window.setTimeout(() => { slot.style.height = ""; slot.style.overflow = ""; }, REVIEW_EXPAND_MS + 80);
    return () => window.clearTimeout(settle);
  }, [bodyMounted, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".review-composer-body .composer-input")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

  const open = () => {
    // A past-date tap means "write a journal backfill". Preserve the draft,
    // but establish both flags before the full editor mounts so the first save
    // cannot accidentally be sent as another kind or as a normal record.
    props.onKindChange("journal");
    props.onBackfillChange(true);
    setBodyMounted(true);
    setExpanded(true);
  };
  const draft = props.content.trim();

  return <div className="review-composer" data-expanded={expanded ? "true" : "false"}>
    <button className="review-composer-bar" type="button" onClick={open} aria-label="补记这一天的记录，展开完整编辑器">
      <span className="review-composer-kind" aria-hidden="true"><NotebookPen size={15} strokeWidth={1.8} /><span>日记</span></span>
      <span className={`review-composer-preview ${draft ? "has-draft" : ""}`} aria-hidden="true">{draft || "写点什么…"}</span>
      <span className="review-composer-cta" aria-hidden="true"><Send size={16} strokeWidth={1.8} /><span>补记</span></span>
    </button>
    <div className="review-composer-slot" ref={slotRef}>
      <div className="review-composer-body" ref={bodyRef} inert={!expanded}>
        {bodyMounted ? <Composer {...props} onClose={() => { setExpanded(false); props.onClose(); }} /> : null}
      </div>
    </div>
  </div>;
}
