import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
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
  ClipboardCopy,
  CloudUpload,
  CloudSun,
  ContactRound,
  Download,
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
  Menu,
  NotebookPen,
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
import { MENTION_MARKERS, PLACE_MARKER, PLACE_ROLES, SUMMARY_MAX_LENGTH, entitySearchTerms, findEntityMentions, normalizeEntitySearchTerm, trimSummaryText, type PlacePeriod, type PlaceRole } from "@lifeos/core";
import { clearLogs, copyRecentJson, installDiagnostics, recentLogs, subscribe } from "./diagnostics";
import { sha256Hex } from "./contentHash";
import type { Asset, AssetKind, AssetLink, AssetRole, CycleIntimacyEventKind, CycleIntimacyModuleConfig, CycleIntimacyModuleData, DaySummary, Entity, EntityKind, EntityRef, RecordKind, RelationKind, TaskStatus, WeatherAttachment } from "@lifeos/core";
import {
  apiRequest,
  type AssetsResponse,
  type AiStatus,
  type AuthState,
  type BackupStatus,
  type BackupRetentionPolicy,
  type BackupRetentionView,
  type EntitiesResponse,
  type MovieEntity,
  type MovieModuleStatus,
  type RecordView,
  type RecordsResponse,
  type RecordWritePayload,
  type SummariesResponse,
  type TaskRecordView,
  type WeatherCurrentResponse,
  type WeatherArchiveResponse,
  type WeatherProfilesResponse,
  type WeatherStatus,
} from "./api";
import { AIAssistant } from "./AIAssistant";
import { calendarDayInfo } from "./calendarData";
import { peekScore, scorePhoto, storyWeight } from "./photoScore";
import { WeatherHeader } from "./WeatherHeader";
import { BackupCalendar } from "./BackupCalendar";
import { getWeatherEmoji, type WeatherDay, type WeatherProfile } from "./weather";
import {
  dateKeyForRecord,
  dateOnly,
  datesOfWeek,
  displayDate,
  instantFromInput,
  lifeTimeDate,
  lifeTimeTime,
  lifeTimeToInput,
  localDateToday,
  localNowInputFor,
  monthGridDates,
  monthTitle,
  shiftDate,
  shiftMonth,
  shortDate,
  USER_TIME_ZONE,
  weekdayShort,
} from "./time";
import { registerWebMcp } from "./webmcp";
import { enabledModuleCommands, fetchMovieModuleStatus, movieRef, MovieAddPanel, MovieCardDialog, MoviePrompt, MovieSettingsCard, type ModuleCommand } from "./movie";
import "./styles.css";

type AppView = "today" | "timeline" | "calendar" | "tasks" | "notes" | "entities" | "settings";
type CalendarMode = "week" | "month";
type ComposerKind = Extract<RecordKind, "journal" | "task" | "event" | "note">;
/** Everything the create form can collect in one shot. */
interface EntityCreateRequest { readonly type: "person" | "place"; readonly name: string; readonly aliases?: readonly string[]; readonly role?: PlaceRole; readonly period?: PlacePeriod; readonly address?: string; }
type CreateEntity = (type: EntityKind, name: string, extras?: { readonly aliases?: readonly string[]; readonly role?: PlaceRole; readonly period?: PlacePeriod; readonly address?: string }) => Promise<Entity | null>;

const DEMO_ID_PREFIX = "demo-";
const DEMO_HIDDEN_STORAGE_KEY = "lifeos.hideDemo";
const MOVIE_PROMPT_HIDDEN_STORAGE_KEY = "lifeos.moviePromptHidden";
/**
 * Photos dropped beside the entry box are uploaded the moment they land, so
 * an unsent draft has real files behind it. Keeping the draft in this browser
 * means switching views — or reloading — does not throw those photos away.
 */
const COMPOSER_SHOTS_STORAGE_KEY = "lifeos.composerShots";
const ASSET_ROLE_VALUES: readonly AssetRole[] = ["photo", "recording", "attachment"];

/**
 * Rebuilds a stored draft defensively. A draft is a convenience, never a
 * source of truth, so anything malformed is dropped rather than trusted.
 */
