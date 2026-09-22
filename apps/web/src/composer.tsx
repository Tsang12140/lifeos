import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  CalendarDays,
  Check,
  CloudSun,
  Film,
  History,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  NotebookPen,
  Plus,
  Search,
  Send,
  Sparkles,
  User,
  MapPin,
  X,
} from "lucide-react";
import type { AssetLink, Entity, EntityRef, PlacePeriod, PlaceRole, WeatherAttachment } from "@lifeos/core";
import { PLACE_MARKER, cleanMovieQuery, entitySearchTerms, normalizeEntitySearchTerm } from "@lifeos/core";
import type { MovieEntity, RecordView } from "./api";
import type { ComposerKind, CreateEntity, EntityCreateRequest } from "./app-types";
import type { ModuleCommand } from "./movie";
import { DateField } from "./date-field";
import { TaskScheduleField } from "./task-schedule";
import {
  CJK_PATTERN,
  COMPOSER_META,
  ENTITY_META,
  MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH,
  entityRefKey,
  isMovieEntity,
  isMovieRef,
} from "./app-meta";
import { entityHint, mentionQueryAt, mentionSuggestions, slashQueryAt, slashSuggestions, type MentionQuery } from "./mention";
import { localDateToday } from "./time";
import { enabledModuleCommands, movieRef, MovieAddPanel } from "./movie";
import { EntityCreateForm, MentionBox, type ContextAction } from "./entity-forms";
import { ShotDropZone, type ShotUpload } from "./shot-drop-zone";

export interface ComposerProps { kind: ComposerKind; content: string; occurredAt: string; occurredDirty?: boolean; dueAt: string; isPrivate: boolean; isBackfill: boolean; weather: WeatherAttachment | null; weatherBusy: boolean; selectedDate: string; saving: boolean; dismissible: boolean; entities: readonly Entity[]; recentPlaceIds?: readonly string[]; movieEnabled: boolean; movieRefs: readonly EntityRef[]; onMovieRefsChange: (refs: readonly EntityRef[]) => void; onMovieEntity: (movie: MovieEntity) => void; onCreateEntity: CreateEntity; onOpenSearch: () => void; onKindChange: (kind: ComposerKind) => void; onContentChange: (content: string) => void; onOccurredAtChange: (value: string) => void; onDueAtChange: (value: string) => void; onPrivateChange: (value: boolean) => void; onBackfillChange: (value: boolean) => void; onCaptureWeather: () => void; onClearWeather: () => void; onSubmit: () => void; onClose: () => void; shots: readonly AssetLink[]; onShotsChange: Dispatch<SetStateAction<readonly AssetLink[]>>; onUploadShot: (file: File) => Promise<ShotUpload | null>; onNotify: (message: string, tone?: "ok" | "warn") => void; onShotsCleared: (cleared: readonly AssetLink[], restore: () => void) => void; }

interface ComposerSelection { readonly start: number; readonly end: number; readonly text: string; }
interface SmartMentionPrompt { readonly source: "person" | "place" | "universal"; readonly selection: ComposerSelection; readonly personMatches: readonly Entity[]; readonly placeMatches: readonly Entity[]; }

