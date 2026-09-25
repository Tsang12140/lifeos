import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
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
  ListChecks,
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
  Search,
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
  SUMMARY_MAX_LENGTH, clampSummaryText, entitySearchTerms, findEntityMentions, normalizeEntitySearchTerm, trimSummaryText, type PlacePeriod, type PlaceRole } from "@lifeos/core";
import { installDiagnostics } from "./diagnostics";
import { sha256Hex } from "./contentHash";
import type { Asset, AssetKind, AssetLink, AssetRole, CycleIntimacyEventKind, CycleIntimacyModuleConfig, CycleIntimacyModuleData, DaySummary, Entity, EntityKind, EntityRef, NoteDetails, NoteFormat, RecordKind, RelationKind, TaskStatus, WeatherAttachment } from "@lifeos/core";
import {
  apiRequest,
  type AssetsResponse,
  type AiStatus,
  type AiStatusState,
  type AuthState,
  type BackupStatus,
  type BackupRetentionPolicy,
  type BackupRetentionView,
  type CycleModuleResponse,
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
import { AI_DEFAULT_BASE_URL } from "./settings-cards";
import { type CalendarWeather } from "./timeline";
import { CalendarSettingsPanel, CalendarSummaryMenu, CalendarView, CycleModuleDialog, CycleModulePanel } from "./calendar-view";
import { NoteEditorDialog, NotesLibrary, RecordEditorDialog, RelationPanel, type NoteDraft, type NoteSaveHandler, type RecordEditorDraft } from "./record-dialogs";
import { TaskSummary, taskDueLabel } from "./task-summary";
import { AssetPreview, CalendarDayMarkers, PrivacyMask, RecordPhotoGrid, Timeline, TimelineEntityChip, TimelineItem, assetContentUrl, assetThumbUrl, dayPhotoCandidates, dayPhotoIds, monthCellPhoto, periodMoonForDate, periodRuns, nextPredictedStart, weatherFromArchiveValue, recordsByDate, groupRecords, type ThumbnailWidth } from "./timeline";
import { ConfirmDialog, EntitiesView, EntityEditDialog, ImportDialog, LoginGate, MobileMenuDialog, PersonCardDialog, SearchDialog } from "./dialogs";
import { WelcomeGate } from "./WelcomeGate";
import { useWeatherAutoFollow } from "./weather-follow";
import { AiSettingsCard, AssetTrashSettingsCard, BackupSettingsCard, CycleSettingsCard, FontSettingsCard, SettingsView, ThumbnailCacheSettingsCard, WeatherSettingsCard } from "./settings-cards";
import { Composer, ReviewComposer, type ComposerProps } from "./composer";
import { AliasField, EntityCreateForm, MentionBox, aliasListFrom } from "./entity-forms";
import { DiagnosticsDrawer, EmptyState, ErrorState, LoadingState } from "./timeline-states";
import { ShotDropZone, resolveKnownShot, type ShotUpload } from "./shot-drop-zone";

import type { AppView, CalendarMode, ComposerKind, CreateEntity, EntityCreateRequest, SettingsPageId, UiFontId } from "./app-types";

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
  writeComposerShotsDraft,
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

function noteUpdatedAt(record: RecordView): string {
  return shortDate(lifeTimeDate(record.updatedAt ?? record.createdAt) ?? "");
}

const RECORDS_CACHE_LIMIT = 24;
const DEFAULT_MOVIE_MODULE_STATUS: MovieModuleStatus = { enabled: false, configured: false, keyConfigured: false, connected: false };

function clearTenantSensitiveBrowserStorage(): void {
  try {
    for (const key of ["lifeos.ai.chat", "lifeos.composerShots", "lifeos.hideDemo", "lifeos.moviePromptHidden"]) window.localStorage.removeItem(key);
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
  const [selectedDate, setSelectedDate] = useState(localDateToday);
  const [records, setRecords] = useState<readonly RecordView[] | null>(null);
  const [recordsQueryPath, setRecordsQueryPath] = useState<string | null>(null);
  const [recordsDisplayedDate, setRecordsDisplayedDate] = useState<string | null>(null);
  const [tasks, setTasks] = useState<readonly RecordView[] | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("week");
  const [cycleModule, setCycleModule] = useState<CycleIntimacyModuleData | null>(null);
  const [cycleModuleOpen, setCycleModuleOpen] = useState(false);
  const [cyclePanelOpen, setCyclePanelOpen] = useState(false);
  const [summaries, setSummaries] = useState<readonly DaySummary[]>([]);
  const [aiSummaries, setAiSummaries] = useState(false);
  // Calendar-local settings and the edit mode they can switch on. Drafts are keyed
  // by date and hold only days that were actually touched, so the save bar's count
  // is the number of edits rather than the number of cells.
  const [calendarSettingsOpen, setCalendarSettingsOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [summaryDrafts, setSummaryDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryBusyDate, setSummaryBusyDate] = useState<string | null>(null);
  const [summariesReload, setSummariesReload] = useState(0);
  const [weatherArchive, setWeatherArchive] = useState<ReadonlyMap<string, CalendarWeather>>(new Map());
  const [photoPreview, setPhotoPreview] = useState<{ assetIds: readonly string[]; index: number } | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerKind, setComposerKind] = useState<ComposerKind>("journal");
  const [composerContent, setComposerContent] = useState("");
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
  const [composerShots, setComposerShots] = useState<readonly AssetLink[]>(readComposerShotsDraft);
  const shotsDraftChecked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; tone: "ok" | "warn"; undo?: () => void } | null>(null);
  /** Held outside React state so clearing a toast can cancel its own timer. A
   *  toast that outlives its welcome leaves a dead "撤销" on screen. */
  const toastTimer = useRef<number | null>(null);
  const [authState, setAuthState] = useState<AuthState>({ required: true, authenticated: false });
  const [authResolved, setAuthResolved] = useState(false);
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
  const [weatherProfilesState, setWeatherProfilesState] = useState<WeatherProfilesState>({ phase: "loading", status: null });
  const [weatherProfilesRetry, setWeatherProfilesRetry] = useState(0);
  const weatherStatus = weatherProfilesState.status?.status ?? null;
  const [movieStatusState, setMovieStatusState] = useState<MovieModuleStatusState>({ phase: "loading", status: null });
  const [movieStatusRetry, setMovieStatusRetry] = useState(0);
  // Other parts of the app can hide optional movie affordances until the first
  // successful read. The settings card receives the source state separately
  // and never treats this display fallback as a persisted configuration.
  const movieStatus = movieStatusState.status ?? DEFAULT_MOVIE_MODULE_STATUS;
  const [backupStatus, setBackupStatus] = useState<BackupStatus>({ localDirectory: null, s3: { configured: false, enabled: false, endpoint: "", region: "", bucket: "", prefix: "backups/db", forcePathStyle: true }, schedule: { enabled: false, hour: 2, minute: 0, timeZone: "Asia/Shanghai", nextRunAt: null }, lastDualBackup: null, runs: [] });
  const [backupBusy, setBackupBusy] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<RecordView | null>(null);
  const [entityCard, setEntityCard] = useState<Entity | null>(null);
  const [editingEntity, setEditingEntity] = useState<Entity | null>(null);
  const [entityFilterId, setEntityFilterId] = useState<string | null>(null);
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
  const recordsPrefetchRef = useRef(new Map<string, AbortController>());
  const recordsCacheGenerationRef = useRef(0);
  const tasksRequestRef = useRef(0);
  const previousSettingsPageRef = useRef(settingsPage);

  const openSettingsPage = useCallback((page: SettingsPageId) => {
    const nextHash = settingsHash(page);
    if (window.location.hash !== nextHash) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
    setSettingsPage(page);
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

  // Only runs for a signed-in space whose device opted into follow mode. The
  // raw coordinates never reach storage; when the server resolves a different
  // city the weather is re-read so the header stops showing the old one.
  useWeatherAutoFollow(authState.account?.tenantId, retryWeatherProfiles);

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
    if (activeView === "today") params.set("date", selectedDate);
    if (activeView === "calendar") {
      // The month grid is always six weeks, so the cells spilling in from the
      // neighbouring months are populated by the same request.
      params.set("from", calendarRange[0] ?? selectedDate);
      params.set("to", calendarRange[calendarRange.length - 1] ?? selectedDate);
    }
    if (activeView === "timeline" && entityFilterId !== null) params.set("entityId", entityFilterId);
    if (activeView === "tasks") params.set("kind", "task");
    if (activeView === "notes") params.set("kind", "note");
    return `/api/records?${params.toString()}`;
  }, [activeView, entityFilterId, searchQuery, selectedDate, calendarRange]);

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

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<AuthState>("/api/auth", { signal: controller.signal }).then((state) => { authRef.current = state; setAuthState(state); setAuthResolved(true); }).catch((error) => { if (!controller.signal.aborted) { if (errorStatus(error) === 401) { const nextAuth = loggedOutAuth(authRef.current); authRef.current = nextAuth; setAuthState(nextAuth); } else setAuthError(errorMessage(error, "无法连接 LifeOS API")); setAuthResolved(true); } });
    return () => controller.abort();
  }, []);

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
    if (authState.required && !authState.authenticated) return () => controller.abort();
    apiRequest<BackupStatus>("/api/backup/status", { signal: controller.signal }).then((status) => { if (!controller.signal.aborted) setBackupStatus(status); }).catch(() => { if (!controller.signal.aborted) setBackupStatus((current) => current); });
    return () => controller.abort();
  }, [authState.authenticated, authState.required]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++recordsRequestRef.current;
    recordsCacheGenerationRef.current += 1;
    const prefetchGeneration = recordsCacheGenerationRef.current;
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
    if (cached !== undefined) {
      // The render path also reads this entry directly, while these state
      // updates make the cached key authoritative for actions and refs before
      // the background revalidation completes.
      setRecords(cached.items);
      setRecordsQueryPath(queryPath);
      setRecordsDisplayedDate(cached.selectedDate);
    }
    setRecordsLoading(true);
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

      // Daily navigation is the only path where an adjacent day is useful.
      // These requests are local records reads, share the full query (search
      // and entity filters included), and never update the visible list.
      if (activeView === "today") {
        const baseQuery = queryPath.indexOf("?") >= 0 ? queryPath.slice(queryPath.indexOf("?") + 1) : "";
        const prefetch = (date: string) => {
          const params = new URLSearchParams(baseQuery);
          params.set("date", date);
          const targetPath = `/api/records?${params.toString()}`;
          if (recordsCacheRef.current.has(targetPath) || recordsPrefetchRef.current.has(targetPath)) return;
          const prefetchController = new AbortController();
          recordsPrefetchRef.current.set(targetPath, prefetchController);
          apiRequest<RecordsResponse>(targetPath, { signal: prefetchController.signal }).then((next) => {
            if (prefetchController.signal.aborted || requestId !== recordsRequestRef.current || prefetchGeneration !== recordsCacheGenerationRef.current || (authState.required && !authState.authenticated)) return;
            cacheRecords(recordsCacheRef.current, targetPath, { items: next.items, selectedDate: date });
          }).catch(() => { /* Prefetch is an optimisation; the next visit retries normally. */ }).finally(() => {
            if (recordsPrefetchRef.current.get(targetPath) === prefetchController) recordsPrefetchRef.current.delete(targetPath);
          });
        };
        prefetch(shiftDate(selectedDate, -1));
        prefetch(shiftDate(selectedDate, 1));
      }
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
  }, [activeView, authState.authenticated, authState.required, handleRequestError, queryPath, recordsReload]);

  useEffect(() => {
    recordsRef.current = recordsForQuery ?? [];
    recordsLoadedRef.current = recordsForQuery !== null;
  }, [recordsForQuery]);

  /**
   * Month cells always carry a one-line summary, and the week grid carries it in
   * edit mode, where the day's existing sentence is the thing being edited — so
   * the window is fetched whenever either of those is on screen. The server owns
   * the cache — it keys on the record versions behind each day — so this asks for
   * the visible window and refetches after a write. A failure here is not
   * surfaced: the grid still knows every day number and record count, and a
   * summary is an extra, not the point.
   */
  useEffect(() => {
    const controller = new AbortController();
    if (activeView !== "calendar" || (calendarMode !== "month" && !editMode) || (authState.required && !authState.authenticated)) {
      setSummaries([]);
      return () => controller.abort();
    }
    const params = new URLSearchParams({
      from: calendarRange[0] ?? selectedDate,
      to: calendarRange[calendarRange.length - 1] ?? selectedDate,
      timeZone: USER_TIME_ZONE,
    });
    apiRequest<SummariesResponse>(`/api/summaries?${params.toString()}`, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSummaries(payload.items);
        setAiSummaries(payload.ai);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSummaries([]);
        setAiSummaries(false);
      });
    return () => controller.abort();
  }, [activeView, calendarMode, editMode, calendarRange, selectedDate, authState.authenticated, authState.required, recordsReload, summariesReload]);

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
    setOccurredAt(localNowInputFor(selectedDate));
    const timer = window.setInterval(() => setOccurredAt(localNowInputFor(selectedDate)), 15_000);
    return () => window.clearInterval(timer);
  }, [occurredAtDirty, selectedDate]);

  // Moving to another day starts with a clean, explicit backfill choice.
  useEffect(() => setComposerBackfill(false), [selectedDate]);

  const refresh = () => { reloadRecords(); setTasksReload((current) => current + 1); setRelationReload((current) => current + 1); setCycleModuleReload((current) => current + 1); };
  const navigate = (view: AppView) => {
    if (view === "settings") { openSettingsPage(DEFAULT_SETTINGS_PAGE); return; }
    if (window.location.hash.startsWith("#settings")) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    setActiveView(view); setMobileMenuOpen(false); if (view !== "timeline") setEntityFilterId(null); if (view === "tasks") setComposerKind("task"); if (view === "notes") setComposerKind("note");
  };
  /**
   * A calendar cell is a way back into the day it stands for — except while the
   * cycle panel is open. There a cell only picks the date a private record
   * lands on, so the panel and the grid stay in front of you.
   */
  const openDay = (date: string) => {
    setSelectedDate(date);
    if (cyclePanelOpen) return;
    setActiveView("today");
    setMobileMenuOpen(false);
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
  const handleShotsCleared = (cleared: readonly AssetLink[], restore: () => void) => showToast(`已清空 ${cleared.length} 张照片`, "ok", () => { restore(); showToast(`已恢复 ${cleared.length} 张照片`); });

  // An unsent drop is worth keeping: the files are already on disk, so losing
  // the draft would leave nothing behind but orphans.
  useEffect(() => { writeComposerShotsDraft(composerShots); }, [composerShots]);

  // A restored draft can name an asset the collector already took away. Check
  // it once against the real asset list rather than rendering a broken
  // thumbnail forever, and say what happened.
  useEffect(() => {
    if (shotsDraftChecked.current) return;
    if (composerShots.length === 0) { shotsDraftChecked.current = true; return; }
    if (!assetsLoaded) return;
    shotsDraftChecked.current = true;
    const live = new Set(assets.map((asset) => asset.id));
    const kept = composerShots.filter((shot) => live.has(shot.assetId));
    const dropped = composerShots.length - kept.length;
    if (dropped === 0) { showToast(`已恢复上次没发出的 ${kept.length} 张照片`); return; }
    setComposerShots(kept);
    showToast(kept.length === 0 ? `草稿里 ${dropped} 张照片已被清理，已从投放区移除` : `草稿里 ${dropped} 张照片已被清理，保留剩下 ${kept.length} 张`);
  }, [assets, assetsLoaded, composerShots, showToast]);
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
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const path = action === "local" ? "/api/backup/local" : action === "s3" ? "/api/backup/s3" : action === "dual" ? "/api/backup/dual" : "/api/backup/s3/test";
      const result = await apiRequest<{ ok: boolean; fileName?: string; location?: string; transport?: "http" | "file"; warning?: string; status?: "success" | "partial" | "local_only" | "failed"; s3?: { status?: "success" | "failed" | "skipped"; error?: string; location?: string } }> (path, { method: "POST", body: "{}" });
      setBackupStatus(await apiRequest<BackupStatus>("/api/backup/status"));
      const remoteWroteLocally = result.transport === "file" || result.location?.startsWith("file:") === true || result.s3?.location?.startsWith("file:") === true;
      showToast(action === "test"
        ? remoteWroteLocally ? "连接测试只写入了本机目录，未联网 —— 请检查 Endpoint" : "对象存储连接成功"
        : action === "s3"
          ? remoteWroteLocally ? `只写入本机目录，未联网${result.fileName ? `：${result.fileName}` : ""}` : `已上传对象存储${result.fileName ? `：${result.fileName}` : ""}`
          : action === "dual"
            ? result.status === "success" ? remoteWroteLocally ? "双备份已完成，但远端只写入了本机目录" : "双备份已完成" : result.status === "local_only" ? "本地备份已完成，远端已跳过" : result.status === "partial" ? "本地备份已完成，但远端失败" : "本地备份失败"
            : "本地备份已完成");
    } catch (error) {
      try { setBackupStatus(await apiRequest<BackupStatus>("/api/backup/status")); } catch { /* keep the existing status when the follow-up read also fails */ }
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
  /** How long a run lasts is the one number she tunes from the calendar itself. */
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
  const changeEditMode = async (value: boolean) => {
    if (value) { setEditMode(true); return; }
    if (summaryDrafts.size > 0 && !summarySaving && !(await saveSummaryDrafts())) return;
    setEditMode(false);
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
    if (next !== "month" && editMode) void changeEditMode(false);
  };
  const editSummaryDraft = (date: string, text: string) => {
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
  const discardSummaryDrafts = () => setSummaryDrafts(new Map());
  /** Writes every pending draft in one request, and says whether the text landed. */
  const saveSummaryDrafts = async (): Promise<boolean> => {
    if (summaryDrafts.size === 0 || summarySaving) return true;
    setSummarySaving(true);
    const entries = [...summaryDrafts].map(([date, text]) => ({ date, text }));
    try {
      await apiRequest<SummaryManualResponse>("/api/summaries/manual", { method: "POST", body: JSON.stringify({ entries, timeZone: USER_TIME_ZONE }) });
      setSummaryDrafts(new Map());
      setSummariesReload((current) => current + 1);
      showToast(entries.length === 1 ? "小结已保存" : `已保存 ${entries.length} 天的小结`);
      return true;
    } catch (error) {
      // The drafts stay put: a failed save must not look like a successful one.
      showToast(handleRequestError(error, "小结保存失败，请重试"), "warn");
      return false;
    } finally {
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
      await apiRequest<SummaryManualResponse>("/api/summaries/manual", { method: "POST", body: JSON.stringify({ entries: [{ date, text: "" }], timeZone: USER_TIME_ZONE }) });
      setSummaryDrafts((current) => { const next = new Map(current); next.delete(date); return next; });
      setSummariesReload((current) => current + 1);
      showToast(`${displayDate(date)} 的小结已恢复原样`);
    } catch (error) {
      showToast(handleRequestError(error, "恢复原样失败，请重试"), "warn");
    } finally {
      setSummaryBusyDate(null);
    }
  };

  useEffect(() => { installDiagnostics(); }, []);

  const handleCreateEntity = async (type: EntityKind, name: string, extras?: { readonly aliases?: readonly string[]; readonly role?: PlaceRole; readonly period?: PlacePeriod; readonly address?: string }): Promise<Entity | null> => {
    try {
      const payloadBody = {
        type,
        name,
        ...(extras?.aliases === undefined ? {} : { aliases: extras.aliases }),
        ...(type === "place" && extras?.role !== undefined ? { role: extras.role } : {}),
        ...(type === "place" && extras?.period !== undefined ? { period: extras.period } : {}),
        ...(type === "place" && extras?.address !== undefined ? { address: extras.address } : {}),
      };
      const entity = await apiRequest<Entity>("/api/entities", { method: "POST", body: JSON.stringify(payloadBody) });
      setEntities((current) => [...current, entity]);
      showToast(`已新建${ENTITY_META[type].label}「${name}」`);
      return entity;
    } catch (error) {
      showToast(handleRequestError(error, "新建关联对象失败，请重试"), "warn");
      return null;
    }
  };
  const handleSaveEntity = async (entity: Entity, patch: { name: string; aliases: readonly string[]; description?: string; address?: string | null }): Promise<Entity | null> => {
    try {
      const updated = await apiRequest<Entity>(`/api/entities/${encodeURIComponent(entity.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      setEntities((current) => current.map((item) => item.id === updated.id ? updated : item));
      showToast(`${updated.type === "place" ? "地点" : "联系人"}「${updated.name}」已更新`);
      return updated;
    } catch (error) {
      showToast(handleRequestError(error, "人物资料保存失败，请重试"), "warn");
      return null;
    }
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setSearchQuery(searchInput.trim()); };

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
  const uploadComposerShot = async (file: File): Promise<ShotUpload | null> => {
    try {
      const hash = await sha256Hex(file);
      if (hash !== null) {
        const known = await resolveKnownShot(hash);
        if (known !== null) {
          setAssets((current) => current.some((asset) => asset.id === known.id) ? current : [...current, known]);
          return { asset: known, reused: true };
        }
      }
      const asset = await apiRequest<Asset>(`/api/assets/uploads?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      // The upload route reuses the row the library already holds, so this can
      // hand back an asset that is already in the list — the resolve above is a
      // courtesy, not a guarantee. Appending it again would put one id in twice,
      // which is the same collision the drop zone guards against, one level up.
      setAssets((current) => current.some((held) => held.id === asset.id) ? current : [...current, asset]);
      return { asset, reused: false };
    } catch (error) {
      showToast(handleRequestError(error, "照片上传失败，请重试"), "warn");
      return null;
    }
  };

  const handleCreate = async () => {
    const content = composerContent;
    if (!content.trim() || saving) return;
    const isTodaySelection = selectedDate === localDateToday();
    // The field already defaults to the current minute, so "now" is the normal
    // path; clearing it means "no explicit time" and falls back to the entry moment.
    const occurred = occurredAt ? instantFromInput(occurredAt) : isTodaySelection ? undefined : dateOnly(selectedDate);
    const due = dueAt ? instantFromInput(dueAt) : undefined;
    if ((occurredAt && !occurred) || (dueAt && !due)) { showToast("请检查时间格式后再保存", "warn"); return; }
    const payload: RecordWritePayload = { kind: composerKind, content, ...(occurred ? { occurredAt: occurred } : {}), ...(composerKind === "task" && dueAt && due ? { dueAt: due } : {}), ...(composerPrivate ? { isPrivate: true } : {}), ...(composerBackfill && !isTodaySelection ? { isBackfill: true } : {}), ...(composerWeather === null ? {} : { weather: composerWeather }), ...(composerMovieRefs.length === 0 ? {} : { entityRefs: composerMovieRefs }), ...(composerShots.length === 0 ? {} : { assetRefs: composerShots }) };
    setSaving(true);
    setActionMessage(null);
    try { await apiRequest<RecordView>("/api/records", { method: "POST", body: JSON.stringify(payload) }); setComposerContent(""); setComposerMovieRefs([]); setComposerShots([]); setComposerPrivate(false); setComposerBackfill(false); setComposerWeather(null); setOccurredAtDirty(false); setDueAt(""); showToast("已保存到时间轴"); refresh(); } catch (error) { showToast(handleRequestError(error, "保存失败，请重试")); } finally { setSaving(false); }
  };

  const noteDetailsPayload = (draft: NoteDraft): NoteDetails => {
    if (draft.format === "article") return { format: "article", title: draft.title.trim() };
    if (draft.format === "quote") return { format: "quote", ...(draft.source.trim() ? { source: draft.source.trim() } : {}) };
    return { format: "fragment" };
  };

  const handleSaveNote: NoteSaveHandler = async (record, draft) => {
    const note = noteDetailsPayload(draft);
    try {
      if (record === null) {
        const payload: RecordWritePayload = { kind: "note", content: draft.content, note };
        await apiRequest<RecordView>("/api/records", { method: "POST", body: JSON.stringify(payload) });
        showToast("笔记已保存");
      } else {
        const payload: RecordWritePayload = {
          revision: record.revision,
          ...(draft.content !== recordText(record) ? { content: draft.content } : {}),
          ...(draft.metadataTouched ? { note } : {}),
        };
        await apiRequest<RecordView>(`/api/records/${encodeURIComponent(record.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
        showToast("笔记已更新，原文仍保留");
      }
      refresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: errorStatus(error) === 409 ? "笔记版本已变化，请重新打开后保存" : handleRequestError(error, "笔记保存失败，请重试") };
    }
  };

  const handleDemo = async () => {
    if (creatingDemo) return;
    setCreatingDemo(true);
    setActionMessage(null);
    const examples: readonly { kind: ComposerKind; content: string; hour: string; dueHour?: string }[] = [{ kind: "journal", content: "今天先把生活记录从一句话开始。", hour: "09:10" }, { kind: "note", content: "把值得回看的想法留在自己的时间轴里。", hour: "12:40" }, { kind: "task", content: "晚间整理今天的三条记录", hour: "16:20", dueHour: "19:00" }];
    try { for (const example of examples) { const occurred = instantFromInput(`${selectedDate}T${example.hour}`); const due = example.dueHour ? instantFromInput(`${selectedDate}T${example.dueHour}`) : undefined; if (!occurred) throw new Error("预置记录时间无效"); const payload: RecordWritePayload = { kind: example.kind, content: example.content, occurredAt: occurred, isDemo: true, ...(due ? { dueAt: due } : {}) }; await apiRequest<RecordView>("/api/records", { method: "POST", body: JSON.stringify(payload) }); } showToast("已加入 3 条预置记录，可随时删除"); refresh(); } catch (error) { showToast(handleRequestError(error, "预置记录创建失败，请重试")); } finally { setCreatingDemo(false); }
  };

  const handleEdit = (record: RecordView) => { setEditError(null); setEditingRecord(record); };

  const handleSaveEdit = async (record: RecordView, draft: RecordEditorDraft) => {
    const occurredPatch = draft.occurredDirty ? (draft.occurredAt ? instantFromInput(draft.occurredAt) : null) : undefined;
    if (draft.occurredDirty && draft.occurredAt && !occurredPatch) { setEditError("发生时间格式无效"); return; }
    const duePatch = draft.dueDirty ? (draft.dueAt ? instantFromInput(draft.dueAt) : null) : undefined;
    if (draft.dueDirty && draft.dueAt && !duePatch) { setEditError("截止时间格式无效"); return; }
    const payload: RecordWritePayload = { revision: record.revision, entityRefs: draft.entityRefs, relatedRecordIds: draft.relatedRecordIds, assetRefs: draft.assetRefs, ...(draft.content !== recordText(record) ? { content: draft.content } : {}), ...(draft.occurredDirty ? { occurredAt: occurredPatch ?? null } : {}), ...(isTaskRecord(record) && draft.dueDirty ? { dueAt: duePatch ?? null } : {}), ...(isTaskRecord(record) && draft.status !== record.task.status ? { status: draft.status } : {}), ...(draft.isPrivate !== (record.isPrivate === true) ? { isPrivate: draft.isPrivate } : {}), ...(draft.isBackfill !== (record.isBackfill === true) ? { isBackfill: draft.isBackfill } : {}) };
    setEditSaving(true);
    setEditError(null);
    try { await apiRequest<RecordView>(`/api/records/${encodeURIComponent(record.id)}`, { method: "PATCH", body: JSON.stringify(payload) }); setEditingRecord(null); showToast("修改已保存，原文仍保留"); refresh(); } catch (error) { setEditError(errorStatus(error) === 409 ? "编辑冲突：记录已被其他操作更新，草稿仍保留。请读取最新版本后合并。" : handleRequestError(error, "修改保存失败，请重试")); } finally { setEditSaving(false); }
  };

  const handleReloadLatest = async () => {
    if (!editingRecord) return;
    setEditReloading(true);
    try { const payload = await apiRequest<RecordsResponse>(`/api/records?timeZone=${encodeURIComponent(USER_TIME_ZONE)}`); const latest = payload.items.find((record) => record.id === editingRecord.id); if (!latest) throw new Error("找不到这条记录的最新版本"); setEditingRecord(latest); setEditError("已读取最新版本，草稿仍保留在编辑框中。请比较后再保存。"); } catch (error) { setEditError(handleRequestError(error, "无法读取最新版本，请重试")); } finally { setEditReloading(false); }
  };

  const handleDelete = async () => {
    if (!deleteRecord) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try { await apiRequest<void>(`/api/records/${encodeURIComponent(deleteRecord.id)}`, { method: "DELETE", body: JSON.stringify({ revision: deleteRecord.revision }) }); setDeleteRecord(null); showToast("记录已删除"); refresh(); } catch (error) { setDeleteError(errorStatus(error) === 409 ? "记录已更新，无法按旧版本删除。请关闭后重新加载。" : handleRequestError(error, "删除失败，请重试")); } finally { setDeleteBusy(false); }
  };

  const syncTaskRecord = (updated: RecordView) => {
    reloadRecords();
    setRecords((current) => current === null ? current : current.map((item) => item.id === updated.id ? updated : item));
    setTasks((current) => current === null ? current : current.map((item) => item.id === updated.id ? updated : item));
  };

  const handleTaskStatus = async (record: TaskRecordView, status: TaskStatus, options?: { readonly sync?: boolean; readonly feedback?: boolean }): Promise<RecordView | null> => {
    try {
      const updated = await apiRequest<RecordView>(`/api/records/${encodeURIComponent(record.id)}`, { method: "PATCH", body: JSON.stringify({ revision: record.revision, status }) });
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
  const isReviewingPast = isToday && selectedDate < localDateToday();
  // Views that own their column outright: no composer bar, no page actions. The
  // time machine is one of them — there is nothing to write while reading history,
  // and the composer would push the axis down the page. It keeps the task column,
  // like the calendar does.
  const hidesComposer = activeView === "settings" || activeView === "entities" || activeView === "timemachine" || activeView === "notes";
  const showComposer = isToday || (!hidesComposer && composerOpen);
  // Calendar owns its compact range navigation and backfill entry. Letting the
  // generic page header render there would leave a wide, almost-empty row whose
  // only job was the old "新建记录" button.
  const showPageActions = activeView !== "notes" && Boolean(searchQuery || entityFilterId !== null || (!hidesComposer && !isToday && activeView !== "calendar"));
  const loadedVisibleRecords = hideDemo && recordsForQuery ? recordsForQuery.filter((record) => !isDemoRecord(record)) : recordsForQuery;
  // The notes route owns its own library. Other record surfaces deliberately
  // receive a note-free view even when an old note carries occurredAt.
  const visibleRecords = activeView === "notes" ? loadedVisibleRecords : loadedVisibleRecords?.filter((record) => record.kind !== "note") ?? loadedVisibleRecords;
  const visibleTasks = hideDemo && tasks ? tasks.filter((record) => !isDemoRecord(record)) : tasks;
  // Which places were written about most recently, so the mention picker can put
  // them first. Derived from the records rather than tracked separately: the
  // evidence is already in every saved record's entityRefs.
  const recentPlaces = useMemo(() => recentPlaceIds(visibleRecords ?? []), [visibleRecords]);
  const composerProps: ComposerProps = {
    onShotsCleared: handleShotsCleared,
    kind: composerKind,
    content: composerContent,
    entities,
    recentPlaceIds: recentPlaces,
    movieEnabled: movieStatus.enabled,
    movieRefs: composerMovieRefs,
    onMovieRefsChange: setComposerMovieRefs,
    onMovieEntity: rememberMovieEntity,
    onCreateEntity: handleCreateEntity,
    onOpenSearch: () => setSearchDialogOpen(true),
    occurredAt,
    dueAt,
    isPrivate: composerPrivate,
    isBackfill: composerBackfill,
    selectedDate,
    saving,
    // Review mode needs a way back: the bar would otherwise be a one-way door,
    // since the Today view normally has no close button. The ✕ folds the editor
    // back into the bar rather than discarding anything.
    dismissible: isReviewingPast || !isToday,
    occurredDirty: occurredAtDirty,
    weather: composerWeather,
    weatherBusy: composerWeatherBusy,
    onCaptureWeather: () => void captureComposerWeather(),
    onClearWeather: () => setComposerWeather(null),
    onKindChange: setComposerKind,
    onContentChange: setComposerContent,
    onOccurredAtChange: (value) => { setOccurredAt(value); setOccurredAtDirty(true); },
    onDueAtChange: setDueAt,
    onPrivateChange: setComposerPrivate,
    onBackfillChange: setComposerBackfill,
    shots: composerShots,
    onShotsChange: setComposerShots,
    onUploadShot: uploadComposerShot,
    onNotify: showToast,
    onSubmit: () => void handleCreate(),
    onClose: () => { setComposerOpen(false); setComposerWeather(null); setComposerMovieRefs([]); setComposerShots([]); },
  };
  const summaryMap = useMemo(() => new Map(summaries.map((summary) => [summary.date, summary])), [summaries]);
  if (!authResolved) return <main className="auth-screen"><div className="auth-panel surface" role="status"><LoaderCircle className="spin" size={22} aria-hidden="true" /><p className="auth-description">正在检查账号会话…</p></div></main>;
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
  const openCalendarBackfill = () => {
    setComposerKind("journal");
    setComposerBackfill(selectedDate < localDateToday());
    setComposerOpen(true);
  };
  const onNavigate = navigate;

  return <div className="app-shell"><Sidebar activeView={activeView} onNavigate={navigate} /><main className="main-column"><header className="topbar"><div className="topbar-layout"><WeatherHeader selectedDate={selectedDate} status={weatherStatus} onOpenSettings={() => openSettingsPage("integrations/weather")} onDateChange={setSelectedDate} onDateStep={activeView === "calendar" ? stepCalendar : undefined} onNotice={(message, tone) => showToast(message, tone ?? "warn")} showDateNavigation={activeView !== "calendar"} /><div className="topbar-actions"><form className="search-form" onSubmit={submitSearch} role="search"><Search className="search-leading-icon" size={17} strokeWidth={1.8} aria-hidden="true" /><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索记录" aria-label="搜索记录" />{searchInput ? <button className="search-clear" type="button" aria-label="清空搜索" onClick={() => { setSearchInput(""); setSearchQuery(""); }}><X size={15} strokeWidth={1.9} aria-hidden="true" /></button> : null}<span className="search-divider" aria-hidden="true" /><button className="search-submit" type="submit" aria-label="提交搜索"><Search size={16} strokeWidth={2} aria-hidden="true" /></button></form><button className="icon-button mobile-search-button" type="button" onClick={() => setSearchDialogOpen(true)} aria-label="搜索记录"><Search size={17} strokeWidth={1.9} aria-hidden="true" /></button></div></div></header><div className="content-grid"><div className="content-column">{showPageActions ? <div className="page-heading page-heading-actions"><div className="heading-actions">{searchQuery ? <span className="search-context">正在搜索 “{searchQuery}”</span> : null}{entityFilterId !== null ? <button className="entity-filter-chip" type="button" onClick={() => setEntityFilterId(null)} aria-label="清除人物筛选">人物：{entities.find((entity) => entity.id === entityFilterId)?.name ?? entityFilterId}<X size={13} aria-hidden="true" /></button> : null}{activeView !== "settings" && !isToday && activeView !== "calendar" ? <button className="secondary-button heading-create-button" type="button" onClick={() => { setComposerKind(activeView === "tasks" ? "task" : "journal"); setComposerOpen(true); }}><Plus size={16} aria-hidden="true" /><span>新建{activeView === "tasks" ? "任务" : "记录"}</span></button> : null}</div></div> : null}{showComposer ? (isReviewingPast ? <ReviewComposer {...composerProps} /> : <Composer {...composerProps} />) : null}{activeView === "settings"
       ? <SettingsView page={settingsPage} onNavigatePage={openSettingsPage} onImport={() => fileInputRef.current?.click()} onLogout={() => void handleLogout()} logoutBusy={logoutBusy} authRequired={authState.required} accountMode={authState.accountMode === true} account={authState.account} aiStatusState={aiStatusState} onAiStatusChange={onAiStatusChange} onRetryAiStatus={retryAiStatus} assistantVisible={assistantVisible} onAssistantVisibleChange={setAssistantVisibility} backupStatus={backupStatus} backupBusy={backupBusy} onBackup={(action) => void handleBackup(action)} onBackupStatusChange={setBackupStatus} weatherProfilesState={weatherProfilesState} onWeatherStatusChange={onWeatherStatusChange} onRetryWeatherProfiles={retryWeatherProfiles} movieStatusState={movieStatusState} onMovieStatusChange={onMovieStatusChange} onRetryMovieStatus={retryMovieStatus} demoCount={demoCount} hideDemo={hideDemo} demoBusy={demoBusy} demoDeleteArmed={demoDeleteArmed} onToggleDemo={toggleDemo} onDeleteDemo={() => void handleDeleteDemo()} uiFont={uiFont} onUiFontChange={setUiFont} onAssetsChanged={refresh} cycleModule={cycleModule} onSaveCycleConfig={saveCycleModuleConfig} />
      : activeView === "entities"
        ? <EntitiesView entities={entities} records={visibleRecords ?? []} onCreateEntity={handleCreateEntity} onEdit={setEditingEntity} onViewRecords={(entity) => { setEntityFilterId(entity.id); setActiveView("timeline"); }} />
      : activeView === "notes"
        ? <NotesLibrary records={visibleRecords} loading={recordsLoading} error={recordsError} entities={entities} onRetry={() => setRecordsReload((current) => current + 1)} onCreateEntity={handleCreateEntity} onSave={handleSaveNote} onDelete={(record) => { setDeleteError(null); setDeleteRecord(record); }} />
      : activeView === "calendar"
        ? <CalendarView mode={calendarMode} onModeChange={switchCalendarMode} onStep={stepCalendar} onOpenBackfill={openCalendarBackfill} anchor={selectedDate} today={localDateToday()} records={visibleRecords} assets={assets} summaries={summaryMap} aiEnabled={aiSummaries} weatherByDate={weatherArchive} loading={recordsLoading} error={recordsError} cycleModule={cycleModule} cyclePanelOpen={cyclePanelOpen} onOpenCycleModule={() => setCyclePanelOpen((current) => !current)} onOpenCycleSettings={() => openSettingsPage("private/cycle")} onSaveCycleConfig={saveCycleModuleConfig} onAddCycleModuleEvent={addCycleModuleEvent} onDeleteCycleModuleEvent={deleteCycleModuleEvent} onSavePeriodLength={saveCyclePeriodLength} onSaveCycleLength={saveCycleLength} onRetry={() => setRecordsReload((current) => current + 1)} onOpenDay={openDay} settingsOpen={calendarSettingsOpen} onToggleSettings={() => setCalendarSettingsOpen((current) => !current)} aiStatusState={aiStatusState} onAiStatusChange={onAiStatusChange} onRetryAiStatus={retryAiStatus} editMode={editMode} onEditModeChange={changeEditMode} drafts={summaryDrafts} onDraftChange={editSummaryDraft} summarySaving={summarySaving} onSaveDrafts={() => void saveSummaryDrafts()} onDiscardDrafts={discardSummaryDrafts} onRegenerateSummary={regenerateDaySummary} onRevertSummary={revertDaySummary} busyDate={summaryBusyDate} />
      : activeView === "timemachine"
        ? <TimeMachine />
      : <Timeline records={visibleRecords} assets={assets} entities={entities} loading={recordsInitialLoading} refreshing={recordsRefreshing || !recordsAreCurrent} error={recordsErrorForQuery} selectedDate={recordsForQueryDate} activeView={activeView} searchQuery={searchQuery} movieEnabled={movieStatus.enabled} moviePromptHidden={moviePromptHidden} onMovieAttachToRecord={attachMovieToRecord} onMoviePromptSuppress={suppressMoviePrompt} onRetry={reloadRecords} onDemo={() => void handleDemo()} creatingDemo={creatingDemo} onEdit={(record) => { if (recordsInteractionEnabled) handleEdit(record); }} onDelete={(record) => { if (!recordsInteractionEnabled) return; setDeleteError(null); setDeleteRecord(record); }} onTaskStatus={(record, status) => { if (recordsInteractionEnabled) void handleTaskStatus(record, status); }} onPreviewAsset={(assetIds, index) => setPhotoPreview({ assetIds, index })} onOpenEntity={setEntityCard} interactionDisabled={!recordsInteractionEnabled} dataCurrent={recordsAreCurrent} />}</div>{activeView !== "settings" ? <TaskSummary tasks={visibleTasks} loading={tasksLoading} error={tasksError} onTaskStatus={(record, status) => handleTaskStatus(record, status, { sync: false, feedback: false })} onTaskStateChange={syncTaskRecord} /> : null}</div></main><MobileNav activeView={activeView} onNavigate={navigate} onMore={() => setMobileMenuOpen(true)} moreOpen={mobileMenuOpen} />{actionMessage ? <div className={`action-toast ${actionMessage.tone === "warn" ? "is-warning" : ""}`} role="status">{actionMessage.tone === "warn" ? <AlertCircle size={16} strokeWidth={2} aria-hidden="true" /> : <Check size={16} strokeWidth={2} aria-hidden="true" />}<span className="action-toast-text">{actionMessage.text}</span>{actionMessage.undo ? <button className="action-toast-undo" type="button" onClick={() => { const undo = actionMessage.undo; dismissToast(); undo?.(); }}>撤销</button> : null}</div> : null}<CycleModuleDialog open={cycleModuleOpen} module={cycleModule} selectedDate={selectedDate} onClose={() => setCycleModuleOpen(false)} onSaveConfig={saveCycleModuleConfig} onAddEvent={addCycleModuleEvent} onDeleteEvent={deleteCycleModuleEvent} /><MobileMenuDialog open={mobileMenuOpen} activeView={activeView} onClose={() => setMobileMenuOpen(false)} onNavigate={onNavigate} onOpenSearch={() => setSearchDialogOpen(true)} /><SearchDialog open={searchDialogOpen} initialQuery={searchInput} onClose={() => setSearchDialogOpen(false)} onSearch={(query) => { setSearchInput(query); setSearchQuery(query); }} /><DiagnosticsDrawer /><RecordEditorDialog record={editingRecord} saving={editSaving} reloading={editReloading} error={editError} entities={entities} assets={assets} candidates={(recordsForQuery ?? []).filter((candidate) => candidate.id !== editingRecord?.id)} onCreateEntity={handleCreateEntity} onClose={() => { if (!editSaving) setEditingRecord(null); }} onSave={(record, draft) => void handleSaveEdit(record, draft)} onReloadLatest={() => void handleReloadLatest()} /><ConfirmDialog record={deleteRecord} busy={deleteBusy} error={deleteError} onClose={() => { if (!deleteBusy) setDeleteRecord(null); }} onConfirm={() => void handleDelete()} /><ImportDialog file={importFile} busy={importBusy} error={importError} onClose={() => { if (!importBusy) setImportFile(null); }} onConfirm={() => void handleImportConfirm()} /><PersonCardDialog entity={entityCard} entities={entities} onClose={() => setEntityCard(null)} onEdit={(entity) => { setEntityCard(null); setEditingEntity(entity); }} onViewRecords={(entity) => { setEntityCard(null); setEntityFilterId(entity.id); setActiveView("timeline"); }} onMovieSaved={rememberMovieEntity} /><EntityEditDialog entity={editingEntity} onClose={() => setEditingEntity(null)} onSave={handleSaveEntity} /><input ref={fileInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file) { setImportError(null); setImportFile(file); } event.target.value = ""; }} />{photoPreview === null ? null : <AssetPreview assetIds={photoPreview.assetIds} index={photoPreview.index} assets={assets} onClose={() => setPhotoPreview(null)} onIndexChange={(index) => setPhotoPreview((current) => current === null ? null : { ...current, index })} />}<AIAssistant status={aiStatus} visible={assistantVisible} onOpenSettings={() => openSettingsPage("integrations/ai")} /></div>;
}

export default App;

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("LifeOS root element is missing");
createRoot(rootElement).render(<App />);