function readComposerShotsDraft(): readonly AssetLink[] {
  try {
    const raw = window.localStorage.getItem(COMPOSER_SHOTS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const shots = (parsed as { shots?: unknown }).shots;
    if (!Array.isArray(shots)) return [];
    return shots.flatMap((shot) => {
      if (typeof shot !== "object" || shot === null) return [];
      const candidate = shot as { assetId?: unknown; role?: unknown; label?: unknown };
      if (typeof candidate.assetId !== "string" || candidate.assetId.length === 0) return [];
      if (!ASSET_ROLE_VALUES.includes(candidate.role as AssetRole)) return [];
      if (candidate.label !== undefined && typeof candidate.label !== "string") return [];
      const link: AssetLink = { assetId: candidate.assetId, role: candidate.role as AssetRole, ...(typeof candidate.label === "string" ? { label: candidate.label } : {}) };
      return [link];
    });
  } catch {
    return [];
  }
}

function writeComposerShotsDraft(shots: readonly AssetLink[]): void {
  try {
    if (shots.length === 0) window.localStorage.removeItem(COMPOSER_SHOTS_STORAGE_KEY);
    else window.localStorage.setItem(COMPOSER_SHOTS_STORAGE_KEY, JSON.stringify({ shots, savedAt: new Date().toISOString() }));
  } catch {
    // Storage can be blocked or full; the draft simply will not survive a reload.
  }
}
const UI_FONT_STORAGE_KEY = "lifeos.uiFont";
type UiFontId = "misans" | "source-han-sans" | "harmonyos-sans";
const UI_FONT_OPTIONS: readonly { id: UiFontId; label: string; stack: string }[] = [
  { id: "misans", label: "MiSans", stack: '"LifeOS MiSans", "MiSans", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: "source-han-sans", label: "思源黑体 / Source Han Sans", stack: '"Source Han Sans SC", "Source Han Sans SC VF", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: "harmonyos-sans", label: "HarmonyOS Sans", stack: '"HarmonyOS Sans SC", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
];
/** A name typed by this user is normally Chinese; a token like `@a1b2` is not. */
const CJK_PATTERN = /[\u3400-\u9fff]/;
const MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH = 6;

function isUiFontId(value: string | null): value is UiFontId {
  return UI_FONT_OPTIONS.some((option) => option.id === value);
}

function readUiFont(): UiFontId {
  const stored = window.localStorage.getItem(UI_FONT_STORAGE_KEY);
  return isUiFontId(stored) ? stored : "misans";
}

const COMPOSER_META: Record<ComposerKind, { label: string; placeholder: string; icon: LucideIcon }> = {
  journal: { label: "日记", placeholder: "记录此刻正在发生的事……", icon: NotebookPen },
  task: { label: "任务", placeholder: "下一步要完成什么？", icon: ListChecks },
  event: { label: "事件", placeholder: "记下一个值得回看的时间点……", icon: CalendarDays },
  note: { label: "笔记", placeholder: "把想法留在这里……", icon: BookOpen },
};

const ENTITY_META: Record<string, { label: string; icon: LucideIcon }> = {
  person: { label: "人物", icon: User },
  project: { label: "项目", icon: FolderKanban },
  place: { label: "地点", icon: MapPin },
  topic: { label: "主题", icon: Tag },
  movie: { label: "电影", icon: Film },
};

const ENTITY_KIND_ORDER: readonly EntityKind[] = ["person", "place", "project", "topic"];

const ASSET_ROLE_LABEL: Record<AssetRole, string> = { photo: "照片", recording: "录音", attachment: "附件" };

const RELATION_META: Record<RelationKind, { label: string; icon: LucideIcon }> = {
  partner: { label: "爱人", icon: Heart },
  friend: { label: "朋友", icon: Handshake },
  family: { label: "家人", icon: House },
  colleague: { label: "同事", icon: BriefcaseBusiness },
};

/**
 * Reserved id for the person who owns this log. Relations such as 同事/爱人 are
 * stored between two people, so chips can only name a kind once we know who
 * "I" am; without that entity they simply show no kind.
 */
const SELF_ENTITY_ID = "self";

/** Movie is supplied by an optional backend module and may be one deploy
 * revision ahead of the shared core package. Keep the runtime guard local so
 * the rest of the UI can render historical movie refs during that window. */
function isMovieEntity(value: unknown): value is MovieEntity {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === "movie" && typeof (value as { readonly id?: unknown }).id === "string";
}

function isMovieRef(value: EntityRef): boolean {
  return (value.entityType as string) === "movie";
}

function asCoreEntity(value: MovieEntity): Entity {
  return value as unknown as Entity;
}

function relationKindFor(entityId: string, entities: readonly Entity[]): RelationKind | undefined {
  const self = entities.find((entity) => entity.id === SELF_ENTITY_ID);
  if (self === undefined) return undefined;
  const direct = (self.relations ?? []).find((relation) => relation.entityId === entityId);
  if (direct !== undefined) return direct.kind;
  // The edge is symmetric, but tolerate a one-sided record left by an older write.
  const other = entities.find((entity) => entity.id === entityId);
  const inverse = (other?.relations ?? []).find((relation) => relation.entityId === SELF_ENTITY_ID);
  return inverse?.kind;
}

function relationLabelFor(entityId: string, entities: readonly Entity[]): string | undefined {
  const kind = relationKindFor(entityId, entities);
  return kind === undefined ? undefined : RELATION_META[kind].label;
}

function isLocalAsset(asset: Asset | undefined): boolean {
  return asset?.storageRefs.some((storageRef) => storageRef.sourceId === "local") === true;
}

function assetRoleFor(kind: AssetKind): AssetRole {
  if (kind === "photo") return "photo";
  if (kind === "audio") return "recording";
  return "attachment";
}

function entityRefKey(ref: EntityRef): string {
  return `${ref.entityType}:${ref.entityId}`;
}

function formatBytes(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function refAsEntity(ref: EntityRef): Entity {
  const base = { id: ref.entityId, name: ref.label ?? ref.entityId };
  if (ref.entityType === "person") return { ...base, type: "person" };
  if (ref.entityType === "place") return { ...base, type: "place" };
  if (ref.entityType === "project") return { ...base, type: "project" };
  if ((ref.entityType as string) === "movie") return { ...base, type: "movie" } as unknown as Entity;
  return { ...base, type: "topic" };
}

/**
 * Names that may render as capsules: every known entity, plus the label stored
 * on this record's own refs so renaming a person never makes old text unreadable.
 * Whether one of them actually renders is decided by `findEntityMentions`, which
 * is people-only — so a place that somehow appears here stays plain text.
 */
function mentionVocabulary(record: RecordView, entities: readonly Entity[]): readonly Entity[] {
  const known = new Set(entities.map((entity) => entity.id));
  const extras = record.entityRefs.filter((ref) => !known.has(ref.entityId)).map(refAsEntity);
  return extras.length === 0 ? entities : [...entities, ...extras];
}

/** Record text where `@person` and `#place` render as capsules, markers hidden. */
function RecordText({ text, entities }: { readonly text: string; readonly entities: readonly Entity[] }) {
  const mentions = useMemo(() => findEntityMentions(text, entities), [text, entities]);
  if (mentions.length === 0) return <>{text}</>;
  const canonicalNames = new Map(entities.map((entity) => [entity.id, entity.name]));
  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((mention, index) => {
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    parts.push(<span className={`mention-chip ${mention.entityType === "place" ? "is-place" : ""}`} key={`${mention.entityId}-${mention.start}-${index}`}>{canonicalNames.get(mention.entityId) ?? mention.matched}</span>);
    cursor = mention.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const PLACE_ROLE_LABELS: Record<(typeof PLACE_ROLES)[number], string> = { home: "家", work: "工作", other: "其他" };

/**
 * Secondary information for a quick-picker row. The picker already tells us
 * whether it contains people or places, so repeating "人物/地点" is noise.
 */
function entityHint(entity: Entity, entities: readonly Entity[] = []): string {
  if (isMovieEntity(entity)) {
    return [entity.originalTitle, entity.releaseYear === undefined ? undefined : String(entity.releaseYear), entity.doubanRating === undefined ? undefined : `豆瓣 ${entity.doubanRating}`].filter(Boolean).join(" · ");
  }
  const parts: string[] = [];
  if (entity.type === "person") {
    const relation = relationLabelFor(entity.id, entities);
    if (relation !== undefined) parts.push(relation);
  }
  if (entity.type === "place") {
    if (entity.role !== undefined) parts.push(PLACE_ROLE_LABELS[entity.role]);
    const { period } = entity;
    if (period !== undefined && (period.from !== undefined || period.until !== undefined)) {
      parts.push(`${period.from ?? "…"} – ${period.until ?? "至今"}`);
    }
  }
  const aliasText = (entity.aliases ?? []).join("、");
  if (aliasText.length > 0) parts.push(aliasText);
  if (parts.length === 0 && entity.description?.trim()) {
    const description = entity.description.trim().replace(/\s+/g, " ");
    parts.push(description.length > 36 ? `${description.slice(0, 36)}…` : description);
  }
  return parts.join(" · ");
}

interface MentionQuery { readonly query: string; readonly marker: string; readonly start: number; readonly end: number; readonly forceNew: boolean; }

function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const upto = value.slice(0, caret);
  // The last typed marker wins; `##名字` or `@@名字` means "skip the known
  // list, offer to create" — and its replacement range starts at the FIRST
  // marker so the doubled trigger is removed when a name is inserted.
  let at = -1;
  let marker = "";
  for (const entry of MENTION_MARKERS) {
    const index = upto.lastIndexOf(entry.marker);
    if (index > at) { at = index; marker = entry.marker; }
  }
  if (at === -1) return null;
  const previous = upto[at - 1];
  if (previous !== undefined && /[A-Za-z0-9]/.test(previous)) return null;
  const forceNew = previous === marker;
  const query = upto.slice(at + 1);
  const isCompactQuery = !/[\s@#]/.test(query);
  const isSpacedEnglishName = /^[A-Za-z][A-Za-z\s_-]*[A-Za-z]$/u.test(query);
  if (query.length > 24 || /[@#]/.test(query) || (!isCompactQuery && !isSpacedEnglishName)) return null;
  return { query, marker, start: forceNew ? at - 1 : at, end: caret, forceNew };
}

function mentionSuggestions(entities: readonly Entity[], marker: string, query: string, recentIds: readonly string[] = []): readonly Entity[] {
  // Each marker resolves to its own kinds, so the picker after `@` never
  // offers a place and the picker after `#` never offers a person.
  const kinds = MENTION_MARKERS.find((entry) => entry.marker === marker)?.kinds ?? [];
  const pool = entities.filter((entity) => kinds.includes(entity.type));
  const needle = normalizeEntitySearchTerm(query);
  const matched = needle.length === 0 ? pool : pool.filter((entity) => entitySearchTerms(entity).some((term) => normalizeEntitySearchTerm(term).includes(needle)));
  return rankByRecency(matched, recentIds).slice(0, 10);
}

/**
 * Recently used first, everything else in the order it arrived.
 *
 * The list a mention picker shows is a shortcut, and the shortcut people
 * actually want is "the one I used last time" — you go back to the same café,
 * the same office, the same friend. Entity order (creation order, effectively)
 * says nothing about that, so a stable pass is run over the matches and the ones
 * that appear in `recentIds` float to the top, most recent first.
 *
 * Stability matters here: anything not recently used keeps its relative
 * position, so the list never shuffles under a person typing into it.
 */
function rankByRecency(items: readonly Entity[], recentIds: readonly string[]): readonly Entity[] {
  if (recentIds.length === 0 || items.length < 2) return items;
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  return [...items].sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}

/**
 * The order places were last written about, most recent first.
 *
 * A place has no "used" flag of its own, and inventing one would mean a new
 * field to keep in sync, migrate and eventually get wrong. The records already
 * say it: every saved record carries entityRefs, and a place ref inside one is
 * the evidence that this place was mentioned at that moment. Sorting the refs by
 * the record's own time gives the recency list for free.
 *
 * `occurredAt` (when it happened) is preferred over `createdAt` (when it was
 * typed), because a backfilled entry about last Tuesday is still a use of that
 * place — it just happened earlier.
 */
function recentPlaceIds(records: readonly RecordView[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const sorted = [...records].sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt?.value ?? left.createdAt.value) || 0;
    const rightTime = Date.parse(right.occurredAt?.value ?? right.createdAt.value) || 0;
    return rightTime - leftTime;
  });
  for (const record of sorted) {
    for (const ref of record.entityRefs) {
      if (ref.entityType !== "place" || seen.has(ref.entityId)) continue;
      seen.add(ref.entityId);
      ordered.push(ref.entityId);
    }
  }
  return ordered;
}

function hasKnownMentionPrefix(entities: readonly Entity[], marker: string, query: string): boolean {
  const kinds = MENTION_MARKERS.find((entry) => entry.marker === marker)?.kinds ?? [];
  const normalizedQuery = normalizeEntitySearchTerm(query);
  return normalizedQuery.length > 0 && entities
    .filter((entity) => kinds.includes(entity.type))
    .some((entity) => entitySearchTerms(entity).some((term) => normalizedQuery.startsWith(normalizeEntitySearchTerm(term))));
}

interface SlashQuery {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/** A slash only becomes a command trigger at the start of a token. This keeps
 * URLs, paths, and ordinary prose untouched while allowing Chinese IME input
 * to continue through the same native textarea. */
function slashQueryAt(value: string, caret: number): SlashQuery | null {
  const upto = value.slice(0, caret);
  const slash = upto.lastIndexOf("/");
  if (slash < 0) return null;
  const previous = upto[slash - 1];
  if (previous !== undefined && !/\s/u.test(previous)) return null;
  const query = upto.slice(slash + 1);
  if (/\s|[@#]/u.test(query) || query.length > 24) return null;
  return { query, start: slash, end: caret };
}

function slashSuggestions(commands: readonly ModuleCommand[], query: string): readonly ModuleCommand[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return commands;
  return commands.filter((command) => [command.label, ...command.aliases].some((term) => term.toLocaleLowerCase().startsWith(needle)));
}

const NAV_ITEMS: readonly { id: AppView; label: string; icon: LucideIcon }[] = [
  { id: "today", label: "今天", icon: Sun },
  { id: "timeline", label: "时间轴", icon: CalendarDays },
  { id: "calendar", label: "日历", icon: CalendarRange },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "notes", label: "笔记", icon: NotebookPen },
  { id: "entities", label: "联系人与地点", icon: ContactRound },
];

const SETTINGS_NAV_ITEM: { id: AppView; label: string; icon: LucideIcon } = { id: "settings", label: "设置", icon: Settings };

function isTaskRecord(record: RecordView): record is TaskRecordView {
  return record.kind === "task";
}

function recordText(record: RecordView): string {
  return record.body.edited ?? record.body.original;
}

function recordLabel(kind: RecordKind): string {
  return COMPOSER_META[kind].label;
}

function statusLabel(status: string | undefined): string {
  if (status === "in_progress") return "进行中";
  if (status === "done") return "已完成";
  if (status === "cancelled") return "已取消";
  return "待办";
}

function isDemoRecord(record: RecordView): boolean {
  return record.isDemo === true;
}

/**
 * A week card is a glance, not a miniature timeline. Keep its visible first
 * and last entries, then select one representative interior entry. A photo is
 * deliberately worth more than every non-photo signal combined; among photos
 * (or ties), fuller notes closest to the day's middle win.
 */
function weekCardRecords(items: readonly RecordView[]): readonly RecordView[] {
  if (items.length <= 3) return items;
  const middle = (items.length - 1) / 2;
  const score = (record: RecordView, index: number): number => {
    const hasPhoto = record.assetRefs.some((ref) => ref.role === "photo");
    const photoWeight = hasPhoto ? 100 : 0;
    const detailWeight = Math.min(recordText(record).trim().length, 96) / 8;
    const centralityWeight = Math.max(0, 20 - Math.abs(index - middle) * 4);
    return photoWeight + detailWeight + centralityWeight;
  };
  let representativeIndex = 1;
  let representativeScore = score(items[representativeIndex], representativeIndex);
  for (let index = 2; index < items.length - 1; index += 1) {
    const candidateScore = score(items[index], index);
    if (candidateScore > representativeScore) {
      representativeIndex = index;
      representativeScore = candidateScore;
    }
  }
  return [items[0], items[representativeIndex], items[items.length - 1]];
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

function errorMessage(error: unknown, fallback = "请稍后重试"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function timelineHeading(view: AppView): string {
  if (view === "today") return "当日记录";
  if (view === "timeline") return "全部记录";
  if (view === "tasks") return "任务记录";
  return "笔记记录";
}

function emptyCopy(view: AppView, selectedDate: string, hasSearch: boolean): { title: string; showDemo: boolean } {
  if (hasSearch) return { title: "没有找到匹配记录", showDemo: false };
  if (view === "today") return { title: `${shortDate(selectedDate)}还没有记录`, showDemo: false };
  if (view === "tasks") return { title: "还没有任务", showDemo: false };
  if (view === "notes") return { title: "还没有笔记", showDemo: false };
  return { title: "还没有记录", showDemo: false };
}

function Sidebar({ activeView, onNavigate }: { activeView: AppView; onNavigate: (view: AppView) => void }) {
  return (
    <aside className="sidebar" aria-label="LifeOS 导航">
      <div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-name">LifeOS</span></div>
      <nav className="primary-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => { const Icon = item.icon; return <button className={`nav-item ${activeView === item.id ? "is-active" : ""}`} key={item.id} type="button" onClick={() => onNavigate(item.id)} aria-current={activeView === item.id ? "page" : undefined}><Icon size={18} strokeWidth={1.8} aria-hidden="true" /><span>{item.label}</span></button>; })}
      </nav>
      <div className="sidebar-footer"><button className={`nav-item sidebar-settings-item ${activeView === SETTINGS_NAV_ITEM.id ? "is-active" : ""}`} type="button" onClick={() => onNavigate(SETTINGS_NAV_ITEM.id)} aria-current={activeView === SETTINGS_NAV_ITEM.id ? "page" : undefined}><Settings size={18} strokeWidth={1.8} aria-hidden="true" /><span>设置</span></button></div>
    </aside>
  );
}

function MobileNav({ activeView, onNavigate }: { activeView: AppView; onNavigate: (view: AppView) => void }) {
  return <nav className="mobile-nav" aria-label="移动端导航">{NAV_ITEMS.map((item) => { const Icon = item.icon; return <button className={`mobile-nav-item ${activeView === item.id ? "is-active" : ""}`} key={item.id} type="button" onClick={() => onNavigate(item.id)} aria-current={activeView === item.id ? "page" : undefined}><Icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{item.label}</span></button>; })}</nav>;
}

/**
 * The photo drop zone beside the entry box. This is the only place in LifeOS
 * that writes a file: everywhere else an asset is a reference to an original
 * that stays where it lives. A dropped photo uploads immediately, so the
 * thumbnail on screen is the very asset the record will point at — saving the
 * entry only links it.
 *
 * Nine is the timeline's own number, not an arbitrary cap: a record's grid
 * shows nine squares and folds the rest behind a +N badge. Keeping the two
 * equal means every photo the owner can attach is a photo the timeline can
 * show, so the badge never becomes a surprise.
 */
const SHOT_LIMIT = 9;

/**
 * Uploading a photo ends either in newly stored bytes or in a reuse of bytes
 * the library already holds. The drop zone reports which, so the owner can
 * see that nothing was uploaded twice.
 */
interface ShotUpload { readonly asset: Asset; readonly reused: boolean; }

interface AssetResolveResponse { readonly matched: boolean; readonly asset?: Asset; }

/**
 * The library's answer to "do you already hold these exact bytes?". Failing to
 * ask must never stop an upload, so any error degrades to "no".
 */
async function resolveKnownShot(hash: string): Promise<Asset | null> {
  try {
    const payload = await apiRequest<AssetResolveResponse>("/api/assets/resolve", { method: "POST", body: JSON.stringify({ algorithm: "sha256", value: hash }) });
    return payload.matched ? payload.asset ?? null : null;
  } catch {
    return null;
  }
}

interface ShotDropZoneProps {
  readonly shots: readonly AssetLink[];
  readonly onShotsChange: Dispatch<SetStateAction<readonly AssetLink[]>>;
  readonly onUpload: (file: File) => Promise<ShotUpload | null>;
  /** Says things the drop zone itself no longer says. The zone keeps no message
   *  line of its own: a paragraph of status text under a hand of cards reads as
   *  a defect in the panel. Anything that has to be said is said as a toast. */
  readonly onNotify: (message: string, tone?: "ok" | "warn") => void;
  /** Clearing the hand is one tap on a phone and one hover away on a desktop, so
   *  it has to be undoable. The zone hands the undo back to whoever owns the
   *  toast: it can put the photos back, but only the shell can offer the button. */
  readonly onCleared: (cleared: readonly AssetLink[], restore: () => void) => void;
}

function ShotDropZone({ shots, onShotsChange, onUpload, onNotify, onCleared }: ShotDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  // dragenter/dragleave fire again for every child element, so only a depth
  // counter can tell whether the pointer really left the zone.
  const dragDepth = useRef(0);

  const takeFiles = async (files: readonly File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      onNotify("只接受图片文件", "warn");
      return;
    }
    const room = SHOT_LIMIT - shots.length;
    if (room <= 0) {
      onNotify(`已经 ${SHOT_LIMIT} 张了，时间轴一屏放不下，先删一张再加`, "warn");
      return;
    }
    const batch = images.slice(0, room);
    if (images.length > room) onNotify(`一次最多 ${SHOT_LIMIT} 张，只收下了前 ${room} 张`, "warn");
    setUploading((count) => count + batch.length);
    const added: AssetLink[] = [];
    let failedCount = 0;
    // Identical bytes resolve to the same asset, so dropping one photo twice
    // would put two identical assetIds in this list: the React keys would
    // collide and one ✕ would remove both thumbnails. Keep one per asset.
    const seen = new Set(shots.map((shot) => shot.assetId));
    for (const file of batch) {
      const upload = await onUpload(file);
      if (upload === null) { failedCount += 1; continue; }
      if (seen.has(upload.asset.id)) continue;
      seen.add(upload.asset.id);
      added.push({ assetId: upload.asset.id, role: assetRoleFor(upload.asset.kind), ...(upload.asset.originalName === undefined ? {} : { label: upload.asset.originalName }) });
    }
    setUploading((count) => count - batch.length);
    if (added.length > 0) onShotsChange((current) => [...current, ...added]);
    // Reuse and duplicates are both silent on purpose: whether the bytes were
    // already in the library is the library's business, not the owner's. A photo
    // landing in the hand is the whole confirmation.
    if (failedCount > 0) onNotify(`${failedCount} 张没能传上去，可以重试`, "warn");
  };

  const remove = (assetId: string) => onShotsChange((current) => current.filter((shot) => shot.assetId !== assetId));

  const clearAll = () => {
    if (shots.length === 0) return;
    const cleared = [...shots];
    onShotsChange([]);
    onCleared(cleared, () => onShotsChange((current) => [...cleared, ...current]));
  };

  const busy = uploading > 0;
  const empty = shots.length === 0;

  // Reading order is the order they were added in. There is no rank, no arc and
  // no stacking: the strip is a set of pictures, and the only thing it has to
  // say is which ones are in it.
  const strip = shots;

  // One state, one component. The add control is a dashed square like the slot
  // it stands for, in every state — it is never a different thing. A labelled
  // button for the empty case was what made this area read as a control bolted
  // under the field rather than as the place photos go, so it is gone.
  const zoneClass = `composer-shots ${dragging ? "is-dragging" : ""} ${empty ? "is-empty" : "has-shots"}`;
  const zoneHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => { event.preventDefault(); dragDepth.current += 1; setDragging(true); },
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy" as const; },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); },
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void takeFiles(Array.from(event.dataTransfer.files)); },
  };

  const fileInput = <input ref={inputRef} className="shot-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void takeFiles(files); }} />;

  /**
   * One strip, one component. Every photo is the same square and they run in the
   * order they were added, with the add square as the last tile in the row —
   * which is where 微信, 微博 and 小红书 all put it, and therefore where nobody
   * has to look for it. On an empty composer that square is simply the only tile
   * there: the row does not change shape, it only has one member.
   *
   * A desk gets one row of nine. A phone cannot fit nine across, so the same row
   * is allowed to wrap into 朋友圈's grid; the tiles never change size or shape,
   * only the number that fits per line. That is the whole responsive story — no
   * second rendering, no second set of rules, and nothing that has to be kept in
   * sync with the other one.
   */
  return <div className={zoneClass} {...zoneHandlers}>
    <div className="shot-row">
      <ul className="shot-strip" data-count={shots.length}>
        {strip.map((shot) => <li className="shot-tile" key={shot.assetId}>
          <img src={assetThumbUrl(shot.assetId, 400)} alt={shot.label ?? "已添加的照片"} loading="lazy" decoding="async" />
          <button className="shot-tile-remove" type="button" onClick={() => remove(shot.assetId)} aria-label={`移除 ${shot.label ?? "这张照片"}`}><X size={12} strokeWidth={2.4} aria-hidden="true" /></button>
        </li>)}
        {/* The slot for the next photo, and the same dashed square whether or
            not there are any yet. A dashed box with a plus is the one add
            affordance nobody has to be taught; an empty composer just happens to
            be showing only this one. */}
        <li className="shot-tile shot-tile-add">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} aria-label="添加照片">
            <Plus size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </li>
      </ul>
      {/* The two things that are about the strip rather than in it. They ride
          the end of the same row, so they cost no height of their own: on a
          line underneath they would add a full caption line of blank below
          the last row of photos, which is exactly the stretch of nothing the
          owner kept seeing. The tally and the broom are both simply there — the
          broom does not wait for a hover, because a control people cannot see is
          a control half of them never use. */}
      {empty
        ? null
        : <div className="shot-strip-meta">
            <span className="shot-strip-tally">{shots.length}/{SHOT_LIMIT}</span>
            <button className="shot-clear" type="button" onClick={clearAll} aria-label="清空全部照片"><Eraser size={13} strokeWidth={2} aria-hidden="true" /><span>清空</span></button>
            {busy ? <span className="shot-busy" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" /></span> : null}
          </div>}
    </div>
    {fileInput}
  </div>;
}

interface ComposerProps { kind: ComposerKind; content: string; occurredAt: string; occurredDirty?: boolean; dueAt: string; isPrivate: boolean; isBackfill: boolean; weather: WeatherAttachment | null; weatherBusy: boolean; selectedDate: string; saving: boolean; dismissible: boolean; entities: readonly Entity[]; recentPlaceIds?: readonly string[]; movieEnabled: boolean; movieRefs: readonly EntityRef[]; onMovieRefsChange: (refs: readonly EntityRef[]) => void; onMovieEntity: (movie: MovieEntity) => void; onCreateEntity: CreateEntity; onKindChange: (kind: ComposerKind) => void; onContentChange: (content: string) => void; onOccurredAtChange: (value: string) => void; onDueAtChange: (value: string) => void; onPrivateChange: (value: boolean) => void; onBackfillChange: (value: boolean) => void; onCaptureWeather: () => void; onClearWeather: () => void; onSubmit: () => void; onClose: () => void; shots: readonly AssetLink[]; onShotsChange: Dispatch<SetStateAction<readonly AssetLink[]>>; onUploadShot: (file: File) => Promise<ShotUpload | null>; onNotify: (message: string, tone?: "ok" | "warn") => void; onShotsCleared: (cleared: readonly AssetLink[], restore: () => void) => void; }

interface ComposerSelection { readonly start: number; readonly end: number; readonly text: string; }
interface SmartMentionPrompt { readonly source: "person" | "place" | "universal"; readonly selection: ComposerSelection; readonly personMatches: readonly Entity[]; readonly placeMatches: readonly Entity[]; }

function Composer({ kind, content, occurredAt, dueAt, isPrivate, isBackfill, weather, weatherBusy, selectedDate, saving, dismissible, entities, recentPlaceIds = [], movieEnabled, movieRefs, onMovieRefsChange, onMovieEntity, onCreateEntity, onKindChange, onContentChange, onOccurredAtChange, onDueAtChange, onPrivateChange, onBackfillChange, onCaptureWeather, onClearWeather, onSubmit, onClose, shots, onShotsChange, onUploadShot, onNotify, onShotsCleared }: ComposerProps) {
  const activeMeta = COMPOSER_META[kind];
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [pickerKind, setPickerKind] = useState<"person" | "place" | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [smartMentionPrompt, setSmartMentionPrompt] = useState<SmartMentionPrompt | null>(null);
  const [smartHintVisible, setSmartHintVisible] = useState(false);
  const [moviePanelOpen, setMoviePanelOpen] = useState(false);
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
      {dismissible ? <button className="icon-button compact-icon-button composer-close" type="button" onClick={onClose} aria-label="关闭记录编辑器"><X size={17} strokeWidth={1.9} aria-hidden="true" /></button> : null}
    </div>
    <div className="composer-entry">
    {/* Two collapsed rows. The fan used to be the reason for three — a turned
        square grows its box by about 1.3x, so a deep hand was paid for in height
        as well as width. The strip below is a flat 44px row and needs none of
        that, so the field goes back to two rows (about 81px) and the band adds
        its own height underneath. */}
    <MentionBox className="composer-input" value={content} onChange={onContentChange} entities={entities} recentPlaceIds={recentPlaceIds} onCreateEntity={onCreateEntity} textareaRef={inputRef} placeholder={activeMeta.placeholder} rows={1} autoGrow autoGrowRows={2} ariaLabel={`${activeMeta.label}内容`} moduleCommands={moduleCommands} onSlashCommand={() => setMoviePanelOpen(true)} />
      {/* The photos sit flush under the text block, not under the room. The
          textarea is inset from the room's top by its own padding, so a floor on
          the room leaves that same inset stranded below the text instead — the
          gap moves, it does not go away. Cancelling the entry's slack here is
          what actually closes it. */}
      <ShotDropZone shots={shots} onShotsChange={onShotsChange} onUpload={onUploadShot} onNotify={onNotify} onCleared={onShotsCleared} />
    </div>
    {moviePanelOpen ? <MovieAddPanel enabled={movieEnabled} onAttach={attachMovie} onClose={() => setMoviePanelOpen(false)} /> : null}
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
        <label className="composer-date-control" title="发生时间"><CalendarDays size={15} aria-hidden="true" /><input className="field-input" type="datetime-local" value={occurredAt} onChange={(event) => onOccurredAtChange(event.target.value)} aria-label="发生时间" /></label>
        {kind === "task" ? <label className="composer-date-control" title="截止时间"><CalendarDays size={15} aria-hidden="true" /><input className="field-input" type="datetime-local" value={dueAt} onChange={(event) => onDueAtChange(event.target.value)} aria-label="截止时间" /></label> : null}
        {isBackfillDate ? <label className={`backfill-toggle ${isBackfill ? "is-on" : ""}`} title="将这条记录标记为补记"><input type="checkbox" checked={isBackfill} onChange={(event) => onBackfillChange(event.target.checked)} /><History size={14} strokeWidth={1.9} aria-hidden="true" /><span>补记</span></label> : null}
        <label className={`privacy-toggle ${isPrivate ? "is-on" : ""}`} title="隐私记录"><input type="checkbox" checked={isPrivate} onChange={(event) => onPrivateChange(event.target.checked)} /><LockKeyhole size={14} strokeWidth={1.9} aria-hidden="true" /><span>隐私</span></label>
        <button className={`weather-pin-toggle ${weather ? "is-on" : ""}`} type="button" onClick={weather ? onClearWeather : onCaptureWeather} disabled={weatherBusy} title={weather ? "取消天气" : "读取当前天气"} aria-label={weather ? `天气 · ${weather.text}，点击取消` : "天气，点击读取当前天气"}>{weatherBusy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <CloudSun size={14} aria-hidden="true" />}<span>{weatherBusy ? "读取中" : weather ? `天气 · ${weather.text}` : "天气"}</span></button>
      </div>
      <button className="primary-button" type="button" disabled={!content.trim() || saving} onClick={onSubmit}>{saving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Send size={17} strokeWidth={1.8} aria-hidden="true" />}<span>{saving ? "保存中" : "保存记录"}</span></button>
    </div>
  </section>;
}

interface MentionBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly entities: readonly Entity[];
  readonly recentPlaceIds?: readonly string[];
  readonly onCreateEntity: CreateEntity;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  readonly className?: string;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly ariaLabel: string;
  readonly autoFocus?: boolean;
  readonly autoGrow?: boolean;
  readonly autoGrowRows?: number;
  readonly moduleCommands?: readonly ModuleCommand[];
  readonly onSlashCommand?: (command: ModuleCommand) => void;
}

/**
 * The create form behind "新建" — type is switchable, and a place collects its
 * role and period right here, so nobody ever gets filed under the wrong kind
 * again. Marker characters are stripped from the name: an entity literally
 * named "@老王" would be unmentionable forever.
 */
/**
 * One alias field, split on `/`.
 *
 * The separator used to be a comma, and that was a coin flip: half the world
 * types `,` and half types `，`, and whichever one you did not handle silently
 * welded two aliases into one. A slash has no such twin — there is one slash on
 * a keyboard — so it is the one delimiter that cannot be typed "wrong".
 *
 * The split is shown as it happens. Every segment that has been closed off by a
 * slash lights up as its own chip, so the field answers "did that register?"
 * while it is being typed rather than at save time. A run with no separator in
 * it stays unlit as one long block, which is exactly what it is — and seeing
 * "王后广场皇后广场天后广场" sitting there as a single slab is the tell that the
 * slashes are missing, without anything having to say so in words.
 */
function AliasField({ value, onChange, label, placeholder, compact = false }: { value: string; onChange: (value: string) => void; label: string; placeholder?: string; compact?: boolean }) {
  const segments = parseAliasSegments(value);
  const chips = segments.filter((segment) => segment.complete);
  // A segment can be "complete" by the slash rule and still be obviously wrong:
  // two aliases glued together is a longer run than any alias should be, and a
  // comma inside one means somebody used the separator this field no longer
  // takes. Both are flagged rather than quietly accepted, because the whole
  // point of showing the split is to catch it now instead of at save time.
  const suspect = chips.some(isSuspectAlias);
  return <div className={`alias-field ${compact ? "is-compact" : ""}`}>
    <input
      className={compact ? "alias-input" : "entity-create-input alias-input"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder ?? "可选，用 / 分隔，例如：家 / 老宅"}
      aria-label={label}
    />
    {/* Only rendered once there is something to confirm -- an empty ruler under
        an empty field would be noise. */}
    {chips.length > 0 ? <div className="alias-chips" data-alias-count={chips.length} data-alias-suspect={suspect ? "true" : "false"} aria-live="polite">
      {chips.map((segment) => <span className={`alias-chip ${isSuspectAlias(segment) ? "is-suspect" : ""}`} key={segment.start} title={isSuspectAlias(segment) ? "这一段看起来像两个别名粘在一起了，用 / 分开试试" : undefined}>{segment.text}</span>)}
      <span className="alias-chip-note">{suspect ? "是不是漏了 / ？" : `${chips.length} 个别名`}</span>
    </div> : null}
  </div>;
}

/**
 * Whether a finished-looking segment is probably two aliases that never got
 * separated.
 *
 * Two tells, both cheap and both reliable enough: a comma inside it (the old
 * separator, typed out of habit) or a length no single alias reaches. The length
 * bound is deliberately loose — place and person names in CJK are usually two to
 * six characters, and this fires at ten, so it only catches the obvious glue.
 */
const SUSPECT_ALIAS_LENGTH = 10;
function isSuspectAlias(segment: AliasSegment): boolean {
  return /[,，、;；]/.test(segment.text) || Array.from(segment.text).length >= SUSPECT_ALIAS_LENGTH;
}

interface AliasSegment { readonly text: string; readonly start: number; readonly complete: boolean; }

/**
 * Splits raw alias text into the runs between slashes, and says which of them
 * are finished.
 *
 * "Finished" means a slash closed it off, or it is the last run and no slash is
 * pending. So `家 / 老宅 /` has two finished aliases and an empty tail, while
 * `家 / 老宅` has two as well, and a bare `家老宅` is one unfinished run — the
 * case that should visibly not light up.
 *
 * Whitespace around a segment is trimmed but tolerated, because people type
 * `家 / 老宅` and mean two aliases, not one containing spaces.
 */
function parseAliasSegments(raw: string): readonly AliasSegment[] {
  if (raw.trim().length === 0) return [];
  const parts = raw.split("/");
  const segments: AliasSegment[] = [];
  let cursor = 0;
  parts.forEach((part, index) => {
    const start = cursor;
    cursor += part.length + 1;
    const text = part.trim();
    // A trailing empty part means the string ended on a slash: nothing pending.
    const isLast = index === parts.length - 1;
    const complete = text.length > 0 && (!isLast || !raw.endsWith("/"));
    if (text.length > 0) segments.push({ text, start, complete });
  });
  return segments;
}

/**
 * The aliases an alias field actually holds, in order, deduplicated.
 *
 * The last run counts even without a closing slash — somebody who typed one
 * alias and stopped should not have to add a slash to prove it.
 */
function aliasListFrom(raw: string): readonly string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const segment of parseAliasSegments(raw)) {
    if (seen.has(segment.text)) continue;
    seen.add(segment.text);
    list.push(segment.text);
  }
  return list;
}
function EntityCreateForm({ defaultType, defaultName, onCreate, onCancel, submitLabel }: { defaultType: "person" | "place"; defaultName: string; onCreate: (request: EntityCreateRequest) => Promise<boolean>; onCancel: () => void; submitLabel: string }) {
  const [type, setType] = useState<"person" | "place">(defaultType);
  const [name, setName] = useState(defaultName);
  const [aliases, setAliases] = useState("");
  const [role, setRole] = useState<PlaceRole>("home");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const cleanName = name.replace(/[@#]/g, "").trim();
  const submit = async () => {
    if (cleanName.length === 0 || busy) return;
    const aliasList = aliasListFrom(aliases);
    setBusy(true);
    const created = await onCreate({
      type,
      name: cleanName,
      ...(aliasList.length > 0 ? { aliases: aliasList } : {}),
      ...(type === "place" ? { role } : {}),
      ...(type === "place" && (from !== "" || until !== "") ? { period: { ...(from === "" ? {} : { from }), ...(until === "" ? {} : { until }) } } : {}),
      ...(type === "place" && address.trim() ? { address: address.trim() } : {}),
    });
    setBusy(false);
    if (created) onCancel();
  };
  return <div className="entity-create-form" role="form" aria-label={`新建${type === "place" ? "地点" : "人物"}`}>
    <div className="entity-create-row">
      <span className="entity-create-label">类型</span>
      <div className="entity-create-types">
        <button type="button" className={`entity-type-option ${type === "person" ? "is-active" : ""}`} onClick={() => setType("person")}><User size={13} strokeWidth={1.8} aria-hidden="true" />人物</button>
        <button type="button" className={`entity-type-option ${type === "place" ? "is-active" : ""}`} onClick={() => setType("place")}><MapPin size={13} strokeWidth={1.8} aria-hidden="true" />地点</button>
      </div>
    </div>
    <div className="entity-create-row">
      <span className="entity-create-label">名称</span>
      <input className="entity-create-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="名称（@ # 符号会自动去掉）" autoFocus onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} />
    </div>
    <div className="entity-create-row">
      <span className="entity-create-label">别名</span>
      <AliasField value={aliases} onChange={setAliases} label="别名，用斜杠分隔" />
    </div>
    {type === "place" ? <>
      <div className="entity-create-row">
        <span className="entity-create-label">角色</span>
        <div className="entity-create-types">
          {PLACE_ROLES.map((option) => <button key={option} type="button" className={`entity-type-option ${role === option ? "is-active" : ""}`} onClick={() => setRole(option)}>{PLACE_ROLE_LABELS[option]}</button>)}
        </div>
      </div>
      <div className="entity-create-row">
        <span className="entity-create-label">时期</span>
        <input className="entity-create-input entity-create-month" type="month" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="开始年月" />
        <span className="entity-create-label">至</span>
        <input className="entity-create-input entity-create-month" type="month" value={until} onChange={(event) => setUntil(event.target.value)} aria-label="结束年月，留空表示至今" />
      </div>
      <div className="entity-create-row">
        <span className="entity-create-label">详细地址</span>
        <input className="entity-create-input" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="可选；平时不会展开" />
      </div>
    </> : null}
    <div className="entity-create-actions">
      <button type="button" className="text-button" onClick={onCancel}>取消</button>
      <button type="button" className="primary-button entity-create-submit" disabled={cleanName.length === 0 || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}<span>{submitLabel}</span></button>
    </div>
  </div>;
}

/**
 * A textarea that understands `@person` and `#place`. Typing a marker opens a
 * small list of known entities of the matching kind (searched across names
 * and aliases); picking one writes `标记名字` into the text, and the server
 * turns that mention into a real entityRef when the record is saved. Doubling
 * the marker (`##名字` / `@@名字`) opens the create form — type stays
 * switchable there, so a person can never be filed as a place by accident.
 * Unknown names are never rewritten, which is what keeps e-mail addresses,
 * passwords, and hex colours safe.
 */
function MentionBox({ value, onChange, entities, recentPlaceIds = [], onCreateEntity, textareaRef, className, placeholder, rows = 3, ariaLabel, autoFocus, autoGrow, autoGrowRows, moduleCommands = [], onSlashCommand }: MentionBoxProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const slashOptions = useMemo(() => slash === null ? [] : slashSuggestions(moduleCommands, slash.query), [moduleCommands, slash]);
  const suggestions = useMemo(() => (mention === null || createFormOpen ? [] : mentionSuggestions(entities, mention.marker, mention.query, recentPlaceIds)), [entities, mention, createFormOpen, recentPlaceIds]);
  const trimmedQuery = mention?.query.trim() ?? "";
  const hasKnownPrefix = mention !== null && hasKnownMentionPrefix(entities, mention.marker, mention.query);
  const markerKind = mention?.marker === PLACE_MARKER ? "place" : "person";
  const kindLabel = markerKind === "place" ? "地点" : "人物";
  // The list opens for a real match, or for something that reads like a name.
  // A password or API token typed after @ stays plain text and never offers to
  // create a person out of it. A doubled marker skips the known list entirely
  // and opens the create form, where the type is switchable before anything
  // is written.
  const wantsNew = trimmedQuery.length > 0 && !hasKnownPrefix && (mention?.forceNew === true ||
    (CJK_PATTERN.test(trimmedQuery) && Array.from(trimmedQuery).length <= MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH && !suggestions.some((entity) => entitySearchTerms(entity).some((term) => normalizeEntitySearchTerm(term) === normalizeEntitySearchTerm(trimmedQuery)))));
  const optionCount = createFormOpen ? 0 : (mention?.forceNew === true ? 0 : suggestions.length) + (wantsNew ? 1 : 0);

  useEffect(() => { setActiveIndex(0); }, [mention?.start, mention?.query, slash?.start, slash?.query]);
  // The list reopens on its first row, and stays there until the owner moves it.
  // The clamp is a guard, not a feature: the option count can shrink under a
  // selection (a filter tightening, the create row dropping away) and an index
  // past the end would silently make Enter do nothing.
  const safeIndex = optionCount === 0 ? 0 : Math.min(activeIndex, optionCount - 1);

  const syncMention = (element: HTMLTextAreaElement) => {
    setMention(mentionQueryAt(element.value, element.selectionStart ?? element.value.length));
    setSlash(slashQueryAt(element.value, element.selectionStart ?? element.value.length));
  };

  useEffect(() => {
    if (slash === null) return undefined;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.parentElement?.contains(target) !== true) setSlash(null);
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [slash]);

  const insert = (name: string, markerOverride?: string) => {
    if (mention === null) return;
    const inserted = `${markerOverride ?? mention.marker}${name}`;
    const nextValue = `${value.slice(0, mention.start)}${inserted}${value.slice(mention.end)}`;
    const caret = mention.start + inserted.length;
    onChange(nextValue);
    setMention(null);
    setCreateFormOpen(false);
    window.requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const submitCreateForm = async (request: EntityCreateRequest): Promise<boolean> => {
    if (mention === null) return false;
    const entity = await onCreateEntity(request.type, request.name, {
      ...(request.aliases === undefined ? {} : { aliases: request.aliases }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.period === undefined ? {} : { period: request.period }),
      ...(request.address === undefined ? {} : { address: request.address }),
    });
    if (entity === null) return false;
    // The form decides the kind last — a ## trigger that was switched to a
    // person must still insert as @.
    insert(entity.name, request.type === "place" ? PLACE_MARKER : "@");
    return true;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (slash !== null) {
      if (slashOptions.length === 0) {
        if (event.key === "Escape") { event.preventDefault(); setSlash(null); }
      } else {
        if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => (current + 1) % slashOptions.length); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => (current - 1 + slashOptions.length) % slashOptions.length); return; }
        if (event.key === "Escape") { event.preventDefault(); setSlash(null); return; }
        if (event.key === "Enter") {
          event.preventDefault();
          const command = slashOptions[activeIndex];
          if (command) {
            const next = `${value.slice(0, slash.start)}${value.slice(slash.end)}`;
            onChange(next);
            setSlash(null);
            setMention(null);
            onSlashCommand?.(command);
            window.requestAnimationFrame(() => {
              const element = ref.current;
              if (!element) return;
              element.focus();
              element.setSelectionRange(slash.start, slash.start);
            });
          }
          return;
        }
      }
    }
    if (mention === null || optionCount === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => (current + 1) % optionCount); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => (current - 1 + optionCount) % optionCount); return; }
    if (event.key === "Escape") { event.preventDefault(); setMention(null); setCreateFormOpen(false); return; }
    // Enter and Space both take the highlighted option. Space is not a typo
    // for Enter -- the picker opens with its first row already highlighted, so
    // the fastest path through it is "@王后" then space then straight on with
    // the sentence, and the space that committed is not left behind in the
    // text. Escape is the only way out without choosing.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (createFormOpen || mention.forceNew === true) { setCreateFormOpen(true); return; }
      const target = suggestions[safeIndex];
      if (target) insert(target.name);
      else setCreateFormOpen(true);
    }
  };

  // Grow once, smoothly, when the text would overflow 90% of the collapsed
  // height; shrink back when the content fits again. Height is driven inline
  // here because scrollHeight never reads smaller than the element itself.
  const collapsedRef = useRef(0);
  useEffect(() => {
    if (!autoGrow) return;
    const element = ref.current;
    if (element === null) return;
    const style = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || 21;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    collapsedRef.current = lineHeight * (autoGrowRows ?? rows) + padding;
    element.style.setProperty("min-height", "0px", "important");
    element.style.height = `${collapsedRef.current}px`;
  }, [autoGrow, autoGrowRows, rows, ref]);
  useEffect(() => {
    if (!autoGrow) return;
    const element = ref.current;
    if (element === null || collapsedRef.current === 0) return;
    const collapsed = collapsedRef.current;
    // Content height comes from a hidden, same-width copy, so the live element
    // never has to change height for a measurement. Touching the live height
    // here used to make the box bounce on every keystroke: reading
    // clientWidth flushes style, a transient "0px" got snapshotted as the
    // computed value, and restoring the height then re-ran the 260ms height
    // transition from zero on every keystroke.
    const measurement = element.cloneNode(false) as HTMLTextAreaElement;
    measurement.value = element.value;
    measurement.rows = 1;
    measurement.style.position = "absolute";
    measurement.style.visibility = "hidden";
    measurement.style.pointerEvents = "none";
    measurement.style.height = "auto";
    measurement.style.minHeight = "0px";
    measurement.style.width = `${element.clientWidth}px`;
    measurement.style.overflow = "hidden";
    document.body.appendChild(measurement);
    const contentHeight = measurement.scrollHeight;
    measurement.remove();
    const target = contentHeight > collapsed * 0.9 ? collapsed * 2 : collapsed;
    element.style.height = `${target}px`;
  }, [autoGrow, value, ref]);

  return <div className="mention-box">
    <textarea ref={ref} className={className} value={value} autoFocus={autoFocus} rows={rows} placeholder={placeholder} aria-label={ariaLabel} onChange={(event) => { onChange(event.target.value); syncMention(event.target); }} onKeyDown={handleKeyDown} onClick={(event) => syncMention(event.currentTarget)} onKeyUp={(event) => { if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") syncMention(event.currentTarget); }} />
    {slash !== null && slashOptions.length > 0 ? <div className="slash-suggest" role="listbox" aria-label="模块命令">{slashOptions.map((command, index) => <button className={`slash-option ${index === activeIndex ? "is-active" : ""}`} type="button" role="option" aria-selected={index === activeIndex} key={command.id} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => { const next = `${value.slice(0, slash.start)}${value.slice(slash.end)}`; onChange(next); setSlash(null); setMention(null); onSlashCommand?.(command); window.requestAnimationFrame(() => { const element = ref.current; if (element) { element.focus(); element.setSelectionRange(slash.start, slash.start); } }); }}><span className="slash-option-label">{command.label}</span><small>{command.aliases.length > 0 ? `${command.aliases.join("、")} · ` : ""}{command.description}</small></button>)}</div> : null}
    {mention !== null && (createFormOpen || mention.forceNew === true) ? <EntityCreateForm defaultType={markerKind} defaultName={trimmedQuery} onCreate={submitCreateForm} onCancel={() => { setCreateFormOpen(false); setMention(null); }} submitLabel={`创建并插入 ${mention.marker}`} /> : null}
    {mention !== null && !createFormOpen && mention.forceNew !== true && optionCount > 0 ? <div className="mention-suggest" role="listbox" aria-label="选择要关联的对象">
      {suggestions.map((entity, index) => <button className={`mention-option ${index === safeIndex ? "is-active" : ""}`} key={entity.id} type="button" role="option" aria-selected={index === safeIndex} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(entity.name)}>{(() => { const KindIcon = ENTITY_META[entity.type].icon; return <KindIcon size={13} strokeWidth={1.8} aria-hidden="true" />; })()}<span className="mention-option-name">{entity.name}</span><small>{entityHint(entity)}</small></button>)}
      {wantsNew ? <button className="mention-option mention-option-create" type="button" role="option" aria-selected={safeIndex === suggestions.length} onMouseEnter={() => setActiveIndex(suggestions.length)} onMouseDown={(event) => event.preventDefault()} onClick={() => setCreateFormOpen(true)}><Plus size={13} aria-hidden="true" /><span className="mention-option-name">新建{kindLabel}「{trimmedQuery}」…</span></button> : null}
    </div> : null}
  </div>;
}

function LoadingState() { return <div className="timeline-state state-loading" role="status"><LoaderCircle className="spin" size={23} aria-hidden="true" /><span>正在读取时间轴……</span></div>; }

const DIAG_COPY_COUNT = 50;

/**
 * The debug log the user asked for: every console error, uncaught exception,
 * and failed API call lands in a ring buffer; the drawer exports only the
 * most recent 50 entries as JSON, so a bug report stays small.
 */
function DiagnosticsDrawer() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, forceRender] = useState(0);
  useEffect(() => subscribe(() => forceRender((current) => current + 1)), []);
  const entries = recentLogs(DIAG_COPY_COUNT);
  return <>
    <button className={`diag-toggle ${entries.length > 0 ? "has-entries" : ""}`} type="button" onClick={() => setOpen((current) => !current)} aria-label="诊断日志" aria-expanded={open}><Activity size={16} strokeWidth={1.9} aria-hidden="true" />{entries.length > 0 ? <span className="diag-badge">{entries.length}</span> : null}</button>
    {open ? <div className="diag-panel" role="dialog" aria-label="诊断日志">
      <div className="diag-head">
        <strong>诊断日志</strong>
        <span className="diag-count">最近 {entries.length} 条</span>
        <button className="diag-action" type="button" onClick={async () => { const copiedOk = await copyRecentJson(); setCopied(copiedOk); window.setTimeout(() => setCopied(false), 2000); }}>{copied ? "已复制" : <><ClipboardCopy size={13} strokeWidth={1.8} aria-hidden="true" />复制近期 JSON</>}</button>
        <button className="diag-action" type="button" onClick={() => clearLogs()}>清空</button>
        <button className="diag-action" type="button" onClick={() => setOpen(false)} aria-label="关闭诊断日志"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button>
      </div>
      <div className="diag-list">
        {entries.length === 0 ? <p className="diag-empty">暂无记录。页面报错、接口失败都会自动收进来。</p> : entries.slice().reverse().map((entry, index) => <div className={`diag-entry diag-${entry.level}`} key={`${entry.at}-${index}`}><time>{entry.at.slice(11, 19)}</time><div><span>{entry.message}</span>{entry.detail === undefined ? null : <small>{entry.detail}</small>}</div></div>)}
      </div>
    </div> : null}
  </>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="timeline-state state-error" role="alert"><div className="state-icon state-icon-error"><CircleHelp size={21} strokeWidth={1.8} aria-hidden="true" /></div><div><strong>暂时无法读取记录</strong><p>{message}</p><button className="text-button" type="button" onClick={onRetry}>重试</button></div></div>; }

