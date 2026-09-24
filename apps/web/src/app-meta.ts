import {
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  CalendarRange,
  ContactRound,
  Film,
  FolderKanban,
  Handshake,
  Heart,
  House,
  ListChecks,
  MapPin,
  NotebookPen,
  Settings,
  Sun,
  Tag,
  User,
  History,
  type LucideIcon,
} from "lucide-react";
import type {
  Asset,
  AssetKind,
  AssetLink,
  AssetRole,
  Entity,
  EntityKind,
  EntityRef,
  NoteFormat,
  RecordKind,
  RelationKind,
} from "@lifeos/core";
import type { MovieEntity, RecordView, TaskRecordView } from "./api";
import type { AppView, ComposerKind, SettingsPageId, UiFontId } from "./app-types";
import { shortDate } from "./time";

export const DEMO_ID_PREFIX = "demo-";
export const DEMO_HIDDEN_STORAGE_KEY = "lifeos.hideDemo";
export const MOVIE_PROMPT_HIDDEN_STORAGE_KEY = "lifeos.moviePromptHidden";
export const AI_ASSISTANT_VISIBLE_STORAGE_KEY = "lifeos.ai.assistant-visible";
export const COMPOSER_SHOTS_STORAGE_KEY = "lifeos.composerShots";
export const UI_FONT_STORAGE_KEY = "lifeos.uiFont";
/** A name typed by this user is normally Chinese; a token like `@a1b2` is not. */
export const CJK_PATTERN = /[㐀-鿿]/;
export const MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH = 6;
export const SELF_ENTITY_ID = "self";

export const SETTINGS_PAGE_GROUPS: readonly {
  readonly id: string;
  readonly label: string;
  readonly pages: readonly { readonly id: SettingsPageId; readonly label: string }[];
}[] = [
  { id: "account", label: "账户", pages: [{ id: "account/session", label: "账户与会话" }] },
  { id: "data", label: "数据", pages: [{ id: "data/import-export", label: "导入与导出" }, { id: "data/backup", label: "备份与恢复" }, { id: "data/demo", label: "演示数据" }, { id: "data/photos", label: "照片存储" }] },
  { id: "appearance", label: "外观", pages: [{ id: "appearance/interface", label: "界面" }] },
  { id: "integrations", label: "服务集成", pages: [{ id: "integrations/weather", label: "天气" }, { id: "integrations/ai", label: "AI 助手" }, { id: "integrations/movie", label: "观影" }] },
  { id: "private", label: "私密模块", pages: [{ id: "private/cycle", label: "周期与亲密" }] },
  { id: "about", label: "关于", pages: [{ id: "about", label: "LifeOS" }] },
];
export const SETTINGS_PAGE_IDS = new Set<SettingsPageId>(SETTINGS_PAGE_GROUPS.flatMap((group) => group.pages.map((page) => page.id)));
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "account/session";

