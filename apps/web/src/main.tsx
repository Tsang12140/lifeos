import { syncPhotoRotations } from "./asset-urls";
import { photoPreviewSession, type PhotoPreviewSession, type PhotoPreviewHandler } from "./asset-preview-model";
import { noteDetails } from "./notes-library";
import { SharedNotePage } from "./note-sharing";
import { hasSavableRecordContent } from "./record-content";
import { RecordDeletionContext, useRecordDeletions } from "./record-deletion";
import type { PlaceDetails } from "@lifeos/core";
import { useCalendarPresentations } from "./calendar-cache";
import { VideoScopeContext } from "./video-ui";
import type { CustomHabit, UiCommand, UiTurnPlan } from "@lifeos/core";
import { canEditDaySummary } from "@lifeos/core";
import { EMPTY_SEARCH_FILTERS, hasSearchFilters, searchFilterParams, type SearchFilters } from "./search-filters";
import { privacyRevealed, readPrivacySessionGrant, readPrivacyVisible, writePrivacySessionGrant, writePrivacyVisible } from "./privacy-visibility";
import { CalendarDayDialog } from "./calendar-day-dialog";
import { RecordPeekDialog, type RecordPeekRequest } from "./record-peek";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  Bot,
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CloudUpload,
  CloudSun,
  ContactRound,
  Download,
  Dumbbell,
  Archive,
  Edit3,
  ExternalLink,
  Film,
  FileJson,
  FileText,
  FolderKanban,
  FolderOpen,
  HardDrive,
  Heart,
  Handshake,
  History,
  House,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MapPin,
  Moon,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  PlugZap,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  SlidersHorizontal,
  Sun,
  Tag,
  Type,
  Trash2,
  Upload,
  Eraser,
  User,
  UsersRound,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { MENTION_MARKERS, PLACE_MARKER, PLACE_ROLES, SUMMARY_SYSTEM_PROMPT,
  rebaseEntityDecisions, type TextEntityDecision, SUMMARY_MAX_LENGTH, clampSummaryText, entitySearchTerms, findEntityMentions, normalizeEntitySearchTerm, trimSummaryText, type PlacePeriod, type PlaceRole } from "@lifeos/core";
import { installDiagnostics } from "./diagnostics";
import { installDialogDismiss } from "./dialog-dismiss";
import { sha256Hex } from "./contentHash";
import type { Asset, AssetKind, AssetLink, AssetRole, CycleIntimacyEventKind, CycleIntimacyModuleConfig, CycleIntimacyModuleData, DaySummary, Entity, EntityKind, EntityRef, NoteDetails, NoteFormat, RecordKind, RelationKind, TaskStatus, WeatherAttachment } from "@lifeos/core";
import {
  apiUploadRequest,
  apiRequest,
  type AssetsResponse,
  type AiStatus,
  type ApiUploadProgress,
  type AiStatusState,
  type AuthState,
  type BackupStatus,
  type BackupStatusState,
  type BackupRetentionPolicy,
  type BackupRetentionView,
  type CycleDayEditResponse,
  type CycleDayUndoResponse,
  type CycleModuleResponse,
  type MobileCycleEventKind,
  type EntitiesResponse,
  type MovieEntity,
  type MovieModuleStatus,
  type RecordView,
  type RecordsResponse,
  type RecordWritePayload,
  type SummariesResponse,
  type SummaryManualResponse,
  type TaskRecordView,
  type WeatherCurrentResponse,
  type WeatherArchiveResponse,
  type WeatherProfilesResponse,
  type WeatherProfilesState,
  type WeatherStatus,
} from "./api";
import { AIAssistant } from "./AIAssistant";
import { calendarDayInfo } from "./calendarData";
import { peekScore, scorePhoto, storyWeight } from "./photoScore";
import { WeatherHeader } from "./WeatherHeader";
import { WeatherSky } from "./WeatherBackground";
import { BackupCalendar } from "./BackupCalendar";
import { TimeMachine } from "./TimeMachine";
import { getWeatherEmoji, type WeatherCategory, type WeatherDay, type WeatherPhase } from "./weather";
import { WeatherLocationPicker } from "./WeatherLocationPicker";
import { describeWeatherLocationByName, weatherLocationDisplayName } from "./weather-locations";
import { ScrollSlotStrip } from "./ScrollSlotStrip";
import { TaskScheduleField } from "./task-schedule";
import { DateField, WEEKDAY_LABELS } from "./date-field";
import {
  combineDateTime,
  DAY_WINDOW,
  dateKeyForRecord,
  dateOnly,
  datePartOf,
  datesOfWeek,
  dayLabel,
  dayWindow,
  displayDate,
  hourOptions,
  instantFromInput,
  isDaySunday,
  isFutureDay,
  isFutureMonth,
  lastWholeHour,
  lifeTimeDate,
  lifeTimeTime,
  lifeTimeToInput,
  localDateToday,
  localNowInput,
  localNowInputFor,
  MINUTE_STEP_COARSE,
  MINUTE_STEP_FINE,
  minuteCapFor,
  minuteOptions,
  monthGridDates,
  monthGridWeeks,
  monthTitle,
  shiftDate,
  shiftMonth,
  shortDate,
  timePartOf,
  USER_TIME_ZONE,
  weekdayShort,
} from "./time";
import { registerWebMcp } from "./webmcp";
import { enabledModuleCommands, fetchMovieModuleStatus, movieRef, MovieAddPanel, MovieCardDialog, MoviePrompt, MovieSettingsCard, type ModuleCommand, type MovieModuleStatusState } from "./movie";
import "./styles.css";
import "./assistant-launcher-mobile.css";
import "./action-menu.css";
import { AI_DEFAULT_BASE_URL } from "./settings-cards";
import { type CalendarWeather } from "./timeline";
import { CalendarSettingsPanel, CalendarSummaryMenu, CalendarView, CycleModuleDialog } from "./calendar-view";
import { CalendarBackground } from "./calendar-background";
import { NoteEditorDialog, NotesLibrary, RelationPanel, type NoteDraft, type NoteSaveHandler, type RecordEditorDraft } from "./record-dialogs";
import { TaskSummary, taskDueLabel } from "./task-summary";
import { TaskPageFilters, TaskPageHeader, type TaskPageFilter } from "./tasks-page";
import { AssetPreview, CalendarDayMarkers, PrivacyMask, RecordPhotoGrid, Timeline, TimelineEntityChip, TimelineItem, assetContentUrl, assetThumbUrl, dayPhotoCandidates, dayPhotoIds, monthCellPhoto, periodMoonForDate, periodRuns, nextPredictedStart, weatherFromArchiveValue, recordsByDate, groupRecords, type ThumbnailWidth } from "./timeline";
import { RecordSearch, RecordSearchResults } from "./record-search";
import { SearchAlternatives } from "./search-alternatives";
import { ContactAvatarDialog, EntityPhotoScopeContext } from "./contact-avatar";
import { ConfirmDialog, EntitiesView, EntityEditDialog, ImportDialog, LoginGate, MobileMenuDialog, PersonCardDialog } from "./dialogs";
import { WelcomeGate } from "./WelcomeGate";
import { WeatherLocationProvider } from "./weather-location";
import { AiSettingsCard, AssetTrashSettingsCard, BackupSettingsCard, CycleSettingsCard, FontSettingsCard, SettingsView, ThumbnailCacheSettingsCard, WeatherSettingsCard } from "./settings-cards";
import { Composer, type ComposerProps, type NoteEditMeta } from "./composer";
import { RecordFeed } from "./record-feed";
import { BackToTop } from "./back-to-top";
import { AliasField, EntityCreateForm, MentionBox, aliasListFrom } from "./entity-forms";
import { DiagnosticsDrawer, EmptyState, ErrorState, LoadingState } from "./timeline-states";
import { ShotDropZone, resolveKnownShot, type ShotUpload } from "./shot-drop-zone";
import { clearComposerDraft, composerDraftScope, readComposerDraft, writeComposerDraft } from "./composer-draft";

import type { AppView, CalendarMode, ComposerKind, CreateEntity, EntityCreateRequest, EntityEditPatch, SettingsPageId, UiFontId } from "./app-types";
import { scopedKey } from "./storage-scope";

import {
  AI_ASSISTANT_VISIBLE_STORAGE_KEY,
  ASSET_ROLE_LABEL,
  ASSET_ROLE_VALUES,
  CJK_PATTERN,
  COMPOSER_META,
  COMPOSER_SHOTS_STORAGE_KEY,
  DEMO_HIDDEN_STORAGE_KEY,
  DEMO_ID_PREFIX,
  ENTITY_KIND_ORDER,
  ENTITY_META,
  MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH,
  MOVIE_PROMPT_HIDDEN_STORAGE_KEY,
  MOBILE_MORE_ITEMS,
  MOBILE_NAV_ITEMS,
  NOTE_FORMATS,
  NAV_ITEMS,
  RELATION_META,
  SELF_ENTITY_ID,
  SETTINGS_NAV_ITEM,
  SETTINGS_PAGE_GROUPS,
  SETTINGS_PAGE_IDS,
  DEFAULT_SETTINGS_PAGE,
  UI_FONT_OPTIONS,
  UI_FONT_STORAGE_KEY,
  asCoreEntity,
  assetRoleFor,
  emptyCopy,
  entityRefKey,
  errorMessage,
  errorStatus,
  formatBytes,
  isDemoRecord,
  isLocalAsset,
  isMovieEntity,
  isMovieRef,
  isTaskRecord,
  isUiFontId,
  mentionVocabulary,
  noteFormatOf,
  readAssistantVisibility,
  readComposerShotsDraft,
  readSettingsPageFromHash,
  readUiFont,
  recordLabel,
  recordText,
  refAsEntity,
  relationKindFor,
  relationLabelFor,
  settingsHash,
  statusLabel,
  timelineHeading,
  weekCardRecords,
} from "./app-meta";
import {
  PLACE_ROLE_LABELS,
  entityHint,
  hasKnownMentionPrefix,
  mentionQueryAt,
  mentionSuggestions,
  slashQueryAt,
  slashSuggestions,
  rankByRecency,
  recentPlaceIds,
  RecordText,
  type MentionQuery,
  type SlashQuery,
} from "./mention";
import { Sidebar, MobileNav } from "./shell-nav";
// Confirmed control surfaces follow component styles, including shared search CSS.
import "./control-surfaces.css";
import "./date-controls.css";
import "./tasks-page.css";
import "./login-surfaces.css";
import "./mobile-input-layout.css";

function noteUpdatedAt(record: RecordView): string {
  return shortDate(lifeTimeDate(record.updatedAt ?? record.createdAt) ?? "");
}

const RECORDS_CACHE_LIMIT = 24;
const DEFAULT_MOVIE_MODULE_STATUS: MovieModuleStatus = { enabled: false, configured: false, keyConfigured: false, connected: false };
const CALENDAR_MODE_STORAGE_KEY = scopedKey("lifeos.calendar.mode");

type AuthBootstrapPhase = "checking" | "ready" | "unavailable";