function EmptyState({ title, showDemo, creatingDemo, onDemo }: { title: string; showDemo: boolean; creatingDemo: boolean; onDemo: () => void }) { return <div className="timeline-state state-empty"><div><strong>{title}</strong>{showDemo ? <button className="secondary-button" type="button" onClick={onDemo} disabled={creatingDemo}>{creatingDemo ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />}<span>{creatingDemo ? "准备预置记录中" : "加入预置记录"}</span></button> : null}</div></div>; }

function groupRecords(records: readonly RecordView[], fallbackDate: string): readonly { date: string; records: readonly RecordView[] }[] {
  const groups = new Map<string, RecordView[]>();
  for (const record of records) { const date = dateKeyForRecord(record.occurredAt, record.createdAt) ?? fallbackDate; const group = groups.get(date); if (group) group.push(record); else groups.set(date, [record]); }
  return [...groups.entries()].map(([date, items]) => ({ date, records: items }));
}

function Timeline({ records, assets, entities, loading, error, selectedDate, activeView, searchQuery, movieEnabled, moviePromptHidden, onMovieAttachToRecord, onMoviePromptSuppress, onRetry, onDemo, creatingDemo, onEdit, onDelete, onTaskStatus, onPreviewAsset, onOpenEntity }: { records: readonly RecordView[] | null; assets: readonly Asset[]; entities: readonly Entity[]; loading: boolean; error: string | null; selectedDate: string; activeView: AppView; searchQuery: string; movieEnabled: boolean; moviePromptHidden: boolean; onMovieAttachToRecord: (record: RecordView, movie: MovieEntity) => void; onMoviePromptSuppress: () => void; onRetry: () => void; onDemo: () => void; creatingDemo: boolean; onEdit: (record: RecordView) => void; onDelete: (record: RecordView) => void; onTaskStatus: (record: TaskRecordView, status: TaskStatus) => void; onPreviewAsset: (assetIds: readonly string[], index: number) => void; onOpenEntity: (entity: Entity) => void }) {
  const title = timelineHeading(activeView);
  const empty = emptyCopy(activeView, selectedDate, Boolean(searchQuery));
  const groups = records ? groupRecords(records, selectedDate) : [];
  return <section className="timeline-section" aria-labelledby="timeline-title"><div className="section-heading"><div><h2 id="timeline-title">{title}</h2></div>{records && records.length > 0 ? <span className="record-count">{records.length} 条</span> : null}</div>{loading ? <LoadingState /> : null}{!loading && error ? <ErrorState message={error} onRetry={onRetry} /> : null}{!loading && !error && records && records.length === 0 ? <EmptyState {...empty} onDemo={onDemo} creatingDemo={creatingDemo} /> : null}{!loading && !error && records && records.length > 0 ? <div className="timeline-list">{groups.map((group) => <div className="timeline-group" key={group.date}><h3 className="timeline-group-title">{group.date === localDateToday() ? `今天 · ${shortDate(group.date)}` : displayDate(group.date)}</h3>{group.records.map((record) => <TimelineItem key={record.id} record={record} assets={assets} entities={entities} movieEnabled={movieEnabled} moviePromptHidden={moviePromptHidden} onMovieAttachToRecord={onMovieAttachToRecord} onMoviePromptSuppress={onMoviePromptSuppress} onEdit={onEdit} onDelete={onDelete} onTaskStatus={onTaskStatus} onPreviewAsset={onPreviewAsset} onOpenEntity={onOpenEntity} />)}</div>)}</div> : null}</section>;
}

const WEEKDAY_LABELS: readonly string[] = ["一", "二", "三", "四", "五", "六", "日"];

/**
 * The records that landed on each day of the window the calendar is showing.
 * Insertion order is kept, because the API already ordered the list newest
 * first — re-sorting here would only risk disagreeing with the timeline.
 */