export function readSettingsPageFromHash(): SettingsPageId {
  if (typeof window === "undefined") return DEFAULT_SETTINGS_PAGE;
  const match = window.location.hash.match(/^#settings\/(.+)$/);
  const candidate = match?.[1] as SettingsPageId | undefined;
  return candidate !== undefined && SETTINGS_PAGE_IDS.has(candidate) ? candidate : DEFAULT_SETTINGS_PAGE;
}

export function settingsHash(page: SettingsPageId): string {
  return `#settings/${page}`;
}

export function readAssistantVisibility(): boolean {
  try {
    return window.localStorage.getItem(AI_ASSISTANT_VISIBLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export const ASSET_ROLE_VALUES: readonly AssetRole[] = ["photo", "recording", "attachment"];

/**
 * Rebuilds a stored draft defensively. A draft is a convenience, never a
 * source of truth, so anything malformed is dropped rather than trusted.
 */
export function readComposerShotsDraft(): readonly AssetLink[] {
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
      const link: AssetLink = {
        assetId: candidate.assetId,
        role: candidate.role as AssetRole,
        ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
      };
      return [link];
    });
  } catch {
    return [];
  }
}

export function writeComposerShotsDraft(shots: readonly AssetLink[]): void {
  try {
    if (shots.length === 0) window.localStorage.removeItem(COMPOSER_SHOTS_STORAGE_KEY);
    else window.localStorage.setItem(COMPOSER_SHOTS_STORAGE_KEY, JSON.stringify({ shots, savedAt: new Date().toISOString() }));
  } catch {
    // Storage can be blocked or full; the draft simply will not survive a reload.
  }
}

export const UI_FONT_OPTIONS: readonly { id: UiFontId; label: string; stack: string }[] = [
  { id: "misans", label: "MiSans", stack: '"LifeOS MiSans", "MiSans", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
];

export function isUiFontId(value: string | null): value is UiFontId {
  return UI_FONT_OPTIONS.some((option) => option.id === value);
}

export function readUiFont(): UiFontId {
  const stored = window.localStorage.getItem(UI_FONT_STORAGE_KEY);
  return isUiFontId(stored) ? stored : "misans";
}

export const COMPOSER_META: Record<ComposerKind, { label: string; placeholder: string; icon: LucideIcon }> = {
  journal: { label: "日记", placeholder: "记录此刻正在发生的事……", icon: NotebookPen },
  task: { label: "任务", placeholder: "下一步要完成什么？", icon: ListChecks },
  event: { label: "事件", placeholder: "记下一个值得回看的时间点……", icon: CalendarDays },
  note: { label: "笔记", placeholder: "把想法留在这里……", icon: BookOpen },
};

export const ENTITY_META: Record<string, { label: string; icon: LucideIcon }> = {
  person: { label: "人物", icon: User },
  project: { label: "项目", icon: FolderKanban },
  place: { label: "地点", icon: MapPin },
  topic: { label: "主题", icon: Tag },
  movie: { label: "电影", icon: Film },
};

export const ENTITY_KIND_ORDER: readonly EntityKind[] = ["person", "place", "project", "topic"];

export const ASSET_ROLE_LABEL: Record<AssetRole, string> = { photo: "照片", recording: "录音", attachment: "附件" };

export const RELATION_META: Record<RelationKind, { label: string; icon: LucideIcon }> = {
  partner: { label: "爱人", icon: Heart },
  friend: { label: "朋友", icon: Handshake },
  family: { label: "家人", icon: House },
  colleague: { label: "同事", icon: BriefcaseBusiness },
};

/** Movie is supplied by an optional backend module and may be one deploy
 * revision ahead of the shared core package. Keep the runtime guard local so
 * the rest of the UI can render historical movie refs during that window. */
export function isMovieEntity(value: unknown): value is MovieEntity {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === "movie" && typeof (value as { readonly id?: unknown }).id === "string";
}

export function isMovieRef(value: EntityRef): boolean {
  return (value.entityType as string) === "movie";
}

export function asCoreEntity(value: MovieEntity): Entity {
  return value as unknown as Entity;
}

export function relationKindFor(entityId: string, entities: readonly Entity[]): RelationKind | undefined {
  const self = entities.find((entity) => entity.id === SELF_ENTITY_ID);
  if (self === undefined) return undefined;
  const direct = (self.relations ?? []).find((relation) => relation.entityId === entityId);
  if (direct !== undefined) return direct.kind;
  // The edge is symmetric, but tolerate a one-sided record left by an older write.
  const other = entities.find((entity) => entity.id === entityId);
  const inverse = (other?.relations ?? []).find((relation) => relation.entityId === SELF_ENTITY_ID);
  return inverse?.kind;
}

export function relationLabelFor(entityId: string, entities: readonly Entity[]): string | undefined {
  const kind = relationKindFor(entityId, entities);
  return kind === undefined ? undefined : RELATION_META[kind].label;
}

export function isLocalAsset(asset: Asset | undefined): boolean {
  return asset?.storageRefs.some((storageRef) => storageRef.sourceId === "local") === true;
}

export function assetRoleFor(kind: AssetKind): AssetRole {
  if (kind === "photo") return "photo";
  if (kind === "audio") return "recording";
  return "attachment";
}

export function entityRefKey(ref: EntityRef): string {
  return `${ref.entityType}:${ref.entityId}`;
}

export function formatBytes(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function refAsEntity(ref: EntityRef): Entity {
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
 */
export function mentionVocabulary(record: RecordView, entities: readonly Entity[]): readonly Entity[] {
  const known = new Set(entities.map((entity) => entity.id));
  const extras = record.entityRefs.filter((ref) => !known.has(ref.entityId)).map(refAsEntity);
  return extras.length === 0 ? entities : [...entities, ...extras];
}

export const NAV_ITEMS: readonly { id: AppView; label: string; icon: LucideIcon }[] = [
  { id: "today", label: "今天", icon: Sun },
  { id: "timeline", label: "时间轴", icon: CalendarDays },
  { id: "calendar", label: "日历", icon: CalendarRange },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "notes", label: "笔记", icon: NotebookPen },
  { id: "entities", label: "联系人与地点", icon: ContactRound },
  { id: "timemachine", label: "时光机", icon: History },
];

export const SETTINGS_NAV_ITEM: { id: AppView; label: string; icon: LucideIcon } = { id: "settings", label: "设置", icon: Settings };

export const MOBILE_NAV_ITEMS: readonly { id: AppView; label: string; icon: LucideIcon }[] = [
  { id: "today", label: "今天", icon: Sun },
  { id: "calendar", label: "日历", icon: CalendarRange },
  { id: "notes", label: "笔记", icon: NotebookPen },
  { id: "entities", label: "联系人", icon: ContactRound },
];

export const MOBILE_MORE_ITEMS: readonly { id: AppView; label: string; icon: LucideIcon }[] = [
  { id: "timeline", label: "时间轴", icon: CalendarDays },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "timemachine", label: "时光机", icon: History },
  SETTINGS_NAV_ITEM,
];

export function isTaskRecord(record: RecordView): record is TaskRecordView {
  return record.kind === "task";
}

export function recordText(record: RecordView): string {
  return record.body.edited ?? record.body.original;
}

export function recordLabel(kind: RecordKind): string {
  return COMPOSER_META[kind].label;
}

export const NOTE_FORMATS: readonly { readonly value: NoteFormat; readonly label: string; readonly hint: string }[] = [
  { value: "article", label: "文章", hint: "有标题的完整内容" },
  { value: "fragment", label: "碎片", hint: "随手记下一点想法" },
  { value: "quote", label: "摘抄", hint: "保留引文和出处" },
];

export function noteFormatOf(record: RecordView): NoteFormat {
  return record.kind === "note" ? record.note?.format ?? "fragment" : "fragment";
}

export function statusLabel(status: string | undefined): string {
  if (status === "in_progress") return "进行中";
  if (status === "done") return "已完成";
  if (status === "cancelled") return "已取消";
  return "待办";
}

export function isDemoRecord(record: RecordView): boolean {
  return record.isDemo === true;
}

/**
 * A week card is a glance, not a miniature timeline. Keep its visible first
 * and last entries, then select one representative interior entry.
 */
export function weekCardRecords(items: readonly RecordView[]): readonly RecordView[] {
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

export function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

export function errorMessage(error: unknown, fallback = "请稍后重试"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function timelineHeading(view: AppView): string {
  if (view === "today") return "当日记录";
  if (view === "timeline") return "全部记录";
  if (view === "tasks") return "任务记录";
  return "笔记记录";
}

export function emptyCopy(view: AppView, selectedDate: string, hasSearch: boolean): { title: string; showDemo: boolean } {
  if (hasSearch) return { title: "没有找到匹配记录", showDemo: false };
  if (view === "today") return { title: `${shortDate(selectedDate)}还没有记录`, showDemo: false };
  if (view === "tasks") return { title: "还没有任务", showDemo: false };
  if (view === "notes") return { title: "还没有笔记", showDemo: false };
  return { title: "还没有记录", showDemo: false };
}