function StartupSurface({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  return <main className="startup-screen" role="status" aria-label="LifeOS">
    <div className="startup-content">
      <div className="startup-brand"><img className="startup-brand-mark" src="/favicon.svg?v=2" width={40} height={40} alt="" /><span>LifeOS</span></div>
      {failed ? <div className="startup-feedback" role="alert"><p>暂时无法确认账号状态，请检查连接后重试。</p><button className="secondary-button" type="button" onClick={onRetry}>重试</button></div> : null}
    </div>
  </main>;
}

function readCalendarModePreference(): CalendarMode {
  try {
    return window.localStorage.getItem(CALENDAR_MODE_STORAGE_KEY) === "month" ? "month" : "week";
  } catch {
    return "week";
  }
}

function clearTenantSensitiveBrowserStorage(): void {
  try {
    for (const key of ["lifeos.ai.chat", "lifeos.composerShots", "lifeos.hideDemo", "lifeos.moviePromptHidden"]) window.localStorage.removeItem(scopedKey(key));
  } catch { /* Browser storage is optional; in-memory state is discarded on reload. */ }
}

function loggedOutAuth(previous: AuthState): AuthState {
  return { required: true, authenticated: false, ...(previous.accountMode === true ? { accountMode: true } : {}) };
}

function cacheRecords(
  cache: Map<string, { readonly items: readonly RecordView[]; readonly selectedDate: string }>,
  queryPath: string,
  entry: { readonly items: readonly RecordView[]; readonly selectedDate: string },
): void {
  cache.set(queryPath, entry);
  while (cache.size > RECORDS_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function App() {
  const [activeView, setActiveView] = useState<AppView>(() => typeof window !== "undefined" && window.location.hash.startsWith("#settings/") ? "settings" : "today");
  const [settingsPage, setSettingsPage] = useState<SettingsPageId>(() => readSettingsPageFromHash());
  const [settingsMobileEntry, setSettingsMobileEntry] = useState({ root: false, version: 0 });
  const [selectedDate, setSelectedDate] = useState(localDateToday);
  const [todayDate, setTodayDate] = useState(localDateToday);
  const [recordingDate, setRecordingDate] = useState(localDateToday);
  const [feedJumpVersion, setFeedJumpVersion] = useState(0);
  const createDate = activeView === "today" ? recordingDate : selectedDate;
  useEffect(() => {
    if (activeView === "today" && selectedDate > todayDate) setSelectedDate(todayDate);
  }, [activeView, selectedDate, todayDate]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localDateToday();
      if (next === todayDate) return;
      setTodayDate(next);
      setSelectedDate(current => current === todayDate ? next : current);
      setRecordingDate(current => current === todayDate ? next : current);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [todayDate]);
  const [records, setRecords] = useState<readonly RecordView[] | null>(null);
  const [recordsRevalidation, setRecordsRevalidation] = useState(0);
  const [recordsQueryPath, setRecordsQueryPath] = useState<string | null>(null);
  const [recordsDisplayedDate, setRecordsDisplayedDate] = useState<string | null>(null);
  const [tasks, setTasks] = useState<readonly RecordView[] | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(EMPTY_SEARCH_FILTERS);
  // Private records are hidden until the owner says otherwise. The switch UI lives
  // in the sidebar; this is the state it reads and writes.
  const [privacyVisible, setPrivacyVisible] = useState(readPrivacyVisible);
  const [privacySessionGrant, setPrivacySessionGrant] = useState(readPrivacySessionGrant);
  const [privacyOneShot, setPrivacyOneShot] = useState(false);
  const [privacyRequest, setPrivacyRequest] = useState<{ readonly reason: string } | null>(null);
  // Set when a compiled filter runs, so the privacy question is asked only after
  // we can see how many records it actually hid.
  const [uiPrivacyCheck, setUiPrivacyCheck] = useState(false);
  const [uiFocusRecordId, setUiFocusRecordId] = useState<string | null>(null);
  /** Which id has already been scrolled to, so a records refresh does not re-yank the view. */
  const uiFocusScrolledFor = useRef<string | null>(null);
  const searchActive = Boolean(searchQuery) || hasSearchFilters(searchFilters);
  const [calendarMode, setCalendarMode] = useState<CalendarMode>(readCalendarModePreference);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search), month = params.get("month") ?? "";
    if (params.get("calendarBackgroundPreview") !== "1" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    setActiveView("calendar"); setCalendarMode("month"); setSelectedDate(month + "-01");
  }, []);
  const [cycleModule, setCycleModule] = useState<CycleModuleResponse | null>(null);
  const [cycleModuleOpen, setCycleModuleOpen] = useState(false);
  const [cyclePanelOpen, setCyclePanelOpen] = useState(false);
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [calendarTextVisible, setCalendarTextVisible] = useState(() => !window.matchMedia("(max-width: 560px)").matches);
  useEffect(() => { const media = window.matchMedia("(max-width: 560px)"); const update = () => setCalendarTextVisible(!media.matches); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  useEffect(() => { if (activeView !== "calendar") setCalendarDay(null); }, [activeView]);
  const [summaries, setSummaries] = useState<readonly DaySummary[]>([]);
  const [aiSummaries, setAiSummaries] = useState(false);
  // Calendar-local settings and the edit mode they can switch on. Drafts are keyed
  // by date and hold only days that were actually touched, so the save bar's count
  // is the number of edits rather than the number of cells.
  const [calendarSettingsOpen, setCalendarSettingsOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [summaryDrafts, setSummaryDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [summarySaving, setSummarySaving] = useState(false);
  const summarySaveBusyRef = useRef(false);
  const summaryWriteRef = useRef({ owner: "local", epoch: 0, dates: new Map<string, number>() });
  const [summaryBusyDate, setSummaryBusyDate] = useState<string | null>(null);
  const [weatherArchive, setWeatherArchive] = useState<ReadonlyMap<string, CalendarWeather>>(new Map());
  const [photoPreview, setPhotoPreview] = useState<(PhotoPreviewSession & { scope: string }) | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerKind, setComposerKind] = useState<ComposerKind>("journal");
  const [composerContent, setComposerContent] = useState("");
  const [taskPageFilter, setTaskPageFilter] = useState<TaskPageFilter>("incomplete");
  const [taskComposerMounted, setTaskComposerMounted] = useState(false);
  const [taskComposerExpanded, setTaskComposerExpanded] = useState(false);
  const taskComposerRef = useRef<HTMLDivElement>(null);
  const taskCreateTeaserRef = useRef<HTMLButtonElement>(null);
  const [composerEntityMentions, setComposerEntityMentions] = useState<readonly TextEntityDecision[]>([]);
  const changeComposerContent = (content: string, editRange?: { start: number; end: number }) => { setComposerEntityMentions((current) => rebaseEntityDecisions(composerContent, content, current, editRange)); setComposerContent(content); };
  const [composerPrivate, setComposerPrivate] = useState(false);
  const [composerBackfill, setComposerBackfill] = useState(false);
  const [composerWeather, setComposerWeather] = useState<WeatherAttachment | null>(null);
  const [composerWeatherBusy, setComposerWeatherBusy] = useState(false);
  const [occurredAt, setOccurredAt] = useState(() => localNowInputFor(localDateToday()));
  const [occurredAtDirty, setOccurredAtDirty] = useState(false);
  const [dueAt, setDueAt] = useState("");
  const [composerMovieRefs, setComposerMovieRefs] = useState<readonly EntityRef[]>([]);
  // Photos dropped beside the entry box. They are already uploaded by the time
  // they sit here; saving the entry is what links them to the record.
  const [composerShots, setComposerShots] = useState<readonly AssetLink[]>([]);
  const composerShotsRef = useRef(composerShots);
  composerShotsRef.current = composerShots;
  const setComposerShotsTracked: Dispatch<SetStateAction<readonly AssetLink[]>> = (update) => {
    const next = typeof update === "function" ? update(composerShotsRef.current) : update;
    composerShotsRef.current = next;
    setComposerShots(next);
  };
  const [composerDraftOwner, setComposerDraftOwner] = useState<string | null>(null);
  const composerDraftWarningShown = useRef(false);
  const shotsDraftChecked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; tone: "ok" | "warn"; undo?: () => void } | null>(null);
  /** Held outside React state so clearing a toast can cancel its own timer. A
   *  toast that outlives its welcome leaves a dead "撤销" on screen. */
  const toastTimer = useRef<number | null>(null);
  const [authState, setAuthState] = useState<AuthState>({ required: true, authenticated: false });
  if (summaryWriteRef.current.owner !== (authState.account?.tenantId ?? "local")) { summaryWriteRef.current = { owner: authState.account?.tenantId ?? "local", epoch: 0, dates: new Map() }; setSummaries([]); }
  const [authBootstrapPhase, setAuthBootstrapPhase] = useState<AuthBootstrapPhase>("checking");
  const [authBootstrapAttempt, setAuthBootstrapAttempt] = useState(0);
  const authResolved = authBootstrapPhase === "ready";
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [aiStatusState, setAiStatusState] = useState<AiStatusState>({ phase: "loading", status: null });
  const [aiStatusRetry, setAiStatusRetry] = useState(0);
  // Outside the settings write path, AI affordances may use this display
  // fallback. The settings cards receive `aiStatusState` and therefore never
  // mistake it for a confirmed server configuration.
  const aiStatus = aiStatusState.status ?? { preset: "quick", enabled: true, configured: false, keyConfigured: false, keyUnreadable: false, provider: "deepseek", model: "deepseek-flash", baseUrl: AI_DEFAULT_BASE_URL, thinking: false, reasoningEffort: null, keySource: "none", summaryPrompt: SUMMARY_SYSTEM_PROMPT, summaryPromptCustom: false } as const;
  const [assistantVisible, setAssistantVisible] = useState(readAssistantVisibility);
  const contentColumnRef = useRef<HTMLDivElement>(null);
  const [weatherProfilesState, setWeatherProfilesState] = useState<WeatherProfilesState>({ phase: "loading", status: null });
  const [weatherProfilesRetry, setWeatherProfilesRetry] = useState(0);
  const weatherStatus = weatherProfilesState.status?.status ?? null;
  const [movieStatusState, setMovieStatusState] = useState<MovieModuleStatusState>({ phase: "loading", status: null });
  const [movieStatusRetry, setMovieStatusRetry] = useState(0);
  // Other parts of the app can hide optional movie affordances until the first
  // successful read. The settings card receives the source state separately
  // and never treats this display fallback as a persisted configuration.
  const movieStatus = movieStatusState.status ?? DEFAULT_MOVIE_MODULE_STATUS;
  const [backupStatusState, setBackupStatusState] = useState<BackupStatusState>({ phase: "loading", status: null });
  const [backupStatusRetry, setBackupStatusRetry] = useState(0);
  const backupAccountRef = useRef<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<RecordView | null>(null);
  const [recordEditDraft, setRecordEditDraft] = useState<RecordEditorDraft | null>(null);
  const recordEditDraftRef = useRef(recordEditDraft);
  recordEditDraftRef.current = recordEditDraft;
  const setRecordEditDraftTracked: Dispatch<SetStateAction<RecordEditorDraft | null>> = (update) => {
    const next = typeof update === "function" ? update(recordEditDraftRef.current) : update;
    recordEditDraftRef.current = next;
    setRecordEditDraft(next);
  };
  const shotSubmissionStatesRef = useRef(new Map<string, "active" | "failed">());
  const reportShotSubmissionState = useCallback((scope: string, state: "active" | "failed" | null) => {
    if (state === null) shotSubmissionStatesRef.current.delete(scope);
    else shotSubmissionStatesRef.current.set(scope, state);
  }, []);
  const [noteEditMeta, setNoteEditMeta] = useState<NoteEditMeta | null>(null);
  const composerOpenBeforeRecordEdit = useRef(false);
  const recordEditView = useRef<AppView | null>(null);
  const [entityCard, setEntityCard] = useState<Entity | null>(null);
  const [entityCardVersion, setEntityCardVersion] = useState(0);
  const [recordPeek, setRecordPeek] = useState<RecordPeekRequest | null>(null);
  useEffect(() => { setRecordPeek(null); setEntityCard(null); }, [authState.account?.tenantId, authState.authenticated]);
  const [avatarEntity, setAvatarEntity] = useState<Entity | null>(null);
  useEffect(() => setAvatarEntity(null), [authState.account?.tenantId]);
  const [editingEntity, setEditingEntity] = useState<Entity | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editReloading, setEditReloading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteRecord, setDeleteRecord] = useState<RecordView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [recordsReload, setRecordsReload] = useState(0);
  const [recordsErrorQueryPath, setRecordsErrorQueryPath] = useState<string | null>(null);
  const [tasksReload, setTasksReload] = useState(0);
  const [entities, setEntities] = useState<readonly Entity[]>([]);
  const [assets, setAssets] = useState<readonly Asset[]>([]);
  // The draft check must not run against an asset list that has not arrived
  // yet, or every restored photo would look stale.
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [relationReload, setRelationReload] = useState(0);
  const [cycleModuleReload, setCycleModuleReload] = useState(0);
  const [demoCount, setDemoCount] = useState(0);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoDeleteArmed, setDemoDeleteArmed] = useState(false);
  const [hideDemo, setHideDemo] = useState(() => window.localStorage.getItem(DEMO_HIDDEN_STORAGE_KEY) === "1");
  const [moviePromptHidden, setMoviePromptHidden] = useState(() => window.localStorage.getItem(MOVIE_PROMPT_HIDDEN_STORAGE_KEY) === "1");
  const [uiFont, setUiFont] = useState<UiFontId>(readUiFont);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordsRef = useRef<readonly RecordView[]>([]);
  const recordsLoadedRef = useRef(false);
  const authRef = useRef<AuthState>({ required: true, authenticated: false });
  const recordsRequestRef = useRef(0);
  const recordsCacheRef = useRef(new Map<string, { readonly items: readonly RecordView[]; readonly selectedDate: string }>());
  const patchedTaskQuery = useRef<string | null>(null);
  const currentQueryPath = useRef("");
  const recordsPrefetchRef = useRef(new Map<string, AbortController>());
  const recordsCacheGenerationRef = useRef(0);
  const tasksRequestRef = useRef(0);
  const previousSettingsPageRef = useRef(settingsPage);

  const openSettingsPage = useCallback((page: SettingsPageId, root = false) => {
    const nextHash = settingsHash(page);
    if (window.location.hash !== nextHash) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
    setSettingsPage(page);
    setSettingsMobileEntry((current) => ({ root, version: current.version + 1 }));
    setActiveView("settings");
    setMobileMenuOpen(false);
  }, []);

  useEffect(() => {
    let wasSettingsHash = window.location.hash.startsWith("#settings");
    const syncSettingsHash = () => {
      if (!window.location.hash.startsWith("#settings")) {
        if (wasSettingsHash) setActiveView("today");
        wasSettingsHash = false;
        return;
      }
      wasSettingsHash = true;
      const nextPage = readSettingsPageFromHash();
      const nextHash = settingsHash(nextPage);
      if (window.location.hash !== nextHash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
      setSettingsPage(nextPage);
      setSettingsMobileEntry((current) => ({ root: false, version: current.version + 1 }));
      setActiveView("settings");
    };
    syncSettingsHash();
    window.addEventListener("hashchange", syncSettingsHash);
    window.addEventListener("popstate", syncSettingsHash);
    return () => { window.removeEventListener("hashchange", syncSettingsHash); window.removeEventListener("popstate", syncSettingsHash); };
  }, []);

  useEffect(() => {
    const previousPage = previousSettingsPageRef.current;
    previousSettingsPageRef.current = settingsPage;
    if (settingsPage === "integrations/movie" && previousPage !== settingsPage) {
      // Revalidate the module status when returning to its settings page. This
      // gives the last confirmed value a real refresh-failure path to fall back
      // to, while leaving the manual retry button available for failures.
      setMovieStatusRetry((current) => current + 1);
    }
    if (settingsPage === "integrations/ai" && previousPage !== settingsPage) setAiStatusRetry((current) => current + 1);
    if (settingsPage === "integrations/weather" && previousPage !== settingsPage) setWeatherProfilesRetry((current) => current + 1);
  }, [settingsPage]);

  const setAssistantVisibility = useCallback((visible: boolean) => {
    setAssistantVisible(visible);
    try { window.localStorage.setItem(AI_ASSISTANT_VISIBLE_STORAGE_KEY, visible ? "1" : "0"); } catch { /* local persistence is optional */ }
  }, []);

  const askSearchAssistant = useCallback(() => {
    setAssistantVisibility(true);
    window.dispatchEvent(new CustomEvent("lifeos:open-ai", { detail: { focusInput: true } }));
  }, [setAssistantVisibility]);

  const onMovieStatusChange = useCallback((status: MovieModuleStatus) => {
    // Only a successful config save reaches this callback; its response is the
    // new server-confirmed baseline for the toggle.
    setMovieStatusState({ phase: "ready", status });
  }, []);

  const retryMovieStatus = useCallback(() => {
    setMovieStatusState((current) => ({ phase: "loading", status: current.status }));
    setMovieStatusRetry((current) => current + 1);
  }, []);

  const onAiStatusChange = useCallback((status: AiStatus) => {
    // Config save/reset returns the only value that may become the next
    // persistence baseline.
    setAiStatusState({ phase: "ready", status });
  }, []);

  const retryAiStatus = useCallback(() => {
    setAiStatusState((current) => ({ phase: "loading", status: current.status }));
    setAiStatusRetry((current) => current + 1);
  }, []);

  const onWeatherStatusChange = useCallback((status: WeatherStatus) => {
    // The default-config route returns only status. It can advance a confirmed
    // profile baseline, but it must not manufacture a writable profile list
    // after a read failure.
    setWeatherProfilesState((current) => current.status === null
      ? current
      : { phase: "ready", status: { ...current.status, status } });
  }, []);

  const retryWeatherProfiles = useCallback(() => {
    setWeatherProfilesState((current) => ({ phase: "loading", status: current.status }));
    setWeatherProfilesRetry((current) => current + 1);
  }, []);

  const retryBackupStatus = useCallback(() => {
    setBackupStatusState((current) => ({ phase: "loading", status: current.status }));
    setBackupStatusRetry((current) => current + 1);
  }, []);

  useEffect(() => {
    const option = UI_FONT_OPTIONS.find((candidate) => candidate.id === uiFont) ?? UI_FONT_OPTIONS[0];
    document.documentElement.dataset.lifeosFont = option.id;
    document.documentElement.style.setProperty("--lifeos-ui-font", option.stack);
    window.localStorage.setItem(UI_FONT_STORAGE_KEY, option.id);
  }, [uiFont]);

  const calendarRange = useMemo(
    // Week mode also needs last week: PC 周历下方有「上一周」预览，查询窗口必须比画布宽。
    () => (calendarMode === "week"
      ? [...datesOfWeek(shiftDate(selectedDate, -7)), ...datesOfWeek(selectedDate)]
      : monthGridDates(selectedDate)),
    [calendarMode, selectedDate],
  );

  const queryPath = useMemo(() => {
    const params = new URLSearchParams({ timeZone: USER_TIME_ZONE });
    if (searchQuery) params.set("q", searchQuery);
    if (searchActive) searchFilterParams(searchFilters, params);
    if (activeView === "tasks") {
      // Keep task-page scope at the request boundary, including both exact and
      // near-match search requests. The sidebar/calendar task query is separate.
      params.set("kind", "task");
      if (taskPageFilter === "incomplete") {
        const incomplete = ["todo", "in_progress"] as const;
        const allowed = searchFilters.statuses.length
          ? incomplete.filter((status) => searchFilters.statuses.includes(status))
          : incomplete;
        if (allowed.length) {
          params.delete("status");
          params.set("statuses", allowed.join(","));
        } else {
          // The legacy singular status and plural search statuses are intersected
          // by the API. Their deliberately conflicting values encode empty set.
          params.set("status", "todo");
          params.set("statuses", "done,cancelled");
        }
      }
    }
    if (!searchActive) {
      if (activeView === "today") params.set("to", todayDate);
      if (activeView === "calendar") {
        params.set("calendar", "1");
        // The month grid is always six weeks, so the cells spilling in from the
        // neighbouring months are populated by the same request.
        params.set("from", calendarRange[0] ?? selectedDate);
        params.set("to", calendarRange[calendarRange.length - 1] ?? selectedDate);
      }
      if (activeView === "notes") params.set("kind", "note");
    }
    return `/api/records?${params.toString()}`;
  }, [activeView, searchQuery, searchActive, searchFilters, taskPageFilter, selectedDate, calendarRange, todayDate]);
  currentQueryPath.current = queryPath;

  const invalidateRecordsCache = useCallback(() => {
    recordsCacheGenerationRef.current += 1;
    recordsCacheRef.current.clear();
    for (const controller of recordsPrefetchRef.current.values()) controller.abort();
    recordsPrefetchRef.current.clear();
  }, []);

  const reloadRecords = useCallback(() => {
    // A mutation must invalidate both cached dates and the in-flight request
    // generation. The effect below starts the replacement request and owns its
    // loading state, so an old finally() cannot leave the UI stuck as busy.
    invalidateRecordsCache();
    recordsRequestRef.current += 1;
    // Mark the visible payload stale in the same render as the invalidation.
    // Otherwise a mutation can leave one frame where old records are still
    // actionable before the replacement effect flips loading on.
    setRecordsQueryPath(null);
    setRecordsReload((current) => current + 1);
  }, [invalidateRecordsCache]);

  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState !== "visible") return;
      invalidateRecordsCache();
      setRecordsRevalidation(n => n + 1);
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => { window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", revalidate); };
  }, [invalidateRecordsCache]);

  const cachedRecordsForQuery = recordsCacheRef.current.get(queryPath);
  const recordsForQuery = cachedRecordsForQuery?.items ?? records;
  const recordsForQueryPath = cachedRecordsForQuery === undefined ? recordsQueryPath : queryPath;
  const recordsForQueryDate = cachedRecordsForQuery?.selectedDate ?? recordsDisplayedDate ?? selectedDate;
  const recordsErrorForQuery = recordsErrorQueryPath === queryPath ? recordsError : null;
  const recordsAreCurrent = recordsForQueryPath === queryPath;
  const recordsRefreshing = recordsLoading && recordsForQuery !== null;
  const recordsInitialLoading = recordsLoading && recordsForQuery === null;
  const recordsTargetRefreshing = recordsRefreshing || (!recordsAreCurrent && recordsForQuery !== null);
  const recordsInteractionEnabled = recordsAreCurrent && !recordsRefreshing && recordsErrorForQuery === null;

  const handleRequestError = useCallback((error: unknown, fallback: string): string => {
    if (errorStatus(error) === 401) {
      invalidateRecordsCache();
      const nextAuth = loggedOutAuth(authRef.current);
      authRef.current = nextAuth;
      setRecords(null);
      setRecordsQueryPath(null);
      setRecordsDisplayedDate(null);
      setRecordsErrorQueryPath(null);
      setTasks(null);
      recordsRef.current = [];
      setAuthState(nextAuth);
    }
    return errorMessage(error, fallback);
  }, [invalidateRecordsCache]);

  const retryAuthBootstrap = () => {
    setAuthBootstrapPhase("checking");
    setAuthError(null);
    setAuthBootstrapAttempt((current) => current + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    setAuthBootstrapPhase("checking");
    apiRequest<AuthState>("/api/auth", { signal: controller.signal }).then((state) => {
      if (controller.signal.aborted) return;
      authRef.current = state;
      setAuthState(state);
      setAuthBootstrapPhase("ready");
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (errorStatus(error) === 401) {
        const nextAuth = loggedOutAuth(authRef.current);
        authRef.current = nextAuth;
        setAuthState(nextAuth);
        setAuthBootstrapPhase("ready");
        return;
      }
      // A connection/server failure does not confirm that the person is logged out.
      // Keep protected views closed until a retry establishes the session state.
      setAuthBootstrapPhase("unavailable");
    });
    return () => controller.abort();
  }, [authBootstrapAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setAiStatusState({ phase: "failed", status: null, error: "登录后才能读取 AI 状态" });
      return () => controller.abort();
    }
    setAiStatusState((current) => ({ phase: "loading", status: current.status }));
    apiRequest<AiStatus>("/api/ai/status", { signal: controller.signal }).then((status) => {
      if (!controller.signal.aborted) setAiStatusState({ phase: "ready", status });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (errorStatus(error) === 401) {
        const nextAuth = loggedOutAuth(authRef.current);
        authRef.current = nextAuth;
        setAuthState(nextAuth);
        setAiStatusState({ phase: "failed", status: null, error: "需要重新登录后才能读取 AI 状态" });
        return;
      }
      setAiStatusState((current) => ({ phase: "failed", status: current.status, error: errorMessage(error, "AI 状态暂时无法读取，请重试") }));
    });
    return () => controller.abort();
  }, [authState.authenticated, authState.required, aiStatusRetry]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setMovieStatusState({ phase: "failed", status: null, error: "登录后才能读取观影状态" });
      return () => controller.abort();
    }
    setMovieStatusState((current) => ({ phase: "loading", status: current.status }));
    fetchMovieModuleStatus(controller.signal).then((status) => {
      if (!controller.signal.aborted) setMovieStatusState({ phase: "ready", status });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (errorStatus(error) === 401) {
        const nextAuth = loggedOutAuth(authRef.current);
        authRef.current = nextAuth;
        setAuthState(nextAuth);
        setMovieStatusState({ phase: "failed", status: null, error: "需要重新登录后才能读取观影状态" });
        return;
      }
      setMovieStatusState((current) => ({ phase: "failed", status: current.status, error: errorMessage(error, "观影状态暂时无法读取，请重试") }));
    });
    return () => controller.abort();
  }, [authState.authenticated, authState.required, movieStatusRetry]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setWeatherProfilesState({ phase: "failed", status: null, error: "登录后才能读取天气配置" });
      return () => controller.abort();
    }
    setWeatherProfilesState((current) => ({ phase: "loading", status: current.status }));
    apiRequest<WeatherProfilesResponse>("/api/weather/profiles", { signal: controller.signal }).then((payload) => {
      if (controller.signal.aborted) return;
      setWeatherProfilesState({ phase: "ready", status: payload });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (errorStatus(error) === 401) {
        const nextAuth = loggedOutAuth(authRef.current);
        authRef.current = nextAuth;
        setAuthState(nextAuth);
        setWeatherProfilesState({ phase: "failed", status: null, error: "需要重新登录后才能读取天气配置" });
        return;
      }
      setWeatherProfilesState((current) => ({ phase: "failed", status: current.status, error: errorMessage(error, "天气配置暂时无法读取，请重试") }));
    });
    return () => controller.abort();
  }, [authState.authenticated, authState.required, weatherProfilesRetry]);

  useEffect(() => {
    const controller = new AbortController();
    const accountId = authState.account?.id ?? null;
    const accountChanged = backupAccountRef.current !== accountId;
    backupAccountRef.current = accountId;
    if (authState.required && !authState.authenticated) {
      setBackupStatusState({ phase: "failed", status: null, error: "登录后才能读取备份状态" });
      return () => controller.abort();
    }
    setBackupStatusState((current) => ({ phase: "loading", status: accountChanged ? null : current.status }));
    apiRequest<BackupStatus>("/api/backup/status", { signal: controller.signal }).then((status) => {
      if (!controller.signal.aborted) setBackupStatusState({ phase: "ready", status });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (errorStatus(error) === 401) {
        const nextAuth = loggedOutAuth(authRef.current);
        authRef.current = nextAuth;
        setAuthState(nextAuth);
        setBackupStatusState({ phase: "failed", status: null, error: "需要重新登录后才能读取备份状态" });
        return;
      }
      setBackupStatusState((current) => ({ phase: "failed", status: current.status, error: errorMessage(error, "备份状态暂时无法读取，请重试") }));
    });
    return () => controller.abort();
  }, [authState.authenticated, authState.required, authState.account?.id, backupStatusRetry]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++recordsRequestRef.current;
    recordsCacheGenerationRef.current += 1;
    for (const prefetch of recordsPrefetchRef.current.values()) prefetch.abort();
    recordsPrefetchRef.current.clear();
    if (authState.required && !authState.authenticated) {
      setRecordsLoading(false);
      setRecords(null);
      setRecordsQueryPath(null);
      setRecordsDisplayedDate(null);
      setRecordsError(null);
      setRecordsErrorQueryPath(null);
      return () => controller.abort();
    }
    if (activeView === "settings") {
      setRecordsLoading(false);
      setRecords(null);
      setRecordsQueryPath(null);
      setRecordsDisplayedDate(null);
      setRecordsError(null);
      setRecordsErrorQueryPath(null);
      return () => controller.abort();
    }
    const cached = recordsCacheRef.current.get(queryPath);
    const keepPatchedTask = patchedTaskQuery.current === queryPath && cached !== undefined;
    patchedTaskQuery.current = null;
    if (cached !== undefined) {
      // The render path also reads this entry directly, while these state
      // updates make the cached key authoritative for actions and refs before
      // the background revalidation completes.
      setRecords(cached.items);
      setRecordsQueryPath(queryPath);
      setRecordsDisplayedDate(cached.selectedDate);
      if (activeView === "calendar") { setRecordsLoading(false); setRecordsError(null); setRecordsErrorQueryPath(null); return () => controller.abort(); }
    }
    // A confirmed status-only PATCH leaves this unfiltered list authoritative.
    // Revalidate quietly instead of disabling and repainting every other row.
    if (!keepPatchedTask) setRecordsLoading(true);
    setRecordsError(null);
    setRecordsErrorQueryPath(null);
    apiRequest<RecordsResponse>(queryPath, { signal: controller.signal }).then((payload) => {
      if (controller.signal.aborted || requestId !== recordsRequestRef.current) return;
      cacheRecords(recordsCacheRef.current, queryPath, { items: payload.items, selectedDate });
      setRecords(payload.items);
      setRecordsQueryPath(queryPath);
      setRecordsDisplayedDate(selectedDate);
      setRecordsError(null);
      setRecordsErrorQueryPath(null);

    }).catch((error) => {
      if (controller.signal.aborted || requestId !== recordsRequestRef.current) return;
      const message = handleRequestError(error, "请检查 API 服务是否已启动");
      setRecordsError(message);
      setRecordsErrorQueryPath(queryPath);
      if (!recordsLoadedRef.current && cached === undefined) setRecords(null);
    }).finally(() => {
      if (!controller.signal.aborted && requestId === recordsRequestRef.current) setRecordsLoading(false);
    });
    return () => controller.abort();
  }, [activeView, authState.authenticated, authState.required, handleRequestError, queryPath, recordsReload, recordsRevalidation, searchQuery]);

  useEffect(() => {
    recordsRef.current = recordsForQuery ?? [];
    recordsLoadedRef.current = recordsForQuery !== null;
  }, [recordsForQuery]);

  const calendarPresentations = useCalendarPresentations(
    authState.account?.tenantId ?? "local", calendarRange, todayDate, recordsReload, hideDemo,
    activeView === "calendar" && (!authState.required || authState.authenticated), handleRequestError,
  );

  // Editing uses the same visible month summaries. Entering or leaving edit mode
  // must not refetch an unchanged window and enqueue another AI generation.
  const summariesVisible = activeView === "calendar" && calendarMode === "month" && (calendarTextVisible || editMode);
  useEffect(() => {
    const controller = new AbortController();
    if (!summariesVisible || (authState.required && !authState.authenticated)) {
      if (authState.required && !authState.authenticated) setSummaries([]);
      return () => controller.abort();
    }
    const params = new URLSearchParams({
      from: calendarRange[0] ?? selectedDate,
      to: calendarRange[calendarRange.length - 1] ?? selectedDate,
      timeZone: USER_TIME_ZONE,
    });
    const readEpoch = summaryWriteRef.current.epoch;
    apiRequest<SummariesResponse>(`/api/summaries?${params.toString()}`, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSummaries(current => { const recent = current.filter(item => calendarRange.includes(item.date) && (summaryWriteRef.current.dates.get(item.date) ?? 0) > readEpoch); const changed = new Set(recent.map(item => item.date)); return [...current.filter(item => !calendarRange.includes(item.date)), ...payload.items.filter(item => !changed.has(item.date)), ...recent]; });
        setAiSummaries(payload.ai);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAiSummaries(false);
      });
    return () => controller.abort();
  }, [summariesVisible, calendarRange, selectedDate, todayDate, authState.authenticated, authState.required, recordsReload]);

  // Month cells read all weather rows in one range request. The API endpoint
  // only reads SQLite, so browsing history never causes one fetch per day.
  useEffect(() => {
    const controller = new AbortController();
    if (activeView !== "calendar" || (authState.required && !authState.authenticated) || weatherStatus?.configured !== true) {
      setWeatherArchive(new Map());
      return () => controller.abort();
    }
    const from = calendarRange[0] ?? selectedDate;
    const to = calendarRange[calendarRange.length - 1] ?? selectedDate;
    apiRequest<WeatherArchiveResponse>(`/api/weather/archive?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const next = new Map<string, CalendarWeather>();
        for (const item of payload.items) {
          const day = weatherFromArchiveValue(item.value, item.date);
          if (day !== undefined) next.set(item.date, day);
        }
        setWeatherArchive(next);
      })
      .catch(() => { if (!controller.signal.aborted) setWeatherArchive(new Map()); });
    return () => controller.abort();
  }, [activeView, calendarRange, selectedDate, authState.authenticated, authState.required, weatherStatus?.configured]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setCycleModule(null);
      return () => controller.abort();
    }
    apiRequest<CycleModuleResponse>("/api/modules/cycle-intimacy", { signal: controller.signal })
      .then((module) => { if (!controller.signal.aborted) setCycleModule(module); })
      .catch(() => { if (!controller.signal.aborted) setCycleModule(null); });
    return () => controller.abort();
  }, [authState.authenticated, authState.required, cycleModuleReload]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++tasksRequestRef.current;
    if (authState.required && !authState.authenticated) { setTasksLoading(false); return () => controller.abort(); }
    if (activeView === "settings") { setTasksLoading(false); setTasks([]); return () => controller.abort(); }
    setTasksLoading(true);
    setTasksError(null);
    apiRequest<RecordsResponse>(`/api/records?kind=task&timeZone=${encodeURIComponent(USER_TIME_ZONE)}`, { signal: controller.signal }).then((payload) => { if (!controller.signal.aborted && requestId === tasksRequestRef.current) setTasks(payload.items); }).catch((error) => { if (controller.signal.aborted || requestId !== tasksRequestRef.current) return; setTasks(null); setTasksError(handleRequestError(error, "请检查 API 服务是否已启动")); }).finally(() => { if (!controller.signal.aborted && requestId === tasksRequestRef.current) setTasksLoading(false); });
    return () => controller.abort();
  }, [activeView, authState.authenticated, authState.required, handleRequestError, tasksReload]);

  useEffect(() => registerWebMcp({ readRecords: ({ q }) => { if (!authRef.current.authenticated) throw new Error("请先登录 LifeOS"); return q ? recordsRef.current.filter((record) => recordText(record).toLocaleLowerCase().includes(q.toLocaleLowerCase())) : recordsRef.current; }, navigateTo: setActiveView }), []);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) { setEntities([]); setAssets([]); setDemoCount(0); return () => controller.abort(); }
    Promise.all([
      apiRequest<EntitiesResponse>("/api/entities", { signal: controller.signal }),
      apiRequest<AssetsResponse>("/api/assets", { signal: controller.signal }),
      apiRequest<RecordsResponse>(`/api/records?timeZone=${encodeURIComponent(USER_TIME_ZONE)}`, { signal: controller.signal }),
    ]).then(([entityPayload, assetPayload, demoPayload]) => {
      if (controller.signal.aborted) return;
      setEntities(entityPayload.items);
      setAssets(assetPayload.items);
      setAssetsLoaded(true);
      setDemoCount(demoPayload.items.filter(isDemoRecord).length);
    }).catch((error) => { if (!controller.signal.aborted) handleRequestError(error, "关联对象读取失败"); });
    return () => controller.abort();
  }, [authState.authenticated, authState.required, handleRequestError, relationReload]);

  // Occurred time follows "now" until the user touches the field, so a quick
  // record never asks for a time that has to be typed in by hand.
  useEffect(() => {
    if (occurredAtDirty) return;
    setOccurredAt(localNowInputFor(createDate));
    const timer = window.setInterval(() => setOccurredAt(localNowInputFor(createDate)), 15_000);
    return () => window.clearInterval(timer);
  }, [occurredAtDirty, createDate]);

  // Changing the writing date establishes the explicit home backfill choice.
  useEffect(() => setComposerBackfill(activeView === "today" && createDate < todayDate), [createDate]);

  const refresh = () => { reloadRecords(); setTasksReload((current) => current + 1); setRelationReload((current) => current + 1); setCycleModuleReload((current) => current + 1); };
  const collapseTaskComposer = () => {
    if (taskComposerExpanded) taskComposerRef.current?.dispatchEvent(new CustomEvent("lifeos:task-composer-collapse", { bubbles: true }));
    setTaskComposerExpanded(false);
  };
  const navigate = (view: AppView) => {
    if (view === "settings") { openSettingsPage(DEFAULT_SETTINGS_PAGE, true); return; }
    if (window.location.hash.startsWith("#settings")) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    if (activeView === "tasks" && view !== "tasks" && taskComposerExpanded) collapseTaskComposer();
    if (view === "tasks" && activeView !== "tasks") { setTaskPageFilter("incomplete"); setTaskComposerExpanded(false); }
    setActiveView(view === "timeline" ? "today" : view); setMobileMenuOpen(false); setSearchQuery(""); setSearchFilters(EMPTY_SEARCH_FILTERS); setSearchFiltersOpen(false); if (view === "tasks") setComposerKind("task");
    // A "just this once" grant belongs to the view it was given in.
    setPrivacyOneShot(false);
    if (view === "today" || view === "timeline") { setSelectedDate(todayDate); setFeedJumpVersion(current => current + 1); }
  };
  /**
   * Run one compiled command from the assistant.
   *
   * Only commands the server already validated arrive here: every id exists,
   * every date is real and not in the future, and the name is on the whitelist.
   * Nothing in this switch writes anything — P0 has no write command at all.
   */
  const runUiCommand = (command: UiCommand) => {
    // Any command means the owner is looking at what the assistant just said, so
    // the panel must stay in front. `entity.open` is the exception: it hands over
    // to the entity card on purpose and closes the assistant itself.
    if (command.type !== "entity.open") window.dispatchEvent(new Event("lifeos:open-ai"));
    switch (command.type) {
      case "search.records": {
        const params = command.params;
        setSearchQuery(params.query ?? "");
        setSearchFilters({
          ...EMPTY_SEARCH_FILTERS,
          ...(params.kinds === undefined ? {} : { kinds: [...params.kinds] }),
          ...(params.personIds === undefined ? {} : { personIds: [...params.personIds] }),
          ...(params.placeIds === undefined ? {} : { placeIds: [...params.placeIds] }),
          ...(params.entityIds === undefined ? {} : { entityIds: [...params.entityIds] }),
          ...(params.statuses === undefined ? {} : { statuses: [...params.statuses] }),
          ...(params.attachments === undefined ? {} : { attachments: [...params.attachments] }),
          ...(params.entityTypes === undefined ? {} : { entityTypes: [...params.entityTypes] }),
          ...(params.backfill === undefined ? {} : { backfill: params.backfill }),
          ...(params.assisted === true ? { assisted: true } : {}),
          from: params.from ?? "",
          to: params.to ?? "",
        });
        setActiveView("today");
        setUiPrivacyCheck(true);
        break;
      }
      case "view.goto": navigate(command.params.view); break;
      case "date.goto": setSelectedDate(command.params.date); break;
      case "entity.open": {
        const entity = entities.find((item) => item.id === command.params.entityId);
        if (entity === undefined) return;
        setEntityCard(entity);
        window.dispatchEvent(new Event("lifeos:close-ai"));
        break;
      }
      case "record.focus": setUiFocusRecordId(command.params.recordId); break;
      case "privacy.requestAccess": setPrivacyRequest({ reason: command.params.reason }); break;
    }
  };
  /**
   * Navigation runs before filtering, and focusing runs last.
   *
   * `navigate` clears the filter — that is how the sidebar has always worked — so
   * a plan saying "filter to 姐姐's entries and show me today" must not run in the
   * order the model happened to write it, or the filter is wiped a moment after
   * it is applied.
   */
  const runUiPlan = (plan: UiTurnPlan) => {
    const rank = (command: UiCommand) => command.type === "search.records" ? 1 : command.type === "record.focus" ? 2 : 0;
    for (const command of [...(plan.commands ?? [])].sort((left, right) => rank(left) - rank(right))) runUiCommand(command);
  };
  /**
   * A calendar cell is a way back into the day it stands for — except while the
   * cycle panel is open. There a cell only picks the date a private record
   * lands on, so the panel and the grid stay in front of you.
   */
  const openDay = (date: string) => {
    if (activeView === "calendar" && calendarMode === "month" && !cyclePanelOpen) { setCalendarDay(date); return; }
    setSelectedDate(date);
    if (cyclePanelOpen) return;
    setActiveView("today");
    setMobileMenuOpen(false);
    setFeedJumpVersion(current => current + 1);
  };
  /**
   * One line of feedback, bottom right. With an `undo` it also carries a way
   * back: clearing a hand of photos is a single tap, so the tap has to be
   * reversible for as long as the toast is up. An undoable toast stays longer
   * than a plain one — the point of it is to be caught, not just noticed.
   */
  const showToast = (message: string, tone: "ok" | "warn" = "ok", undo?: () => void) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setActionMessage({ text: message, tone, ...(undo === undefined ? {} : { undo }) });
    toastTimer.current = window.setTimeout(() => { setActionMessage(null); toastTimer.current = null; }, undo !== undefined ? 6000 : tone === "warn" ? 3600 : 2600);
  };
  const dismissToast = () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); toastTimer.current = null; setActionMessage(null); };

  /**
   * The drop zone already emptied itself; this only says so, and holds the undo.
   * The photos are assets on disk, so putting them back is a list operation, not
   * a re-upload — which is exactly why the clear can be this casual.
   */
  const handleShotsCleared = (cleared: readonly AssetLink[], restore: () => boolean, cancelledPending: number) => showToast(`已清空 ${cleared.length} 张照片${cancelledPending > 0 ? `，取消待处理${cancelledPending}张` : ""}`, "ok", () => { if (restore()) showToast(`已恢复 ${cleared.length} 张照片`); });

  const draftScope = composerDraftScope(authResolved, authState);
  const deletions = useRecordDeletions(draftScope, {
    onFinished: record => { setRecords(current => current?.filter(item => item.id !== record.id) ?? null); setTasks(current => current?.filter(item => item.id !== record.id) ?? null); refresh(); },
    onRestored: (record, entry) => { if (entry.query === queryPath) setRecords(current => { if (!current) return current; const next = current.filter(item => item.id !== record.id); next.splice(Math.max(0, Math.min(entry.index, next.length)), 0, record); return next; }); refresh(); },
    onError: message => showToast(message, "warn"),
  });
  const deletionContext = useMemo(() => ({ entries: deletions.entries, undo: deletions.undo }), [deletions.entries, deletions.undo]);
  const createShotScopeKey = `create:${draftScope ?? "unresolved"}:${activeView}:${createDate}:${composerKind}`;
  const editShotScopeKey = `edit:${editingRecord?.id ?? "none"}`;

  // Never hydrate a previous account's text or photos into the next account.
  // Legacy installations migrate only their old photo-only draft.
  useEffect(() => {
    if (draftScope === null) {
      setComposerDraftOwner(null);
      setComposerContent("");
      setComposerEntityMentions([]);
      setComposerShotsTracked([]);
      return;
    }
    const saved = readComposerDraft(draftScope);
    const legacyShots = draftScope === "legacy" && saved === null ? readComposerShotsDraft() : [];
    setComposerContent(saved?.content ?? "");
    setComposerEntityMentions(saved?.entityMentions ?? []);
    setComposerKind(saved?.kind ?? "journal");
    setComposerPrivate(saved?.isPrivate ?? false);
    setComposerShotsTracked(saved?.shots ?? legacyShots);
    shotsDraftChecked.current = false;
    setComposerDraftOwner(draftScope);
    if (saved?.content) showToast(saved.kind === "event" || saved.kind === "note" ? `已恢复${saved.kind === "event" ? "事件" : "笔记"}草稿，可继续保存或切换类型` : "已恢复上次没发出的正文草稿");
  }, [draftScope]);

  useEffect(() => {
    if (draftScope === null || composerDraftOwner !== draftScope) return;
    const saved = writeComposerDraft(draftScope, {
      content: composerContent, kind: composerKind, isPrivate: composerPrivate, shots: composerShots, entityMentions: composerEntityMentions,
    });
    if (saved && draftScope === "legacy") window.localStorage.removeItem(COMPOSER_SHOTS_STORAGE_KEY);
    if (!saved && !composerDraftWarningShown.current) {
      composerDraftWarningShown.current = true;
      showToast("浏览器无法保存草稿；请先复制正文再离开页面", "warn");
    }
  }, [draftScope, composerDraftOwner, composerContent, composerKind, composerPrivate, composerShots, composerEntityMentions]);

  // A restored draft can name an asset the collector already took away. Check
  // it once against the real asset list rather than rendering a broken
  // thumbnail forever, and say what happened.
  useEffect(() => {
    if (draftScope === null || composerDraftOwner !== draftScope) return;
    if (shotsDraftChecked.current) return;
    if (composerShots.length === 0) { shotsDraftChecked.current = true; return; }
    if (!assetsLoaded) return;
    shotsDraftChecked.current = true;
    const live = new Set(assets.map((asset) => asset.id));
    const kept = composerShots.filter((shot) => live.has(shot.assetId));
    const dropped = composerShots.length - kept.length;
    if (dropped === 0) { showToast(`已恢复上次没发出的 ${kept.length} 张照片`); return; }
    setComposerShotsTracked(kept);
    showToast(kept.length === 0 ? `草稿里 ${dropped} 张照片已被清理，已从投放区移除` : `草稿里 ${dropped} 张照片已被清理，保留剩下 ${kept.length} 张`);
  }, [assets, assetsLoaded, composerShots, composerDraftOwner, draftScope, showToast]);
  const rememberMovieEntity = (movie: MovieEntity) => {
    setEntities((current) => {
      const next = current.filter((item) => item.id !== movie.id);
      return [...next, asCoreEntity(movie)];
    });
  };
  const suppressMoviePrompt = () => {
    window.localStorage.setItem(MOVIE_PROMPT_HIDDEN_STORAGE_KEY, "1");
    setMoviePromptHidden(true);
    showToast("已关闭“电影”提示");
  };
  const attachMovieToRecord = async (record: RecordView, movie: MovieEntity) => {
    const movieEntityRef = movieRef(movie) as unknown as EntityRef;
    const patchRecord = (current: RecordView) => apiRequest<RecordView>(`/api/records/${encodeURIComponent(current.id)}`, { method: "PATCH", body: JSON.stringify({ revision: current.revision, entityRefs: [...current.entityRefs.filter((ref) => !isMovieRef(ref)), movieEntityRef] }) });
    try {
      let updated: RecordView;
      try {
        updated = await patchRecord(record);
      } catch (cause) {
        if (errorStatus(cause) !== 409) throw cause;
        const latestPayload = await apiRequest<RecordsResponse>(`/api/records?timeZone=${encodeURIComponent(USER_TIME_ZONE)}`);
        const latest = latestPayload.items.find((item) => item.id === record.id);
        if (!latest) throw new Error("找不到这条记录的最新版本，请刷新后重试");
        updated = await patchRecord(latest);
      }
      rememberMovieEntity(movie);
      reloadRecords();
      setRecords((current) => current === null ? current : current.map((item) => item.id === updated.id ? updated : item));
      showToast("影片已添加到记录");
    } catch (error) {
      showToast(handleRequestError(error, "影片关联失败，请稍后重试"), "warn");
    }
  };
  const handleBackup = async (action: "local" | "s3" | "test" | "dual") => {
    if (backupBusy || backupStatusState.phase !== "ready") return;
    setBackupBusy(true);
    try {
      const path = action === "local" ? "/api/backup/local" : action === "s3" ? "/api/backup/s3" : action === "dual" ? "/api/backup/dual" : "/api/backup/s3/test";
      const result = await apiRequest<{ ok: boolean; fileName?: string; location?: string; transport?: "http" | "file"; warning?: string; status?: "success" | "partial" | "local_only" | "failed"; s3?: { status?: "success" | "failed" | "skipped"; error?: string; location?: string } }> (path, { method: "POST", body: "{}" });
      setBackupStatusState({ phase: "ready", status: await apiRequest<BackupStatus>("/api/backup/status") });
      const remoteWroteLocally = result.transport === "file" || result.location?.startsWith("file:") === true || result.s3?.location?.startsWith("file:") === true;
      showToast(action === "test"
        ? remoteWroteLocally ? "连接测试只写入了本机目录，未联网 —— 请检查 Endpoint" : "对象存储连接成功"
        : action === "s3"
          ? remoteWroteLocally ? `只写入本机目录，未联网${result.fileName ? `：${result.fileName}` : ""}` : `已上传对象存储${result.fileName ? `：${result.fileName}` : ""}`
          : action === "dual"
            ? result.status === "success" ? remoteWroteLocally ? "双备份已完成，但远端只写入了本机目录" : "双备份已完成" : result.status === "local_only" ? "本地备份已完成，远端已跳过" : result.status === "partial" ? "本地备份已完成，但远端失败" : "本地备份失败"
            : "本地备份已完成");
    } catch (error) {
      try { setBackupStatusState({ phase: "ready", status: await apiRequest<BackupStatus>("/api/backup/status") }); }
      catch (readError) { setBackupStatusState((current) => ({ phase: "failed", status: current.status, error: errorMessage(readError, "备份状态暂时无法读取，请重试") })); }
      showToast(handleRequestError(error, action === "test" ? "对象存储连接失败" : action === "dual" ? "双备份失败，请查看本地结果" : "备份失败，请检查配置"), "warn");
    } finally {
      setBackupBusy(false);
    }
  };
  const saveCycleModuleConfig = async (config: CycleIntimacyModuleConfig) => {
    const module = await apiRequest<CycleModuleResponse>("/api/modules/cycle-intimacy/config", {
      method: "PUT",
      body: JSON.stringify({ ...config, anchorStart: config.anchorStart ?? null }),
    });
    setCycleModule(module);
    showToast(config.enabled ? "周期设置已保存" : "周期已关闭，记录仍被保留");
  };
  const reloadCycleModule = async (): Promise<CycleModuleResponse> => {
    const module = await apiRequest<CycleModuleResponse>("/api/modules/cycle-intimacy");
    setCycleModule(module);
    return module;
  };
  const saveMobileCycleDay = async (date: string, kinds: readonly MobileCycleEventKind[], revision: string): Promise<CycleDayEditResponse> => {
    const result = await apiRequest<CycleDayEditResponse>("/api/modules/cycle-intimacy/day-edit", {
      method: "POST",
      body: JSON.stringify({ date, kinds, revision }),
    });
    setCycleModule({ ...result.module, eventRevision: result.eventRevision });
    return result;
  };
  const undoMobileCycleDay = async (token: string): Promise<CycleDayUndoResponse> => {
    const result = await apiRequest<CycleDayUndoResponse>("/api/modules/cycle-intimacy/day-edit/undo", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    setCycleModule({ ...result.module, eventRevision: result.eventRevision });
    return result;
  };
  /** How long a run lasts is the one number she tunes from the calendar itself. */
  const habitActions = {
    save: async (habit: CustomHabit | null, name: string, icon: string) => {
      const owner = summaryWriteRef.current.owner;
      const module = await apiRequest<CycleModuleResponse>(habit ? "/api/modules/cycle-intimacy/habits/" + habit.id : "/api/modules/cycle-intimacy/habits", { method: habit ? "PATCH" : "POST", body: JSON.stringify({ name, icon, ...(habit ? { revision: habit.revision } : {}) }) });
      if (summaryWriteRef.current.owner !== owner) return;
      setCycleModule(module); showToast(habit ? "习惯已更新" : "习惯已添加");
    },
    mark: async (habit: CustomHabit, date: string, marked: boolean) => {
      const owner = summaryWriteRef.current.owner;
      try {
        const module = await apiRequest<CycleModuleResponse>("/api/modules/cycle-intimacy/habits/" + habit.id + "/days", { method: "PUT", body: JSON.stringify({ date, marked, revision: habit.revision }) });
        if (summaryWriteRef.current.owner !== owner) return;
        setCycleModule(module); showToast(marked ? "习惯已标记完成" : "习惯标记已移除");
      } catch (error) {
        if (summaryWriteRef.current.owner === owner) await reloadCycleModule();
        throw error;
      }
    },
  };
  const saveCyclePeriodLength = async (periodLength: number) => {
    if (!cycleModule) return;
    await saveCycleModuleConfig({ ...cycleModule.config, periodLength });
  };
  const saveCycleLength = async (cycleLength: number) => {
    if (!cycleModule) return;
    await saveCycleModuleConfig({ ...cycleModule.config, cycleLength });
  };
  const addCycleModuleEvent = async (date: string, kind: CycleIntimacyEventKind) => {
    const module = await apiRequest<CycleModuleResponse>("/api/modules/cycle-intimacy/events", { method: "POST", body: JSON.stringify({ date, kind }) });
    setCycleModule(module);
    showToast("周期记录已保存");
  };
  const deleteCycleModuleEvent = async (id: string) => {
    const module = await apiRequest<CycleModuleResponse>(`/api/modules/cycle-intimacy/events/${encodeURIComponent(id)}`, { method: "DELETE" });
    setCycleModule(module);
    showToast("周期记录已移除");
  };
  /**
   * Leaving edit mode is not a way to lose work: unsaved text is written first, and
   * only then does the mode end. A save that fails keeps the mode — and the drafts —
   * up, so a dead network cannot pass for a clean exit.
   */
  const changeEditMode = async (value: boolean): Promise<boolean> => {
    if (value) { setEditMode(true); return true; }
    if (summarySaving) return false;
    if (summaryDrafts.size > 0 && !(await saveSummaryDrafts())) return false;
    setEditMode(false);
    return true;
  };
  /** The compact marker list takes over day taps, so finish summary editing first. */
  const toggleCalendarCyclePanel = async () => {
    if (!cyclePanelOpen && editMode) {
      if (!(await changeEditMode(false))) return;
    }
    if (!cyclePanelOpen) setSelectedDate(localDateToday());
    setCyclePanelOpen(!cyclePanelOpen);
  };
  /**
   * Neither of the calendar's two temporary tools is sticky — neither one is
   * written to storage, so a reload drops both. Clicking anywhere outside the
   * calendar drops them too (edit mode saves its drafts first), and so does
   * leaving for another view: these are things picked up for a moment, not a
   * mode the app sits in.
   */
  useEffect(() => {
    if (!editMode && !cyclePanelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target !== null && target.closest(".calendar-section") !== null) return;
      setCyclePanelOpen(false);
      if (editMode) void changeEditMode(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [editMode, cyclePanelOpen, summaryDrafts, summarySaving]);
  useEffect(() => {
    if (activeView === "calendar") return;
    setCyclePanelOpen(false);
    if (editMode) void changeEditMode(false);
  }, [activeView]);
  /** A week card has no summary line, so leaving the month grid also leaves edit mode. */
  const switchCalendarMode = (next: CalendarMode) => {
    setCalendarMode(next);
    try { window.localStorage.setItem(CALENDAR_MODE_STORAGE_KEY, next); } catch { /* Remembering the view is optional. */ }
    if (window.matchMedia("(max-width: 560px)").matches) setCyclePanelOpen(false);
    if (next !== "month" && editMode) void changeEditMode(false);
  };
  const editSummaryDraft = (date: string, text: string) => {
    if (!canEditDaySummary(date, localDateToday(), (records ?? []).filter(record => lifeTimeDate(record.occurredAt ?? record.createdAt) === date))) return;
    const stored = summaries.find((summary) => summary.date === date);
    const original = stored === undefined ? "" : trimSummaryText(stored.text, SUMMARY_MAX_LENGTH);
    setSummaryDrafts((current) => {
      const next = new Map(current);
      // Typing it back to what was already there is not a change, so it drops out of
      // the pending count instead of forcing a pointless write.
      if (text === original) next.delete(date);
      else next.set(date, text);
      return next;
    });
  };
  const applyManualSummaryResult = (payload: SummaryManualResponse) => {
    const dates = new Set([...payload.items.map(item => item.date), ...payload.cleared]);
    const epoch = ++summaryWriteRef.current.epoch;
    for (const date of dates) summaryWriteRef.current.dates.set(date, epoch);
    setSummaries(current => [...current.filter(item => !dates.has(item.date)), ...payload.items]);
  };
  const discardSummaryDrafts = () => setSummaryDrafts(new Map());
  /** Writes every pending draft in one request, and says whether the text landed. */
  const saveSummaryDrafts = async (): Promise<boolean> => {
    if (summarySaveBusyRef.current) return false;
    if (summaryDrafts.size === 0) return true;
    summarySaveBusyRef.current = true;
    const owner = summaryWriteRef.current.owner;
    setSummarySaving(true);
    const entries = [...summaryDrafts].map(([date, text]) => ({ date, text }));
    try {
      const payload = await apiRequest<SummaryManualResponse>("/api/summaries/manual", { method: "POST", body: JSON.stringify({ entries, timeZone: USER_TIME_ZONE }) });
      if (summaryWriteRef.current.owner !== owner) return false;
      applyManualSummaryResult(payload);
      setSummaryDrafts(current => { const next = new Map(current); for (const { date, text } of entries) if (next.get(date) === text) next.delete(date); return next; });
      showToast(entries.length === 1 ? "小结已保存" : `已保存 ${entries.length} 天的小结`);
      return true;
    } catch (error) {
      // The drafts stay put: a failed save must not look like a successful one.
      showToast(handleRequestError(error, "小结保存失败，请重试"), "warn");
      return false;
    } finally {
      summarySaveBusyRef.current = false;
      setSummarySaving(false);
    }
  };
  /** Regenerating replaces whatever text is there, including text the owner typed. */
  const regenerateDaySummary = async (date: string) => {
    setSummaryBusyDate(date);
    try {
      const payload = await apiRequest<SummariesResponse>("/api/summaries/regenerate", { method: "POST", body: JSON.stringify({ date, timeZone: USER_TIME_ZONE }) });
      const updated = payload.items[0];
      if (updated !== undefined) setSummaries((current) => [...current.filter((item) => item.date !== date), updated]);
      setSummaryDrafts((current) => { const next = new Map(current); next.delete(date); return next; });
      showToast(`${displayDate(date)} 的小结已重新生成`);
    } catch (error) {
      showToast(handleRequestError(error, "重新生成失败，请重试"), "warn");
    } finally {
      setSummaryBusyDate(null);
    }
  };
  /** Restoring hands the day back to the automatic summary. */
  const revertDaySummary = async (date: string) => {
    setSummaryBusyDate(date);
    try {
      const payload = await apiRequest<SummaryManualResponse>("/api/summaries/manual", { method: "POST", body: JSON.stringify({ entries: [{ date, text: "" }], timeZone: USER_TIME_ZONE }) });
      applyManualSummaryResult(payload);
      setSummaryDrafts((current) => { const next = new Map(current); next.delete(date); return next; });
      showToast(`${displayDate(date)} 的小结已恢复原样`);
    } catch (error) {
      showToast(handleRequestError(error, "恢复原样失败，请重试"), "warn");
    } finally {
      setSummaryBusyDate(null);
    }
  };

  useEffect(() => { installDiagnostics(); }, []);
  useEffect(() => installDialogDismiss(), []);

  const handleCreateEntity = async (type: EntityKind, name: string, extras?: { readonly aliases?: readonly string[]; readonly role?: PlaceRole; readonly period?: PlacePeriod; readonly address?: string } & PlaceDetails): Promise<Entity | null> => {
    try {
      const payloadBody = {
        ...extras,
        type,
        name,
        ...(extras?.aliases === undefined ? {} : { aliases: extras.aliases }),
        ...(type === "place" && extras?.role !== undefined ? { role: extras.role } : {}),
        ...(type === "place" && extras?.period !== undefined ? { period: extras.period } : {}),
        ...(type === "place" && extras?.address !== undefined ? { address: extras.address } : {}),
      };
      const entity = await apiRequest<Entity>("/api/entities", { method: "POST", body: JSON.stringify(payloadBody) });
      setEntities((current) => [...current.filter(item => item.id !== entity.id), entity]);
      showToast(`已新建${ENTITY_META[type].label}「${name}」`);
      return entity;
    } catch (error) {
      showToast(handleRequestError(error, "新建关联对象失败，请重试"), "warn");
      return null;
    }
  };
  const handleToggleContactStar = async (entity: Entity): Promise<void> => {
    if (entity.type !== "person") return;
    try {
      const updated = await apiRequest<Entity>(`/api/entities/${encodeURIComponent(entity.id)}`, { method: "PATCH", body: JSON.stringify({ isImportant: entity.isImportant !== true }) });
      setEntities(current => current.map(item => item.id === updated.id ? updated : item));
      setEntityCard(current => current?.id === updated.id ? updated : current);
    } catch (error) {
      showToast(handleRequestError(error, "收藏未能保存，请重试"), "warn");
      throw error;
    }
  };

  const handleSaveEntity = async (entity: Entity, patch: EntityEditPatch): Promise<Entity | null> => {
    try {
      const updated = await apiRequest<Entity>(`/api/entities/${encodeURIComponent(entity.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      setEntities((current) => current.map((item) => item.id === updated.id ? updated : item));
      refresh();
      const removedAliases = (entity.aliases ?? []).filter(alias => !(updated.aliases ?? []).includes(alias));
      const renamed = updated.type === "person" && updated.name !== entity.name;
      showToast(renamed ? `原名称“${entity.name}”已保留为别名，历史日记仍使用原称呼。` : `${updated.type === "place" ? "地点" : "联系人"}「${updated.name}」已更新`, "ok", removedAliases.length ? () => {
        void (async () => {
          try {
            const latest = await apiRequest<Entity>(`/api/entities/${encodeURIComponent(updated.id)}`);
            const restored = await apiRequest<Entity>(`/api/entities/${encodeURIComponent(updated.id)}`, { method: "PATCH", body: JSON.stringify({ aliases: [...new Set([...(latest.aliases ?? []), ...removedAliases])].filter(alias => alias !== latest.name) }) });
            setEntities(current => current.map(item => item.id === restored.id ? restored : item));
            refresh(); showToast("已恢复删除的别名");
          } catch (error) { showToast(handleRequestError(error, "撤销失败，请重试"), "warn"); }
        })();
      } : undefined);
      return updated;
    } catch (error) {
      if ((error as { code?: string }).code === "entity_name_review_required") throw error;
      showToast(handleRequestError(error, "人物资料保存失败，请重试"), "warn");
      return null;
    }
  };
  const toggleDemo = () => {
    setHideDemo((current) => {
      const next = !current;
      window.localStorage.setItem(DEMO_HIDDEN_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  /** Best effort: a demo object that real records still point at must survive. */
  const removeQuietly = async (path: string): Promise<boolean> => {
    try {
      await apiRequest<void>(path, { method: "DELETE" });
      return true;
    } catch {
      return false;
    }
  };

  const handleDeleteDemo = async () => {
    if (demoBusy) return;
    if (!demoDeleteArmed) {
      setDemoDeleteArmed(true);
      window.setTimeout(() => setDemoDeleteArmed(false), 4000);
      return;
    }
    setDemoDeleteArmed(false);
    setDemoBusy(true);
    try {
      // Read the demo records fresh so a hidden banner never leaves stragglers behind.
      const payload = await apiRequest<RecordsResponse>(`/api/records?timeZone=${encodeURIComponent(USER_TIME_ZONE)}`);
      for (const record of payload.items.filter(isDemoRecord)) {
        await apiRequest<void>(`/api/records/${encodeURIComponent(record.id)}`, { method: "DELETE", body: JSON.stringify({ revision: record.revision }) });
      }
      for (const entity of entities.filter((item) => item.id.startsWith(DEMO_ID_PREFIX))) {
        await removeQuietly(`/api/entities/${encodeURIComponent(entity.id)}`);
      }
      for (const asset of assets.filter((item) => item.id.startsWith(DEMO_ID_PREFIX))) {
        await removeQuietly(`/api/assets/${encodeURIComponent(asset.id)}`);
      }
      showToast("预置记录已删除，你写的内容不受影响");
      refresh();
    } catch (error) {
      showToast(handleRequestError(error, "删除预置记录失败，请重试"), "warn");
    } finally {
      setDemoBusy(false);
    }
  };

  const captureComposerWeather = async () => {
    if (composerWeatherBusy) return;
    setComposerWeatherBusy(true);
    setActionMessage(null);
    try {
      const result = await apiRequest<WeatherCurrentResponse>("/api/weather/current", { method: "POST" });
      setComposerWeather(result.weather);
      showToast(`已记录${result.weather.text}天气`);
    } catch (error) {
      showToast(handleRequestError(error, "实时天气读取失败，请检查天气配置"), "warn");
    } finally {
      setComposerWeatherBusy(false);
    }
  };

  // A dropped photo is uploaded right away, so the thumbnail on screen is the
  // real asset the entry will point at; saving only writes the link. When the
  // library already holds the same bytes the upload is skipped entirely: the
  // same photo dropped twice must not become two files on disk.
  const uploadComposerShot = async (file: File, signal: AbortSignal, onProgress: (progress: ApiUploadProgress) => void): Promise<ShotUpload> => {
    const throwIfAborted = () => {
      if (!signal.aborted) return;
      throw typeof DOMException === "undefined" ? Object.assign(new Error("The operation was aborted"), { name: "AbortError" }) : new DOMException("The operation was aborted", "AbortError");
    };
    const hash = await sha256Hex(file);
    throwIfAborted();
    if (hash !== null) {
      const known = await resolveKnownShot(hash, signal);
      throwIfAborted();
      if (known !== null) {
        setAssets((current) => current.some((asset) => asset.id === known.id) ? current : [...current, known]);
        return { asset: known, reused: true };
      }
    }
    const asset = await apiUploadRequest<Asset>(`/api/assets/uploads?name=${encodeURIComponent(file.name)}`, file, {
      contentType: file.type,
      signal,
      onProgress,
    });
    throwIfAborted();
    // Upload may return an existing row if another request stored the same
    // bytes. Keep the library list unique by asset id.
    setAssets((current) => current.some((held) => held.id === asset.id) ? current : [...current, asset]);
    return { asset, reused: false };
  };

  const uploadComposerVideo = async (file: File, signal: AbortSignal, onProgress: (value: ApiUploadProgress) => void): Promise<Asset> => {
    const asset = await apiUploadRequest<Asset>(`/api/assets/videos?name=${encodeURIComponent(file.name)}`, file, { contentType: "video/mp4", signal, onProgress });
    if (signal.aborted) throw new DOMException("已取消视频上传", "AbortError");
    setAssets(current => current.some(item => item.id === asset.id) ? current : [...current, asset]);
    return asset;
  };

  const handleCreate = async () => {
    const content = composerContent;
    const fromTaskPage = activeView === "tasks" && composerKind === "task";
    if (!hasSavableRecordContent(composerKind, content, composerShotsRef.current, assets) || saving) return;
    const shotState = shotSubmissionStatesRef.current.get(createShotScopeKey);
    if (shotState !== undefined) { showToast(shotState === "failed" ? "有附件未上传，请重试或移除后保存" : "附件正在处理，请完成后再保存", "warn"); return; }
    const currentDay = localDateToday();
    const writingDate = activeView === "today" && recordingDate === todayDate && !occurredAtDirty ? currentDay : createDate;
    const isTodaySelection = writingDate === currentDay;
    // The field already defaults to the current minute, so "now" is the normal
    // path; clearing it means "no explicit time" and falls back to the entry moment.
    // A save just after midnight must not inherit yesterday while the clock tick is pending.
    const occurred = writingDate !== createDate ? undefined : occurredAt ? instantFromInput(occurredAt) : isTodaySelection ? undefined : dateOnly(writingDate);
    const due = dueAt ? instantFromInput(dueAt) : undefined;
    if ((occurredAt && !occurred) || (dueAt && !due)) { showToast("请检查时间格式后再保存", "warn"); return; }
    const currentShots = composerShotsRef.current;
    const payload: RecordWritePayload = { kind: composerKind, content, entityMentions: composerEntityMentions, ...(occurred ? { occurredAt: occurred } : {}), ...(composerKind === "task" && dueAt && due ? { dueAt: due } : {}), ...(composerPrivate ? { isPrivate: true } : {}), ...(composerKind === "journal" && composerBackfill && !isTodaySelection ? { isBackfill: true } : {}), ...(composerWeather === null ? {} : { weather: composerWeather }), ...(composerMovieRefs.length === 0 ? {} : { entityRefs: composerMovieRefs }), ...(currentShots.length === 0 ? {} : { assetRefs: currentShots }) };
    setSaving(true);
    setActionMessage(null);
    try { await apiRequest<RecordView>("/api/records", { method: "POST", body: JSON.stringify(payload) }); if (draftScope !== null) clearComposerDraft(draftScope); setComposerContent(""); setComposerEntityMentions([]); setComposerMovieRefs([]); setComposerShotsTracked([]); setComposerPrivate(false); setComposerBackfill(false); setComposerWeather(null); setOccurredAtDirty(false); if (activeView === "today") setRecordingDate(todayDate); setDueAt(""); if (fromTaskPage) collapseTaskComposer(); showToast("已保存记录"); refresh(); } catch (error) { showToast(handleRequestError(error, "保存失败，请重试")); } finally { setSaving(false); }
  };

  const noteDetailsPayload = (draft: Pick<NoteDraft, "format" | "title" | "source">): NoteDetails => ({ format: "note", ...(draft.title.trim() ? { title: draft.title.trim() } : {}), ...(draft.source.trim() ? { source: draft.source.trim() } : {}) });
  const handleSaveNote: NoteSaveHandler = async (record, draft) => {
    try {
      const payload: RecordWritePayload = {
        ...(record ? { revision: record.revision } : { kind: "note" }),
        content: draft.content, note: noteDetails(draft),
        ...(draft.assetRefs === undefined ? {} : { assetRefs: draft.assetRefs }),
        ...(draft.isPrivate === undefined ? {} : { isPrivate: draft.isPrivate }),
      };
      const saved = await apiRequest<RecordView>(record ? '/api/records/' + encodeURIComponent(record.id) : "/api/records", { method: record ? "PATCH" : "POST", body: JSON.stringify(payload) });
      refresh();
      return { ok: true, record: saved };
    } catch (error) {
      return { ok: false, message: errorStatus(error) === 409 ? "笔记版本已变化，草稿仍在此设备。请重新打开最新笔记后合并修改" : handleRequestError(error, "笔记保存失败，请重试") };
    }
  };

  const handleDemo = async () => {
    if (creatingDemo) return;
    setCreatingDemo(true);
    setActionMessage(null);
    const examples: readonly { kind: ComposerKind; content: string; hour: string; dueHour?: string }[] = [{ kind: "journal", content: "今天先把生活记录从一句话开始。", hour: "09:10" }, { kind: "note", content: "把值得回看的想法留在自己的时间轴里。", hour: "12:40" }, { kind: "task", content: "晚间整理今天的三条记录", hour: "16:20", dueHour: "19:00" }];
    try { for (const example of examples) { const occurred = instantFromInput(`${selectedDate}T${example.hour}`); const due = example.dueHour ? instantFromInput(`${selectedDate}T${example.dueHour}`) : undefined; if (!occurred) throw new Error("预置记录时间无效"); const payload: RecordWritePayload = { kind: example.kind, content: example.content, occurredAt: occurred, isDemo: true, ...(due ? { dueAt: due } : {}) }; await apiRequest<RecordView>("/api/records", { method: "POST", body: JSON.stringify(payload) }); } showToast("已加入 3 条预置记录，可随时删除"); refresh(); } catch (error) { showToast(handleRequestError(error, "预置记录创建失败，请重试")); } finally { setCreatingDemo(false); }
  };

  const handleEdit = (record: RecordView) => {
    if (record.kind === "note") setActiveView("notes");
    if (activeView === "tasks" && taskComposerExpanded) collapseTaskComposer();
    setEditError(null);
    setEditingRecord(record);
    recordEditView.current = activeView;
    if (recordEditDraft === null) composerOpenBeforeRecordEdit.current = composerOpen;
    setRecordEditDraftTracked({ content: recordText(record), entityMentions: record.body.entityMentions ?? [], occurredAt: lifeTimeToInput(record.occurredAt), dueAt: isTaskRecord(record) ? lifeTimeToInput(record.task.dueAt) : "", occurredDirty: false, dueDirty: false, isPrivate: record.isPrivate === true, isBackfill: record.isBackfill === true, status: isTaskRecord(record) ? record.task.status : "todo", entityRefs: record.entityRefs, relatedRecordIds: record.relatedRecordIds, assetRefs: record.assetRefs });
    setNoteEditMeta(record.kind === "note" ? { format: record.note?.format ?? "fragment", title: record.note?.title ?? "", source: record.note?.source ?? "", metadataTouched: false } : null);
    setComposerOpen(true);
    if (record.kind !== "note") window.requestAnimationFrame(() => document.querySelector(activeView === "tasks" ? ".task-edit-composer .composer" : ".composer")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const handleSaveEdit = async (record: RecordView, draft: RecordEditorDraft) => {
    const shotState = shotSubmissionStatesRef.current.get(`edit:${record.id}`);
    if (shotState !== undefined) { setEditError(shotState === "failed" ? "有附件未上传，请重试或移除后保存" : "附件正在处理，请完成后再保存"); return; }
    draft = recordEditDraftRef.current ?? draft;
    if (!hasSavableRecordContent(record.kind, draft.content, draft.assetRefs, assets)) { setEditError(record.kind === "journal" ? "请填写文字或添加照片" : "请输入内容"); return; }
    if (record.kind === "note" && noteEditMeta?.format === "article" && !noteEditMeta.title.trim()) { setEditError("请填写文章标题"); return; }
    const occurredPatch = draft.occurredDirty ? (draft.occurredAt ? instantFromInput(draft.occurredAt) : null) : undefined;
    if (draft.occurredDirty && draft.occurredAt && !occurredPatch) { setEditError("发生时间格式无效"); return; }
    const duePatch = draft.dueDirty ? (draft.dueAt ? instantFromInput(draft.dueAt) : null) : undefined;
    if (draft.dueDirty && draft.dueAt && !duePatch) { setEditError("截止时间格式无效"); return; }
    const payload: RecordWritePayload = { revision: record.revision, entityMentions: draft.entityMentions ?? [], entityRefs: draft.entityRefs, relatedRecordIds: draft.relatedRecordIds, assetRefs: draft.assetRefs, ...(draft.content !== recordText(record) ? { content: draft.content } : {}), ...(draft.occurredDirty ? { occurredAt: occurredPatch ?? null } : {}), ...(isTaskRecord(record) && draft.dueDirty ? { dueAt: duePatch ?? null } : {}), ...(isTaskRecord(record) && draft.status !== record.task.status ? { status: draft.status } : {}), ...(draft.isPrivate !== (record.isPrivate === true) ? { isPrivate: draft.isPrivate } : {}), ...(draft.isBackfill !== (record.isBackfill === true) ? { isBackfill: draft.isBackfill } : {}), ...(record.kind === "note" && noteEditMeta?.metadataTouched ? { note: noteDetailsPayload(noteEditMeta) } : {}) };
    setEditSaving(true);
    setEditError(null);
    try { await apiRequest<RecordView>(`/api/records/${encodeURIComponent(record.id)}`, { method: "PATCH", body: JSON.stringify(payload) }); recordEditView.current = null; setEditingRecord(null); setRecordEditDraftTracked(null); setNoteEditMeta(null); setComposerOpen(composerOpenBeforeRecordEdit.current); showToast("修改已保存"); refresh(); } catch (error) { setEditError(errorStatus(error) === 409 ? "这条记录已在别处更新。读取最新版本后可以继续保存当前草稿。" : handleRequestError(error, "修改保存失败，请重试")); } finally { setEditSaving(false); }
  };

  const handleReloadLatest = async () => {
    if (!editingRecord) return;
    setEditReloading(true);
    try { const payload = await apiRequest<RecordsResponse>(`/api/records?timeZone=${encodeURIComponent(USER_TIME_ZONE)}`); const latest = payload.items.find((record) => record.id === editingRecord.id); if (!latest) throw new Error("找不到这条记录的最新版本"); setEditingRecord(latest); setEditError("已读取最新版本，当前草稿还在输入框中。"); } catch (error) { setEditError(handleRequestError(error, "无法读取最新版本，请重试")); } finally { setEditReloading(false); }
  };

  const handleDelete = async () => {
    if (!deleteRecord || deleteBusy) return;
    setDeleteBusy(true); setDeleteError(null);
    try { await deletions.start(deleteRecord, queryPath, Math.max(0, recordsForQuery?.findIndex(item => item.id === deleteRecord.id) ?? 0)); setDeleteRecord(null); }
    catch (error) { setDeleteError(errorStatus(error) === 409 ? "记录已更新，请关闭后重新加载" : handleRequestError(error, "删除失败，请重试")); }
    finally { setDeleteBusy(false); }
  };

  const syncTaskRecord = (updated: RecordView) => {
    if (activeView === "tasks" && taskPageFilter === "incomplete" && currentQueryPath.current === queryPath) {
      const incompleteStatuses: readonly TaskStatus[] = ["todo", "in_progress"];
      const allowedStatuses = searchActive && searchFilters.statuses.length
        ? incompleteStatuses.filter(status => searchFilters.statuses.includes(status))
        : incompleteStatuses;
      reloadRecords();
      setRecords(current => current === null ? current : current
        .map(item => item.id === updated.id ? updated : item)
        .filter((item): item is TaskRecordView => isTaskRecord(item) && allowedStatuses.includes(item.task.status)));
    } else if (!searchActive && activeView !== "calendar" && recordsAreCurrent && currentQueryPath.current === queryPath) {
      const items = recordsRef.current.map(item => item.id === updated.id ? updated : item);
      recordsRef.current = items;
      invalidateRecordsCache();
      recordsRequestRef.current += 1;
      cacheRecords(recordsCacheRef.current, queryPath, { items, selectedDate: recordsForQueryDate });
      patchedTaskQuery.current = queryPath;
      setRecords(items);
      setRecordsLoading(false);
      setRecordsReload(current => current + 1);
    } else {
      reloadRecords();
      setRecords(current => current === null ? current : current.map(item => item.id === updated.id ? updated : item));
    }
    setTasks((current) => current === null ? current : current.map((item) => item.id === updated.id ? updated : item));
  };

  const handleTaskStatus = async (record: TaskRecordView, status: TaskStatus, options?: { readonly sync?: boolean; readonly feedback?: boolean }): Promise<RecordView | null> => {
    const owner = authRef.current.account?.tenantId ?? "local";
    try {
      const updated = await apiRequest<RecordView>(`/api/records/${encodeURIComponent(record.id)}`, { method: "PATCH", body: JSON.stringify({ revision: record.revision, status }) });
      if (owner !== (authRef.current.account?.tenantId ?? "local") || (authRef.current.required && !authRef.current.authenticated)) return null;
      if (options?.sync !== false) syncTaskRecord(updated);
      if (options?.feedback !== false) showToast(status === "done" ? "任务已完成" : status === "cancelled" ? "任务已取消" : "任务已恢复");
      return updated;
    } catch (error) {
      showToast(errorStatus(error) === 409 ? "任务版本已变化，请刷新后再操作" : handleRequestError(error, "任务状态更新失败"));
      return null;
    }
  };

  const handleImportConfirm = async () => {
    if (!importFile || importBusy) return;
    setImportBusy(true);
    setImportError(null);
    try { const bundle = JSON.parse(await importFile.text()) as unknown; await apiRequest<unknown>("/api/import", { method: "POST", body: JSON.stringify({ bundle }) }); setImportFile(null); showToast("备份已导入"); refresh(); } catch (error) { setImportError(errorMessage(error, "导入失败，请检查 JSON 文件")); if (errorStatus(error) === 401) { invalidateRecordsCache(); const nextAuth = loggedOutAuth(authRef.current); authRef.current = nextAuth; setRecords(null); setRecordsQueryPath(null); setRecordsDisplayedDate(null); setRecordsErrorQueryPath(null); setTasks(null); recordsRef.current = []; setAuthState(nextAuth); } } finally { setImportBusy(false); }
  };

  const handleLogout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await apiRequest<unknown>("/api/auth/logout", { method: "POST" });
      invalidateRecordsCache();
      if (authState.accountMode) {
        clearTenantSensitiveBrowserStorage();
        window.location.reload();
        return;
      }
      const nextAuth: AuthState = { required: true, authenticated: false };
      authRef.current = nextAuth;
      setRecords(null); setRecordsQueryPath(null); setRecordsDisplayedDate(null); setRecordsErrorQueryPath(null); setTasks(null); recordsRef.current = []; setAuthState(nextAuth); setMobileMenuOpen(false);
    } catch (error) { showToast(handleRequestError(error, "退出失败，请重试")); }
    finally { setLogoutBusy(false); }
  };

  const handleLogin = async (username: string, password: string) => {
    setLoginLoading(true);
    setAuthError(null);
    try {
      if (authState.accountMode) clearTenantSensitiveBrowserStorage();
      const body = authState.accountMode ? { username, password } : { password };
      const state = await apiRequest<AuthState>("/api/auth/login", { method: "POST", body: JSON.stringify(body) });
      invalidateRecordsCache();
      if (authState.accountMode) { window.location.reload(); return; }
      setRecords(null); setRecordsQueryPath(null); setRecordsDisplayedDate(null); setRecordsErrorQueryPath(null); authRef.current = state; setAuthState(state);
    } catch (error) { setAuthError(errorMessage(error, "账号或密码不正确")); }
    finally { setLoginLoading(false); }
  };

  const isToday = activeView === "today";
  useEffect(() => {
    if (recordEditView.current === null || recordEditView.current === activeView) return;
    recordEditView.current = null;
    setEditingRecord(null);
    setRecordEditDraftTracked(null);
    setNoteEditMeta(null);
    setEditError(null);
    setComposerOpen(composerOpenBeforeRecordEdit.current);
  }, [activeView]);
  const isReviewingPast = isToday && createDate < todayDate;
  // Views that own their column outright: no composer bar, no page actions. The
  // time machine is one of them — there is nothing to write while reading history,
  // and the composer would push the axis down the page. It keeps the task column,
  // like the calendar does.
  const hidesComposer = activeView === "settings" || activeView === "entities" || activeView === "timemachine" || activeView === "notes" || activeView === "calendar";
  const editingComposer = editingRecord !== null && recordEditDraft !== null;
  useEffect(() => {
    if (activeView !== "tasks" || !taskComposerExpanded) return;
    const frame = window.requestAnimationFrame(() => taskComposerRef.current?.querySelector<HTMLTextAreaElement>(".composer-input")?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, taskComposerExpanded, taskComposerMounted]);
  useEffect(() => {
    if (activeView !== "tasks" || taskComposerExpanded || editingComposer || !taskComposerMounted) return;
    const frame = window.requestAnimationFrame(() => taskCreateTeaserRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, taskComposerExpanded, editingComposer, taskComposerMounted]);
  const showComposer = !hidesComposer && ((editingComposer && editingRecord.kind !== "note") || (activeView === "tasks" ? false : isToday || composerOpen));
  // Calendar owns its compact range navigation and backfill entry. Letting the
  // generic page header render there would leave a wide, almost-empty row whose
  // only job was the old "新建记录" button.
  const showPageActions = !hidesComposer && activeView !== "tasks" && !isToday && !editingComposer;
  const privacyShown = privacyRevealed(privacyVisible, privacySessionGrant, privacyOneShot);
  const retainedRecords = deletions.retain(recordsForQuery, queryPath);
  const loadedVisibleRecords = retainedRecords ? retainedRecords.filter((record) => (!hideDemo || !isDemoRecord(record)) && (privacyShown || record.isPrivate !== true)) : retainedRecords;
  // The notes route owns its own library. Other record surfaces deliberately
  // receive a note-free view even when an old note carries occurredAt. Global
  // search is the exception: matching notes are part of the result set.
  const visibleRecords = searchActive || activeView === "notes" ? loadedVisibleRecords : loadedVisibleRecords?.filter((record) => record.kind !== "note") ?? loadedVisibleRecords;
  syncPhotoRotations(assets);
  useEffect(() => { setPhotoPreview(null); }, [authState.account?.tenantId, privacyShown, hideDemo]);
  const openPhotoPreview: PhotoPreviewHandler = (ids, index, record, source = visibleRecords ?? []) => {
    const allowed = source.filter(r => (privacyShown || r.isPrivate !== true) && (!hideDemo || !isDemoRecord(r)) && !deletions.entries.some(e => e.record.id === r.id));
    if (record && ((!privacyShown && record.isPrivate === true) || (hideDemo && isDemoRecord(record)))) return;
    setPhotoPreview({ ...photoPreviewSession(ids, index, assets, allowed, record), scope: authState.account?.tenantId ?? "local" });
  };
  const visibleTasks = tasks?.filter(record => (!hideDemo || !isDemoRecord(record)) && !deletions.entries.some(entry => entry.record.id === record.id)) ?? tasks;
  /**
   * The sidebar switch is being built separately. This is the contract it uses:
   * dispatch `lifeos:privacy-visibility` with `detail: boolean`.
   */
  useEffect(() => {
    const apply = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail === true;
      writePrivacyVisible(next);
      setPrivacyVisible(next);
    };
    window.addEventListener("lifeos:privacy-visibility", apply);
    return () => window.removeEventListener("lifeos:privacy-visibility", apply);
  }, []);
  /**
   * Ask about private records only when the answer is "this filter matched
   * nothing, and there is something behind the switch that would have matched".
   *
   * This is why the question is asked here and not by the model: the model never
   * sees private records, so it cannot know they exist. It would ask every time
   * it merely failed to find something.
   */
  useEffect(() => {
    if (!uiPrivacyCheck || !recordsAreCurrent || recordsForQuery === null || recordsForQuery === undefined) return;
    setUiPrivacyCheck(false);
    if (privacyShown) return;
    const hidden = recordsForQuery.filter((record) => record.isPrivate === true).length;
    const shown = recordsForQuery.filter((record) => record.isPrivate !== true).length;
    if (hidden === 0 || shown > 0) return;
    setPrivacyRequest({ reason: `这次筛选有 ${hidden} 条隐私记录符合条件，但隐私总开关是关着的。要现在看吗？` });
  }, [uiPrivacyCheck, recordsForQuery, recordsAreCurrent, privacyShown]);
  /**
   * Bring the record the assistant pointed at into view.
   *
   * `record.focus` is compiled together with the navigation that makes the row
   * appear, so the first pass can run a commit before the row exists — the intent
   * is therefore kept until the row is actually there, and a records refresh in the
   * meantime must not re-scroll the owner back.
   */
  useEffect(() => {
    if (uiFocusRecordId === null) { uiFocusScrolledFor.current = null; return; }
    if (!recordsAreCurrent || uiFocusScrolledFor.current === uiFocusRecordId) return;
    const target = document.querySelector(`.main-column [data-record-id="${CSS.escape(uiFocusRecordId)}"]`);
    if (!(target instanceof HTMLElement)) return;
    uiFocusScrolledFor.current = uiFocusRecordId;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [uiFocusRecordId, recordsForQuery, recordsAreCurrent]);
  /**
   * Fade the ring out on its own timer.
   *
   * Keyed on the id alone: `recordsForQuery` changes several times a second while a
   * list is settling, and a dep-driven cleanup would cancel the timeout and leave
   * the ring on screen for good.
   */
  useEffect(() => {
    if (uiFocusRecordId === null) return;
    const timer = window.setTimeout(() => setUiFocusRecordId(null), 2400);
    return () => window.clearTimeout(timer);
  }, [uiFocusRecordId]);
  const decidePrivacyRequest = (decision: "once" | "session" | "never") => {
    setPrivacyRequest(null);
    if (decision === "never") return;
    if (decision === "session") { writePrivacySessionGrant(true); setPrivacySessionGrant(true); return; }
    // "Just this once" lasts until the owner leaves the view, not until a timer fires.
    setPrivacyOneShot(true);
  };
  // Which places were written about most recently, so the mention picker can put
  // them first. Derived from the records rather than tracked separately: the
  // evidence is already in every saved record's entityRefs.
  const recentPlaces = useMemo(() => recentPlaceIds(visibleRecords ?? []), [visibleRecords]);
  const composerProps: ComposerProps = {
    onShotsCleared: handleShotsCleared,
    kind: composerKind,
    content: composerContent,
    decisions: composerEntityMentions,
    onDecisionsChange: setComposerEntityMentions,
    entities,
    recentPlaceIds: recentPlaces,
    placeIncludePrivate: privacyShown,
    placeHideDemo: hideDemo,
    movieEnabled: movieStatus.enabled,
    movieRefs: composerMovieRefs,
    onMovieRefsChange: setComposerMovieRefs,
    onMovieEntity: rememberMovieEntity,
    onCreateEntity: handleCreateEntity,
    occurredAt,
    dueAt,
    isPrivate: composerPrivate,
    isBackfill: composerBackfill,
    selectedDate: createDate,
    saving,
    // Explicit backfill can return to writing today without discarding the draft.
    dismissible: isReviewingPast || !isToday,
    occurredDirty: occurredAtDirty,
    weather: composerWeather,
    weatherBusy: composerWeatherBusy,
    onCaptureWeather: () => void captureComposerWeather(),
    onClearWeather: () => setComposerWeather(null),
    onKindChange: setComposerKind,
    onContentChange: changeComposerContent,
    onOccurredAtChange: (value) => { setOccurredAt(value); setOccurredAtDirty(true); },
    onDueAtChange: setDueAt,
    onPrivateChange: setComposerPrivate,
    onBackfillChange: setComposerBackfill,
    shots: composerShots,
    onShotsChange: setComposerShotsTracked,
    shotScopeKey: createShotScopeKey,
    onShotSubmissionState: reportShotSubmissionState,
    assets,
    onUploadVideo: uploadComposerVideo,
    onUploadShot: uploadComposerShot,
    onNotify: showToast,
    onSubmit: () => void handleCreate(),
    onClose: activeView === "tasks" ? collapseTaskComposer : () => { setComposerOpen(false); setComposerWeather(null); setComposerMovieRefs([]); if (isToday) { setRecordingDate(todayDate); setOccurredAtDirty(false); setComposerBackfill(false); } },
  };
  const activeComposerProps: ComposerProps = editingComposer ? {
    ...composerProps,
    shotScopeKey: editShotScopeKey,
    kind: editingRecord.kind,
    editing: true,
    error: editError,
    onReloadLatest: editError?.includes("别处更新") ? () => void handleReloadLatest() : undefined,
    content: recordEditDraft.content,
    decisions: recordEditDraft.entityMentions ?? [],
    onDecisionsChange: (decisions) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, entityMentions: decisions }),
    occurredAt: recordEditDraft.occurredAt,
    occurredDirty: recordEditDraft.occurredDirty,
    dueAt: recordEditDraft.dueAt,
    taskStatus: recordEditDraft.status,
    noteMeta: noteEditMeta,
    onNoteMetaChange: setNoteEditMeta,
    isPrivate: recordEditDraft.isPrivate,
    isBackfill: recordEditDraft.isBackfill,
    selectedDate: lifeTimeDate(editingRecord.occurredAt ?? editingRecord.createdAt) ?? selectedDate,
    saving: editSaving,
    dismissible: true,
    movieRefs: recordEditDraft.entityRefs,
    onMovieRefsChange: (refs) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, entityRefs: refs }),
    onKindChange: () => {},
    onContentChange: (content, editRange) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, content, entityMentions: rebaseEntityDecisions(current.content, content, current.entityMentions ?? [], editRange) }),
    onOccurredAtChange: (value) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, occurredAt: value, occurredDirty: true }),
    onDueAtChange: (value) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, dueAt: value, dueDirty: true }),
    onTaskStatusChange: (status) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, status }),
    onPrivateChange: (value) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, isPrivate: value }),
    onBackfillChange: (value) => setRecordEditDraftTracked((current) => current === null ? null : { ...current, isBackfill: value }),
    shots: recordEditDraft.assetRefs.filter((ref) => ref.role === "photo" || ref.role === "video"),
    onShotsChange: (update) => setRecordEditDraftTracked((current) => {
      if (current === null) return null;
      const photos = current.assetRefs.filter((ref) => ref.role === "photo" || ref.role === "video");
      const next = typeof update === "function" ? update(photos) : update;
      return { ...current, assetRefs: [...current.assetRefs.filter((ref) => ref.role !== "photo" && ref.role !== "video"), ...next] };
    }),
    onShotsCleared: handleShotsCleared,
    onSubmit: () => { const currentDraft = recordEditDraftRef.current; if (currentDraft !== null) void handleSaveEdit(editingRecord, currentDraft); },
    onClose: () => { if (!editSaving) { recordEditView.current = null; setEditingRecord(null); setRecordEditDraftTracked(null); setNoteEditMeta(null); setComposerOpen(composerOpenBeforeRecordEdit.current); setEditError(null); } },
  } : composerProps;
  const railDockEligible = activeView !== "settings";
  useLayoutEffect(() => {
    const column = contentColumnRef.current;
    const grid = column?.closest<HTMLElement>(".content-grid");
    if (!column || !grid || !railDockEligible) return;
    // Every view owns an explicit alignment anchor, including views without an
    // editor. A missing feed must not make the chat fill the entire column.
    const pageAnchors: Record<AppView, string> = {
      today: ".composer, .record-search-toolbar",
      timeline: ".composer, .record-search-toolbar",
      calendar: ".calendar-section-heading",
      tasks: ".task-page-heading",
      notes: ".notes-library-heading",
      entities: ".entities-heading",
      timemachine: ".time-machine",
      settings: ".settings-view",
    };
    const alignAssistant = () => {
      if (!window.matchMedia("(min-width: 901px)").matches) return;
      const style = getComputedStyle(grid);
      const bounds = column.getBoundingClientRect();
      const width = Number.parseFloat(style.gridTemplateColumns.split(" ").at(-1) ?? "300");
      const values: Record<string, string> = {
        "--context-left": bounds.right + Number.parseFloat(style.columnGap) + "px",
        "--context-width": width + "px",
      };
      // Read every geometry value before writing inherited CSS variables.
      const commit = () => { for (const [name, value] of Object.entries(values)) if (grid.style.getPropertyValue(name) !== value) grid.style.setProperty(name, value); };
      const weather = document.querySelector(".weather-header");
      const minTop = Math.max(16, Math.min((weather?.getBoundingClientRect().top ?? bounds.top) + window.scrollY, 32));
      const pageAnchor = column.querySelector<HTMLElement>(pageAnchors[activeView])
        ?? column.querySelector<HTMLElement>(".composer, .record-search-toolbar, .page-heading, .section-heading")
        ?? column.firstElementChild ?? column;
      const preferredTop = Math.max(minTop, pageAnchor.getBoundingClientRect().top + window.scrollY);
      values["--context-top"] = preferredTop + "px";
      const panel = grid.querySelector<HTMLElement>(".ai-assistant-panel.is-docked");
      if (!panel) { commit(); return; }
      const tasks = grid.querySelector<HTMLElement>(".task-summary");
      const taskSpace = tasks ? tasks.getBoundingClientRect().height + 16 : 0;
      const bottom = window.innerHeight - 24;
      const saveButton = (activeView === "today" || activeView === "timeline")
        ? column.querySelector<HTMLElement>(".composer-desktop-save") : null;
      // Even an empty conversation starts at the editor's save row. Other
      // pages keep their compact baseline; viewport space still caps growth.
      const saveBounds = saveButton?.getBoundingClientRect();
      const baseline = saveBounds && saveBounds.width > 0
        ? bottom - (saveBounds.top + window.scrollY) : 320;
      const header = panel.querySelector(".ai-assistant-header");
      const content = panel.querySelector(".backfill-workspace-content");
      const footer = panel.querySelector(".backfill-workspace-footer");
      const natural = (header?.getBoundingClientRect().height ?? 0) + (content?.getBoundingClientRect().height ?? 0) + (footer?.getBoundingClientRect().height ?? 0) + 26;
      const desiredHeight = Math.max(baseline, natural);
      const railTop = Math.max(minTop, Math.min(preferredTop, bottom - taskSpace - desiredHeight));
      const available = Math.max(0, bottom - railTop - taskSpace);
      values["--context-top"] = railTop + "px";
      values["--assistant-height"] = Math.min(available, desiredHeight) + "px";
      commit();
    };
    alignAssistant();
    let frame = 0;
    const scheduleAlignment = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(alignAssistant); };
    let columnWidth = column.getBoundingClientRect().width;
    const observer = new ResizeObserver(entries => {
      // A record folding far below the editor changes column height only;
      // none of the rail's alignment inputs changed in that case.
      if (entries.some(entry => {
        if (entry.target !== column) return true;
        const changed = Math.abs(entry.contentRect.width - columnWidth) > .5;
        columnWidth = entry.contentRect.width;
        return changed;
      })) scheduleAlignment();
    });
    observer.observe(column);
    const observedAnchors = new Set<Element>();
    const observeContent = () => {
      const anchors = new Set(column.querySelectorAll(`${pageAnchors[activeView]}, .composer, .composer-desktop-save`));
      for (const node of observedAnchors) if (!anchors.has(node)) { observer.unobserve(node); observedAnchors.delete(node); }
      for (const node of anchors) if (!observedAnchors.has(node)) { observer.observe(node); observedAnchors.add(node); }
    };
    observeContent();
    // Async headings and calendar/editor replacements can change anchor positions
    // without changing the column's overall size. Rebind after those commits.
    const mutations = new MutationObserver(changes => {
      const relevant = changes.some(change => change.type === "childList" || (change.target instanceof Element &&
        (change.target === column || [...observedAnchors].some(anchor => change.target === anchor || (change.target as Element).contains(anchor)))));
      if (relevant) { observeContent(); scheduleAlignment(); }
    });
    mutations.observe(column, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
    const weather = document.querySelector(".weather-header");
    if (weather) observer.observe(weather);
    for (const node of grid.querySelectorAll(".task-summary, .backfill-workspace-content, .backfill-workspace-footer, .ai-assistant-header")) observer.observe(node);
    window.addEventListener("resize", scheduleAlignment);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); window.removeEventListener("resize", scheduleAlignment); for (const name of ["--context-left", "--context-width", "--context-top", "--assistant-height"]) grid.style.removeProperty(name); };
  }, [authResolved, authState.authenticated, railDockEligible, activeView, showComposer, assistantVisible, searchActive]);
  const summaryMap = useMemo(() => new Map(summaries.map((summary) => [summary.date, summary])), [summaries]);
  if (!authResolved) return <StartupSurface failed={authBootstrapPhase === "unavailable"} onRetry={retryAuthBootstrap} />;
  if (authState.required && !authState.authenticated) {
    // An invited person arrives with no account at all: the welcome screen has
    // to cover "log in", "redeem an invite", "set your own password" and "pick
    // your weather", not just a password box.
    if (authState.accountMode === true) {
      return <WelcomeGate onLogin={handleLogin} loginError={authError} loginLoading={loginLoading} onFinished={() => window.location.reload()} />;
    }
    return <LoginGate onLogin={handleLogin} error={authError} loading={loginLoading} />;
  }
  // In the calendar the arrows page by the unit on screen — a week, or a month.
  const stepCalendar = (direction: number) => setSelectedDate((current) => (calendarMode === "week" ? shiftDate(current, direction * 7) : shiftMonth(current, direction)));
  const onNavigate = navigate;
  const changeBrowseDate = (date: string) => {
    setSelectedDate(activeView === "today" && !searchActive ? (date > todayDate ? todayDate : date) : date);
    if (activeView === "today") setFeedJumpVersion(current => current + 1);
  };
  const returnRecordingToday = () => {
    setRecordingDate(todayDate); setOccurredAtDirty(false); setComposerBackfill(false);
  };
  const startBackfill = (date: string) => {
    if (date >= todayDate) return;
    setRecordingDate(date); setOccurredAtDirty(false); setOccurredAt(localNowInputFor(date));
    setComposerKind("journal"); setComposerBackfill(true); setComposerOpen(true);
    window.requestAnimationFrame(() => document.querySelector(".composer")?.scrollIntoView({ block: "start", behavior: "instant" }));
  };
  const openRelatedRecords = (entity: Entity) => {
    const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, [entity.type === "person" ? "personIds" : entity.type === "place" ? "placeIds" : "entityIds"]: [entity.id] };
    const params = new URLSearchParams({ timeZone: USER_TIME_ZONE }); searchFilterParams(filters, params);
    if (recordPeek) setEntityCard(null);
    setRecordPeek({ title: entity.name + "的相关记录", path: "/api/records?" + params.toString(), filters });
  };
  const openRecordPeek = (id: string) => {
    if (recordPeek) setEntityCard(null);
    setRecordPeek({ title: "查看记录", path: "/api/records/" + encodeURIComponent(id), recordId: id });
  };
  const enterPeekRecord = (record: RecordView) => {
    setRecordPeek(null); setEntityCard(null); setCalendarDay(null);
    setSearchQuery(""); setSearchFilters(EMPTY_SEARCH_FILTERS);
    setActiveView(record.kind === "note" ? "notes" : "today");
    setSelectedDate(lifeTimeDate(record.occurredAt ?? record.createdAt) ?? todayDate);
    uiFocusScrolledFor.current = null; setUiFocusRecordId(null);
    window.requestAnimationFrame(() => setUiFocusRecordId(record.id));
  };
  const showTaskIncompleteEmpty = activeView === "tasks" && taskPageFilter === "incomplete" && !searchActive;
  const timelineContent = <Timeline filtered={searchActive} records={visibleRecords} assets={assets} entities={entities} loading={recordsInitialLoading} refreshing={recordsRefreshing || !recordsAreCurrent} error={recordsErrorForQuery} selectedDate={recordsForQueryDate} activeView={searchActive ? "timeline" : activeView} searchQuery={searchQuery} movieEnabled={movieStatus.enabled} moviePromptHidden={moviePromptHidden} onMovieAttachToRecord={attachMovieToRecord} onMoviePromptSuppress={suppressMoviePrompt} onRetry={reloadRecords} onDemo={() => void handleDemo()} creatingDemo={creatingDemo} onEdit={(record) => { if (recordsInteractionEnabled) handleEdit(record); }} onDelete={(record) => { if (!recordsInteractionEnabled) return; setDeleteError(null); setDeleteRecord(record); }} onTaskStatus={(record, status) => { if (recordsInteractionEnabled) void handleTaskStatus(record, status); }} onPreviewAsset={openPhotoPreview} onOpenEntity={setEntityCard} interactionDisabled={!recordsInteractionEnabled} dataCurrent={recordsAreCurrent} focusRecordId={uiFocusRecordId} emptyTitle={showTaskIncompleteEmpty ? "没有未完成的任务" : undefined} />;
  const recordFeedContent = <RecordFeed today={todayDate} jumpVersion={feedJumpVersion} onBackfill={startBackfill} records={visibleRecords} assets={assets} entities={entities} loading={recordsInitialLoading} refreshing={recordsRefreshing || !recordsAreCurrent} error={recordsErrorForQuery} selectedDate={selectedDate} activeView={searchActive ? "timeline" : activeView} searchQuery={searchQuery} movieEnabled={movieStatus.enabled} moviePromptHidden={moviePromptHidden} onMovieAttachToRecord={attachMovieToRecord} onMoviePromptSuppress={suppressMoviePrompt} onRetry={reloadRecords} onDemo={() => void handleDemo()} creatingDemo={creatingDemo} onEdit={(record) => { if (recordsInteractionEnabled) handleEdit(record); }} onDelete={(record) => { if (!recordsInteractionEnabled) return; setDeleteError(null); setDeleteRecord(record); }} onTaskStatus={(record, status) => { if (recordsInteractionEnabled) void handleTaskStatus(record, status); }} onPreviewAsset={openPhotoPreview} onOpenEntity={setEntityCard} interactionDisabled={!recordsInteractionEnabled} dataCurrent={recordsAreCurrent} focusRecordId={uiFocusRecordId} />;

  const showRecordSearch = activeView !== "settings" && (isToday || activeView === "timeline" || activeView === "tasks" || searchActive);
  const applyRecordSearch = (query: string, filters: SearchFilters) => { setSearchQuery(query); setSearchFilters(filters); };
  const recordSearchControl = showRecordSearch ? <RecordSearch query={searchQuery} filters={searchFilters} entities={entities} open={searchFiltersOpen} onOpenChange={setSearchFiltersOpen} onApply={applyRecordSearch} /> : null;
  const searchContent = <SearchAlternatives key={`${queryPath}|${privacyShown}|${hideDemo}|${recordsReload}|${recordsRevalidation}|${authState.account?.tenantId ?? "local"}`} queryPath={queryPath} filters={searchFilters} entities={entities} privacyShown={privacyShown} hideDemo={hideDemo} exactCount={recordsAreCurrent ? visibleRecords?.length ?? null : null} ready={recordsInteractionEnabled} exactContent={timelineContent} onApply={filters => applyRecordSearch(searchQuery, filters)} onAskAssistant={askSearchAssistant} renderRecord={record => <TimelineItem record={record} assets={assets} entities={entities} movieEnabled={movieStatus.enabled} moviePromptHidden={moviePromptHidden} onMovieAttachToRecord={attachMovieToRecord} onMoviePromptSuppress={suppressMoviePrompt} onEdit={handleEdit} onDelete={record => { setDeleteError(null); setDeleteRecord(record); }} onTaskStatus={(record, status) => void handleTaskStatus(record, status)} onPreviewAsset={(ids, index) => openPhotoPreview(ids, index, record, [record])} onOpenEntity={setEntityCard} interactionDisabled={!recordsInteractionEnabled} /> } />;
  return <RecordDeletionContext.Provider value={deletionContext}><WeatherLocationProvider key={authState.account?.tenantId ?? "local"} tenantId={authState.account?.tenantId ?? "local"} status={weatherStatus} onChanged={retryWeatherProfiles} onNotice={(message, tone) => showToast(message, tone ?? "warn")}><EntityPhotoScopeContext.Provider value={authState.account?.tenantId ?? "local"}><VideoScopeContext.Provider value={draftScope ?? ""}><div className="app-shell" data-view={activeView}><Sidebar activeView={activeView} onNavigate={navigate} /><main className="main-column"><CalendarBackground scope={authState.account?.tenantId ?? "local"} month={selectedDate.slice(0, 7)} hideDemo={hideDemo} generation={recordsReload} enabled={activeView === "calendar" && calendarMode === "month" && (!authState.required || authState.authenticated)} viewing={activeView === "calendar" && (!authState.required || authState.authenticated)} /><header className="topbar"><div className="topbar-layout"><WeatherHeader maxDate={isToday && !searchActive ? todayDate : undefined} selectedDate={selectedDate} status={weatherStatus} onOpenSettings={() => openSettingsPage("integrations/weather")} onDateChange={changeBrowseDate} onDateStep={activeView === "calendar" ? stepCalendar : undefined} onNotice={(message, tone) => showToast(message, tone ?? "warn")} showDateNavigation={activeView !== "calendar"} /></div></header><div className="content-grid"><div ref={contentColumnRef} className="content-column">{activeView === "tasks" ? <TaskPageHeader expanded={taskComposerExpanded} editing={editingComposer} draft={composerContent} onOpenComposer={() => { setComposerKind("task"); setTaskComposerMounted(true); setTaskComposerExpanded(true); }} onTeaserRef={node => { taskCreateTeaserRef.current = node; }} /> : null}{showPageActions ? <div className="page-heading page-heading-actions"><div className="heading-actions"><button className="secondary-button heading-create-button" type="button" onClick={() => { setComposerKind("journal"); setComposerOpen(true); }}><Plus size={16} aria-hidden="true" /><span>新建记录</span></button></div></div> : null}{isReviewingPast && !editingComposer ? <div className="recording-date-notice"><span>补记 {shortDate(createDate)}</span><button className="secondary-button" type="button" onClick={returnRecordingToday}>改为记录今天</button></div> : null}{activeView === "tasks" && taskComposerMounted ? <div ref={taskComposerRef} className="task-composer-retained" hidden={!taskComposerExpanded || editingComposer} inert={!taskComposerExpanded || editingComposer} aria-hidden={!taskComposerExpanded || editingComposer}><Composer key="task-create" {...composerProps} searchControl={undefined} /></div> : null}{showComposer ? (activeView === "tasks" ? <div className="task-edit-composer"><Composer key={editingComposer ? editingRecord.id : "create"} {...activeComposerProps} searchControl={undefined} /></div> : <Composer key={editingComposer ? editingRecord.id : "create"} {...activeComposerProps} searchControl={recordSearchControl} />) : null}{activeView === "tasks" ? <TaskPageFilters filter={taskPageFilter} onFilterChange={setTaskPageFilter} /> : null}{showRecordSearch && (activeView === "tasks" || !showComposer) ? <div className="record-search-toolbar">{recordSearchControl}</div> : null}{showRecordSearch ? <RecordSearchResults query={searchQuery} filters={searchFilters} entities={entities} onApply={applyRecordSearch} count={recordsAreCurrent ? visibleRecords?.length ?? null : null} loading={recordsInitialLoading || recordsRefreshing || !recordsAreCurrent} error={recordsErrorForQuery} /> : null}{activeView === "settings"
       ? <SettingsView habitActions={habitActions} page={settingsPage} mobileEntry={settingsMobileEntry} onNavigatePage={openSettingsPage} onImport={() => fileInputRef.current?.click()} onLogout={() => void handleLogout()} logoutBusy={logoutBusy} authRequired={authState.required} accountMode={authState.accountMode === true} account={authState.account} aiStatusState={aiStatusState} onAiStatusChange={onAiStatusChange} onRetryAiStatus={retryAiStatus} assistantVisible={assistantVisible} onAssistantVisibleChange={setAssistantVisibility} backupStatusState={backupAccountRef.current === (authState.account?.id ?? null) ? backupStatusState : { phase: "loading", status: null }} backupBusy={backupBusy} onBackup={(action) => void handleBackup(action)} onBackupStatusChange={(status) => setBackupStatusState({ phase: "ready", status })} onRetryBackupStatus={retryBackupStatus} onBackupReadFailed={(cause) => { handleRequestError(cause, "备份状态读取失败"); setBackupStatusState((current) => ({ phase: "failed", status: errorStatus(cause) === 401 ? null : current.status, error: errorMessage(cause, "备份状态暂时无法读取，请重试") })); }} weatherProfilesState={weatherProfilesState} onWeatherStatusChange={onWeatherStatusChange} onRetryWeatherProfiles={retryWeatherProfiles} movieStatusState={movieStatusState} onMovieStatusChange={onMovieStatusChange} onRetryMovieStatus={retryMovieStatus} demoCount={demoCount} hideDemo={hideDemo} demoBusy={demoBusy} demoDeleteArmed={demoDeleteArmed} onToggleDemo={toggleDemo} onDeleteDemo={() => void handleDeleteDemo()} uiFont={uiFont} onUiFontChange={setUiFont} onAssetsChanged={refresh} cycleModule={cycleModule} onSaveCycleConfig={saveCycleModuleConfig} />
      : searchActive
        ? searchContent
      : activeView === "entities"
        ? <EntitiesView onOpenEntity={setEntityCard} onEditAvatar={setAvatarEntity} key={authState.account?.tenantId ?? "local"} scope={authState.account?.tenantId ?? "local"} generation={relationReload} hideDemo={hideDemo} includePrivate={privacyShown} onToggleStar={handleToggleContactStar} entities={entities} records={visibleRecords ?? []} onCreateEntity={handleCreateEntity} onEdit={setEditingEntity} onViewRecords={openRelatedRecords} onViewRecord={openRecordPeek} onAskAssistant={askSearchAssistant} />
      : activeView === "notes"
        ? <NotesLibrary key={authState.account?.tenantId ?? "local"} scope={authState.account?.tenantId ?? "local"} records={visibleRecords} loading={recordsLoading} error={recordsError} entities={entities} onRetry={() => setRecordsReload((current) => current + 1)} onCreateEntity={handleCreateEntity} onSave={handleSaveNote} onEdit={handleEdit} editor={editingComposer && editingRecord.kind === "note" ? <NoteEditorDialog scope={authState.account?.tenantId ?? "local"} key={editingRecord.id} record={editingRecord} createOpen={false} entities={entities} onCreateEntity={handleCreateEntity} onClose={activeComposerProps.onClose} onSave={handleSaveNote} /> : null} onDelete={(record) => { setDeleteError(null); setDeleteRecord(record); }} />
      : activeView === "calendar"
        ? <CalendarView hideDemo={hideDemo} backgroundScope={authState.account?.tenantId ?? "local"} mode={calendarMode} onModeChange={switchCalendarMode} onStep={stepCalendar} anchor={selectedDate} today={localDateToday()} habitActions={habitActions} presentations={calendarPresentations.days} records={recordsAreCurrent ? visibleRecords : null} tasks={visibleTasks ?? []} assets={assets} summaries={summaryMap} aiEnabled={aiSummaries} weatherByDate={weatherArchive} loading={recordsLoading} error={recordsErrorForQuery ?? calendarPresentations.error} cycleModule={cycleModule} cyclePanelOpen={cyclePanelOpen} onOpenCycleModule={toggleCalendarCyclePanel} onCloseCycleModule={() => setCyclePanelOpen(false)} onOpenCycleSettings={() => openSettingsPage("private/cycle")} onSaveCycleConfig={saveCycleModuleConfig} onAddCycleModuleEvent={addCycleModuleEvent} onDeleteCycleModuleEvent={deleteCycleModuleEvent} onSaveMobileCycleDay={saveMobileCycleDay} onUndoMobileCycleDay={undoMobileCycleDay} onReloadCycleModule={reloadCycleModule} onSavePeriodLength={saveCyclePeriodLength} onSaveCycleLength={saveCycleLength} onRetry={reloadRecords} onOpenDay={openDay} settingsOpen={calendarSettingsOpen} onToggleSettings={() => setCalendarSettingsOpen((current) => !current)} aiStatusState={aiStatusState} onAiStatusChange={onAiStatusChange} onRetryAiStatus={retryAiStatus} editMode={editMode} onEditModeChange={changeEditMode} drafts={summaryDrafts} onDraftChange={editSummaryDraft} summarySaving={summarySaving} onSaveDrafts={() => void changeEditMode(false)} onDiscardDrafts={discardSummaryDrafts} onRegenerateSummary={regenerateDaySummary} onRevertSummary={revertDaySummary} busyDate={summaryBusyDate} />
      : activeView === "timemachine"
        ? <TimeMachine />
      : isToday ? recordFeedContent : timelineContent}</div><div className={`context-rail ${railDockEligible ? "is-dock-layout" : ""}`}>{activeView !== "settings" ? <TaskSummary tasks={visibleTasks} loading={tasksLoading} error={tasksError} onTaskStatus={(record, status) => handleTaskStatus(record, status, { sync: false, feedback: false })} onTaskStateChange={syncTaskRecord} /> : null}<AIAssistant desktopDocked={railDockEligible} photoInput={{ onUploadShot: uploadComposerShot, onNotify: showToast, onShotsCleared: handleShotsCleared }} onOpenEntity={(entity) => { setEntityCard(entity); window.dispatchEvent(new Event("lifeos:close-ai")); }} scope={authState.account?.tenantId ?? "local"} onChanged={refresh} onViewRecords={ids => setRecordPeek({ title: "这次辅记的记录", path: "/api/records?assisted=true&timeZone=" + encodeURIComponent(USER_TIME_ZONE), recordIds: ids })} onUiPlan={runUiPlan} onUiCommand={runUiCommand} privacyRequest={privacyRequest} onPrivacyDecision={decidePrivacyRequest} privacyVisible={privacyShown} status={aiStatus} visible={assistantVisible} onOpenSettings={() => openSettingsPage("integrations/ai")} /></div></div></main><BackToTop key={activeView} /><MobileNav activeView={activeView} onNavigate={navigate} onMore={() => setMobileMenuOpen(true)} moreOpen={mobileMenuOpen} />{actionMessage ? <div className={`action-toast ${actionMessage.tone === "warn" ? "is-warning" : ""}`} role="status">{actionMessage.tone === "warn" ? <AlertCircle size={16} strokeWidth={2} aria-hidden="true" /> : <Check size={16} strokeWidth={2} aria-hidden="true" />}<span className="action-toast-text">{actionMessage.text}</span>{actionMessage.undo ? <button className="action-toast-undo" type="button" onClick={() => { const undo = actionMessage.undo; dismissToast(); undo?.(); }}>撤销</button> : null}</div> : null}<CycleModuleDialog open={cycleModuleOpen} module={cycleModule} selectedDate={selectedDate} onClose={() => setCycleModuleOpen(false)} onSaveConfig={saveCycleModuleConfig} onAddEvent={addCycleModuleEvent} onDeleteEvent={deleteCycleModuleEvent} /><MobileMenuDialog open={mobileMenuOpen} activeView={activeView} onClose={() => setMobileMenuOpen(false)} onNavigate={onNavigate} onOpenSearch={() => { setActiveView("today"); setSearchFiltersOpen(true); }} /><DiagnosticsDrawer /><ConfirmDialog assets={assets} record={deleteRecord} busy={deleteBusy} error={deleteError} onClose={() => { if (!deleteBusy) setDeleteRecord(null); }} onConfirm={() => void handleDelete()} /><ImportDialog file={importFile} busy={importBusy} error={importError} onClose={() => { if (!importBusy) setImportFile(null); }} onConfirm={() => void handleImportConfirm()} /><ContactAvatarDialog entity={avatarEntity} onClose={() => setAvatarEntity(null)} onSaved={updated => { setEntities(current => current.map(item => item.id === updated.id ? updated : item)); setEntityCard(current => current?.id === updated.id ? updated : current); }} /><PersonCardDialog key={String(entityCard?.id) + ":" + entityCardVersion} onViewRecord={openRecordPeek} includePrivate={privacyShown} onPlaceSaved={updated => { setEntities(current => current.map(item => item.id === updated.id ? updated : item)); setEntityCard(current => current?.id === updated.id ? updated : current); }} scope={authState.account?.tenantId ?? "local"} onEditAvatar={setAvatarEntity} onToggleStar={handleToggleContactStar} entity={entityCard} entities={entities} onClose={() => setEntityCard(null)} onEdit={(entity) => { setEntityCard(null); setEditingEntity(entity); }} onViewRecords={openRelatedRecords} onMovieSaved={rememberMovieEntity} /><EntityEditDialog entity={editingEntity} onClose={() => setEditingEntity(null)} onSave={handleSaveEntity} onRecordsChanged={refresh} /><input ref={fileInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file) { setImportError(null); setImportFile(file); } event.target.value = ""; }} />{calendarDay !== null && activeView === "calendar" ? <CalendarDayDialog key={calendarDay} date={calendarDay} tasks={visibleTasks ?? []} assets={assets} entities={entities} onClose={() => setCalendarDay(null)} onEnterDay={() => { setSelectedDate(calendarDay > todayDate ? todayDate : calendarDay); setCalendarDay(null); setActiveView("today"); setFeedJumpVersion(current => current + 1); }} onPreview={openPhotoPreview} onOpenEntity={setEntityCard} /> : null}{recordPeek ? <RecordPeekDialog key={authState.account?.tenantId ?? "local"} request={recordPeek} assets={assets} entities={entities} includePrivate={privacyShown} hideDemo={hideDemo} onClose={() => setRecordPeek(null)} onEnter={() => { if (!recordPeek.filters) return; setSearchQuery(""); setSearchFilters(recordPeek.filters); setActiveView("today"); setEntityCard(null); setCalendarDay(null); setRecordPeek(null); }} onEnterRecord={enterPeekRecord} onPreview={openPhotoPreview} onOpenEntity={entity => { setEntityCard(entity); setEntityCardVersion(value => value + 1); }} /> : null}{photoPreview === null || photoPreview.scope !== (authState.account?.tenantId ?? "local") || photoPreview.owners?.some(r => (!privacyShown && r.isPrivate === true) || (hideDemo && isDemoRecord(r))) ? null : <AssetPreview owners={photoPreview.owners} onAssetChange={updated => { if ((authRef.current.account?.tenantId ?? "local") === (authState.account?.tenantId ?? "local")) setAssets(current => current.map(a => a.id === updated.id ? updated : a)); }} assetIds={photoPreview.assetIds} index={photoPreview.index} assets={assets} onClose={() => setPhotoPreview(null)} onIndexChange={(index) => setPhotoPreview((current) => current === null ? null : { ...current, index })} />}</div></VideoScopeContext.Provider></EntityPhotoScopeContext.Provider></WeatherLocationProvider></RecordDeletionContext.Provider>;
}

export default App;

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("LifeOS root element is missing");
document.documentElement.style.setProperty("--lifeos-ui-font", UI_FONT_OPTIONS[0].stack);
// Vite re-evaluates this entry during hot updates. Reusing the root lets React
// refresh effects instead of leaving an old application's listeners alive.
const appRoot: ReturnType<typeof createRoot> = import.meta.hot?.data.root ?? createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.root = appRoot;
const sharedNoteKey=new URLSearchParams(window.location.search).get("noteShare");
const sharedParts=sharedNoteKey?.split(".");
appRoot.render(sharedParts ? <SharedNotePage space={sharedParts[0]??""} token={sharedParts[1]??""}/> : <App />);