function recordsByDate(dates: readonly string[], records: readonly RecordView[]): ReadonlyMap<string, readonly RecordView[]> {
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

/** The original bytes. Only the zoom viewer wants these now. */
function assetContentUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/content`;
}

/** The two derived widths the API keeps: enough for a grid square on a 3x screen, and
 *  enough for a full-card background. Mirrors THUMBNAIL_WIDTHS on the server. */
type ThumbnailWidth = 400 | 1200;

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
function assetThumbUrl(assetId: string, width: ThumbnailWidth): string {
  return `/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=${width}`;
}

/**
 * The day's photos in the order they were taken (records arrive newest
 * first, so walk the day backwards), each carrying the free story signal:
 * how much text and how many entity refs the owning record has.
 */
function dayPhotoCandidates(items: readonly RecordView[]): readonly { assetId: string; story: number }[] {
  const found: { assetId: string; story: number }[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const record = items[index];
    for (const ref of record.assetRefs) {
      if (ref.role !== "photo") continue;
      found.push({ assetId: ref.assetId, story: storyWeight(recordText(record).length, record.entityRefs.length) });
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
function dayPhotoIds(items: readonly RecordView[]): readonly string[] {
  const ids = dayPhotoCandidates(items).map((candidate) => candidate.assetId);
  if (ids.length <= 4) return ids;
  const picked: string[] = [];
  for (let band = 0; band < 4; band += 1) {
    const id = ids[Math.round((band * (ids.length - 1)) / 3)];
    if (!picked.includes(id)) picked.push(id);
  }
  return picked;
}

/**
 * The one photo a month cell shows. Until scores arrive the day's first
 * photo stands in; once measured, the highest pixel-plus-story score wins,
 * chronological order breaking ties. Unmeasurable photos never win.
 */
function monthCellPhoto(candidates: readonly { assetId: string; story: number }[]): string | undefined {
  if (candidates.length === 0) return undefined;
  let bestId = candidates[0].assetId;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const measured = peekScore(assetThumbUrl(candidate.assetId, 1200));
    if (measured === undefined || measured < 0) continue;
    const total = measured + candidate.story;
    if (total > bestScore) {
      bestScore = total;
      bestId = candidate.assetId;
    }
  }
  return bestId;
}

type PeriodMoonPhase = "start" | "middle" | "end";

interface PeriodMoonMarker {
  readonly phase: PeriodMoonPhase;
  readonly forecast: boolean;
}

function phaseForPeriodDay(date: string, start: string, end: string, explicitEnd: string | undefined): PeriodMoonPhase {
  if (start === end) return "middle";
  if (date === start) return "start";
  if (explicitEnd === date) return "end";
  return "middle";
}

/** Confirmed boundaries win; an unclosed run stops at the configured duration. */
function periodMoonForDate(date: string, today: string, module: CycleIntimacyModuleData | null): PeriodMoonMarker | undefined {
  if (!module?.config.enabled) return undefined;
  const starts = module.events.filter((event) => event.kind === "period_start").map((event) => event.date).sort();
  const ends = module.events.filter((event) => event.kind === "period_end").map((event) => event.date).sort();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const nextStart = starts[index + 1];
    const explicitEnd = ends.find((end) => end >= start && (nextStart === undefined || end < nextStart));
    let end = explicitEnd ?? shiftDate(start, module.config.periodLength - 1);
    if (nextStart !== undefined && end >= nextStart) end = shiftDate(nextStart, -1);
    if (date >= start && date <= end) return { phase: phaseForPeriodDay(date, start, end, explicitEnd), forecast: false };
  }
  const baseline = starts[starts.length - 1] ?? module.config.anchorStart;
  if (baseline === undefined || date < today) return undefined;
  const difference = Math.floor((new Date(`${date}T12:00:00`).getTime() - new Date(`${baseline}T12:00:00`).getTime()) / 86_400_000);
  const nearestCycle = Math.max(0, Math.floor(difference / module.config.cycleLength));
  for (let index = Math.max(0, nearestCycle - 1); index <= nearestCycle + 1; index += 1) {
    const start = shiftDate(baseline, index * module.config.cycleLength);
    const end = shiftDate(start, module.config.periodLength - 1);
    if (date >= start && date <= end) return { phase: phaseForPeriodDay(date, start, end, undefined), forecast: true };
  }
  return undefined;
}

interface CalendarMarker { readonly id: string; readonly label: string; readonly content: ReactNode; }

/** Four reserved bottom-right slots: a single marker hugs the corner; new ones grow left. */
function CalendarDayMarkers({ date, today, module }: { readonly date: string; readonly today: string; readonly module: CycleIntimacyModuleData | null }) {
  if (!module?.config.enabled) return null;
  const period = periodMoonForDate(date, today, module);
  const intimate = module.events.some((event) => event.date === date && event.kind === "intimacy");
  const markers: CalendarMarker[] = [];
  if (period !== undefined) markers.push({ id: `period-${date}`, label: period.forecast ? "预计经期" : "已记录经期", content: <span className={`calendar-moon is-${period.phase} ${period.forecast ? "is-forecast" : ""}`} aria-hidden="true" /> });
  if (intimate) markers.push({ id: `intimacy-${date}`, label: "已记录亲密", content: <Heart className="calendar-heart" size={13} strokeWidth={1.9} aria-hidden="true" /> });
  const visible = markers.length > 4 ? [...markers.slice(0, 3), { id: `more-${date}`, label: `还有 ${markers.length - 3} 个日历事件`, content: <span className="calendar-marker-more" aria-hidden="true">+{markers.length - 3}</span> }] : markers;
  if (visible.length === 0) return null;
  return <span className="calendar-day-markers" aria-label={visible.map((marker) => marker.label).join("，")}>{visible.map((marker, index) => <span className="calendar-day-marker" key={marker.id} style={{ gridColumnStart: 5 - visible.length + index }}>{marker.content}</span>)}</span>;
}

interface CalendarWeather {
  readonly text: string;
  readonly icon: string;
  readonly tempMin: string;
  readonly tempMax: string;
}

function weatherFromArchiveValue(value: unknown, date: string): CalendarWeather | undefined {
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

function CalendarView({ mode, onModeChange, anchor, today, records, summaries, aiEnabled, weatherByDate, loading, error, cycleModule, onOpenCycleModule, onRetry, onOpenDay }: { mode: CalendarMode; onModeChange: (mode: CalendarMode) => void; anchor: string; today: string; records: readonly RecordView[] | null; summaries: ReadonlyMap<string, DaySummary>; aiEnabled: boolean; weatherByDate: ReadonlyMap<string, CalendarWeather>; loading: boolean; error: string | null; cycleModule: CycleIntimacyModuleData | null; onOpenCycleModule: () => void; onRetry: () => void; onOpenDay: (date: string) => void }) {
  const dates = useMemo(() => (mode === "week" ? datesOfWeek(anchor) : monthGridDates(anchor)), [mode, anchor]);
  const publicRecords = useMemo(() => (records ?? []).filter((record) => record.isPrivate !== true), [records]);
  const buckets = useMemo(() => recordsByDate(dates, publicRecords), [dates, publicRecords]);
  const inWindow = [...buckets.values()].reduce((total, items) => total + items.length, 0);
  const label = mode === "week" ? `${shortDate(dates[0] ?? anchor)} – ${shortDate(dates[6] ?? anchor)}` : monthTitle(anchor);
  // Month cells show the day's most substantial photo. Scores land one by
  // one; each arrival re-renders so cells upgrade from the first photo to
  // the measured winner without blocking the view.
  const [photoTick, setPhotoTick] = useState(0);
  void photoTick;
  useEffect(() => {
    if (mode !== "month") return;
    let cancelled = false;
    (async () => {
      for (const date of dates) {
        for (const candidate of dayPhotoCandidates(buckets.get(date) ?? [])) {
          await scorePhoto(assetThumbUrl(candidate.assetId, 1200));
          if (cancelled) return;
          setPhotoTick((tick) => tick + 1);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [mode, dates, buckets]);
  return <section className="calendar-section" aria-labelledby="calendar-title">
    <div className="section-heading">
      <div><h2 id="calendar-title">{label}</h2></div>
      <div className="calendar-heading-tools">
        {records !== null ? <span className="record-count">{inWindow} 条</span> : null}
        <button className={`calendar-module-button ${cycleModule?.config.enabled ? "is-enabled" : ""}`} type="button" onClick={onOpenCycleModule} aria-label="打开伴侣周期与亲密模块">
          <SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" /><span>{cycleModule?.config.enabled ? "周期与亲密" : "启用周期模块"}</span>
        </button>
        <div className="mode-switcher" role="tablist" aria-label="日历范围">
          <button className={`mode-option ${mode === "week" ? "is-active" : ""}`} type="button" role="tab" aria-selected={mode === "week"} onClick={() => onModeChange("week")}>周</button>
          <button className={`mode-option ${mode === "month" ? "is-active" : ""}`} type="button" role="tab" aria-selected={mode === "month"} onClick={() => onModeChange("month")}>月</button>
        </div>
      </div>
    </div>
    {mode === "month" ? <div className="calendar-note"><span className="calendar-holiday-legend"><span className="month-day-status is-holiday">休</span><span>法定休息</span><span className="month-day-status is-workday">班</span><span>调休上班</span></span></div> : null}
    {loading ? <LoadingState /> : null}
    {!loading && error ? <ErrorState message={error} onRetry={onRetry} /> : null}
    {!loading && !error ? (mode === "week" ? <div className="week-grid">
      {dates.map((date) => {
        const items = buckets.get(date) ?? [];
        const photoIds = dayPhotoIds(items);
        const highlights = weekCardRecords(items);
        return <button className={`week-card ${date === today ? "is-today" : ""}`} key={date} type="button" onClick={() => onOpenDay(date)} aria-label={`${displayDate(date)}，${items.length} 条记录`}>
          <span className="week-card-head"><span className="week-card-weekday">{weekdayShort(date)}</span><span className="week-card-day">{Number(date.slice(8, 10))}</span></span>
          <span className="week-card-body">
            {items.length === 0 ? <span className="week-card-empty">没有记录</span> : highlights.map((record) => <span className="week-card-line" key={record.id}><span className="week-card-time">{lifeTimeTime(record.occurredAt ?? record.createdAt)}</span><span className="week-card-text">{recordText(record)}</span></span>)}
          </span>
          <span className="week-card-foot">{items.length === 0 ? "—" : `${items.length} 条`}</span>
          <CalendarDayMarkers date={date} today={today} module={cycleModule} />
          {photoIds.length > 0 ? <span className={`week-card-art bands-${photoIds.length}`} aria-hidden="true">
            {photoIds.map((assetId, index) => <span className="week-card-band" key={`${assetId}-${index}`} style={{ top: `calc(${(index * 100) / photoIds.length}% - 16px)`, height: `calc(${100 / photoIds.length}% + 17px)` }}>
              <img src={assetThumbUrl(assetId, 1200)} alt="" loading="lazy" decoding="async" />
            </span>)}
            <span className="week-card-veil" />
          </span> : null}
        </button>;
      })}
    </div> : <div className="month-grid">
      {WEEKDAY_LABELS.map((label) => <span className="month-weekday" key={label}>{label}</span>)}
      {dates.map((date) => {
        const items = buckets.get(date) ?? [];
        const summary = summaries.get(date);
        const weather = weatherByDate.get(date);
        const dayInfo = calendarDayInfo(date);
        const inMonth = date.slice(0, 7) === anchor.slice(0, 7);
        const cellPhoto = inMonth ? monthCellPhoto(dayPhotoCandidates(items)) : undefined;
        const summaryText = summary === undefined ? "" : trimSummaryText(summary.text, SUMMARY_MAX_LENGTH);
        const holidayLabel = dayInfo.holiday === undefined ? "" : `${dayInfo.holiday.name} · ${dayInfo.holiday.kind === "holiday" ? "休息日" : "调休上班"}`;
        const weatherLabel = weather === undefined ? "" : `天气：${weather.text}，${weather.tempMin}~${weather.tempMax}°C`;
        const titleParts = [holidayLabel, dayInfo.solarTerm ? `节气：${dayInfo.solarTerm}` : "", weatherLabel, summaryText === "" ? "" : `${summaryText}（${summary?.status === "generated" ? `AI · ${summary?.provider}` : "规则生成"}）`].filter(Boolean);
        return <button className={`month-cell ${inMonth ? "" : "is-outside"} ${date === today ? "is-today" : ""} ${items.length === 0 ? "is-empty" : ""}`} key={date} type="button" onClick={() => onOpenDay(date)} aria-label={`${displayDate(date)}，${items.length} 条记录${titleParts.length > 0 ? `，${titleParts.join("，")}` : ""}`} title={titleParts.length > 0 ? titleParts.join(" · ") : undefined}>
          {cellPhoto !== undefined ? <span className="month-cell-art" aria-hidden="true"><img src={assetThumbUrl(cellPhoto, 1200)} alt="" loading="lazy" decoding="async" /><span className="month-cell-veil" /></span> : null}
          <span className="month-cell-head"><span className="month-day-number">{Number(date.slice(8, 10))}</span><span className="month-day-meta">{dayInfo.holiday ? <span className={`month-day-status is-${dayInfo.holiday.kind}`} aria-label={holidayLabel}>{dayInfo.holiday.kind === "holiday" ? "休" : "班"}</span> : null}{items.length > 0 ? <span className="month-day-count">{items.length}</span> : null}{weather !== undefined ? <span className="month-day-weather" aria-label={`天气：${weather.text}，${weather.tempMin}到${weather.tempMax}摄氏度`} title={`天气：${weather.text}，${weather.tempMin}~${weather.tempMax}°C`}><span aria-hidden="true">{getWeatherEmoji(weather.icon)}</span></span> : null}</span></span>
          {summaryText !== "" ? <span className={`month-day-summary ${summary?.status === "fallback" ? "is-fallback" : ""}`}>{summaryText}</span> : null}
          {dayInfo.solarTerm ? <span className="month-day-solar" aria-label={`节气：${dayInfo.solarTerm}`}>{dayInfo.solarTerm}</span> : null}
          <CalendarDayMarkers date={date} today={today} module={cycleModule} />
        </button>;
      })}
    </div>) : null}
  </section>;
}

function CycleModuleDialog({ open, module, selectedDate, onClose, onSaveConfig, onAddEvent, onDeleteEvent }: { open: boolean; module: CycleIntimacyModuleData | null; selectedDate: string; onClose: () => void; onSaveConfig: (config: CycleIntimacyModuleConfig) => Promise<void>; onAddEvent: (date: string, kind: CycleIntimacyEventKind) => Promise<void>; onDeleteEvent: (id: string) => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<CycleIntimacyModuleConfig | null>(null);
  const [entryDate, setEntryDate] = useState(selectedDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (module) setDraft(module.config); }, [module]);
  useEffect(() => setEntryDate(selectedDate), [selectedDate, open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && module && !dialog.open) dialog.showModal();
    if ((!open || !module) && dialog.open) dialog.close();
  }, [open, module]);
  if (!module || !draft) return <dialog ref={dialogRef} className="modal-dialog" />;
  const eventsForDate = module.events.filter((event) => event.date === entryDate);
  const eventFor = (kind: CycleIntimacyEventKind) => eventsForDate.find((event) => event.kind === kind);
  const perform = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await operation(); } catch (caught) { setError(errorMessage(caught, "私密日历暂时无法保存，请重试")); } finally { setBusy(false); }
  };
  const toggleEvent = (kind: CycleIntimacyEventKind) => {
    const existing = eventFor(kind);
    void perform(() => existing ? onDeleteEvent(existing.id) : onAddEvent(entryDate, kind));
  };
  return <dialog ref={dialogRef} className="modal-dialog cycle-module-dialog" aria-labelledby="cycle-module-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="dialog-header"><div><p className="eyebrow">可选模块</p><h2 id="cycle-module-title">伴侣周期与亲密</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭模块设置"><X size={17} aria-hidden="true" /></button></div>
    <div className="dialog-body">
      <label className="cycle-enable"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => current ? { ...current, enabled: event.target.checked } : current)} /><span><strong>在日历中启用</strong><small>关闭后不显示月亮或爱心，已有私密记录会保留。</small></span></label>
      <div className="dialog-fields-grid">
        <label className="dialog-field"><span>周期天数</span><input type="number" min="15" max="90" value={draft.cycleLength} onChange={(event) => setDraft((current) => current ? { ...current, cycleLength: Number(event.target.value) } : current)} /></label>
        <label className="dialog-field"><span>预计持续天数</span><input type="number" min="1" max="21" value={draft.periodLength} onChange={(event) => setDraft((current) => current ? { ...current, periodLength: Number(event.target.value) } : current)} /></label>
      </div>
      <label className="dialog-field"><span>最近一次经期开始（可选）</span><input type="date" value={draft.anchorStart ?? ""} onChange={(event) => setDraft((current) => { if (!current) return current; const { anchorStart: _anchorStart, ...rest } = current; return event.target.value ? { ...rest, anchorStart: event.target.value } : rest; })} /></label>
      <p className="cycle-dialog-note">虚影月亮只表示按以上间隔推算的预计日期；确认开始或结束后，会以实心月亮覆盖它。</p>
      <div className="cycle-settings-actions"><button className="primary-button" type="button" onClick={() => void perform(() => onSaveConfig(draft))} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{busy ? "保存中" : "保存模块设置"}</span></button></div>
      {draft.enabled ? <section className="cycle-entry-panel" aria-labelledby="cycle-entry-title"><div><p className="eyebrow">私密记录</p><h3 id="cycle-entry-title">标记一天</h3></div><label className="dialog-field"><span>日期</span><input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} /></label><div className="cycle-entry-options"><button className={`cycle-entry-option ${eventFor("intimacy") ? "is-active" : ""}`} type="button" onClick={() => toggleEvent("intimacy")} disabled={busy}><Heart size={17} strokeWidth={1.9} aria-hidden="true" /><span>{eventFor("intimacy") ? "已记录亲密（点此移除）" : "记录亲密"}</span></button><button className={`cycle-entry-option ${eventFor("period_start") ? "is-active" : ""}`} type="button" onClick={() => toggleEvent("period_start")} disabled={busy}><span className="cycle-option-moon is-start" aria-hidden="true" /><span>{eventFor("period_start") ? "经期开始已记录" : "记录经期开始"}</span></button><button className={`cycle-entry-option ${eventFor("period_end") ? "is-active" : ""}`} type="button" onClick={() => toggleEvent("period_end")} disabled={busy}><span className="cycle-option-moon is-end" aria-hidden="true" /><span>{eventFor("period_end") ? "经期结束已记录" : "记录经期结束"}</span></button></div></section> : null}
      {error ? <p className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" />{error}</p> : null}
    </div>
  </dialog>;
}

/**
 * The original image at full size. LifeOS keeps no thumbnail, so this asks the
 * same content endpoint the chip already uses; the browser caches it, which is
 * why opening a photo does not re-fetch what the chip just loaded.
 */
/**
 * A record's photo group, opened by tapping one specific square. The viewer opens on
 * that square and can walk the rest with ← →, so a nine-square grid does not force the
 * owner to close and reopen for each photo.
 */
function AssetPreview({ assetIds, index, assets, onClose, onIndexChange }: { assetIds: readonly string[]; index: number; assets: readonly Asset[]; onClose: () => void; onIndexChange: (index: number) => void }) {
  const assetId = assetIds[index] ?? assetIds[0] ?? "";
  const asset = assets.find((candidate) => candidate.id === assetId);
  const many = assetIds.length > 1;
  const step = useCallback((delta: number) => { onIndexChange(Math.min(assetIds.length - 1, Math.max(0, index + delta))); }, [assetIds.length, index, onIndexChange]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    // A background page must not scroll behind the photo.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, step]);
  return <div className="asset-preview" role="dialog" aria-modal="true" aria-label={asset?.originalName ?? "照片预览"} onClick={onClose}>
    <button className="asset-preview-close" type="button" onClick={onClose} aria-label="关闭预览"><X size={20} strokeWidth={1.9} aria-hidden="true" /></button>
    {many && index > 0 ? <button className="asset-preview-nav asset-preview-nav-prev" type="button" onClick={(event) => { event.stopPropagation(); step(-1); }} aria-label="上一张"><ChevronLeft size={22} strokeWidth={1.8} aria-hidden="true" /></button> : null}
    {many && index < assetIds.length - 1 ? <button className="asset-preview-nav asset-preview-nav-next" type="button" onClick={(event) => { event.stopPropagation(); step(1); }} aria-label="下一张"><ChevronRight size={22} strokeWidth={1.8} aria-hidden="true" /></button> : null}
    <figure className="asset-preview-figure" onClick={(event) => event.stopPropagation()}>
      {/* Deliberately the original, not a thumbnail: this is the one place the owner
          asked to see the picture, and it is opened one photo at a time. */}
      <img src={assetContentUrl(assetId)} alt={asset?.originalName ?? "照片"} />
      {asset?.originalName === undefined && !many ? null : <figcaption>{many ? `${index + 1} / ${assetIds.length}${asset?.originalName === undefined ? "" : " · "}` : ""}{asset?.originalName}</figcaption>}
    </figure>
  </div>;
}

function PrivacyMask({ onReveal, className = "" }: { onReveal: () => void; className?: string }) {
  return <button className={`privacy-mask ${className}`.trim()} type="button" onClick={onReveal} aria-label="隐私记录已隐藏，点击显示">****</button>;
}

function TimelineEntityChip({ refItem, entity, relationKind, onOpenEntity }: { refItem: EntityRef; entity: Entity | undefined; relationKind: RelationKind | undefined; onOpenEntity: (entity: Entity) => void }) {
  const movie = isMovieEntity(entity);
  const KindIcon = movie ? Film : relationKind === undefined ? (ENTITY_META[refItem.entityType]?.icon ?? Tag) : RELATION_META[relationKind].icon;
  const label = movie ? `《${entity.name}》` : refItem.label ?? refItem.entityId;
  const className = `relation-chip ${entity?.type === "person" ? "relation-chip-person" : ""} ${movie ? "relation-chip-movie" : ""} ${relationKind === undefined ? "relation-kind-none" : `relation-kind-${relationKind}`}`.trim();
  const content = <><KindIcon size={12} strokeWidth={1.9} aria-hidden="true" /><span>{label}</span></>;
  if (entity?.type !== "person" && !movie) return <span className={className}>{content}</span>;
  return <button className={className} type="button" onClick={() => onOpenEntity(movie ? asCoreEntity(entity) : entity)} aria-label={movie ? `查看${entity.name}的电影卡片` : `查看${entity.name}的人物卡片`}>{content}</button>;
}

/** Moments caps the grid at nine squares; the ninth announces what it hides. */
const PHOTO_GRID_LIMIT = 9;

/** A photo means a real local image. Recordings and attachments keep their chip. */
function isPhotoAsset(asset: Asset | undefined): boolean {
  return asset?.kind === "photo" && isLocalAsset(asset);
}

/**
 * A record's photos, laid out the way Moments lays out a post: one large, two and
 * four as a pair, three across from three up. The filename is deliberately absent —
 * `image_225.png` says nothing to the owner, and the chip it used to live in squeezed
 * the thumbnail down to 22px. The name still earns its place in the preview caption
 * and in the aria-label, where it helps rather than clutters.
 */
function RecordPhotoGrid({ assetIds, assets, onPreview }: { assetIds: readonly string[]; assets: readonly Asset[]; onPreview: (assetIds: readonly string[], index: number) => void }) {
  const shown = assetIds.slice(0, PHOTO_GRID_LIMIT);
  const hidden = assetIds.length - shown.length;
  return <div className="record-photo-grid" data-shown={shown.length}>
    {shown.map((assetId, index) => { const asset = assets.find((candidate) => candidate.id === assetId); return <button className="record-photo-cell" key={assetId} type="button" onClick={() => onPreview(assetIds, index)} aria-label={`放大查看 ${asset?.originalName ?? assetId}`}>
      <img src={assetThumbUrl(assetId, 400)} alt="" loading="lazy" decoding="async" />
      {hidden > 0 && index === shown.length - 1 ? <span className="record-photo-more">+{hidden}</span> : null}
    </button>; })}
  </div>;
}

function TimelineItem({ record, assets, entities, movieEnabled, moviePromptHidden, onMovieAttachToRecord, onMoviePromptSuppress, onEdit, onDelete, onTaskStatus, onPreviewAsset, onOpenEntity }: { record: RecordView; assets: readonly Asset[]; entities: readonly Entity[]; movieEnabled: boolean; moviePromptHidden: boolean; onMovieAttachToRecord: (record: RecordView, movie: MovieEntity) => void; onMoviePromptSuppress: () => void; onEdit: (record: RecordView) => void; onDelete: (record: RecordView) => void; onTaskStatus: (record: TaskRecordView, status: TaskStatus) => void; onPreviewAsset: (assetIds: readonly string[], index: number) => void; onOpenEntity: (entity: Entity) => void }) {
  const Icon = COMPOSER_META[record.kind].icon;
  const task = isTaskRecord(record) ? record : undefined;
  const [revealed, setRevealed] = useState(record.isPrivate !== true);
  const masked = record.isPrivate === true && !revealed;
  const reveal = () => setRevealed(true);
  const nextStatus: TaskStatus = task?.task.status === "done" ? "todo" : "done";
  const photoAssetIds = record.assetRefs.filter((ref) => isPhotoAsset(assets.find((candidate) => candidate.id === ref.assetId))).map((ref) => ref.assetId);
  const chipAssetRefs = record.assetRefs.filter((ref) => !photoAssetIds.includes(ref.assetId));
  const relationCount = record.entityRefs.length + record.relatedRecordIds.length + chipAssetRefs.length;
  const vocabulary = useMemo(() => mentionVocabulary(record, entities), [record, entities]);
  const showMoviePrompt = !masked && movieEnabled && !moviePromptHidden && record.kind === "journal" && recordText(record).includes("电影") && !record.entityRefs.some(isMovieRef);
  const photoLine = masked || photoAssetIds.length === 0 ? null : <RecordPhotoGrid assetIds={photoAssetIds} assets={assets} onPreview={onPreviewAsset} />;
  const relationLine = relationCount > 0 ? masked
    ? <div className="relation-row" aria-label="关联"><PrivacyMask onReveal={reveal} className="relation-mask" /></div>
    : <div className="relation-row" aria-label="关联">{record.entityRefs.map((ref) => <TimelineEntityChip key={`entity-${entityRefKey(ref)}`} refItem={ref} entity={entities.find((candidate) => candidate.id === ref.entityId)} relationKind={ref.entityType === "person" ? relationKindFor(ref.entityId, entities) : undefined} onOpenEntity={onOpenEntity} />)}{record.relatedRecordIds.length > 0 ? <span className="relation-chip"><Link2 size={12} strokeWidth={1.9} aria-hidden="true" />关联 {record.relatedRecordIds.length} 条记录</span> : null}{chipAssetRefs.map((ref) => { const asset = assets.find((candidate) => candidate.id === ref.assetId); return <span className="relation-chip" key={`asset-${ref.assetId}`}><ImageIcon size={12} strokeWidth={1.9} aria-hidden="true" />{asset?.originalName ?? ref.assetId}</span>; })}</div> : null;
  const weatherLine = record.weather === undefined || masked ? null : <div className="record-weather-row" aria-label="记录天气"><span className={`weather-record-chip weather-record-chip--${record.weather.mode}`}><CloudSun size={13} strokeWidth={1.8} aria-hidden="true" /><span>{record.weather.mode === "realtime" ? "现场" : "当天"} · {record.weather.text}</span>{record.weather.temperature ? <strong>{record.weather.temperature}°</strong> : record.weather.tempMin || record.weather.tempMax ? <strong>{record.weather.tempMin ?? "—"}~{record.weather.tempMax ?? "—"}°</strong> : null}<small>{record.weather.city}</small></span></div>;
  return <article className="timeline-item"><div className="timeline-time"><time dateTime={record.occurredAt?.value ?? record.createdAt.value}>{lifeTimeTime(record.occurredAt ?? record.createdAt)}</time></div><div className="timeline-marker" aria-hidden="true"><span /></div><div className="timeline-content"><div className="timeline-meta"><span className={`kind-tag kind-${record.kind}`}><Icon size={13} strokeWidth={1.8} aria-hidden="true" />{recordLabel(record.kind)}</span>{record.isBackfill === true ? <span className="backfill-tag"><History size={12} aria-hidden="true" />补记</span> : null}{record.isPrivate === true ? <span className="privacy-tag"><LockKeyhole size={12} aria-hidden="true" />隐私</span> : null}{record.body.edited ? <span className="edited-tag">已编辑</span> : null}</div><p className="timeline-text">{masked ? <PrivacyMask onReveal={reveal} /> : <><RecordText text={recordText(record)} entities={vocabulary} />{showMoviePrompt ? <MoviePrompt enabled={movieEnabled} onAttach={(movie) => onMovieAttachToRecord(record, movie)} onSuppress={onMoviePromptSuppress} /> : null}</>}</p>{photoLine}{relationLine}{weatherLine}{task ? (masked ? <div className="timeline-status"><PrivacyMask onReveal={reveal} /></div> : <span className={`timeline-status status-${task.task.status}`}>{statusLabel(task.task.status)}</span>) : null}<div className="timeline-actions" aria-label="记录操作">{task ? <><button className="record-action task-action" type="button" onClick={() => onTaskStatus(task, nextStatus)}>{task.task.status === "done" ? <RotateCcw size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}{task.task.status === "done" ? "恢复待办" : "完成"}</button>{task.task.status !== "cancelled" && task.task.status !== "done" ? <button className="record-action" type="button" onClick={() => onTaskStatus(task, "cancelled")}><XCircle size={14} aria-hidden="true" />取消</button> : null}</> : null}<button className="record-action" type="button" onClick={() => onEdit(record)}><Edit3 size={14} aria-hidden="true" />编辑</button><button className="record-action record-action-danger" type="button" onClick={() => onDelete(record)}><Trash2 size={14} aria-hidden="true" />删除</button></div></div></article>;
}

interface TaskUndoEntry { readonly task: TaskRecordView; readonly previousStatus: TaskStatus; }

function taskDueLabel(task: TaskRecordView): string {
  const date = lifeTimeDate(task.task.dueAt);
  if (date === undefined) return "";
  if (date === localDateToday()) return "今天";
  if (date === shiftDate(localDateToday(), 1)) return "明天";
  return shortDate(date);
}

function TaskSummary({ tasks, loading, error, onTaskStatus, onTaskStateChange }: { tasks: readonly RecordView[] | null; loading: boolean; error: string | null; onTaskStatus: (record: TaskRecordView, status: TaskStatus) => Promise<RecordView | null>; onTaskStateChange: (record: RecordView) => void }) {
  const [optimisticDoneIds, setOptimisticDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [undoEntry, setUndoEntry] = useState<TaskUndoEntry | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [countPulse, setCountPulse] = useState(false);
  const actionBusyRef = useRef(false);
  const undoTimerRef = useRef<number | null>(null);
  const countPulseTimerRef = useRef<number | null>(null);

  const clearUndoTimer = useCallback(() => {
    if (undoTimerRef.current === null) return;
    window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
  }, []);

  useEffect(() => () => clearUndoTimer(), [clearUndoTimer]);
  useEffect(() => () => { if (countPulseTimerRef.current !== null) window.clearTimeout(countPulseTimerRef.current); }, []);

  // Parent state changes are authoritative after a PATCH. Once they contain the
  // new status, the local marker is no longer needed.
  useEffect(() => {
    if (tasks === null) return;
    const taskById = new Map(tasks.filter(isTaskRecord).map((task) => [task.id, task]));
    setOptimisticDoneIds((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const id of current) {
        const task = taskById.get(id);
        if (task === undefined || task.task.status === "done" || task.task.status === "cancelled") next.delete(id);
      }
      return next.size === current.size ? current : next;
    });
    if (undoEntry !== null && !taskById.has(undoEntry.task.id) && !loading) {
      clearUndoTimer();
      setUndoEntry(null);
    }
  }, [clearUndoTimer, loading, tasks, undoEntry]);

  const activeTasks = (tasks ?? []).filter((task): task is TaskRecordView => task.isPrivate !== true && isTaskRecord(task) && task.task.status !== "done" && task.task.status !== "cancelled" && !optimisticDoneIds.has(task.id));

  const completeTask = async (task: TaskRecordView) => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setCompletingTaskId(task.id);
    try {
      const [updated] = await Promise.all([
        onTaskStatus(task, "done"),
        new Promise<void>((resolve) => window.setTimeout(resolve, 420)),
      ]);
      if (updated === null || !isTaskRecord(updated)) {
        return;
      }
      setOptimisticDoneIds((current) => new Set(current).add(task.id));
      onTaskStateChange(updated);
      if (countPulseTimerRef.current !== null) window.clearTimeout(countPulseTimerRef.current);
      setCountPulse(true);
      countPulseTimerRef.current = window.setTimeout(() => { setCountPulse(false); countPulseTimerRef.current = null; }, 520);
      clearUndoTimer();
      setUndoEntry({ task: updated, previousStatus: task.task.status });
      undoTimerRef.current = window.setTimeout(() => { setUndoEntry(null); undoTimerRef.current = null; }, 5000);
    } finally {
      setCompletingTaskId(null);
      actionBusyRef.current = false;
    }
  };

  const undoCompletion = async () => {
    if (undoEntry === null || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setUndoBusy(true);
    try {
      const restored = await onTaskStatus(undoEntry.task, undoEntry.previousStatus);
      if (restored === null) return;
      clearUndoTimer();
      setUndoEntry(null);
      setOptimisticDoneIds((current) => { const next = new Set(current); next.delete(undoEntry.task.id); return next; });
      onTaskStateChange(restored);
    } finally {
      setUndoBusy(false);
      actionBusyRef.current = false;
    }
  };

  const summaryBusy = completingTaskId !== null || undoBusy;
  return <aside className="task-summary" aria-labelledby="task-summary-title" aria-busy={summaryBusy}>
    <div className="summary-heading"><div><h2 id="task-summary-title">接下来要做</h2></div><span className={`summary-badge ${countPulse ? "is-updated" : ""}`}>{activeTasks.length}</span></div>
    {loading ? <div className="summary-message"><LoaderCircle className="spin" size={17} aria-hidden="true" />正在读取</div> : null}
    {!loading && error ? <div className="summary-message summary-error"><CircleHelp size={17} aria-hidden="true" />暂时无法读取任务</div> : null}
    {!loading && !error && activeTasks.length === 0 ? <div className="summary-empty"><Check size={17} strokeWidth={1.8} aria-hidden="true" /><span>暂时没有待办任务</span></div> : null}
    {!loading && !error && activeTasks.length > 0 ? <ul className="task-list">{activeTasks.slice(0, 5).map((task) => <li className={`task-summary-item ${completingTaskId === task.id ? "is-completing" : ""}`} key={task.id}>
      <button className={`task-dot task-dot-button ${task.task.status === "in_progress" ? "is-progress" : ""}`} type="button" onClick={() => void completeTask(task)} disabled={summaryBusy} aria-label={`完成任务：${recordText(task)}`} title="标记为已完成"><span className="task-dot-indicator" aria-hidden="true"><Check size={12} strokeWidth={3} /></span></button>
      <span className="task-summary-copy">{recordText(task)}</span>
      {task.task.dueAt ? <time dateTime={task.task.dueAt.value} aria-label={`截止时间：${taskDueLabel(task)}`}>{taskDueLabel(task)}</time> : null}
    </li>)}</ul> : null}
    {undoEntry !== null ? <div className="task-undo" role="status" aria-live="polite"><span className="task-undo-copy"><Check size={14} strokeWidth={2} aria-hidden="true" /><span>任务已完成，可在 5 秒内撤销</span></span><button className="text-button task-undo-button" type="button" onClick={() => void undoCompletion()} disabled={undoBusy} aria-label={`撤销完成：${recordText(undoEntry.task)}`}>{undoBusy ? "恢复中…" : "撤销"}</button></div> : null}
  </aside>;
}

interface RecordEditorDraft { content: string; occurredAt: string; dueAt: string; occurredDirty: boolean; dueDirty: boolean; isPrivate: boolean; isBackfill: boolean; status: TaskStatus; entityRefs: readonly EntityRef[]; relatedRecordIds: readonly string[]; assetRefs: readonly AssetLink[]; }

type RelationDraftPatch = Partial<Pick<RecordEditorDraft, "entityRefs" | "relatedRecordIds" | "assetRefs">>;

function RelationPanel({ entities, assets, candidates, draft, onChange, onCreateEntity }: { entities: readonly Entity[]; assets: readonly Asset[]; candidates: readonly RecordView[]; draft: RecordEditorDraft; onChange: (patch: RelationDraftPatch) => void; onCreateEntity: CreateEntity }) {
  const [createKind, setCreateKind] = useState<EntityKind>("person");
  const [createName, setCreateName] = useState("");
  const [createAliases, setCreateAliases] = useState("");
  const [createAddress, setCreateAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const selectedEntityIds = useMemo(() => new Set(draft.entityRefs.map((ref) => ref.entityId)), [draft.entityRefs]);
  const selectedAssetIds = useMemo(() => new Set(draft.assetRefs.map((ref) => ref.assetId)), [draft.assetRefs]);
  const selectedRecordIds = useMemo(() => new Set(draft.relatedRecordIds), [draft.relatedRecordIds]);

  const toggleEntity = (entity: Entity) => {
    onChange(selectedEntityIds.has(entity.id)
      ? { entityRefs: draft.entityRefs.filter((ref) => ref.entityId !== entity.id) }
      : { entityRefs: [...draft.entityRefs, { entityType: entity.type, entityId: entity.id, label: entity.name }] });
  };
  const toggleAsset = (asset: Asset) => {
    onChange(selectedAssetIds.has(asset.id)
      ? { assetRefs: draft.assetRefs.filter((ref) => ref.assetId !== asset.id) }
      : { assetRefs: [...draft.assetRefs, { assetId: asset.id, role: assetRoleFor(asset.kind), ...(asset.originalName === undefined ? {} : { label: asset.originalName }) }] });
  };
  const submitEntity = async () => {
    const name = createName.trim();
    if (!name || creating) return;
    const aliases = aliasListFrom(createAliases);
    setCreating(true);
    try {
      const entity = await onCreateEntity(createKind, name, { ...(aliases.length > 0 ? { aliases } : {}), ...(createKind === "place" && createAddress.trim() ? { address: createAddress.trim() } : {}) });
      if (entity) {
        onChange({ entityRefs: [...draft.entityRefs, { entityType: entity.type, entityId: entity.id, label: entity.name }] });
        setCreateName("");
        setCreateAliases("");
        setCreateAddress("");
      }
    } finally {
      setCreating(false);
    }
  };

  return <section className="relation-panel" aria-label="关联">
    <div className="relation-heading"><div><p className="eyebrow">关联</p><h3>把这条记录接到人和事上</h3></div><span className="relation-count">{draft.entityRefs.length + draft.relatedRecordIds.length + draft.assetRefs.length}</span></div>
    <p className="relation-hint">正文里用 {MENTION_MARKERS[0]!.marker} 提到的人、{MENTION_MARKERS[1]!.marker} 提到的地点会自动关联过来，展示时不显示符号。连续输入两个相同符号（如 ##）可直接新建。项目、主题请在下面直接勾选。</p>

    <div className="relation-kind-row">
      {ENTITY_KIND_ORDER.map((kind) => { const KindIcon = ENTITY_META[kind].icon; const options = entities.filter((entity) => entity.type === kind); const selected = draft.entityRefs.filter((ref) => ref.entityType === kind).filter((ref) => !options.some((entity) => entity.id === ref.entityId)); return <div className="relation-group" key={kind}>
        <div className="relation-group-title"><KindIcon size={14} strokeWidth={1.8} aria-hidden="true" /><span>{ENTITY_META[kind].label}</span></div>
        {options.length === 0 && selected.length === 0 ? <p className="relation-hint">还没有{ENTITY_META[kind].label}，可在下面新建。</p> : null}
        {options.length > 0 || selected.length > 0 ? <div className="relation-chips">
          {options.map((entity) => { const relationLabel = relationLabelFor(entity.id, entities); return <button className={`relation-toggle ${selectedEntityIds.has(entity.id) ? "is-on" : ""}`} key={entity.id} type="button" aria-pressed={selectedEntityIds.has(entity.id)} onClick={() => toggleEntity(entity)}>{entity.name}{relationLabel === undefined ? null : <small>{relationLabel}</small>}</button>; })}
          {selected.map((ref) => <button className="relation-toggle is-on relation-toggle-orphan" key={entityRefKey(ref)} type="button" aria-pressed={true} title="关联对象已不在列表中" onClick={() => onChange({ entityRefs: draft.entityRefs.filter((item) => item.entityId !== ref.entityId) })}>{ref.label ?? ref.entityId}</button>)}
        </div> : null}
      </div>; })}
    </div>

    <div className="relation-create">
      <select value={createKind} onChange={(event) => setCreateKind(event.target.value as EntityKind)} aria-label="要新建的关联对象类型">{ENTITY_KIND_ORDER.map((kind) => <option value={kind} key={kind}>{ENTITY_META[kind].label}</option>)}</select>
      <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="名称" aria-label="新关联对象名称" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitEntity(); } }} />
      <AliasField value={createAliases} onChange={setCreateAliases} label="新关联对象别名" placeholder="别名（可选，用 / 分隔）" compact />
      {createKind === "place" ? <input value={createAddress} onChange={(event) => setCreateAddress(event.target.value)} placeholder="详细地址（可选）" aria-label="新地点详细地址" /> : null}
      <button className="secondary-button relation-create-button" type="button" onClick={() => void submitEntity()} disabled={!createName.trim() || creating}>{creating ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}<span>新建并关联</span></button>
    </div>

    <div className="relation-group">
      <div className="relation-group-title"><Link2 size={14} strokeWidth={1.8} aria-hidden="true" /><span>相关记录</span></div>
      {draft.relatedRecordIds.length > 0 ? <div className="relation-chips">{draft.relatedRecordIds.map((id) => { const target = candidates.find((record) => record.id === id); return <button className="relation-toggle is-on" key={id} type="button" aria-pressed={true} onClick={() => onChange({ relatedRecordIds: draft.relatedRecordIds.filter((item) => item !== id) })}>{target ? `${shortDate(lifeTimeDate(target.occurredAt ?? target.createdAt) ?? "")} ${recordText(target).slice(0, 12)}` : id}</button>; })}</div> : null}
      {candidates.length === 0 ? <p className="relation-hint">当前已加载的记录里还没有可关联的其他记录。</p> : <select className="relation-select" value="" onChange={(event) => { const target = candidates.find((record) => record.id === event.target.value); if (target) onChange({ relatedRecordIds: [...draft.relatedRecordIds, target.id] }); }} aria-label="添加相关记录"><option value="">关联一条已有记录…</option>{candidates.filter((record) => !selectedRecordIds.has(record.id)).map((record) => <option value={record.id} key={record.id}>{`${shortDate(lifeTimeDate(record.occurredAt ?? record.createdAt) ?? "")} · ${recordText(record).slice(0, 24)}`}</option>)}</select>}
    </div>

    <div className="relation-group">
      <div className="relation-group-title"><ImageIcon size={14} strokeWidth={1.8} aria-hidden="true" /><span>照片与资产</span></div>
      {assets.length === 0 ? <p className="relation-hint">还没有登记资产。LifeOS 只保存可替换的引用，不复制 NAS 上的原件。</p> : <div className="relation-chips">{assets.map((asset) => <button className={`relation-toggle ${selectedAssetIds.has(asset.id) ? "is-on" : ""}`} key={asset.id} type="button" aria-pressed={selectedAssetIds.has(asset.id)} onClick={() => toggleAsset(asset)}>{asset.originalName ?? asset.id}<small>{ASSET_ROLE_LABEL[assetRoleFor(asset.kind)]}{formatBytes(asset.sizeBytes) === undefined ? "" : ` · ${formatBytes(asset.sizeBytes)}`}</small></button>)}</div>}
    </div>
  </section>;
}

function RecordEditorDialog({ record, saving, reloading, error, entities, assets, candidates, onClose, onSave, onReloadLatest, onCreateEntity }: { record: RecordView | null; saving: boolean; reloading: boolean; error: string | null; entities: readonly Entity[]; assets: readonly Asset[]; candidates: readonly RecordView[]; onClose: () => void; onSave: (record: RecordView, draft: RecordEditorDraft) => void; onReloadLatest: () => void; onCreateEntity: CreateEntity }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<RecordEditorDraft>({ content: "", occurredAt: "", dueAt: "", occurredDirty: false, dueDirty: false, isPrivate: false, isBackfill: false, status: "todo", entityRefs: [], relatedRecordIds: [], assetRefs: [] });
  const recordId = record?.id ?? null;
  useEffect(() => { if (record) setDraft({ content: recordText(record), occurredAt: lifeTimeToInput(record.occurredAt), dueAt: isTaskRecord(record) ? lifeTimeToInput(record.task.dueAt) : "", occurredDirty: false, dueDirty: false, isPrivate: record.isPrivate === true, isBackfill: record.isBackfill === true, status: isTaskRecord(record) ? record.task.status : "todo", entityRefs: record.entityRefs, relatedRecordIds: record.relatedRecordIds, assetRefs: record.assetRefs }); }, [recordId]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (record && !dialog.open) { dialog.showModal(); window.requestAnimationFrame(() => editorTextareaRef.current?.focus()); } if (!record && dialog.open) dialog.close(); }, [record]);
  if (!record) return <dialog ref={dialogRef} className="modal-dialog" />;
  const task = isTaskRecord(record) ? record : undefined;
  return <dialog ref={dialogRef} className="modal-dialog editor-dialog" aria-labelledby="editor-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">编辑记录</p><h2 id="editor-title">保留原文，更新当前内容</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭编辑"><X size={17} aria-hidden="true" /></button></div><div className="dialog-body"><div className="original-block"><div className="original-block-label"><span>原文</span><span>只读保留</span></div><p><RecordText text={record.body.original || "（原文为空）"} entities={mentionVocabulary(record, entities)} /></p></div>{error?.includes("最新版本") ? <div className="server-current-block"><div className="original-block-label"><span>最新服务端内容</span><span>草稿仍在编辑框中</span></div><p><RecordText text={recordText(record)} entities={mentionVocabulary(record, entities)} /></p></div> : null}<label className="dialog-field"><span>当前内容</span><MentionBox textareaRef={editorTextareaRef} autoFocus value={draft.content} onChange={(value) => setDraft((current) => ({ ...current, content: value }))} entities={entities} onCreateEntity={onCreateEntity} rows={5} ariaLabel="当前内容" /></label><div className="dialog-fields-grid"><label className="dialog-field"><span>发生时间</span><input type="datetime-local" value={draft.occurredAt} onChange={(event) => setDraft((current) => ({ ...current, occurredAt: event.target.value, occurredDirty: true }))} /></label>{task ? <label className="dialog-field"><span>截止时间</span><input type="datetime-local" value={draft.dueAt} onChange={(event) => setDraft((current) => ({ ...current, dueAt: event.target.value, dueDirty: true }))} /></label> : null}</div><div className="dialog-toggle-row"><label className={`backfill-toggle ${draft.isBackfill ? "is-on" : ""}`}><input type="checkbox" checked={draft.isBackfill} onChange={(event) => setDraft((current) => ({ ...current, isBackfill: event.target.checked }))} /><History size={14} strokeWidth={1.9} aria-hidden="true" /><span>补记</span></label><label className={`privacy-toggle dialog-privacy-toggle ${draft.isPrivate ? "is-on" : ""}`}><input type="checkbox" checked={draft.isPrivate} onChange={(event) => setDraft((current) => ({ ...current, isPrivate: event.target.checked }))} /><LockKeyhole size={14} strokeWidth={1.9} aria-hidden="true" /><span>隐私模式</span><small>日历隐藏，时间轴点击后显示</small></label></div>{task ? <label className="dialog-field"><span>任务状态</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))}><option value="todo">待办</option><option value="in_progress">进行中</option><option value="done">已完成</option><option value="cancelled">已取消</option></select></label> : null}<RelationPanel entities={entities} assets={assets} candidates={candidates} draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} onCreateEntity={onCreateEntity} />{error ? <div className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" /><span>{error}</span>{error.includes("冲突") || error.includes("409") || error.includes("最新版本") ? <button className="text-button" type="button" onClick={onReloadLatest} disabled={reloading}>{reloading ? "读取中" : error.includes("最新版本") ? "再次读取最新版本" : "读取最新版本，保留草稿"}</button> : null}</div> : null}</div><div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onSave(record, draft)} disabled={!draft.content.trim() || saving}>{saving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{saving ? "保存中" : "保存修改"}</span></button></div></dialog>;
}

function ConfirmDialog({ record, busy, error, onClose, onConfirm }: { record: RecordView | null; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (record && !dialog.open) dialog.showModal(); if (!record && dialog.open) dialog.close(); }, [record]);
  if (!record) return <dialog ref={dialogRef} className="modal-dialog" />;
  return <dialog ref={dialogRef} className="modal-dialog confirm-dialog" aria-labelledby="delete-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">删除记录</p><h2 id="delete-title">确定要删除这条记录吗？</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={17} aria-hidden="true" /></button></div><p className="confirm-copy">原文会从时间轴移除。导出的备份不会被修改。</p><div className="confirm-preview">{recordText(record)}</div>{error ? <p className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" />{error}</p> : null}<div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>保留</button><button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Trash2 size={17} aria-hidden="true" />}<span>{busy ? "删除中" : "删除记录"}</span></button></div></dialog>;
}

function PersonCardDialog({ entity, entities, onClose, onEdit, onViewRecords, onMovieSaved }: { entity: Entity | null; entities: readonly Entity[]; onClose: () => void; onEdit: (entity: Entity) => void; onViewRecords: (entity: Entity) => void; onMovieSaved: (movie: MovieEntity) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (entity && !dialog.open) dialog.showModal(); if (!entity && dialog.open) dialog.close(); }, [entity]);
  if (entity === null) return <dialog ref={dialogRef} className="modal-dialog" />;
  if (isMovieEntity(entity)) return <MovieCardDialog entity={entity} onClose={onClose} onSaved={onMovieSaved} />;
  const relationKind = relationKindFor(entity.id, entities);
  const relationItems = (entity.relations ?? []).filter((relation) => relation.entityId !== SELF_ENTITY_ID).map((relation) => ({ relation, target: entities.find((candidate) => candidate.id === relation.entityId) })).filter((item) => item.target !== undefined);
  return <dialog ref={dialogRef} className="modal-dialog person-card-dialog" aria-labelledby="person-card-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="person-card-hero"><div className="person-card-avatar"><ContactRound size={25} strokeWidth={1.7} aria-hidden="true" /></div><div className="person-card-heading"><p className="eyebrow">人物卡片</p><h2 id="person-card-title">{entity.name}</h2>{relationKind === undefined ? <span className="person-card-relation relation-kind-none">人物</span> : <span className={`person-card-relation relation-kind-${relationKind}`}><span className="relation-card-icon">{(() => { const Icon = RELATION_META[relationKind].icon; return <Icon size={13} strokeWidth={1.9} aria-hidden="true" />; })()}</span>{RELATION_META[relationKind].label}</span>}</div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭人物卡片"><X size={17} aria-hidden="true" /></button></div>
    <div className="person-card-body">
      {entity.aliases && entity.aliases.length > 0 ? <div className="person-card-field"><small>别名</small><div className="person-card-aliases">{entity.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div></div> : null}
      {entity.description ? <div className="person-card-field"><small>备注</small><p>{entity.description}</p></div> : <p className="person-card-empty">还没有人物备注，可以在编辑人物里补充。</p>}
      {relationItems.length > 0 ? <div className="person-card-field"><small>关系</small><div className="person-card-connections">{relationItems.map(({ relation, target }) => { const Icon = RELATION_META[relation.kind].icon; return <span className={`person-card-connection relation-kind-${relation.kind}`} key={`${relation.kind}-${target!.id}`}><Icon size={13} strokeWidth={1.9} aria-hidden="true" /><span>{target!.name}</span><small>{RELATION_META[relation.kind].label}</small></span>; })}</div></div> : null}
    </div>
    <div className="dialog-footer person-card-footer"><button className="secondary-button" type="button" onClick={() => onViewRecords(entity)}><ExternalLink size={15} aria-hidden="true" /><span>查看相关记录</span></button><button className="primary-button" type="button" onClick={() => onEdit(entity)}><Edit3 size={15} aria-hidden="true" /><span>编辑人物</span></button></div>
  </dialog>;
}

function EntityEditDialog({ entity, onClose, onSave }: { entity: Entity | null; onClose: () => void; onSave: (entity: Entity, patch: { name: string; aliases: readonly string[]; description?: string; address?: string | null }) => Promise<Entity | null> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [description, setDescription] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  // Existing aliases come back slash-separated, matching what the field now
  // accepts -- round-tripping through the old comma join would have shown them
  // as one unseparated run the moment anything was edited.
  useEffect(() => { if (entity) { setName(entity.name); setAliases(entity.aliases?.join(" / ") ?? ""); setDescription(entity.description ?? ""); setAddress(entity.type === "place" ? entity.address ?? "" : ""); } }, [entity?.id]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (entity && !dialog.open) dialog.showModal(); if (!entity && dialog.open) dialog.close(); }, [entity]);
  if (entity === null) return <dialog ref={dialogRef} className="modal-dialog" />;
  const submit = async () => {
    const nextName = name.trim();
    if (!nextName || saving) return;
    setSaving(true);
    const result = await onSave(entity, { name: nextName, aliases: aliasListFrom(aliases), description: description.trim(), ...(entity.type === "place" ? { address: address.trim() || null } : {}) });
    setSaving(false);
    if (result) onClose();
  };
  return <dialog ref={dialogRef} className="modal-dialog entity-edit-dialog" aria-labelledby="entity-edit-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">{entity.type === "place" ? "地点资料" : "联系人资料"}</p><h2 id="entity-edit-title">编辑 {entity.name}</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭编辑"><X size={17} aria-hidden="true" /></button></div><div className="entity-edit-body"><label className="dialog-field"><span>{entity.type === "place" ? "名称" : "姓名"}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="dialog-field"><span>别名</span><AliasField value={aliases} onChange={setAliases} label="别名，用斜杠分隔" placeholder="多个别名用 / 分隔" /></label>{entity.type === "place" ? <label className="dialog-field"><span>详细地址</span><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="可选；平时不会展开" /></label> : null}<label className="dialog-field"><span>备注</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={entity.type === "place" ? "写下这个地点的一些背景" : "写下这个人的一些背景"} /></label></div><div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => void submit()} disabled={!name.trim() || saving}>{saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}<span>{saving ? "保存中" : "保存"}</span></button></div></dialog>;
}

function entityRelatedRecords(entity: Entity, records: readonly RecordView[]): readonly RecordView[] {
  return records.filter((record) => record.entityRefs.some((ref) => ref.entityId === entity.id)).slice(0, 3);
}

function locationSearchUrl(address: string): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`;
}