export function Composer({ kind, content, occurredAt, dueAt, isPrivate, isBackfill, weather, weatherBusy, selectedDate, saving, dismissible, entities, recentPlaceIds = [], movieEnabled, movieRefs, onMovieRefsChange, onMovieEntity, onCreateEntity, onOpenSearch, onKindChange, onContentChange, onOccurredAtChange, onDueAtChange, onPrivateChange, onBackfillChange, onCaptureWeather, onClearWeather, onSubmit, onClose, shots, onShotsChange, onUploadShot, onNotify, onShotsCleared }: ComposerProps) {
  const activeMeta = COMPOSER_META[kind];
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [pickerKind, setPickerKind] = useState<"person" | "place" | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [smartMentionPrompt, setSmartMentionPrompt] = useState<SmartMentionPrompt | null>(null);
  const [smartHintVisible, setSmartHintVisible] = useState(false);
  const [moviePanelOpen, setMoviePanelOpen] = useState(false);
  const [movieQuery, setMovieQuery] = useState<string | undefined>(undefined);
  const composerRef = useRef<HTMLElement>(null);
  const smartHintTimerRef = useRef<number | null>(null);
  const selectionRef = useRef<ComposerSelection | null>(null);
  const isBackfillDate = selectedDate !== localDateToday();
  // Quick-attach: the button pre-opens the picker for its kind; picking one
  // writes `@名字` / `#名字` at the caret, and the mention pipeline links it
  // on save. "新建" opens the shared create form.
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
    const start = Math.min(element.selectionStart ?? content.length, element.selectionEnd ?? content.length);
    const end = Math.max(element.selectionStart ?? content.length, element.selectionEnd ?? content.length);
    const text = content.slice(start, end).trim();
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
  const replaceSelection = (token: string, selection: ComposerSelection | null = selectionRef.current) => {
    if (selection === null) return;
    const next = `${content.slice(0, selection.start)}${token}${content.slice(selection.end)}`;
    onContentChange(next);
    resetMentionTools();
    selectionRef.current = null;
    window.requestAnimationFrame(() => {
      const element = inputRef.current;
      if (element === null) return;
      const caret = selection.start + token.length;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };
  const insertAtCaret = (token: string) => {
    const element = inputRef.current;
    const caret = element?.selectionStart ?? content.length;
    onContentChange(`${content.slice(0, caret)}${token}${content.slice(caret)}`);
    resetMentionTools();
    selectionRef.current = null;
  };
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
      replaceSelection(`@${personMatches[0].name}`, selection);
      return;
    }
    if (source === "place" && placeMatches.length === 1) {
      replaceSelection(`${PLACE_MARKER}${placeMatches[0].name}`, selection);
      return;
    }
    if (source === "universal" && personMatches.length === 1 && placeMatches.length === 0) {
      replaceSelection(`@${personMatches[0].name}`, selection);
      return;
    }
    if (source === "universal" && placeMatches.length === 1 && personMatches.length === 0) {
      replaceSelection(`${PLACE_MARKER}${placeMatches[0].name}`, selection);
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
    const entity = await onCreateEntity(request.type, request.name, {
      ...(request.aliases === undefined ? {} : { aliases: request.aliases }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.period === undefined ? {} : { period: request.period }),
      ...(request.address === undefined ? {} : { address: request.address }),
    });
    if (entity === null) return false;
    const selection = selectionRef.current;
    if (selection !== null) replaceSelection(`${request.type === "place" ? PLACE_MARKER : "@"}${entity.name}`, selection);
    else insertAtCaret(`${request.type === "place" ? PLACE_MARKER : "@"}${entity.name}`);
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
      onSelect: (selected) => { setMovieQuery(cleanMovieQuery(selected)); setMoviePanelOpen(true); },
    }];
  }, [movieEnabled]);
  const attachMovie = (movie: MovieEntity) => {
    const ref = movieRef(movie) as unknown as EntityRef;
    onMovieRefsChange([...movieRefs.filter((item) => !isMovieRef(item)), ref]);
    onMovieEntity(movie);
  };
  const removeMovie = (id: string) => onMovieRefsChange(movieRefs.filter((item) => !(isMovieRef(item) && item.entityId === id)));
  return <section ref={composerRef} className="composer surface" aria-label="记录编辑器">
    <div className="composer-toolbar">
      <div className="kind-switcher" role="tablist" aria-label="记录类型">
        {(Object.keys(COMPOSER_META) as ComposerKind[]).map((item) => {
          const Icon = COMPOSER_META[item].icon;
          return <button className={`kind-option ${kind === item ? "is-active" : ""}`} key={item} type="button" role="tab" aria-selected={kind === item} onClick={() => onKindChange(item)}><Icon size={15} strokeWidth={1.8} aria-hidden="true" /><span>{COMPOSER_META[item].label}</span></button>;
        })}
      </div>
      <div className="composer-toolbar-actions">
        <button className="icon-button compact-icon-button composer-search" type="button" onClick={onOpenSearch} aria-label={`搜索${activeMeta.label}`}><Search size={17} strokeWidth={1.9} aria-hidden="true" /></button>
        {dismissible ? <button className="icon-button compact-icon-button composer-close" type="button" onClick={onClose} aria-label="关闭记录编辑器"><X size={17} strokeWidth={1.9} aria-hidden="true" /></button> : null}
      </div>
    </div>
    <div className="composer-entry">
    {/* Two collapsed rows. The fan used to be the reason for three — a turned
        square grows its box by about 1.3x, so a deep hand was paid for in height
        as well as width. The strip below is a flat 44px row and needs none of
        that, so the field goes back to two rows (about 81px) and the band adds
        its own height underneath. */}
    <MentionBox className="composer-input" value={content} onChange={onContentChange} entities={entities} recentPlaceIds={recentPlaceIds} onCreateEntity={onCreateEntity} textareaRef={inputRef} placeholder={activeMeta.placeholder} rows={1} autoGrow autoGrowRows={2} ariaLabel={`${activeMeta.label}内容`} moduleCommands={moduleCommands} onSlashCommand={() => { setMovieQuery(undefined); setMoviePanelOpen(true); }} contextActions={movieContextActions} />
      {/* The photos sit flush under the text block, not under the room. The
          textarea is inset from the room's top by its own padding, so a floor on
          the room leaves that same inset stranded below the text instead — the
          gap moves, it does not go away. Cancelling the entry's slack here is
          what actually closes it. */}
      <div className="composer-mobile-action-row">
        <ShotDropZone shots={shots} onShotsChange={onShotsChange} onUpload={onUploadShot} onNotify={onNotify} onCleared={onShotsCleared} />
        <button className="primary-button composer-inline-save" type="button" disabled={!content.trim() || saving} onClick={onSubmit} aria-label={saving ? "正在保存" : "保存"} title={saving ? "正在保存" : "保存"}>{saving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Send size={17} strokeWidth={1.8} aria-hidden="true" />}<span className="visually-hidden">{saving ? "保存中" : "保存"}</span></button>
      </div>
    </div>
    {moviePanelOpen ? <MovieAddPanel enabled={movieEnabled} onAttach={attachMovie} onClose={() => { setMoviePanelOpen(false); setMovieQuery(undefined); }} initialQuery={movieQuery} /> : null}
    {movieRefs.filter(isMovieRef).length > 0 ? <div className="composer-movie-refs" aria-label="已添加电影">{movieRefs.filter(isMovieRef).map((ref) => { const entity = entities.find((item) => item.id === ref.entityId); const movie = isMovieEntity(entity) ? entity : undefined; return <span className="movie-ref-chip" key={entityRefKey(ref)}><Film size={13} aria-hidden="true" /><span>{movie?.name ?? ref.label ?? ref.entityId}</span><button type="button" onClick={() => removeMovie(ref.entityId)} aria-label={`移除电影 ${movie?.name ?? ref.label ?? ref.entityId}`}><X size={12} aria-hidden="true" /></button></span>; })}</div> : null}
    <div className="composer-footer">
      <div className="composer-fields">
        <div className="place-anchor">
          <button className={`icon-button compact-icon-button universal-mention-button ${smartPromptOpen ? "is-active-tool" : ""}`} type="button" onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => { if ((smartPromptOpen || smartHintVisible) && selectionRef.current === null) closePicker(); else openSmartMention("universal"); }} aria-label="万能键" aria-expanded={smartPromptOpen}><Sparkles size={15} strokeWidth={1.9} aria-hidden="true" /></button>
          <button className={`icon-button compact-icon-button ${pickerKind === "person" ? "is-active-tool" : ""}`} type="button" onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => { if (selectionRef.current !== null) openSmartMention("person"); else { setPickerKind((current) => (current === "person" ? null : "person")); setCreateOpen(false); setSmartMentionPrompt(null); } }} aria-label="插入人物" aria-expanded={pickerKind === "person"}><User size={15} strokeWidth={1.9} aria-hidden="true" /></button>
          <button className={`icon-button compact-icon-button ${pickerKind === "place" ? "is-active-tool" : ""}`} type="button" onMouseDown={(event) => { event.preventDefault(); rememberSelection(); }} onClick={() => { if (selectionRef.current !== null) openSmartMention("place"); else { setPickerKind((current) => (current === "place" ? null : "place")); setCreateOpen(false); setSmartMentionPrompt(null); } }} aria-label="插入地点" aria-expanded={pickerKind === "place"}><MapPin size={15} strokeWidth={1.9} aria-hidden="true" /></button>
          {smartHintVisible ? <p className="smart-mention-toast" role="status">先选中一段文字，再点万能键</p> : null}
          {smartPromptOpen ? <div className="place-popover smart-mention-popover"><div className="smart-mention-header"><Sparkles size={14} aria-hidden="true" /><strong>{smartPromptTitle}</strong></div>{smartChoices.length > 0 ? <div className="smart-choice-grid">{smartChoices.map(({ entity, type }) => { const KindIcon = type === "person" ? User : MapPin; const detail = entityHint(entity, entities) || (type === "person" ? "@ 人物" : "# 地点"); return <button className="smart-choice" key={`${type}-${entity.id}`} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => replaceSelection(`${type === "place" ? PLACE_MARKER : "@"}${entity.name}`, smartMentionPrompt.selection)}><KindIcon size={15} strokeWidth={1.9} aria-hidden="true" /><span><strong>{entity.name}</strong><small>{detail}</small></span></button>; })}</div> : <div className="smart-choice-grid">{smartCreateTypes.map((type) => { const KindIcon = type === "person" ? User : MapPin; return <button className={`smart-choice smart-choice-${type}`} key={type} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => beginSmartCreate(type)}><KindIcon size={15} strokeWidth={1.9} aria-hidden="true" /><span><strong>{type === "person" ? "人物" : "地点"} · {smartSelectionText}</strong><small>新建并插入 {type === "person" ? "@" : "#"}</small></span></button>; })}</div>}</div> : null}
          {pickerKind !== null ? <div className="place-popover entity-picker-popover"><input className="place-search" type="text" value={pickerSearch} onChange={(event) => setPickerSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closePicker(); }} placeholder={`搜索${pickerKind === "place" ? "地点" : "人物"}，或直接输入新名称`} aria-label="搜索" autoFocus />{createOpen ? <EntityCreateForm defaultType={pickerKind} defaultName={pickerSearch} onCreate={submitCreateForm} onCancel={() => setCreateOpen(false)} submitLabel="创建并插入" /> : <><div className="place-options">{pickerOptions.map((entity) => { const KindIcon = ENTITY_META[entity.type].icon; return <button className="place-option" key={entity.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertAtCaret(`${pickerKind === "place" ? PLACE_MARKER : "@"}${entity.name}`)}><KindIcon size={13} strokeWidth={1.8} aria-hidden="true" /><span>{entity.name}</span>{entityHint(entity, entities) ? <small>{entityHint(entity, entities)}</small> : null}</button>; })}{pickerOptions.length === 0 ? <p className="place-empty">没有匹配的{pickerKind === "place" ? "地点" : "人物"}</p> : null}</div><button className="mention-option mention-option-create" type="button" disabled={createOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setCreateOpen(true)}><Plus size={13} aria-hidden="true" /><span className="mention-option-name">新建{pickerKind === "place" ? "地点" : "人物"}「{pickerSearch.trim() || "…"}」…</span></button></>}</div> : null}
        </div>
        {/* A task gets the range picker instead: both ends of a task can be in
            the future, and the occurrence field's cap at "now" is exactly what
            made "starts next month" unsettable. Every other kind keeps the
            single-day field, which is capped because a journal records what has
            already happened. */}
        {kind === "task"
          ? <TaskScheduleField start={occurredAt} end={dueAt} onStartChange={onOccurredAtChange} onEndChange={onDueAtChange} />
          : <DateField value={occurredAt} onChange={onOccurredAtChange} label="发生时间" showTime capped />}
        {isBackfillDate ? <label className={`backfill-toggle ${isBackfill ? "is-on" : ""}`} title="将这条记录标记为补记"><input type="checkbox" checked={isBackfill} onChange={(event) => onBackfillChange(event.target.checked)} /><History size={14} strokeWidth={1.9} aria-hidden="true" /><span>补记</span></label> : null}
        <label className={`privacy-toggle ${isPrivate ? "is-on" : ""}`} title="隐私记录"><input type="checkbox" checked={isPrivate} onChange={(event) => onPrivateChange(event.target.checked)} /><LockKeyhole size={14} strokeWidth={1.9} aria-hidden="true" /><span>隐私</span></label>
        <button className={`weather-pin-toggle ${weather ? "is-on" : ""}`} type="button" onClick={weather ? onClearWeather : onCaptureWeather} disabled={weatherBusy} title={weather ? "取消天气" : "读取此刻室外天气"} aria-label={weather ? `天气 · 现场 ${weather.text}，点击取消` : "天气，点击读取此刻室外天气"}>{weatherBusy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <CloudSun size={14} aria-hidden="true" />}<span>{weatherBusy ? "读取中" : weather ? `现场 · ${weather.text}` : "天气"}</span></button>
      </div>
      <button className="primary-button composer-desktop-save" type="button" disabled={!content.trim() || saving} onClick={onSubmit}>{saving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Send size={17} strokeWidth={1.8} aria-hidden="true" />}<span>{saving ? "保存中" : "保存"}</span></button>
    </div>
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