function entityPeriodLabel(entity: Entity): string | null {
  if (entity.type !== "place" || entity.period === undefined) return null;
  const from = entity.period.from ?? "更早";
  const until = entity.period.until ?? "至今";
  return `${from}—${until}`;
}

function EntitiesView({ entities, records, onCreateEntity, onEdit, onViewRecords }: { readonly entities: readonly Entity[]; readonly records: readonly RecordView[]; readonly onCreateEntity: CreateEntity; readonly onEdit: (entity: Entity) => void; readonly onViewRecords: (entity: Entity) => void }) {
  const [tab, setTab] = useState<"person" | "place">("person");
  const [createOpen, setCreateOpen] = useState(false);
  const items = entities.filter((entity) => entity.type === tab);
  const create = async (request: EntityCreateRequest): Promise<boolean> => {
    const entity = await onCreateEntity(request.type, request.name, {
      ...(request.aliases === undefined ? {} : { aliases: request.aliases }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.period === undefined ? {} : { period: request.period }),
      ...(request.address === undefined ? {} : { address: request.address }),
    });
    if (entity !== null) setCreateOpen(false);
    return entity !== null;
  };
  return <section className="entities-section" aria-labelledby="entities-title">
    <div className="page-heading entities-heading"><div><p className="eyebrow">关联对象</p><h1 id="entities-title">联系人与地点</h1><p>集中管理会出现在时间轴里的联系人与地点。</p></div><button className="primary-button" type="button" onClick={() => setCreateOpen((current) => !current)}><Plus size={16} aria-hidden="true" /><span>新建{tab === "person" ? "联系人" : "地点"}</span></button></div>
    {createOpen ? <div className="entities-create-panel"><EntityCreateForm defaultType={tab} defaultName="" onCreate={create} onCancel={() => setCreateOpen(false)} submitLabel={`创建${tab === "person" ? "联系人" : "地点"}`} /></div> : null}
    <div className="entities-tabs" role="tablist" aria-label="联系人与地点分类">
      <button type="button" role="tab" aria-selected={tab === "person"} className={`entities-tab ${tab === "person" ? "is-active" : ""}`} onClick={() => { setTab("person"); setCreateOpen(false); }}><User size={16} aria-hidden="true" />联系人<span>{entities.filter((entity) => entity.type === "person").length}</span></button>
      <button type="button" role="tab" aria-selected={tab === "place"} className={`entities-tab ${tab === "place" ? "is-active" : ""}`} onClick={() => { setTab("place"); setCreateOpen(false); }}><MapPin size={16} aria-hidden="true" />地点<span>{entities.filter((entity) => entity.type === "place").length}</span></button>
    </div>
    <div className="entities-grid" role="tabpanel" aria-label={tab === "person" ? "联系人" : "地点"}>
      {items.length === 0 ? <div className="entities-empty"><ContactRound size={24} aria-hidden="true" /><strong>还没有{tab === "person" ? "联系人" : "地点"}</strong><span>从右上角新建一个，之后可以在记录中用 {tab === "person" ? "@" : "#"} 提及。</span></div> : items.map((entity) => {
        const recent = entityRelatedRecords(entity, records);
        const relation = entity.type === "person" ? relationLabelFor(entity.id, entities) : undefined;
        const period = entityPeriodLabel(entity);
        return <article className={`entity-library-card entity-library-card--${entity.type}`} key={entity.id} data-entity-card={entity.id}>
          <div className="entity-library-card-head"><div className="entity-library-icon" aria-hidden="true">{entity.type === "person" ? <User size={18} /> : <MapPin size={18} />}</div><div><h2>{entity.name}</h2>{relation ? <span className="entity-library-role">{relation}</span> : entity.type === "place" && entity.role ? <span className="entity-library-role">{PLACE_ROLE_LABELS[entity.role]}</span> : null}</div><button className="icon-button compact-icon-button" type="button" onClick={() => onEdit(entity)} aria-label={`编辑${entity.type === "person" ? "联系人" : "地点"}${entity.name}`}><Edit3 size={15} aria-hidden="true" /></button></div>
          <div className="entity-library-meta">{entity.aliases && entity.aliases.length > 0 ? <span>别名：{entity.aliases.join("、")}</span> : null}{period ? <span>时期：{period}</span> : null}</div>
          {entity.type === "place" && entity.address ? <div className="entity-library-address"><a href={locationSearchUrl(entity.address)} target="_blank" rel="noreferrer" aria-label={`一键定位${entity.name}`}>一键定位</a><details><summary>查看详细地址</summary><span>{entity.address}</span></details></div> : null}
          <div className="entity-library-recent"><small>最近关联记录</small>{recent.length > 0 ? recent.map((record) => <button type="button" className="entity-library-record" key={record.id} onClick={() => onViewRecords(entity)}><time>{shortDate(lifeTimeDate(record.occurredAt ?? record.createdAt) ?? "")}</time><span>{record.isPrivate ? "隐私记录" : recordText(record).slice(0, 32)}</span></button>) : <span className="entity-library-muted">暂无关联记录</span>}</div>
          <button className="entity-library-view" type="button" onClick={() => onViewRecords(entity)}>查看全部关联记录 <ExternalLink size={13} aria-hidden="true" /></button>
        </article>;
      })}
    </div>
  </section>;
}

function SearchDialog({ open, initialQuery, onClose, onSearch }: { open: boolean; initialQuery: string; onClose: () => void; onSearch: (query: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (open && !dialog.open) { dialog.showModal(); window.requestAnimationFrame(() => searchInputRef.current?.focus()); } if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={dialogRef} className="modal-dialog search-dialog" aria-labelledby="search-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">查找</p><h2 id="search-title">搜索你的记录</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭搜索"><X size={17} aria-hidden="true" /></button></div><form onSubmit={(event) => { event.preventDefault(); onSearch(query.trim()); onClose(); }}><label className="search-dialog-input"><Search size={17} aria-hidden="true" /><input ref={searchInputRef} autoFocus aria-label="搜索关键词" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => { setQuery(""); onSearch(""); onClose(); }}>清空</button><button className="primary-button" type="submit"><Search size={17} aria-hidden="true" /><span>搜索</span></button></div></form></dialog>;
}

function MobileMenuDialog({ open, activeView, onClose, onNavigate }: { open: boolean; activeView: AppView; onClose: () => void; onNavigate: (view: AppView) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (open && !dialog.open) dialog.showModal(); if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={dialogRef} className="mobile-menu-dialog" aria-label="LifeOS 菜单" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="mobile-menu-header"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-name">LifeOS</span></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭菜单"><X size={18} aria-hidden="true" /></button></div><nav className="mobile-menu-nav" aria-label="移动端主导航">{[...NAV_ITEMS, SETTINGS_NAV_ITEM].map((item) => { const Icon = item.icon; return <button className={`mobile-menu-nav-item ${activeView === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => { onNavigate(item.id); onClose(); }}><Icon size={18} aria-hidden="true" /><span>{item.label}</span></button>; })}</nav></dialog>;
}

function ImportDialog({ file, busy, error, onClose, onConfirm }: { file: File | null; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (file && !dialog.open) dialog.showModal(); if (!file && dialog.open) dialog.close(); }, [file]);
  if (!file) return <dialog ref={dialogRef} className="modal-dialog" />;
  return <dialog ref={dialogRef} className="modal-dialog confirm-dialog" aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">导入备份</p><h2 id="import-title">确认恢复这份 JSON？</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={17} aria-hidden="true" /></button></div><p className="confirm-copy">LifeOS 会把这份备份交给 API 校验后恢复。先确认文件来自你信任的备份。</p><div className="confirm-preview import-file"><FileJson size={18} aria-hidden="true" /><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></div>{error ? <p className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" />{error}</p> : null}<div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Upload size={17} aria-hidden="true" />}<span>{busy ? "导入中" : "确认导入"}</span></button></div></dialog>;
}

function LoginGate({ onLogin, error, loading }: { onLogin: (password: string) => void; error: string | null; loading: boolean }) {
  const [password, setPassword] = useState("");
  return <main className="auth-screen"><div className="auth-panel surface" role="dialog" aria-modal="true" aria-labelledby="auth-title"><div className="auth-icon"><LockKeyhole size={21} strokeWidth={1.8} aria-hidden="true" /></div><p className="eyebrow">LifeOS</p><h1 id="auth-title">输入访问密码</h1><p className="auth-description">这是一个自托管的私人空间。</p><form onSubmit={(event) => { event.preventDefault(); onLogin(password); }}><label className="auth-label"><span>密码</span><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error ? <p className="auth-error" role="alert">{error}</p> : null}<button className="primary-button auth-submit" type="submit" disabled={!password || loading}>{loading ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <LockKeyhole size={17} aria-hidden="true" />}<span>{loading ? "验证中" : "进入 LifeOS"}</span></button></form></div></main>;
}

const AI_DEFAULT_BASE_URL = "https://api.deepseek.com";
type AiPresetId = AiStatus["preset"];
type AiReasoningEffort = Exclude<AiStatus["reasoningEffort"], null>;
const AI_PRESETS: readonly { readonly id: Exclude<AiPresetId, "custom">; readonly label: string; readonly detail: string; readonly model: string; readonly thinking: boolean; readonly reasoningEffort: AiReasoningEffort | null }[] = [
  { id: "quick", label: "日常问答", detail: "快速回答 · 关闭思考", model: "deepseek-flash", thinking: false, reasoningEffort: null },
  { id: "reflect", label: "深度复盘", detail: "开启思考 · high", model: "deepseek-flash", thinking: true, reasoningEffort: "high" },
  { id: "review", label: "重要复盘", detail: "开启思考 · high", model: "deepseek-v4-pro", thinking: true, reasoningEffort: "high" },
];

function aiPresetFor(model: string, thinking: boolean, reasoningEffort: AiStatus["reasoningEffort"], baseUrl: string): AiPresetId {
  if (baseUrl.trim().replace(/\/$/, "") !== AI_DEFAULT_BASE_URL) return "custom";
  if (!thinking && reasoningEffort === null && model === "deepseek-flash") return "quick";
  if (thinking && reasoningEffort === "high" && model === "deepseek-flash") return "reflect";
  if (thinking && reasoningEffort === "high" && model === "deepseek-v4-pro") return "review";
  return "custom";
}

function aiPresetLabel(id: AiPresetId): string {
  return id === "quick" ? "日常问答" : id === "reflect" ? "深度复盘" : id === "review" ? "重要复盘" : "自定义";
}

function AiSettingsCard({ status, open, onChanged }: { readonly status: AiStatus; readonly open: boolean; readonly onChanged: (status: AiStatus) => void }) {
  const [expanded, setExpanded] = useState(open);
  const [enabled, setEnabled] = useState(status.enabled);
  const [baseUrl, setBaseUrl] = useState(status.baseUrl || AI_DEFAULT_BASE_URL);
  const [model, setModel] = useState(status.model || "deepseek-flash");
  const [thinking, setThinking] = useState(status.thinking);
  const [reasoningEffort, setReasoningEffort] = useState<AiStatus["reasoningEffort"]>(status.reasoningEffort);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setExpanded(true); }, [open]);
  useEffect(() => { if (open) window.dispatchEvent(new Event("lifeos:close-ai")); }, [open]);
  useEffect(() => { setEnabled(status.enabled); setBaseUrl(status.baseUrl || AI_DEFAULT_BASE_URL); setModel(status.model || "deepseek-flash"); setThinking(status.thinking); setReasoningEffort(status.reasoningEffort); }, [status.enabled, status.baseUrl, status.model, status.thinking, status.reasoningEffort]);
  const currentPreset = aiPresetFor(model, thinking, reasoningEffort, baseUrl);
  const call = async (path: string, body: Record<string, unknown>) => apiRequest<AiStatus & { readonly ok?: boolean; readonly message?: string }>(path, { method: "POST", body: JSON.stringify(body) });
  const applyPreset = (preset: (typeof AI_PRESETS)[number]) => { setModel(preset.model); setThinking(preset.thinking); setReasoningEffort(preset.reasoningEffort); setMessage(null); setError(null); };
  const save = async () => {
    if (busy) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const next = await call("/api/ai/config", { enabled, baseUrl, model, thinking, reasoningEffort: thinking ? reasoningEffort ?? "high" : null, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      const nextStatus: AiStatus = { preset: next.preset, enabled: next.enabled, configured: next.configured, keyConfigured: next.keyConfigured, provider: next.provider, model: next.model, baseUrl: next.baseUrl, thinking: next.thinking, reasoningEffort: next.reasoningEffort, keySource: next.keySource };
      setApiKey(""); onChanged(nextStatus); setMessage("AI 配置已保存");
    } catch (cause) { setError(errorMessage(cause, "AI 配置保存失败，请重试")); }
    finally { setBusy(false); }
  };
  const test = async () => {
    if (busy) return;
    setBusy(true); setMessage(null); setError(null);
    try { const result = await call("/api/ai/config/test", { baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }); setMessage(result.message ?? "AI 服务连接成功"); }
    catch (cause) { setError(errorMessage(cause, "AI 服务连接失败，请检查地址和 API Key")); }
    finally { setBusy(false); }
  };
  const keyConfigured = status.keyConfigured;
  const stateLabel = !status.enabled ? "已关闭" : keyConfigured ? "已启用" : "规则回退";
  return <div className="settings-card settings-ai-card">
    <div className="settings-ai-head">
      <div className="settings-card-icon"><Bot size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong>DeepSeek AI</strong><small>API Key：{keyConfigured ? "已配置" : "未配置"} · provider：DeepSeek</small></div>
      <span className={`settings-status ${status.enabled && keyConfigured ? "is-ready" : ""}`}>{stateLabel}</span>
      <button className="secondary-button settings-action" type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? "收起配置" : "配置 AI"}</button>
    </div>
    <div className="settings-ai-effective" aria-label="当前生效的 AI 配置">
      <div className="settings-ai-effective-item" data-ai-effective="model"><span>当前模型</span><strong>{status.model || "—"}</strong></div>
      <div className="settings-ai-effective-item" data-ai-effective="thinking"><span>思考</span><strong>{status.thinking ? "开启" : "关闭"}</strong></div>
      <div className="settings-ai-effective-item" data-ai-effective="reasoning"><span>推理强度</span><strong>{status.thinking && status.reasoningEffort !== null ? status.reasoningEffort : "— / 不启用"}</strong></div>
      <div className="settings-ai-effective-item is-wide" data-ai-effective="base-url"><span>服务地址</span><strong title={status.baseUrl}>{status.baseUrl || "—"}</strong></div>
      <div className="settings-ai-effective-item" data-ai-effective="key"><span>API Key</span><strong>{keyConfigured ? "已配置" : "未配置"}</strong></div>
    </div>
    {expanded ? <div className="settings-ai-form">
      <div className="settings-ai-presets" aria-label="AI 快捷档位">
        <div className="settings-ai-form-heading"><span>快捷档位</span><strong data-ai-current-preset={`preset-${currentPreset}`}>{aiPresetLabel(currentPreset)}</strong></div>
        <div className="settings-ai-preset-grid">{AI_PRESETS.map((preset) => <button className={`settings-ai-preset ${currentPreset === preset.id ? "is-selected" : ""}`} data-ai-preset={preset.id} aria-pressed={currentPreset === preset.id} type="button" key={preset.id} onClick={() => applyPreset(preset)}><strong>{preset.label}<em className="settings-ai-preset-id">{preset.id}</em></strong><small>{preset.detail}</small><em>{preset.model}</em></button>)}</div>
      </div>
      <div className="settings-ai-fields">
        <label><span>模型</span><input data-ai-field="model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-flash" /></label>
        <label><span>思考开关</span><span className="settings-ai-toggle"><input data-ai-field="thinking" type="checkbox" checked={thinking} onChange={(event) => { const next = event.target.checked; setThinking(next); setReasoningEffort(next ? reasoningEffort ?? "high" : null); }} /><span>{thinking ? "开启" : "关闭"}</span></span></label>
        <label><span>推理强度</span><select data-ai-field="reasoning-effort" value={thinking ? reasoningEffort ?? "high" : ""} disabled={!thinking} onChange={(event) => setReasoningEffort(event.target.value === "low" || event.target.value === "high" || event.target.value === "max" ? event.target.value : null)}><option value="">— / 不启用</option><option value="low">low</option><option value="high">high</option><option value="max">max</option></select></label>
        <label><span>API Key</span><input data-ai-field="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keyConfigured ? "已保存，留空表示继续使用" : "填写 DeepSeek API Key"} autoComplete="new-password" /></label>
        <label className="is-wide"><span>服务地址</span><input data-ai-field="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={AI_DEFAULT_BASE_URL} /></label>
        <label className="settings-ai-enabled is-wide"><input data-ai-field="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>启用真实 AI；关闭后仍保留本地规则模式</span></label>
      </div>
      <div className="settings-ai-actions"><button className="secondary-button" type="button" onClick={() => void test()} disabled={busy}>{busy ? "处理中…" : "测试连接"}</button><button className="primary-button" type="button" onClick={() => void save()} disabled={busy || !baseUrl.trim() || !model.trim()}>{busy ? "保存中…" : "保存配置"}</button></div>{message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}<small className="settings-ai-note">API Key 只写入 API 服务端的加密配置文件，不进入浏览器本地存储或 SQLite 备份。</small>
    </div> : null}
  </div>;
}

/**
 * Everything a Bitiful cdnb bucket needs except the key pair. Kept in one place
 * so the form can offer a one-click fill instead of making the owner retype six
 * fields whose values are already fixed by the provider.
 */
const BITIFUL_PRESET = { endpoint: "https://s3.bitiful.net", region: "cn-east-1", bucket: "cdnb", prefix: "product-backup/lifeos", forcePathStyle: false } as const;

/** Shown until the server answers; mirrors apps/api's documented defaults. */
const DEFAULT_RETENTION_DRAFT: BackupRetentionPolicy = { dailyDays: 7, weeklyWeeks: 8, monthlyMonths: 12, trashDays: 30 };

const RETENTION_TIER_LABELS: Record<BackupRetentionView["entries"][number]["tier"], string> = {
  daily: "日备",
  weekly: "周备",
  monthly: "月备",
  newest: "最新",
  none: "将清理",
};

function BackupSettingsCard({ backupStatus, backupBusy, onBackup, onChanged }: { readonly backupStatus: BackupStatus; readonly backupBusy: boolean; readonly onBackup: (action: "local" | "s3" | "test" | "dual") => void; readonly onChanged: (status: BackupStatus) => void }) {
  const s3 = backupStatus.s3;
  const localTransport = s3.transport === "file" || s3.endpoint.startsWith("file:");
  const [enabled, setEnabled] = useState(s3.enabled);
  const [endpoint, setEndpoint] = useState(s3.endpoint || "https://s3.bitiful.net");
  const [region, setRegion] = useState(s3.region || "cn-east-1");
  const [bucket, setBucket] = useState(s3.bucket || "cdnb");
  const [prefix, setPrefix] = useState(s3.prefix || "product-backup/lifeos");
  const [forcePathStyle, setForcePathStyle] = useState(s3.forcePathStyle);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(backupStatus.schedule.enabled);
  const [scheduleHour, setScheduleHour] = useState(backupStatus.schedule.hour);
  const [scheduleMinute, setScheduleMinute] = useState(backupStatus.schedule.minute);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The credential form is useless while hidden, so keep it expanded whenever
  // there is no usable cloud target yet — nobody should have to hunt for where
  // the Endpoint / keys are typed.
  const needsConfiguring = !s3.configured || localTransport;
  const [detailsOpen, setDetailsOpen] = useState(needsConfiguring);
  useEffect(() => {
    if (needsConfiguring) setDetailsOpen(true);
  }, [needsConfiguring]);
  const [retention, setRetention] = useState<BackupRetentionView | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retentionDraft, setRetentionDraft] = useState<BackupRetentionPolicy>(DEFAULT_RETENTION_DRAFT);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionMessage, setRetentionMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<BackupRetentionView>("/api/backup/retention", { signal: controller.signal })
      .then((view) => {
        if (controller.signal.aborted) return;
        setRetention(view);
        setRetentionDraft(view.policy);
      })
      .catch(() => { /* the panel stays hidden while the endpoint is unavailable */ });
    return () => controller.abort();
  }, [backupStatus.runs]);
  const saveRetention = async () => {
    if (retentionSaving) return;
    setRetentionSaving(true);
    setRetentionMessage(null);
    try {
      const view = await apiRequest<BackupRetentionView>("/api/backup/retention", { method: "POST", body: JSON.stringify(retentionDraft) });
      setRetention(view);
      setRetentionDraft(view.policy);
      setRetentionMessage("保留策略已保存，下一次备份完成后按新策略清理");
    } catch (cause) {
      setRetentionMessage(errorMessage(cause, "保存保留策略失败"));
    } finally {
      setRetentionSaving(false);
    }
  };
  useEffect(() => {
    setEnabled(s3.enabled);
    setEndpoint(s3.endpoint || "https://s3.bitiful.net");
    setRegion(s3.region || "cn-east-1");
    setBucket(s3.bucket || "cdnb");
    setPrefix(s3.prefix || "product-backup/lifeos");
    setForcePathStyle(s3.forcePathStyle);
  }, [s3.enabled, s3.endpoint, s3.region, s3.bucket, s3.prefix, s3.forcePathStyle]);
  useEffect(() => {
    setScheduleEnabled(backupStatus.schedule.enabled);
    setScheduleHour(backupStatus.schedule.hour);
    setScheduleMinute(backupStatus.schedule.minute);
  }, [backupStatus.schedule.enabled, backupStatus.schedule.hour, backupStatus.schedule.minute]);
  const latestRun = (provider: "local" | "s3") => backupStatus.runs.find((run) => run.provider === provider && run.kind !== "test");
  const localRun = latestRun("local");
  const s3Run = latestRun("s3");
  const s3RunWroteLocally = s3Run?.location?.startsWith("file:") ?? false;
  const formatRun = (run: typeof localRun) => {
    if (!run) return "从未备份";
    if (run.status === "skipped") return `已跳过 · ${run.error ?? "未配置"}`;
    if (run.status === "failed") return `失败 · ${run.error ?? "未知错误"}`;
    return run.finishedAt ? new Date(run.finishedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "已完成";
  };
  const formatBytes = (size: number | undefined) => size === undefined ? "" : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  const formatWhen = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const formatTotal = (count: number, bytes: number) => count === 0 ? "0 份" : `${count} 份 · ${formatBytes(bytes)}`;
  const dual = backupStatus.lastDualBackup;
  const dualWroteLocally = dual?.s3.location?.startsWith("file:") ?? false;
  const dualLabel = dual === null ? "尚未执行" : dual.status === "success" ? dualWroteLocally ? "本地与「本机目录模拟」均已写入" : "本地与对象存储均成功" : dual.status === "local_only" ? "本地成功 · 远端已跳过" : dual.status === "partial" ? "本地成功 · 远端失败" : "本地失败 · 未上传远端";
  const s3BadgeLabel = localTransport ? (s3.configured && s3.enabled ? "本机目录模拟 · 未联网" : "仅本地备份") : s3.configured && s3.enabled ? "对象存储已启用" : "仅本地备份";
  const s3BadgeClass = localTransport ? "is-blocked" : s3.configured && s3.enabled ? "is-ready" : "";
  const applyPreset = () => {
    setEndpoint(BITIFUL_PRESET.endpoint);
    setRegion(BITIFUL_PRESET.region);
    setBucket(BITIFUL_PRESET.bucket);
    setPrefix(BITIFUL_PRESET.prefix);
    setForcePathStyle(BITIFUL_PRESET.forcePathStyle);
    setError(null);
    setMessage("已填入 Bitiful（cdnb）预设，只剩 Access Key 和 Secret Key 需要粘贴");
  };
  const save = async () => {
    if (saving) return;
    setSaving(true); setMessage(null); setError(null);
    try {
      await apiRequest("/api/backup/config", { method: "POST", body: JSON.stringify({ enabled, endpoint, region, bucket, prefix, forcePathStyle, ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim() } : {}), ...(secretAccessKey.trim() ? { secretAccessKey: secretAccessKey.trim() } : {}) }) });
      setAccessKeyId(""); setSecretAccessKey("");
      onChanged(await apiRequest<BackupStatus>("/api/backup/status"));
      setMessage("对象存储配置已保存");
    } catch (cause) {
      setError(errorMessage(cause, "保存对象存储配置失败，请检查字段"));
    } finally { setSaving(false); }
  };
  const saveSchedule = async () => {
    if (scheduleSaving) return;
    setScheduleSaving(true);
    setScheduleMessage(null);
    try {
      await apiRequest("/api/backup/schedule", { method: "POST", body: JSON.stringify({ enabled: scheduleEnabled, hour: scheduleHour, minute: scheduleMinute }) });
      onChanged(await apiRequest<BackupStatus>("/api/backup/status"));
      setScheduleMessage(scheduleEnabled ? `已设置每天 ${String(scheduleHour).padStart(2, "0")}:${String(scheduleMinute).padStart(2, "0")} 执行` : "定时双备份已停用");
    } catch (cause) {
      setScheduleMessage(errorMessage(cause, "保存定时备份失败"));
    } finally {
      setScheduleSaving(false);
    }
  };
  return <div className="settings-backup-card">
    <div className="settings-backup-overview"><div className="settings-backup-icon"><CloudUpload size={19} aria-hidden="true" /></div><div className="settings-card-copy"><strong>数据备份</strong></div><span className={`settings-status ${s3BadgeClass}`}>{s3BadgeLabel}</span></div>
    {localTransport ? <p className="settings-backup-warning" data-backup-local-transport>{s3.warning ?? "当前对象存储 Endpoint 是本机目录（file://），备份不会联网上传。"}</p> : null}
    <div className="settings-backup-stats"><div><small>最近本地结果</small><strong>{formatRun(localRun)}{localRun?.status === "success" && localRun.sizeBytes === undefined ? "" : localRun?.status === "success" && localRun.sizeBytes !== undefined ? ` · ${formatBytes(localRun.sizeBytes)}` : ""}</strong></div><div><small>最近对象存储结果</small><strong>{formatRun(s3Run)}{s3Run?.status === "success" && s3Run.sizeBytes !== undefined ? ` · ${formatBytes(s3Run.sizeBytes)}` : ""}{s3RunWroteLocally ? " · 本机目录" : ""}</strong></div></div>
    <div className="settings-backup-dual" data-backup-dual-status><div><span>双备份结果</span><strong className={`is-${dual?.status ?? "empty"}`}>{dualLabel}</strong>{dual?.s3.status === "skipped" || dual?.s3.status === "failed" ? <small>{dual.s3.error ?? "远端没有成功"}</small> : null}</div><button className="primary-button" data-backup-action="dual" type="button" onClick={() => onBackup("dual")} disabled={backupBusy || saving}>{backupBusy ? "执行中…" : "立即双备份"}</button></div>
    <div className="settings-backup-actions"><button className="secondary-button" type="button" onClick={() => onBackup("local")} disabled={backupBusy || saving}><HardDrive size={15} aria-hidden="true" /><span>{backupBusy ? "备份中" : "备份到本地"}</span></button><button className="primary-button" type="button" onClick={() => onBackup("s3")} disabled={backupBusy || saving || !s3.configured || !s3.enabled}><CloudUpload size={15} aria-hidden="true" /><span>备份到对象存储</span></button><button className="icon-text-button" type="button" onClick={() => onBackup("test")} disabled={backupBusy || saving || !s3.configured || !s3.enabled}><PlugZap size={15} aria-hidden="true" /><span>测试连接</span></button></div>
    <div className="settings-backup-schedule" data-backup-schedule><div className="settings-backup-schedule-head"><div><span>定时双备份</span><small>服务端执行 · Asia/Shanghai</small></div><label className="settings-switch"><input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} /><span aria-hidden="true" /></label></div><div className="settings-backup-schedule-controls"><label><span>每天</span><select value={scheduleHour} onChange={(event) => setScheduleHour(Number(event.target.value))}>{Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{String(hour).padStart(2, "0")}</option>)}</select></label><b>:</b><label><span>时刻</span><select value={scheduleMinute} onChange={(event) => setScheduleMinute(Number(event.target.value))}>{[0, 15, 30, 45].map((minute) => <option value={minute} key={minute}>{String(minute).padStart(2, "0")}</option>)}</select></label><button className="secondary-button" type="button" onClick={() => void saveSchedule()} disabled={scheduleSaving}>{scheduleSaving ? "保存中…" : "保存排程"}</button></div><div className="settings-backup-schedule-next">{scheduleEnabled && backupStatus.schedule.nextRunAt ? `即将执行：${new Date(backupStatus.schedule.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` : "定时双备份未启用"}{scheduleMessage ? <span role="status"> · {scheduleMessage}</span> : null}</div></div>
    {retention === null ? null : <details className="settings-backup-retention" data-backup-retention open={retentionOpen} onToggle={(event) => setRetentionOpen(event.currentTarget.open)}><summary><Archive size={15} aria-hidden="true" /><span>保留策略：日备 {retention.policy.dailyDays} 天 · 周备 {retention.policy.weeklyWeeks} 周 · 月备 {retention.policy.monthlyMonths} 个月</span><span className="settings-backup-retention-count" data-backup-retention-count>{retention.summary.keepCount} 份保留 · {retention.summary.deleteCount} 份待清理</span><ChevronDown size={15} aria-hidden="true" /></summary>
      <div className="settings-backup-retention-body">
        <ul className="settings-backup-retention-rules" data-backup-retention-rules>{retention.described.map((line) => <li key={line}>{line}</li>)}</ul>
        <div className="settings-backup-retention-stats">
          <div><small>当前保留</small><strong>{formatTotal(retention.summary.keepCount, retention.summary.keepBytes)}</strong></div>
          <div><small>待清理</small><strong>{formatTotal(retention.summary.deleteCount, retention.summary.deleteBytes)}</strong></div>
          <div><small>下次清理</small><strong>{retention.cleanupScheduled && retention.nextCleanupAt ? formatWhen(retention.nextCleanupAt) : "定时备份未启用"}</strong></div>
        </div>
        <p className="settings-backup-retention-scope" data-backup-retention-scope>清理不会直接删掉：本地副本移入备份目录下的 <code>_trash</code>，云端对象移入 <code>{(s3.prefix || "product-backup/lifeos") + "-trash"}</code>，在回收站留满 {retention.policy.trashDays} 天后才真正删除。{retention.cleanupTrigger}</p>
        <div className="settings-backup-retention-list">{retention.entries.length === 0 ? <p className="settings-backup-retention-note">还没有备份。</p> : retention.entries.slice(0, 12).map((entry) => <div className={`settings-backup-retention-row ${entry.keep ? "is-keep" : "is-drop"}`} key={entry.fileName} data-backup-retention-row={entry.keep ? "keep" : "drop"}><span className={`settings-backup-retention-tier is-${entry.tier}`}>{RETENTION_TIER_LABELS[entry.tier]}</span><span className="settings-backup-retention-when">{formatWhen(entry.startedAt)}{entry.sizeBytes === undefined ? "" : ` · ${formatBytes(entry.sizeBytes)}`}</span><span className="settings-backup-retention-why">{entry.reason}</span></div>)}{retention.entries.length > 12 ? <p className="settings-backup-retention-note">仅显示最近 12 份，共 {retention.entries.length} 份。</p> : null}</div>
        {retention.trashed.length > 0 ? <div className="settings-backup-retention-trashed" data-backup-retention-trashed><p className="settings-backup-retention-note">已清理 {retention.trashed.length} 份，仍在回收站里（可以拿回来）。最近几份：</p>{retention.trashed.slice(0, 6).map((entry) => <div className="settings-backup-retention-row is-drop" key={entry.fileName + entry.prunedAt}><span className="settings-backup-retention-tier is-none">回收站</span><span className="settings-backup-retention-when">{formatWhen(entry.prunedAt)}</span><span className="settings-backup-retention-why">{entry.fileName} · {entry.provider === "s3" ? "云端" : "本地"}</span></div>)}</div> : null}
        {retention.connectionTestCount > 0 ? <p className="settings-backup-retention-note">另有 {retention.connectionTestCount} 个连接测试文件（{formatBytes(retention.connectionTestBytes)}）不算备份，不参与保留。</p> : null}
        <div className="settings-backup-retention-form"><label><span>日备保留天数</span><input type="number" min={retention.limits.dailyDays.min} max={retention.limits.dailyDays.max} value={retentionDraft.dailyDays} onChange={(event) => setRetentionDraft({ ...retentionDraft, dailyDays: Number(event.target.value) })} /></label><label><span>周备保留周数</span><input type="number" min={retention.limits.weeklyWeeks.min} max={retention.limits.weeklyWeeks.max} value={retentionDraft.weeklyWeeks} onChange={(event) => setRetentionDraft({ ...retentionDraft, weeklyWeeks: Number(event.target.value) })} /></label><label><span>月备保留月数</span><input type="number" min={retention.limits.monthlyMonths.min} max={retention.limits.monthlyMonths.max} value={retentionDraft.monthlyMonths} onChange={(event) => setRetentionDraft({ ...retentionDraft, monthlyMonths: Number(event.target.value) })} /></label><label><span>回收站保留天数</span><input type="number" min={retention.limits.trashDays.min} max={retention.limits.trashDays.max} value={retentionDraft.trashDays} onChange={(event) => setRetentionDraft({ ...retentionDraft, trashDays: Number(event.target.value) })} /></label><button className="secondary-button" type="button" data-backup-retention-save onClick={() => void saveRetention()} disabled={retentionSaving}>{retentionSaving ? "保存中…" : "保存保留策略"}</button></div>
        {retentionMessage ? <p className="settings-inline-success" role="status">{retentionMessage}</p> : null}
      </div></details>}
    <details className="settings-backup-details" data-backup-config-details open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}><summary><FolderOpen size={15} aria-hidden="true" /><span>{needsConfiguring ? "填写对象存储配置（Endpoint / Region / Bucket / 密钥）" : "对象存储配置与本地目录"}</span><ChevronDown size={15} aria-hidden="true" /></summary><div className="settings-backup-details-body"><div><small>本地目录</small><code>{backupStatus.localDirectory ?? "未配置"}</code></div><div><small>当前 Endpoint</small><code>{s3.endpoint || "未配置"}</code></div><div><small>当前 Bucket / Prefix</small><code>{s3.configured ? `${s3.bucket} / ${s3.prefix}` : "尚未保存云端配置"}</code></div><div className="settings-backup-form"><label><span>Endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://s3.bitiful.net" /></label><div className="settings-backup-form-row"><label><span>Region</span><input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="cn-east-1" /></label><label><span>Bucket</span><input value={bucket} onChange={(event) => setBucket(event.target.value)} placeholder="cdnb" /></label></div><label><span>Prefix / 文件夹</span><input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="product-backup/lifeos" /></label><div className="settings-backup-form-row"><label><span>Access Key</span><input value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} autoComplete="off" placeholder={s3.configured ? "已保存，留空不变" : "填写 Access Key"} /></label><label><span>Secret Key</span><input value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} type="password" autoComplete="new-password" placeholder={s3.configured ? "已保存，留空不变" : "填写 Secret Key"} /></label></div><label className="settings-backup-checkbox"><input type="checkbox" checked={forcePathStyle} onChange={(event) => setForcePathStyle(event.target.checked)} /><span>使用 Path-style URL（MinIO / 自建 S3 时开启；cdnb 保持关闭）</span></label><label className="settings-backup-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>启用对象存储自动备份</span></label><div className="settings-backup-form-actions"><button className="secondary-button" type="button" data-backup-preset onClick={applyPreset} disabled={saving}>填入 Bitiful 预设</button><button className="primary-button" type="button" onClick={() => void save()} disabled={saving || !endpoint.trim() || !region.trim() || !bucket.trim()}>{saving ? "保存中…" : "保存对象存储配置"}</button></div>{message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}<p className="settings-backup-note">密钥只提交给 API 服务端并加密保存，不会进入浏览器本地存储或 SQLite 备份。保存后再点上方“测试连接”，确认 cdnb 真实可写。</p></div></div></details>
    <BackupCalendar initialRuns={backupStatus.runs} />
  </div>;
}

function WeatherSettingsCard({ status, profiles, activeProfileId, onChanged, onProfilesChanged }: { readonly status: WeatherStatus | null; readonly profiles: readonly WeatherProfile[]; readonly activeProfileId: string | null; readonly onChanged: (status: WeatherStatus) => void; readonly onProfilesChanged: (payload: WeatherProfilesResponse) => void }) {
  const [enabled, setEnabled] = useState(status?.enabled ?? true);
  const [apiKey, setApiKey] = useState("");
  const [locationId, setLocationId] = useState(status?.locationId ?? "");
  const [city, setCity] = useState(status?.city ?? "");
  const [apiHost, setApiHost] = useState(status?.apiHost ?? "devapi.qweather.com");
  const [profileName, setProfileName] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(activeProfileId);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    setEnabled(status.enabled);
    setLocationId(status.locationId);
    setCity(status.city);
    setApiHost(status.apiHost || "devapi.qweather.com");
  }, [status]);

  useEffect(() => {
    setSelectedProfileId(activeProfileId);
    const active = profiles.find((profile) => profile.id === activeProfileId);
    if (active) setProfileName(active.label);
  }, [activeProfileId, profiles]);

  const save = async () => {
    if (busy || (!locationId.trim() && !city.trim())) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await apiRequest<WeatherStatus>("/api/weather/config", { method: "POST", body: JSON.stringify({ enabled, locationId, city, apiHost, ...(apiKey.trim() ? { apiKey } : {}) }) });
      onChanged(next);
      setApiKey("");
      setMessage("天气配置已保存");
    } catch (caught) {
      setError(errorMessage(caught, "天气配置保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (testing || !locationId.trim()) return;
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      await apiRequest<{ ok: true; message: string }>("/api/weather/config/test", { method: "POST", body: JSON.stringify({ locationId, apiHost, ...(apiKey.trim() ? { apiKey } : {}) }) });
      setMessage("天气 API 连接成功");
    } catch (caught) {
      setError(errorMessage(caught, "天气 API 连接失败"));
    } finally {
      setTesting(false);
    }
  };

  const activateProfile = async (id: string) => {
    if (!id || busy || testing) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await apiRequest<WeatherProfilesResponse>("/api/weather/profiles/activate", { method: "POST", body: JSON.stringify({ id }) });
      onProfilesChanged(next);
      onChanged(next.status);
      setSelectedProfileId(next.activeProfileId);
      setApiKey("");
      setMessage("天气方案已切换");
    } catch (caught) {
      setError(errorMessage(caught, "天气方案切换失败"));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    if (busy || testing || (!locationId.trim() && !city.trim())) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await apiRequest<WeatherProfilesResponse>("/api/weather/profiles", { method: "POST", body: JSON.stringify({ ...(selectedProfileId === null ? {} : { id: selectedProfileId }), label: profileName.trim() || city.trim() || locationId.trim(), locationId, city, apiHost, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), activate: true }) });
      onProfilesChanged(next);
      onChanged(next.status);
      setSelectedProfileId(next.activeProfileId);
      setApiKey("");
      setMessage("天气方案已保存并应用");
    } catch (caught) {
      setError(errorMessage(caught, "天气方案保存失败"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="settings-weather-card">
    <div className="settings-weather-overview"><div className="settings-card-icon"><CloudSun size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>天气动画与预报</strong><small className="settings-weather-scope">{status?.locationScope === "device" ? "本设备独立城市" : "沿用服务端默认城市"}</small></div><span className={`settings-status ${status?.configured ? "is-ready" : ""}`}>{status?.configured ? "已连接" : "未配置"}</span></div>
    <div className="settings-weather-form">
      <div className="settings-weather-profile-row"><label><span>已保存的天气方案</span><select value={selectedProfileId ?? ""} onChange={(event) => { const id = event.target.value; setSelectedProfileId(id || null); if (id) void activateProfile(id); }} disabled={busy || testing}><option value="">当前手动配置 / 服务端默认</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.label} · {profile.city || profile.locationId}{profile.hasKey ? "" : " · 缺少 Key"}</option>)}</select></label><label><span>方案名称</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="例如：佛山南海区" /></label></div>
      <label><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder={status?.hasKey ? "已保存，留空不变" : "填写和风天气 Key"} /></label>
      <div className="settings-weather-form-row"><label><span>位置 ID</span><input value={locationId} onChange={(event) => setLocationId(event.target.value)} placeholder="例如 101280601" /></label><label><span>城市名（备用）</span><input value={city} onChange={(event) => setCity(event.target.value)} placeholder="例如 佛山南海区" /></label></div>
      <label><span>API Host</span><input value={apiHost} onChange={(event) => setApiHost(event.target.value)} placeholder="devapi.qweather.com" /></label>
      <label className="settings-backup-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>启用天气模块与表头动画</span></label>
      <div className="settings-weather-actions"><button className="icon-text-button" type="button" onClick={() => void test()} disabled={testing || busy || !locationId.trim()}>{testing ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}<span>{testing ? "测试中…" : "测试连接"}</span></button><button className="secondary-button" type="button" onClick={() => void saveProfile()} disabled={busy || testing || (!locationId.trim() && !city.trim())}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}<span>{busy ? "保存中…" : "保存为天气方案"}</span></button><button className="primary-button" type="button" onClick={() => void save()} disabled={busy || testing || (!locationId.trim() && !city.trim())}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}<span>{busy ? "保存中…" : "保存默认配置"}</span></button></div>
      {message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      <p className="settings-weather-note">测试成功后可保存为方案；方案会加密保存 API Host、API Key 和位置 ID，之后直接切换即可。未配置 Key 时，表头不会伪造天气数据。</p>
    </div>
  </div>;
}

interface AssetTrashPendingItem {
  readonly asset: Asset;
  readonly dueAt: string;
  readonly daysRemaining: number;
  readonly overdue: boolean;
}

interface AssetTrashItem {
  readonly asset: Asset;
  readonly trashedAt: string;
  readonly origin: "orphan-scan" | "asset-delete";
  readonly daysRemaining: number;
}

interface AssetTrashView {
  readonly graceDays: number;
  readonly trashDays: number;
  readonly nextRunAt: string;
  readonly pending: readonly AssetTrashPendingItem[];
  readonly trashed: readonly AssetTrashItem[];
}

/** The derived-thumbnail cache: how much of it there is, and where it lives. */
interface AssetThumbnailCacheView {
  readonly count: number;
  readonly bytes: number;
  readonly widths: readonly number[];
  readonly directory: string;
}

const ASSET_TRASH_ORIGIN_LABELS: Record<AssetTrashItem["origin"], string> = { "orphan-scan": "自动清理", "asset-delete": "手动删除" };

function assetTrashName(asset: Asset): string {
  return asset.originalName !== undefined && asset.originalName.trim() !== "" ? asset.originalName : "未命名照片";
}

function assetTrashMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: USER_TIME_ZONE, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function assetTrashRemaining(days: number): string {
  return days <= 0 ? "即将清理" : `还剩 ${days} 天`;
}

/**
 * The two halves of the asset lifecycle, made visible: uploads waiting out
 * their grace period, and collected files that can still be put back.
 */
function AssetTrashSettingsCard({ onAssetsChanged }: { readonly onAssetsChanged: () => void }) {
  const [view, setView] = useState<AssetTrashView | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiRequest<AssetTrashView>("/api/assets/trash", { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setView(payload);
        setUnavailable(null);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        // Without LIFEOS_ASSET_ROOT the host never opted into local files, so
        // the panel says so instead of showing an error the owner cannot act on.
        setView(null);
        setUnavailable(errorMessage(cause, "照片回收站暂不可用"));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const act = async (id: string, requestPath: string, method: "POST" | "DELETE", done: string) => {
    if (busyId !== null) return;
    setBusyId(id);
    setMessage(null);
    setError(null);
    try {
      await apiRequest<void>(requestPath, { method });
      onAssetsChanged();
      setConfirmId(null);
      setReload((current) => current + 1);
      setMessage(done);
    } catch (cause) {
      setError(errorMessage(cause, "操作失败，请重试"));
    } finally {
      setBusyId(null);
    }
  };

  const pending = view?.pending ?? [];
  const trashed = view?.trashed ?? [];
  return <div className="settings-asset-trash-card" data-asset-trash>
    <div className="settings-asset-trash-overview">
      <div className="settings-card-icon"><Trash2 size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong>照片回收站</strong><small>拖进输入框、又没保存的照片，会先在原处留 {view?.graceDays ?? 7} 天；过期后由服务端自动收走，再在回收站放 {view?.trashDays ?? 30} 天可以拿回来。</small></div>
      <button className="icon-text-button" type="button" onClick={() => setReload((current) => current + 1)} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}<span>{loading ? "读取中" : "刷新"}</span></button>
    </div>
    {unavailable !== null ? <p className="settings-asset-trash-note" data-asset-trash-unavailable>{unavailable}；服务端配置 LIFEOS_ASSET_ROOT 后这里会显示实物。</p> : null}
    {view === null ? null : <>
      <div className="settings-asset-trash-stats">
        <div><small>待清理</small><strong data-asset-trash-pending-count>{pending.length} 张</strong></div>
        <div><small>回收站</small><strong data-asset-trash-trashed-count>{trashed.length} 张</strong></div>
        <div><small>下次自动清理</small><strong data-asset-trash-next-run>{assetTrashMoment(view.nextRunAt)}</strong></div>
      </div>
      <div className="settings-asset-trash-group">
        <p className="settings-asset-trash-group-head">待清理<span>没人引用，到期即收走</span></p>
        {pending.length === 0 ? <p className="settings-asset-trash-note">没有等着过期的照片。</p> : <ul className="settings-asset-trash-list" data-asset-trash-pending>{pending.map((item) => <li className="settings-asset-trash-row" key={item.asset.id}><img src={assetThumbUrl(item.asset.id, 400)} alt="" loading="lazy" decoding="async" /><span className="settings-asset-trash-meta"><strong>{assetTrashName(item.asset)}</strong><small>{formatBytes(item.asset.sizeBytes) ?? "尺寸未知"}{item.asset.createdAt === undefined ? "" : ` · ${assetTrashMoment(item.asset.createdAt.value)} 上传`}</small></span><span className={`settings-asset-trash-days ${item.overdue ? "is-overdue" : ""}`}>{assetTrashRemaining(item.daysRemaining)}</span></li>)}</ul>}
      </div>
      <div className="settings-asset-trash-group">
        <p className="settings-asset-trash-group-head">回收站<span>可以恢复，也可以立即删掉</span></p>
        {trashed.length === 0 ? <p className="settings-asset-trash-note">回收站是空的。</p> : <ul className="settings-asset-trash-list" data-asset-trash-trashed>{trashed.map((item) => <li className="settings-asset-trash-row" key={item.asset.id}><img src={`/api/assets/trash/${encodeURIComponent(item.asset.id)}/content`} alt="" loading="lazy" decoding="async" /><span className="settings-asset-trash-meta"><strong>{assetTrashName(item.asset)}</strong><small>{ASSET_TRASH_ORIGIN_LABELS[item.origin]} · {formatBytes(item.asset.sizeBytes) ?? "尺寸未知"} · {assetTrashMoment(item.trashedAt)} 收走</small></span><span className="settings-asset-trash-days">{assetTrashRemaining(item.daysRemaining)}</span><span className="settings-asset-trash-actions"><button className="icon-text-button" type="button" data-asset-trash-restore disabled={busyId !== null} onClick={() => void act(item.asset.id, `/api/assets/trash/${encodeURIComponent(item.asset.id)}/restore`, "POST", `已恢复「${assetTrashName(item.asset)}」`)}><RotateCcw size={14} aria-hidden="true" /><span>恢复</span></button><button className={`danger-button settings-asset-trash-purge ${confirmId === item.asset.id ? "is-armed" : ""}`} type="button" data-asset-trash-purge disabled={busyId !== null} onClick={() => { if (confirmId !== item.asset.id) { setConfirmId(item.asset.id); setMessage(null); return; } void act(item.asset.id, `/api/assets/trash/${encodeURIComponent(item.asset.id)}`, "DELETE", `已永久删除「${assetTrashName(item.asset)}」`); }}>{busyId === item.asset.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}<span>{confirmId === item.asset.id ? "再点一次真删" : "立即删除"}</span></button></span></li>)}</ul>}
      </div>
    </>}
    {message !== null ? <p className="settings-inline-success" role="status">{message}</p> : null}
    {error !== null ? <p className="settings-inline-error" role="alert">{error}</p> : null}
  </div>;
}

/**
 * The derived-thumbnail cache, made visible for the same reason the trash panel is:
 * it is LifeOS's own copy of the owner's photos, it grows without being asked, and the
 * one thing the owner needs to know is that deleting it costs nothing. So the card
 * states the two facts that matter — how much disk it holds, and that it rebuilds —
 * and offers a single button to empty it.
 */
function ThumbnailCacheSettingsCard() {
  const [view, setView] = useState<AssetThumbnailCacheView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiRequest<AssetThumbnailCacheView>("/api/assets/thumbnails", { signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) setView(payload); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause, "缩略图缓存暂不可用")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  // Same two-step as deleting a photo for good: the first click only arms.
  const clear = async () => {
    if (busy) return;
    if (!armed) { setArmed(true); setMessage(null); return; }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const cleared = await apiRequest<{ readonly removed: number; readonly freedBytes: number }>("/api/assets/thumbnails", { method: "DELETE" });
      setArmed(false);
      setReload((current) => current + 1);
      setMessage(cleared.removed === 0 ? "本来就没有缩略图。" : `已清掉 ${cleared.removed} 张缩略图，腾出 ${formatBytes(cleared.freedBytes) ?? "0 B"}；下次显示会自动重建。`);
    } catch (cause) {
      setError(errorMessage(cause, "清空失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="settings-asset-trash-card" data-thumb-cache>
    <div className="settings-asset-trash-overview">
      <div className="settings-card-icon"><ImageIcon size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong>缩略图缓存</strong><small>时间轴、照片底纹和投放区显示的都是 {view === null || view.widths.length === 0 ? "400 / 1200" : view.widths.join(" / ")} px 的派生小图，由服务端从原图生成、按原图内容命名。它只是缓存：删掉不影响任何照片，下次显示会自动重建。</small></div>
      <button className="icon-text-button" type="button" onClick={() => setReload((current) => current + 1)} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}<span>{loading ? "读取中" : "刷新"}</span></button>
    </div>
    <div className="settings-asset-trash-stats">
      <div><small>缩略图</small><strong data-thumb-cache-count>{view === null ? "—" : `${view.count} 张`}</strong></div>
      <div><small>占用</small><strong data-thumb-cache-bytes>{view === null ? "—" : formatBytes(view.bytes) ?? "0 B"}</strong></div>
    </div>
    {view === null ? null : <p className="settings-asset-trash-note">存放在 <code data-thumb-cache-directory>{view.directory}</code></p>}
    <div className="settings-asset-trash-actions">
      <button className={`danger-button settings-asset-trash-purge ${armed ? "is-armed" : ""}`} type="button" data-thumb-cache-clear disabled={busy || view === null} onClick={() => void clear()}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}<span>{armed ? "再点一次清空" : "清空缩略图缓存"}</span></button>
    </div>
    {message !== null ? <p className="settings-inline-success" role="status">{message}</p> : null}
    {error !== null ? <p className="settings-inline-error" role="alert">{error}</p> : null}
  </div>;
}

function FontSettingsCard({ value, onChange }: { readonly value: UiFontId; readonly onChange: (value: UiFontId) => void }) {
  const selected = UI_FONT_OPTIONS.find((option) => option.id === value) ?? UI_FONT_OPTIONS[0];
  return <div className="settings-card settings-font-card"><div className="settings-card-icon"><Type size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>界面字体</strong><small>仅影响本浏览器的 LifeOS 界面；Maple Mono 继续用于日期和数字等宽信息。</small></div><select className="settings-font-select" value={value} aria-label="界面字体" onChange={(event) => { if (isUiFontId(event.target.value)) onChange(event.target.value); }}><option value={selected.id}>{selected.label}</option>{UI_FONT_OPTIONS.filter((option) => option.id !== selected.id).map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></div>;
}

function SettingsView({ onImport, onLogout, logoutBusy, authRequired, aiStatus, onAiStatusChange, openAiConfig, backupStatus, backupBusy, onBackup, onBackupStatusChange, weatherStatus, weatherProfiles, weatherActiveProfileId, onWeatherStatusChange, onWeatherProfilesChange, movieStatus, onMovieStatusChange, demoCount, hideDemo, demoBusy, demoDeleteArmed, onToggleDemo, onDeleteDemo, uiFont, onUiFontChange, onAssetsChanged }: { onImport: () => void; onLogout: () => void; logoutBusy: boolean; authRequired: boolean; aiStatus: AiStatus; onAiStatusChange: (status: AiStatus) => void; openAiConfig: boolean; backupStatus: BackupStatus; backupBusy: boolean; onBackup: (action: "local" | "s3" | "test" | "dual") => void; onBackupStatusChange: (status: BackupStatus) => void; weatherStatus: WeatherStatus | null; weatherProfiles: readonly WeatherProfile[]; weatherActiveProfileId: string | null; onWeatherStatusChange: (status: WeatherStatus) => void; onWeatherProfilesChange: (payload: WeatherProfilesResponse) => void; movieStatus: MovieModuleStatus; onMovieStatusChange: (status: MovieModuleStatus) => void; demoCount: number; hideDemo: boolean; demoBusy: boolean; demoDeleteArmed: boolean; onToggleDemo: () => void; onDeleteDemo: () => void; uiFont: UiFontId; onUiFontChange: (value: UiFontId) => void; onAssetsChanged: () => void }) {
  return <section className="settings-page" aria-label="设置">
    <div className="settings-sections">
      <section className="settings-section"><div className="settings-section-heading"><h3>账户</h3></div><div className="settings-card settings-account-card"><div className="settings-card-icon"><LockKeyhole size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>{authRequired ? "已登录" : "本机访问"}</strong></div>{authRequired ? <button className="danger-button settings-action" type="button" onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LogOut size={16} aria-hidden="true" />}<span>{logoutBusy ? "退出中" : "退出登录"}</span></button> : null}</div></section>
      <section className="settings-section"><div className="settings-section-heading"><h3>数据</h3></div><div className="settings-card settings-data-grid"><div className="settings-card-icon"><FileJson size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>备份与导出</strong></div><div className="settings-card-actions"><button className="secondary-button" type="button" onClick={onImport}><Upload size={15} aria-hidden="true" /><span>导入 JSON</span></button><a className="secondary-button" href="/api/export?format=json" download><FileJson size={15} aria-hidden="true" /><span>导出 JSON</span></a><a className="secondary-button" href="/api/export?format=markdown" download><FileText size={15} aria-hidden="true" /><span>导出 Markdown</span></a></div></div></section>
      <section className="settings-section settings-demo-section"><div className="settings-section-heading"><h3>演示数据</h3></div><div className="settings-card settings-demo-card"><div className="settings-card-icon"><Sparkles size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>{hideDemo ? "演示数据已隐藏" : `显示 ${demoCount} 条演示记录`}</strong></div><label className="settings-switch" title="显示演示数据"><input type="checkbox" checked={!hideDemo} onChange={onToggleDemo} aria-label="显示演示数据" /><span aria-hidden="true" /></label><button className={`danger-button settings-demo-delete ${demoDeleteArmed ? "is-armed" : ""}`} type="button" onClick={onDeleteDemo} disabled={demoBusy || demoCount === 0}>{demoBusy ? "删除中…" : demoDeleteArmed ? `再次点击删除 ${demoCount} 条` : "删除全部演示数据"}</button></div></section>
      <section className="settings-section"><div className="settings-section-heading"><h3>备份</h3></div><BackupSettingsCard backupStatus={backupStatus} backupBusy={backupBusy} onBackup={onBackup} onChanged={onBackupStatusChange} /></section>
      <section className="settings-section"><div className="settings-section-heading"><h3>照片</h3></div><AssetTrashSettingsCard onAssetsChanged={onAssetsChanged} /><ThumbnailCacheSettingsCard /></section>
      <section className="settings-section"><div className="settings-section-heading"><h3>天气</h3></div><WeatherSettingsCard status={weatherStatus} profiles={weatherProfiles} activeProfileId={weatherActiveProfileId} onChanged={onWeatherStatusChange} onProfilesChanged={onWeatherProfilesChange} /></section>
      <section className="settings-section"><div className="settings-section-heading"><h3>模块</h3></div><MovieSettingsCard status={movieStatus} onChanged={onMovieStatusChange} /></section>
      <section className="settings-section"><div className="settings-section-heading"><h3>AI 助手</h3></div><AiSettingsCard status={aiStatus} open={openAiConfig} onChanged={onAiStatusChange} /></section>
      <section className="settings-section"><div className="settings-section-heading"><h3>系统</h3></div><FontSettingsCard value={uiFont} onChange={onUiFontChange} /><div className="settings-card"><div className="settings-card-icon"><Activity size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>自托管 LifeOS</strong></div></div></section>
    </div>
  </section>;
}

function App() {
  const [activeView, setActiveView] = useState<AppView>("today");
  const [selectedDate, setSelectedDate] = useState(localDateToday);
  const [records, setRecords] = useState<readonly RecordView[] | null>(null);
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
  const [summaries, setSummaries] = useState<readonly DaySummary[]>([]);
  const [aiSummaries, setAiSummaries] = useState(false);
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
  const [authState, setAuthState] = useState<AuthState>({ required: false, authenticated: true });
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ preset: "quick", enabled: true, configured: false, keyConfigured: false, provider: "deepseek", model: "deepseek-flash", baseUrl: AI_DEFAULT_BASE_URL, thinking: false, reasoningEffort: null, keySource: "none" });
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [weatherStatus, setWeatherStatus] = useState<WeatherStatus | null>(null);
  const [weatherProfiles, setWeatherProfiles] = useState<readonly WeatherProfile[]>([]);
  const [weatherActiveProfileId, setWeatherActiveProfileId] = useState<string | null>(null);
  const [movieStatus, setMovieStatus] = useState<MovieModuleStatus>({ enabled: false, configured: false, keyConfigured: false, connected: false });
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
  const authRef = useRef<AuthState>({ required: false, authenticated: true });
  const recordsRequestRef = useRef(0);
  const tasksRequestRef = useRef(0);

  useEffect(() => {
    const option = UI_FONT_OPTIONS.find((candidate) => candidate.id === uiFont) ?? UI_FONT_OPTIONS[0];
    document.documentElement.dataset.lifeosFont = option.id;
    document.documentElement.style.setProperty("--lifeos-ui-font", option.stack);
    window.localStorage.setItem(UI_FONT_STORAGE_KEY, option.id);
  }, [uiFont]);

  const calendarRange = useMemo(
    () => (calendarMode === "week" ? datesOfWeek(selectedDate) : monthGridDates(selectedDate)),
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

  const handleRequestError = useCallback((error: unknown, fallback: string): string => {
    if (errorStatus(error) === 401) {
      const nextAuth = { required: true, authenticated: false } as const;
      authRef.current = nextAuth;
      setRecords(null);
      setTasks(null);
      recordsRef.current = [];
      setAuthState(nextAuth);
    }
    return errorMessage(error, fallback);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<AuthState>("/api/auth", { signal: controller.signal }).then((state) => { authRef.current = state; setAuthState(state); }).catch((error) => { if (!controller.signal.aborted && errorStatus(error) === 401) { const nextAuth = { required: true, authenticated: false } as const; authRef.current = nextAuth; setAuthState(nextAuth); } });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setAiStatus({ preset: "quick", enabled: true, configured: false, keyConfigured: false, provider: "deepseek", model: "deepseek-flash", baseUrl: AI_DEFAULT_BASE_URL, thinking: false, reasoningEffort: null, keySource: "none" });
      return () => controller.abort();
    }
    apiRequest<AiStatus>("/api/ai/status", { signal: controller.signal }).then((status) => { if (!controller.signal.aborted) setAiStatus(status); }).catch(() => { if (!controller.signal.aborted) setAiStatus({ preset: "quick", enabled: true, configured: false, keyConfigured: false, provider: "deepseek", model: "deepseek-flash", baseUrl: AI_DEFAULT_BASE_URL, thinking: false, reasoningEffort: null, keySource: "none" }); });
    return () => controller.abort();
  }, [authState.authenticated, authState.required]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setMovieStatus({ enabled: false, configured: false, keyConfigured: false, connected: false });
      return () => controller.abort();
    }
    fetchMovieModuleStatus().then((status) => { if (!controller.signal.aborted) setMovieStatus(status); }).catch(() => {
      if (!controller.signal.aborted) setMovieStatus({ enabled: false, configured: false, keyConfigured: false, connected: false });
    });
    return () => controller.abort();
  }, [authState.authenticated, authState.required]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setWeatherProfiles([]);
      setWeatherActiveProfileId(null);
      return () => controller.abort();
    }
    apiRequest<WeatherProfilesResponse>("/api/weather/profiles", { signal: controller.signal }).then((payload) => {
      if (controller.signal.aborted) return;
      setWeatherProfiles(payload.items);
      setWeatherActiveProfileId(payload.activeProfileId);
      setWeatherStatus(payload.status);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setWeatherProfiles([]);
      setWeatherActiveProfileId(null);
    });
    return () => controller.abort();
  }, [authState.authenticated, authState.required]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) {
      setWeatherStatus(null);
      return () => controller.abort();
    }
    apiRequest<WeatherStatus>("/api/weather/status", { signal: controller.signal }).then((status) => { if (!controller.signal.aborted) setWeatherStatus(status); }).catch(() => { if (!controller.signal.aborted) setWeatherStatus(null); });
    return () => controller.abort();
  }, [authState.authenticated, authState.required]);

  useEffect(() => {
    const controller = new AbortController();
    if (authState.required && !authState.authenticated) return () => controller.abort();
    apiRequest<BackupStatus>("/api/backup/status", { signal: controller.signal }).then((status) => { if (!controller.signal.aborted) setBackupStatus(status); }).catch(() => { if (!controller.signal.aborted) setBackupStatus((current) => current); });
    return () => controller.abort();
  }, [authState.authenticated, authState.required]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++recordsRequestRef.current;
    if (authState.required && !authState.authenticated) { setRecordsLoading(false); return () => controller.abort(); }
    if (activeView === "settings") { setRecordsLoading(false); setRecords([]); return () => controller.abort(); }
    setRecordsLoading(true);
    setRecordsError(null);
    apiRequest<RecordsResponse>(queryPath, { signal: controller.signal }).then((payload) => { if (!controller.signal.aborted && requestId === recordsRequestRef.current) setRecords(payload.items); }).catch((error) => { if (controller.signal.aborted || requestId !== recordsRequestRef.current) return; setRecords(null); setRecordsError(handleRequestError(error, "请检查 API 服务是否已启动")); }).finally(() => { if (!controller.signal.aborted && requestId === recordsRequestRef.current) setRecordsLoading(false); });
    return () => controller.abort();
  }, [authState.authenticated, authState.required, handleRequestError, queryPath, recordsReload]);

  useEffect(() => { recordsRef.current = records ?? []; }, [records]);

  /**
   * Month cells carry a one-line summary. The server owns the cache — it keys on
   * the record versions behind each day — so this asks for the visible window and
   * refetches after a write. A failure here is not surfaced: the grid still knows
   * every day number and record count, and a summary is an extra, not the point.
   */
  useEffect(() => {
    const controller = new AbortController();
    if (activeView !== "calendar" || calendarMode !== "month" || (authState.required && !authState.authenticated)) {
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
  }, [activeView, calendarMode, calendarRange, selectedDate, authState.authenticated, authState.required, recordsReload]);

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
    apiRequest<CycleIntimacyModuleData>("/api/modules/cycle-intimacy", { signal: controller.signal })
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

  const refresh = () => { setRecordsReload((current) => current + 1); setTasksReload((current) => current + 1); setRelationReload((current) => current + 1); setCycleModuleReload((current) => current + 1); };
  const navigate = (view: AppView) => { setActiveView(view); setMobileMenuOpen(false); if (view !== "timeline") setEntityFilterId(null); if (view === "tasks") setComposerKind("task"); if (view === "notes") setComposerKind("note"); };
  /** A calendar cell is a way back into the day it stands for. */
  const openDay = (date: string) => { setSelectedDate(date); setActiveView("today"); setMobileMenuOpen(false); };
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
    const module = await apiRequest<CycleIntimacyModuleData>("/api/modules/cycle-intimacy/config", {
      method: "PUT",
      body: JSON.stringify({ ...config, anchorStart: config.anchorStart ?? null }),
    });
    setCycleModule(module);
    showToast(config.enabled ? "周期与亲密模块已保存" : "周期与亲密模块已关闭，记录仍被保留");
  };
  const addCycleModuleEvent = async (date: string, kind: CycleIntimacyEventKind) => {
    const module = await apiRequest<CycleIntimacyModuleData>("/api/modules/cycle-intimacy/events", { method: "POST", body: JSON.stringify({ date, kind }) });
    setCycleModule(module);
    showToast("私密日历标记已保存");
  };
  const deleteCycleModuleEvent = async (id: string) => {
    const module = await apiRequest<CycleIntimacyModuleData>(`/api/modules/cycle-intimacy/events/${encodeURIComponent(id)}`, { method: "DELETE" });
    setCycleModule(module);
    showToast("私密日历标记已移除");
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
      setAssets((current) => [...current, asset]);
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
    try { const bundle = JSON.parse(await importFile.text()) as unknown; await apiRequest<unknown>("/api/import", { method: "POST", body: JSON.stringify({ bundle }) }); setImportFile(null); showToast("备份已导入"); refresh(); } catch (error) { setImportError(errorMessage(error, "导入失败，请检查 JSON 文件")); if (errorStatus(error) === 401) { const nextAuth = { required: true, authenticated: false } as const; authRef.current = nextAuth; setRecords(null); setTasks(null); recordsRef.current = []; setAuthState(nextAuth); } } finally { setImportBusy(false); }
  };

  const handleLogout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try { await apiRequest<unknown>("/api/auth/logout", { method: "POST" }); const nextAuth: AuthState = { required: true, authenticated: false }; authRef.current = nextAuth; setRecords(null); setTasks(null); recordsRef.current = []; setAuthState(nextAuth); setMobileMenuOpen(false); } catch (error) { showToast(handleRequestError(error, "退出失败，请重试")); } finally { setLogoutBusy(false); }
  };

  const handleLogin = async (password: string) => {
    setLoginLoading(true);
    setAuthError(null);
    try { const state = await apiRequest<AuthState>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }); authRef.current = state; setAuthState(state); } catch (error) { setAuthError(errorMessage(error, "密码不正确")); } finally { setLoginLoading(false); }
  };

  if (authState.required && !authState.authenticated) return <LoginGate onLogin={handleLogin} error={authError} loading={loginLoading} />;

  const isToday = activeView === "today";
  const showComposer = isToday || (activeView !== "settings" && activeView !== "entities" && composerOpen);
  const showPageActions = Boolean(searchQuery || entityFilterId !== null || (activeView !== "settings" && activeView !== "entities" && !isToday));
  const visibleRecords = hideDemo && records ? records.filter((record) => !isDemoRecord(record)) : records;
  const visibleTasks = hideDemo && tasks ? tasks.filter((record) => !isDemoRecord(record)) : tasks;
  // Which places were written about most recently, so the mention picker can put
  // them first. Derived from the records rather than tracked separately: the
  // evidence is already in every saved record's entityRefs.
  const recentPlaces = useMemo(() => recentPlaceIds(visibleRecords ?? []), [visibleRecords]);
  const summaryMap = useMemo(() => new Map(summaries.map((summary) => [summary.date, summary])), [summaries]);
  // In the calendar the arrows page by the unit on screen — a week, or a month.
  const stepCalendar = (direction: number) => setSelectedDate((current) => (calendarMode === "week" ? shiftDate(current, direction * 7) : shiftMonth(current, direction)));

  return <div className="app-shell"><Sidebar activeView={activeView} onNavigate={navigate} /><main className="main-column"><header className="topbar"><div className="topbar-layout"><button className="mobile-menu-button icon-button" type="button" onClick={() => setMobileMenuOpen(true)} aria-label="打开导航"><Menu size={19} strokeWidth={1.9} aria-hidden="true" /></button><WeatherHeader selectedDate={selectedDate} status={weatherStatus} onOpenSettings={() => setActiveView("settings")} onDateChange={setSelectedDate} onDateStep={activeView === "calendar" ? stepCalendar : undefined} /><div className="topbar-actions"><button className="mobile-search-button icon-button" type="button" onClick={() => setSearchDialogOpen(true)} aria-label="打开搜索"><Search size={18} strokeWidth={1.8} aria-hidden="true" /></button><form className="search-form" onSubmit={submitSearch} role="search"><Search className="search-leading-icon" size={17} strokeWidth={1.8} aria-hidden="true" /><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索记录" aria-label="搜索记录" />{searchInput ? <button className="search-clear" type="button" aria-label="清空搜索" onClick={() => { setSearchInput(""); setSearchQuery(""); }}><X size={15} strokeWidth={1.9} aria-hidden="true" /></button> : null}<span className="search-divider" aria-hidden="true" /><button className="search-submit" type="submit" aria-label="提交搜索"><Search size={16} strokeWidth={2} aria-hidden="true" /></button></form></div></div></header><div className="content-grid"><div className="content-column">{showPageActions ? <div className="page-heading page-heading-actions"><div className="heading-actions">{searchQuery ? <span className="search-context">正在搜索 “{searchQuery}”</span> : null}{entityFilterId !== null ? <button className="entity-filter-chip" type="button" onClick={() => setEntityFilterId(null)} aria-label="清除人物筛选">人物：{entities.find((entity) => entity.id === entityFilterId)?.name ?? entityFilterId}<X size={13} aria-hidden="true" /></button> : null}{activeView !== "settings" && !isToday ? <button className="secondary-button heading-create-button" type="button" onClick={() => { setComposerKind(activeView === "tasks" ? "task" : activeView === "notes" ? "note" : "journal"); setComposerOpen(true); }}><Plus size={16} aria-hidden="true" /><span>新建{activeView === "tasks" ? "任务" : activeView === "notes" ? "笔记" : "记录"}</span></button> : null}</div></div> : null}{demoCount > 0 && activeView !== "settings" ? <section className="demo-banner" aria-label="预置记录"><div className="demo-banner-text"><Sparkles size={16} strokeWidth={1.8} aria-hidden="true" /><div><strong>预置记录</strong><p>{demoCount} 条记录，包含关联、@ 提及和照片引用。随时可以藏起来或整批删掉。</p></div></div><div className="demo-banner-actions"><button className="secondary-button" type="button" onClick={toggleDemo}>{hideDemo ? "显示预置记录" : "隐藏预置记录"}</button><button className={`text-button demo-delete ${demoDeleteArmed ? "is-armed" : ""}`} type="button" onClick={() => void handleDeleteDemo()} disabled={demoBusy}>{demoBusy ? "删除中…" : demoDeleteArmed ? `再点一次，删除 ${demoCount} 条` : "删除全部预置记录"}</button></div></section> : null}{showComposer ? <Composer onShotsCleared={handleShotsCleared} kind={composerKind} content={composerContent} entities={entities} recentPlaceIds={recentPlaces} movieEnabled={movieStatus.enabled} movieRefs={composerMovieRefs} onMovieRefsChange={setComposerMovieRefs} onMovieEntity={rememberMovieEntity} onCreateEntity={handleCreateEntity} occurredAt={occurredAt} dueAt={dueAt} isPrivate={composerPrivate} isBackfill={composerBackfill} selectedDate={selectedDate} saving={saving} dismissible={!isToday} occurredDirty={occurredAtDirty} weather={composerWeather} weatherBusy={composerWeatherBusy} onCaptureWeather={() => void captureComposerWeather()} onClearWeather={() => setComposerWeather(null)} onKindChange={setComposerKind} onContentChange={setComposerContent} onOccurredAtChange={(value) => { setOccurredAt(value); setOccurredAtDirty(true); }} onDueAtChange={setDueAt} onPrivateChange={setComposerPrivate} onBackfillChange={setComposerBackfill} shots={composerShots} onShotsChange={setComposerShots} onUploadShot={uploadComposerShot} onNotify={showToast} onSubmit={() => void handleCreate()} onClose={() => { setComposerOpen(false); setComposerWeather(null); setComposerMovieRefs([]); setComposerShots([]); }} /> : null}{activeView === "settings"
       ? <SettingsView onImport={() => fileInputRef.current?.click()} onLogout={() => void handleLogout()} logoutBusy={logoutBusy} authRequired={authState.required} aiStatus={aiStatus} onAiStatusChange={setAiStatus} openAiConfig={aiConfigOpen || activeView === "settings"} backupStatus={backupStatus} backupBusy={backupBusy} onBackup={(action) => void handleBackup(action)} onBackupStatusChange={setBackupStatus} weatherStatus={weatherStatus} weatherProfiles={weatherProfiles} weatherActiveProfileId={weatherActiveProfileId} onWeatherStatusChange={setWeatherStatus} onWeatherProfilesChange={(payload) => { setWeatherProfiles(payload.items); setWeatherActiveProfileId(payload.activeProfileId); }} movieStatus={movieStatus} onMovieStatusChange={setMovieStatus} demoCount={demoCount} hideDemo={hideDemo} demoBusy={demoBusy} demoDeleteArmed={demoDeleteArmed} onToggleDemo={toggleDemo} onDeleteDemo={() => void handleDeleteDemo()} uiFont={uiFont} onUiFontChange={setUiFont} onAssetsChanged={refresh} />
      : activeView === "entities"
        ? <EntitiesView entities={entities} records={visibleRecords ?? []} onCreateEntity={handleCreateEntity} onEdit={setEditingEntity} onViewRecords={(entity) => { setEntityFilterId(entity.id); setActiveView("timeline"); }} />
      : activeView === "calendar"
        ? <CalendarView mode={calendarMode} onModeChange={setCalendarMode} anchor={selectedDate} today={localDateToday()} records={visibleRecords} summaries={summaryMap} aiEnabled={aiSummaries} weatherByDate={weatherArchive} loading={recordsLoading} error={recordsError} cycleModule={cycleModule} onOpenCycleModule={() => setCycleModuleOpen(true)} onRetry={() => setRecordsReload((current) => current + 1)} onOpenDay={openDay} />
      : <Timeline records={visibleRecords} assets={assets} entities={entities} loading={recordsLoading} error={recordsError} selectedDate={selectedDate} activeView={activeView} searchQuery={searchQuery} movieEnabled={movieStatus.enabled} moviePromptHidden={moviePromptHidden} onMovieAttachToRecord={attachMovieToRecord} onMoviePromptSuppress={suppressMoviePrompt} onRetry={() => setRecordsReload((current) => current + 1)} onDemo={() => void handleDemo()} creatingDemo={creatingDemo} onEdit={handleEdit} onDelete={(record) => { setDeleteError(null); setDeleteRecord(record); }} onTaskStatus={(record, status) => void handleTaskStatus(record, status)} onPreviewAsset={(assetIds, index) => setPhotoPreview({ assetIds, index })} onOpenEntity={setEntityCard} />}</div>{activeView !== "settings" ? <TaskSummary tasks={visibleTasks} loading={tasksLoading} error={tasksError} onTaskStatus={(record, status) => handleTaskStatus(record, status, { sync: false, feedback: false })} onTaskStateChange={syncTaskRecord} /> : null}</div></main><MobileNav activeView={activeView} onNavigate={navigate} />{actionMessage ? <div className={`action-toast ${actionMessage.tone === "warn" ? "is-warning" : ""}`} role="status">{actionMessage.tone === "warn" ? <AlertCircle size={16} strokeWidth={2} aria-hidden="true" /> : <Check size={16} strokeWidth={2} aria-hidden="true" />}<span className="action-toast-text">{actionMessage.text}</span>{actionMessage.undo ? <button className="action-toast-undo" type="button" onClick={() => { const undo = actionMessage.undo; dismissToast(); undo?.(); }}>撤销</button> : null}</div> : null}<CycleModuleDialog open={cycleModuleOpen} module={cycleModule} selectedDate={selectedDate} onClose={() => setCycleModuleOpen(false)} onSaveConfig={saveCycleModuleConfig} onAddEvent={addCycleModuleEvent} onDeleteEvent={deleteCycleModuleEvent} /><MobileMenuDialog open={mobileMenuOpen} activeView={activeView} onClose={() => setMobileMenuOpen(false)} onNavigate={navigate} /><SearchDialog open={searchDialogOpen} initialQuery={searchInput} onClose={() => setSearchDialogOpen(false)} onSearch={(query) => { setSearchInput(query); setSearchQuery(query); }} /><DiagnosticsDrawer /><RecordEditorDialog record={editingRecord} saving={editSaving} reloading={editReloading} error={editError} entities={entities} assets={assets} candidates={(records ?? []).filter((candidate) => candidate.id !== editingRecord?.id)} onCreateEntity={handleCreateEntity} onClose={() => { if (!editSaving) setEditingRecord(null); }} onSave={(record, draft) => void handleSaveEdit(record, draft)} onReloadLatest={() => void handleReloadLatest()} /><ConfirmDialog record={deleteRecord} busy={deleteBusy} error={deleteError} onClose={() => { if (!deleteBusy) setDeleteRecord(null); }} onConfirm={() => void handleDelete()} /><ImportDialog file={importFile} busy={importBusy} error={importError} onClose={() => { if (!importBusy) { setImportFile(null); setImportError(null); } }} onConfirm={() => void handleImportConfirm()} /><PersonCardDialog entity={entityCard} entities={entities} onClose={() => setEntityCard(null)} onEdit={(entity) => { setEntityCard(null); setEditingEntity(entity); }} onViewRecords={(entity) => { setEntityCard(null); setEntityFilterId(entity.id); setActiveView("timeline"); }} onMovieSaved={rememberMovieEntity} /><EntityEditDialog entity={editingEntity} onClose={() => setEditingEntity(null)} onSave={handleSaveEntity} /><input ref={fileInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file) { setImportError(null); setImportFile(file); } event.target.value = ""; }} />{photoPreview === null ? null : <AssetPreview assetIds={photoPreview.assetIds} index={photoPreview.index} assets={assets} onClose={() => setPhotoPreview(null)} onIndexChange={(index) => setPhotoPreview((current) => current === null ? null : { ...current, index })} />}<AIAssistant status={aiStatus} onOpenSettings={() => setActiveView("settings")} /></div>;
}

export default App;

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("LifeOS root element is missing");
createRoot(rootElement).render(<App />);
