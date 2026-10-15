import { calendarCoverForAspect, calendarPhotoUrl, type CalendarPresentation } from "@lifeos/core";
import { useActionMenu } from "./action-menu";
import { useCalendarHold } from "./calendar-hold";
import "./calendar-mark-list.css";
import { CustomHabitPanel, type HabitActions } from "./habit-panel";
import { CalendarBackgroundSettings } from "./calendar-background-settings";
import { HabitIcon } from "./habit-icon";
import type { CustomHabit } from "@lifeos/core";
import { canEditDaySummary } from "@lifeos/core";
import { calendarTasksForDate, calendarTaskStatus, calendarTaskText, useCalendarTaskLabels } from "./calendar-tasks";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { clampFixedMenuPosition } from "./menu-position";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CloudSun,
  Dumbbell,
  Edit3,
  Eraser,
  Heart,
  History,
  LoaderCircle,
  LockKeyhole,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import {
  SUMMARY_MAX_LENGTH,
  clampSummaryText,
  trimSummaryText,
  type Asset,
  type CycleIntimacyEventKind,
  type CycleIntimacyModuleConfig,
  type CycleIntimacyModuleData,
  type DaySummary,
  type Entity,
  type PlacePeriod,
  type PlaceRole,
  type WeatherAttachment,
} from "@lifeos/core";
import { apiRequest, type AiStatus, type AiStatusState, type CycleDayEditResponse, type CycleDayUndoResponse, type CycleModuleResponse, type MobileCycleEventKind, type MovieEntity, type RecordView } from "./api";
import type { AppView, CalendarMode, ComposerKind, CreateEntity, SettingsPageId } from "./app-types";
import { calendarDayInfo } from "./calendarData";
import { getWeatherEmoji, type WeatherCategory, type WeatherDay, type WeatherPhase } from "./weather";
import { WEEKDAY_LABELS } from "./date-field";
import {
  DEMO_HIDDEN_STORAGE_KEY,
  SELF_ENTITY_ID,
  errorMessage,
  isDemoRecord,
  isMovieEntity,
  isMovieRef,
  isTaskRecord,
  recordText,
  weekCardRecords,
} from "./app-meta";
import { RecordText } from "./mention";
import { ErrorState } from "./timeline-states";
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
  startOfWeek,
  weekdayShort,
} from "./time";
import {
  nextPredictedStart,
  periodMoonForDate,
  recordsByDate,
  type CalendarMarker,
} from "./timeline";
import calendarDateGlyphSpriteUrl from "./assets/calendar-date-glyphs.svg?url";

type CalendarDateArtPaletteKey = "morandi" | "peach" | "tea" | "blue";
type CalendarDateArtLayout = "horizontal" | "vertical" | "big";
type CalendarDateArtPreferences = {
  readonly version: 1;
  readonly scheme: CalendarDateArtPaletteKey;
  readonly desktopLayout: CalendarDateArtLayout;
  readonly mobileLayout: CalendarDateArtLayout;
  readonly dateNumberScale: number;
};

const CALENDAR_DATE_ART_STORAGE_KEY = "lifeos.calendar.dateArt.v1";
const DEFAULT_CALENDAR_DATE_ART_PREFERENCES: CalendarDateArtPreferences = {
  version: 1,
  scheme: "morandi",
  desktopLayout: "big",
  mobileLayout: "horizontal",
  dateNumberScale: 1.2,
};
const CALENDAR_DATE_ART_PALETTES: readonly {
  readonly key: CalendarDateArtPaletteKey;
  readonly name: string;
  readonly foreground: string;
  readonly colors: readonly [string, string, string, string, string, string];
}[] = [
  { key: "morandi", name: "晨光莫兰迪", foreground: "#263647", colors: ["#E5B0B2", "#A9C1D3", "#C0C7DE", "#D1BDD2", "#B9CCBF", "#E5D4A5"] },
  { key: "peach", name: "杏桃春日", foreground: "#3B302E", colors: ["#F4B19A", "#F2C49D", "#EBAFB1", "#F3A89A", "#E6C272", "#B7D8D0"] },
  { key: "tea", name: "奶茶花园", foreground: "#3C3831", colors: ["#E8D9C7", "#DCCBB7", "#B9C5A6", "#C3C69A", "#B3C7C6", "#D8C2BD"] },
  { key: "blue", name: "墨蓝海岸", foreground: "#F8F4EA", colors: ["#4D6379", "#536E85", "#45696E", "#4A706A", "#58627A", "#606D7D"] },
];
const CALENDAR_DATE_ART_TONE_BY_DAY = [1, 4, 2, 6, 3, 5, 1, 3, 6, 5, 2, 1, 5, 3, 6, 2, 5, 1, 4, 2, 3, 1, 4, 5, 3, 2, 6, 1, 4, 5, 6] as const;
const CALENDAR_DATE_GLYPH_NAMES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] as const;

function isCalendarDateArtPalette(value: unknown): value is CalendarDateArtPaletteKey {
  return value === "morandi" || value === "peach" || value === "tea" || value === "blue";
}

function isCalendarDateArtLayout(value: unknown): value is CalendarDateArtLayout {
  return value === "horizontal" || value === "vertical" || value === "big";
}

function readCalendarDateArtPreferences(): CalendarDateArtPreferences {
  try {
    const stored = window.localStorage.getItem(CALENDAR_DATE_ART_STORAGE_KEY);
    if (stored === null) return DEFAULT_CALENDAR_DATE_ART_PREFERENCES;
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_CALENDAR_DATE_ART_PREFERENCES;
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1) return DEFAULT_CALENDAR_DATE_ART_PREFERENCES;
    return {
      version: 1,
      dateNumberScale: typeof candidate.dateNumberScale === "number" && Number.isFinite(candidate.dateNumberScale) ? Math.min(1.8, Math.max(1, candidate.dateNumberScale)) : 1.2,
      scheme: isCalendarDateArtPalette(candidate.scheme) ? candidate.scheme : DEFAULT_CALENDAR_DATE_ART_PREFERENCES.scheme,
      desktopLayout: isCalendarDateArtLayout(candidate.desktopLayout) ? candidate.desktopLayout : DEFAULT_CALENDAR_DATE_ART_PREFERENCES.desktopLayout,
      mobileLayout: isCalendarDateArtLayout(candidate.mobileLayout) ? candidate.mobileLayout : DEFAULT_CALENDAR_DATE_ART_PREFERENCES.mobileLayout,
    };
  } catch {
    return DEFAULT_CALENDAR_DATE_ART_PREFERENCES;
  }
}

function calendarDateGlyphNames(day: number): readonly string[] {
  if (day >= 1 && day <= 9) return [CALENDAR_DATE_GLYPH_NAMES[day]];
  if (day === 10) return ["ten"];
  if (day >= 11 && day <= 19) return ["ten", CALENDAR_DATE_GLYPH_NAMES[day - 10]];
  if (day === 20) return ["twenty"];
  if (day >= 21 && day <= 29) return ["twenty", CALENDAR_DATE_GLYPH_NAMES[day - 20]];
  if (day === 30) return ["thirty"];
  if (day === 31) return ["thirty", "one"];
  return [];
}

function CalendarDateGlyph({ day }: { day: number }) {
  const names = calendarDateGlyphNames(day);
  return <span className="calendar-date-art" data-date-art-count={names.length} data-date-art-glyphs={names.join(" ")} aria-hidden="true">
    {names.map((name) => <svg className="calendar-date-glyph" data-date-art-glyph={name} key={name} viewBox="0 0 1000 1000" focusable="false" aria-hidden="true">
      <use href={`${calendarDateGlyphSpriteUrl}#calendar-pal-glyph-${name}`} x="0" y="0" width="1000" height="1000" />
    </svg>)}
  </span>;
}

function WeekDateArt({ date, showGlyph }: { date: string; showGlyph: boolean }) {
  const day = Number(date.slice(8, 10));
  return <span className="week-card-art week-card-date-art" data-date-art-background data-date-art-tone={CALENDAR_DATE_ART_TONE_BY_DAY[day - 1]} aria-hidden="true">
    {showGlyph ? <span className="calendar-date-art-safe-area"><CalendarDateGlyph day={day} /></span> : null}
    <span className="week-card-veil" data-date-art-veil />
  </span>;
}

const CALENDAR_DATE_ART_LAYOUTS: readonly { readonly key: CalendarDateArtLayout; readonly label: string }[] = [
  { key: "horizontal", label: "横排留白" },
  { key: "vertical", label: "竖排书页" },
  { key: "big", label: "大字留白" },
];

function CalendarDateArtSettings({ preferences, onChange }: { preferences: CalendarDateArtPreferences; onChange: (next: Partial<CalendarDateArtPreferences>) => void }) {
  return <div className="calendar-settings-block calendar-date-art-settings">
    <div className="calendar-date-art-settings-heading"><p className="eyebrow">无照片日期背景</p></div>
    <div className="calendar-date-art-palette-group">
      <span className="calendar-date-art-label">色系</span>
      <div className="calendar-date-art-palettes" role="radiogroup" aria-label="无照片日期背景色系">
        {CALENDAR_DATE_ART_PALETTES.map((palette) => <button className={`calendar-date-art-palette ${preferences.scheme === palette.key ? "is-selected" : ""}`} type="button" role="radio" aria-checked={preferences.scheme === palette.key} aria-label={`选择${palette.name}`} data-date-art-palette={palette.key} key={palette.key} onClick={() => onChange({ scheme: palette.key })}>
          <span className="calendar-date-art-palette-swatches" aria-hidden="true">{palette.colors.map((color, index) => <span style={{ backgroundColor: color }} key={`${palette.key}-${index}`} />)}</span>
          <span className="calendar-date-art-palette-name">{palette.name}</span>
        </button>)}
      </div>
    </div>
    {(["desktop", "mobile"] as const).map((device) => {
      const selected = device === "desktop" ? preferences.desktopLayout : preferences.mobileLayout;
      const title = device === "desktop" ? "桌面字形排法" : "手机字形排法";
      const property = device === "desktop" ? "desktopLayout" : "mobileLayout";
      return <div className="calendar-date-art-layout-group" data-layout-device={device} key={device}>
        <span className="calendar-date-art-label">{title}</span>
        <div className="calendar-date-art-layouts" role="radiogroup" aria-label={title}>
          {CALENDAR_DATE_ART_LAYOUTS.map((layout) => <button className={`calendar-date-art-layout ${selected === layout.key ? "is-selected" : ""}`} type="button" role="radio" aria-checked={selected === layout.key} aria-label={layout.label} data-date-art-layout={layout.key} data-layout-device={device} key={layout.key} onClick={() => onChange({ [property]: layout.key })}>{layout.label}</button>)}
        </div>
      </div>;
    })}
  </div>;
}

function cycleMarkerLabelsForDate(date: string, today: string, module: CycleIntimacyModuleData | null): string[] {
  if (!module?.config.enabled) return [];
  const period = periodMoonForDate(date, today, module);
  const hasPeriodStart = module.config.enabled && module.events.some((event) => event.date === date && event.kind === "period_start");
  const hasPeriodEnd = module.config.enabled && module.events.some((event) => event.date === date && event.kind === "period_end");
  const labels: string[] = [];
  if (period !== undefined || hasPeriodStart || hasPeriodEnd) {
    labels.push(hasPeriodStart && hasPeriodEnd ? "已记录经期开始和经期结束" : hasPeriodStart ? "已记录经期开始" : hasPeriodEnd ? "已记录经期结束" : period?.forecast ? "预测经期" : "已记录经期");
  }
  if (module.events.some((event) => event.date === date && event.kind === "intimacy")) labels.push("已记录亲密");
  if (module.events.some((event) => event.date === date && event.kind === "fitness")) labels.push("已记录健身");
  return labels;
}

function CalendarDayMarkers({ date, today, module }: { readonly date: string; readonly today: string; readonly module: CycleIntimacyModuleData | null }) {
  if (!module) return null;
  const period = module.config.enabled ? periodMoonForDate(date, today, module) : undefined;
  const hasPeriodStart = module.events.some((event) => event.date === date && event.kind === "period_start");
  const hasPeriodEnd = module.events.some((event) => event.date === date && event.kind === "period_end");
  const intimate = module.config.enabled && module.events.some((event) => event.date === date && event.kind === "intimacy");
  const fitness = module.config.enabled && module.events.some((event) => event.date === date && event.kind === "fitness");
  const markers: CalendarMarker[] = [];
  if (period !== undefined || hasPeriodStart || hasPeriodEnd) {
    // Keep the calendar's established future-period ghosting even when an
    // explicit endpoint was recorded. An orphan endpoint still gets a visible
    // marker, with the same future-date treatment when no inferred run exists.
    const forecast = period?.forecast ?? (date > today);
    const label = hasPeriodStart && hasPeriodEnd ? "已记录经期开始和经期结束" : hasPeriodStart ? "已记录经期开始" : hasPeriodEnd ? "已记录经期结束" : forecast ? "预测经期" : "已记录经期";
    markers.push({
      id: `period-${date}`,
      label,
      content: <span className={`calendar-period-marker ${forecast ? "is-forecast" : ""}`} role="img" aria-label={label} title={label}>
        <Moon className={`calendar-moon ${forecast ? "is-forecast" : ""}`} size={12} strokeWidth={1.9} aria-hidden="true" />
        {hasPeriodStart ? <span className="calendar-period-start-cap" aria-hidden="true" /> : null}
        {hasPeriodEnd ? <span className="calendar-period-end-cap" aria-hidden="true" /> : null}
      </span>,
    });
  }
  if (intimate) markers.push({ id: `intimacy-${date}`, label: "已记录亲密", content: <Heart className="calendar-heart" size={13} strokeWidth={1.9} aria-hidden="true" /> });
  if (fitness) markers.push({ id: `fitness-${date}`, label: "已记录健身", content: <Dumbbell className="calendar-fitness" size={13} strokeWidth={1.9} aria-hidden="true" /> });
  for (const habit of module.config.habits ?? []) if (habit.dates.includes(date)) markers.push({ id: habit.id, label: habit.name, content: <span data-habit-marker={habit.id} title={habit.name} aria-label={habit.name}><HabitIcon name={habit.icon} size={13} /></span> });
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

/**
 * The calendar's own settings, behind the gear beside the cycle button.
 *
 * Local date-cell appearance is kept separate from the API-backed AI summary
 * settings below. The prompt remains visible in full because it changes what
 * every cell's summary says.
 */
export function CalendarSettingsPanel({ statusState, onStatusChange, onRetry, onClose, dateArtPreferences, onDateArtChange, backgroundMonth, hideDemo, backgroundScope }: { statusState: AiStatusState; onStatusChange: (status: AiStatus) => void; onRetry: () => void; onClose: () => void; dateArtPreferences: CalendarDateArtPreferences; onDateArtChange: (next: Partial<CalendarDateArtPreferences>) => void; backgroundMonth: string; hideDemo: boolean; backgroundScope: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPointerDownRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const backdropGestureRef = useRef<{ pointerId: number; endedAt: number } | null>(null);
  const [section, setSection] = useState<"appearance" | "summary">("appearance");
  const status = statusState.status;
  const statusReady = statusState.phase === "ready" && status !== null;
  const [enabled, setEnabled] = useState(status?.enabled ?? true);
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? "https://api.deepseek.com");
  const [model, setModel] = useState(status?.model ?? "deepseek-flash");
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState(status?.summaryPrompt ?? "");
  const [busy, setBusy] = useState<null | "save" | "test">(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  useEffect(() => {
    if (status === null) return;
    setEnabled(status.enabled);
    setBaseUrl(status.baseUrl);
    setModel(status.model);
    setPrompt(status.summaryPrompt);
  }, [status]);

  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  const run = async (kind: "save" | "test", request: () => Promise<AiStatus | { ok?: boolean; message?: string }>, done: (next: AiStatus | { ok?: boolean; message?: string }) => void, failure: string) => {
    if (!statusReady || busy !== null) return;
    setBusy(kind);
    setMessage(null);
    try {
      done(await request());
    } catch (error) {
      setMessage({ text: errorMessage(error, failure), tone: "bad" });
    } finally {
      setBusy(null);
    }
  };
  const save = () => run("save", () => apiRequest<AiStatus>("/api/ai/config", { method: "POST", body: JSON.stringify({ enabled, baseUrl, model, summaryPrompt: prompt, ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }) }) }), (next) => {
    const saved = next as AiStatus;
    setApiKey("");
    onStatusChange(saved);
    setPrompt(saved.summaryPrompt);
    setMessage({ text: saved.keyConfigured ? "已保存" : "已保存，未配置密钥时使用离线小结。", tone: "ok" });
  }, "保存失败，请重试");
  const resetPrompt = () => run("save", () => apiRequest<AiStatus>("/api/ai/config", { method: "POST", body: JSON.stringify({ enabled, baseUrl, model, summaryPrompt: null, ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }) }) }), (next) => {
    const saved = next as AiStatus;
    setApiKey("");
    onStatusChange(saved);
    setPrompt(saved.summaryPrompt);
    setMessage({ text: "已换回内置的提示词。", tone: "ok" });
  }, "换回默认失败，请重试");
  const test = () => run("test", () => apiRequest<{ ok?: boolean; message?: string }>("/api/ai/config/test", { method: "POST", body: JSON.stringify({ baseUrl, ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }) }) }), (next) => {
    setMessage({ text: (next as { message?: string }).message ?? "连接成功", tone: "ok" });
  }, "连接失败");

  const keyConfigured = status?.keyConfigured === true;
  const custom = status?.summaryPromptCustom === true;
  const isBackdrop = (event: ReactPointerEvent<HTMLDialogElement> | ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  return <dialog ref={dialogRef} id="calendar-settings-panel" className="modal-dialog calendar-settings-panel calendar-settings-dialog" aria-labelledby="calendar-settings-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => {
      event.stopPropagation();
      backdropPointerDownRef.current = event.isPrimary && event.button === 0 && isBackdrop(event) ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY } : null;
      backdropGestureRef.current = null;
    }}
    onPointerMove={(event) => {
      event.stopPropagation();
      const start = backdropPointerDownRef.current;
      if (start && (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 || !isBackdrop(event))) backdropPointerDownRef.current = null;
    }}
    onPointerUp={(event) => {
      event.stopPropagation();
      const start = backdropPointerDownRef.current;
      backdropPointerDownRef.current = null;
      if (start && start.pointerId === event.pointerId && event.isPrimary && event.button === 0 && isBackdrop(event) && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6) {
        backdropGestureRef.current = { pointerId: start.pointerId, endedAt: performance.now() };
      }
    }}
    onPointerCancel={(event) => { event.stopPropagation(); backdropPointerDownRef.current = null; backdropGestureRef.current = null; }}
    onClick={(event) => {
      event.stopPropagation();
      const gesture = backdropGestureRef.current;
      backdropGestureRef.current = null;
      if (!isBackdrop(event) || gesture === null || event.detail === 0 || performance.now() - gesture.endedAt > 500) return;
      const pointerId = (event.nativeEvent as PointerEvent).pointerId;
      if (typeof pointerId === "number" && pointerId !== gesture.pointerId) return;
      onClose();
    }}>
    <div className="dialog-header"><h2 id="calendar-settings-title">日历设置</h2><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭日历设置"><X size={17} aria-hidden="true" /></button></div>
    <div className="calendar-settings-tabs" aria-label="设置分区">
      <button type="button" aria-pressed={section === "appearance"} aria-controls="calendar-settings-appearance" onClick={() => setSection("appearance")}>外观</button>
      <button type="button" aria-pressed={section === "summary"} aria-controls="calendar-settings-summary" onClick={() => setSection("summary")}>AI 小结</button>
    </div>
    <div className="dialog-body calendar-settings-dialog-body">
      <div id="calendar-settings-appearance" hidden={section !== "appearance"}>
      <label className="calendar-date-size-setting"><span>日期数字大小 <output>{Math.round(dateArtPreferences.dateNumberScale * 100)}%</output></span><input type="range" min="100" max="180" step="1" value={Math.round(dateArtPreferences.dateNumberScale * 100)} onChange={event => onDateArtChange({ dateNumberScale: Number(event.target.value) / 100 })} aria-label="日期数字大小" /></label>
      <CalendarDateArtSettings preferences={dateArtPreferences} onChange={onDateArtChange} />
      <CalendarBackgroundSettings key={`${backgroundScope}:${hideDemo}:${backgroundMonth}`} month={backgroundMonth} hideDemo={hideDemo} scope={backgroundScope} />
      </div>
      <div id="calendar-settings-summary" className="calendar-settings-block" hidden={section !== "summary"}>
      <div className="calendar-settings-switch"><span>用 AI 生成小结<small>{statusReady ? keyConfigured ? "已配置密钥" : "还没有密钥，暂时用离线规则" : "状态确认后才能修改"}</small></span><button className={"toggle-button" + (enabled ? " is-on" : "")} type="button" role="switch" aria-checked={enabled} disabled={!statusReady} onClick={() => setEnabled(!enabled)} aria-label="用 AI 生成小结"><span className="toggle-knob" /></button></div>
      <p className="settings-ai-note">当天先显示离线小结，次日首次查看时生成 AI 小结。修改模型或提示词后，已生成的小结仍保留；可在日期菜单中主动重新生成。</p>
      <p className="settings-ai-note">待办简写按用户每天最多处理 20 条新增、10 次内容修改。超出额度或生成失败时仍显示原文提醒，重复查看不会重新消耗额度。</p>
      {statusState.phase === "failed" ? <div className="settings-config-read-error" role="alert"><span>{statusState.error}</span><button className="secondary-button" type="button" onClick={onRetry}>重试读取</button></div> : null}
      {status === null ? <p className="settings-config-unavailable">状态暂时不可读取；保存、测试和提示词调整已锁定。</p> : null}
      <div className="calendar-settings-grid">
        <label><span>服务地址</span><input value={baseUrl} disabled={!statusReady} onChange={(event) => setBaseUrl(event.target.value)} aria-label="AI 服务地址" /></label>
        <label><span>模型</span><input value={model} disabled={!statusReady} onChange={(event) => setModel(event.target.value)} aria-label="AI 模型" /></label>
        <label className="calendar-settings-wide"><span>API Key{keyConfigured ? "（留空则沿用已存的）" : ""}</span><input type="password" value={apiKey} disabled={!statusReady} onChange={(event) => setApiKey(event.target.value)} aria-label="AI API Key" autoComplete="off" /></label>
      </div>
      <label className="calendar-settings-prompt"><span>给 AI 的提示词</span><textarea value={prompt} disabled={!statusReady} onChange={(event) => setPrompt(event.target.value)} rows={9} spellCheck={false} aria-label="给 AI 的提示词" /></label>
      </div>
    </div>
    <div className="calendar-settings-footer">
      {section === "appearance" ? <span className="settings-ai-note" role="status">日期外观即时生效，照片背景需保存</span> : <>
      {custom ? <span className="calendar-settings-badge">自定义提示词</span> : null}
      {message !== null ? <p className={"settings-ai-note " + (message.tone === "bad" ? "settings-inline-error" : "settings-inline-success")} role="status">{message.text}</p> : null}
      <div className="calendar-settings-actions">
        <button className="primary-button" type="button" onClick={() => void save()} disabled={!statusReady || busy !== null}>{busy === "save" ? "保存中…" : "保存"}</button>
        <button className="secondary-button" type="button" onClick={() => void test()} disabled={!statusReady || busy !== null}>{busy === "test" ? "测试中…" : "测试连接"}</button>
        <button className="secondary-button" type="button" onClick={() => void resetPrompt()} disabled={!statusReady || busy !== null || !custom}>换回内置提示词</button>
      </div>
      </>}
    </div>
  </dialog>;
}

/** The four cycle marks, in panel order — one list, because both the panel's
 *  buttons and the right-click submenu have to show the same four in the same
 *  order, and separate copies would drift. */
export const CYCLE_EVENT_KINDS: readonly { kind: CycleIntimacyEventKind; label: string; activeLabel: string; icon: ReactNode }[] = [
  { kind: "period_start", label: "经期开始", activeLabel: "已记录经期开始", icon: <Moon className="cycle-option-moon" size={17} strokeWidth={1.9} aria-hidden="true" /> },
  { kind: "period_end", label: "经期结束", activeLabel: "已记录经期结束", icon: <Moon className="cycle-option-moon" size={17} strokeWidth={1.9} aria-hidden="true" /> },
  { kind: "intimacy", label: "亲密", activeLabel: "已记录亲密", icon: <Heart size={17} strokeWidth={1.9} aria-hidden="true" /> },
  { kind: "fitness", label: "健身", activeLabel: "已记录健身", icon: <Dumbbell size={17} strokeWidth={1.9} aria-hidden="true" /> },
];

type MobileCycleKind = MobileCycleEventKind;
const MOBILE_CYCLE_EVENT_KINDS = CYCLE_EVENT_KINDS.filter(
  (item): item is (typeof CYCLE_EVENT_KINDS)[number] & { readonly kind: MobileCycleKind } => item.kind !== "fitness",
);

interface MobileCycleDraft {
  readonly date: string;
  readonly kinds: readonly MobileCycleKind[];
  readonly revision: string;
}

const MOBILE_CYCLE_WEATHER_KEY = "lifeos.calendar.show-cycle-weather";

function mobileCycleDraftForDate(date: string, module: CycleModuleResponse): MobileCycleDraft {
  const kinds = MOBILE_CYCLE_EVENT_KINDS.map((item) => item.kind).filter((kind) => module.events.some((event) => event.date === date && event.kind === kind));
  return { date, kinds, revision: module.eventRevision };
}

function MobileCycleEntryPanel({ date, draft, busy, pendingKind, error, conflict, onSelect, onReload, onOpenSettings, fitnessMarked, onToggleFitness, menu = false }: { fitnessMarked: boolean; onToggleFitness: () => void; menu?: boolean; date: string; draft: MobileCycleDraft | null; busy: boolean; pendingKind: MobileCycleKind | null; error: string | null; conflict: boolean; onSelect: (kind: MobileCycleKind) => void; onReload: () => void; onOpenSettings: () => void }) {
  return <section className="cycle-mobile-entry" aria-label="周期与习惯标记" data-date={date}>
    <div className="cycle-mobile-actions" role="group" aria-label="选择周期记录">
      {CYCLE_EVENT_KINDS.map((item) => { const selected = item.kind === "fitness" ? fitnessMarked : draft?.kinds.includes(item.kind) === true; const Icon = item.kind === "intimacy" ? Heart : item.kind === "fitness" ? Dumbbell : Moon; return <button className={`cycle-mobile-action ${selected ? "is-selected" : ""}`} data-cycle-kind={item.kind} type="button" key={item.kind} disabled={busy || draft === null} role={menu ? "menuitemcheckbox" : "checkbox"} aria-checked={selected} aria-busy={pendingKind === item.kind ? true : undefined} aria-label={item.label} onClick={() => item.kind === "fitness" ? onToggleFitness() : onSelect(item.kind)}>
        <span className="cycle-mobile-checkbox" aria-hidden="true">{selected ? <Check size={13} strokeWidth={2.6} /> : null}</span><Icon className="cycle-mobile-action-icon" size={12} strokeWidth={1.9} aria-hidden="true" /><span className="cycle-mobile-action-label">{item.label}</span>
      </button>; })}
    </div>
    {error !== null ? <div className="cycle-mobile-error-row"><p className="cycle-mobile-error" role="alert">{error}</p>{conflict ? <button className="cycle-mobile-reload" type="button" onClick={onReload} disabled={busy}>重新载入</button> : null}</div> : null}
  </section>;
}

/**
 * The right-click menu on a day. It does not depend on edit mode: changing one
 * day's summary and marking a cycle event are both things you reach for from the
 * grid itself. Summaries only exist in the month grid, so the three summary items
 * are month-only; the cycle shortcuts are there in either view.
 */
export function CalendarSummaryMenu({ x, y, monthMode, summaryEditable, habits, date, onToggleHabit, busy, cycleReady, cycleEnabled, recordedKinds, onEdit, onRegenerate, onRevert, onToggleCycle, onPickCycle, onClose }: { x: number; y: number; habits: readonly CustomHabit[]; date: string; onToggleHabit: (habit: CustomHabit) => void; monthMode: boolean; summaryEditable: boolean; busy: boolean; cycleReady: boolean; cycleEnabled: boolean; recordedKinds: ReadonlySet<CycleIntimacyEventKind>; onEdit: () => void; onRegenerate: () => void; onRevert: () => void; onToggleCycle: (kind: CycleIntimacyEventKind) => void; onPickCycle: (kind: CycleIntimacyEventKind) => void; onClose: () => void }) {
  const [cycleOpen, setCycleOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [submenuPosition, setSubmenuPosition] = useState({ left: 0, top: 0 });
  useActionMenu(menuRef, true, onClose, () => setCycleOpen(false));
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const rect = menu.getBoundingClientRect();
    setPosition(clampFixedMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
  }, [x, y, monthMode]);
  useLayoutEffect(() => {
    const submenu = submenuRef.current;
    const root = menuRef.current;
    if (!cycleOpen || !submenu || !root || !submenu.parentElement) return;
    const row = submenu.parentElement.getBoundingClientRect();
    const parent = root.getBoundingClientRect();
    const rect = submenu.getBoundingClientRect();
    const desiredX = parent.right + rect.width <= window.innerWidth - 8 ? parent.right - 1 : parent.left - rect.width + 1;
    const clamped = clampFixedMenuPosition(desiredX, row.top - 7, rect.width, rect.height, window.innerWidth, window.innerHeight);
    setSubmenuPosition({ left: clamped.x - row.left, top: clamped.y - row.top });
  }, [cycleOpen, position, habits, cycleReady, cycleEnabled]);
  return <div ref={menuRef} className="calendar-summary-menu" role="menu" aria-label="日历操作" style={{ left: position.x, top: position.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    {/* Picking an action dismisses the menu. Inside presses are allowed by the
        shared dismissal hook. Cycle checkboxes are the exception — the menu stays up, so two things can be
        marked on the same day without right-clicking again. */}
    {monthMode ? <button role="menuitem" type="button" disabled={busy || !summaryEditable} onClick={() => { onClose(); onEdit(); }}><Pencil size={14} strokeWidth={1.9} aria-hidden="true" /><span>编辑小结</span></button> : null}
    {monthMode ? <button role="menuitem" type="button" disabled={busy || !summaryEditable} onClick={() => { onClose(); onRegenerate(); }}><RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" /><span>AI 重新生成小结</span></button> : null}
    {monthMode ? <button role="menuitem" type="button" disabled={busy || !summaryEditable} onClick={() => { onClose(); onRevert(); }}><Eraser size={14} strokeWidth={1.9} aria-hidden="true" /><span>恢复原样</span></button> : null}
    {monthMode ? <div className="action-menu-separator" role="separator" /> : null}
    <div className="calendar-summary-submenu-host" onMouseEnter={() => setCycleOpen(true)} onMouseLeave={() => { if (!submenuRef.current?.contains(document.activeElement)) setCycleOpen(false); }}>
      <button role="menuitem" type="button" aria-haspopup="menu" aria-expanded={cycleOpen} className={cycleOpen ? "is-open" : ""} onClick={() => setCycleOpen(true)}><CalendarDays size={14} strokeWidth={1.9} aria-hidden="true" /><span>周期</span><ChevronRight className="calendar-summary-caret" size={14} strokeWidth={1.9} aria-hidden="true" /></button>
      {cycleOpen ? <div ref={submenuRef} className="calendar-summary-submenu" style={submenuPosition} role="menu" aria-label="周期">
        {!cycleReady ? <small className="calendar-cycle-hint">正在读取周期设置…</small> : !cycleEnabled ? <small className="calendar-cycle-hint">选择后启用周期记录</small> : null}
        {/* Two click targets per row on purpose. The box is the multi-select half —
            tick several marks in a row without the menu getting in the way — while
            the label is the single-select half: pick this one thing and be done, so
            the menu closes behind it. */}
        {CYCLE_EVENT_KINDS.map((item) => {
          const on = recordedKinds.has(item.kind);
          const off = busy || !cycleReady;
          return <div className="calendar-summary-cycle-row" role="none" key={item.kind}>
            <button className={`calendar-summary-checkbox ${on ? "is-checked" : ""}`} type="button" role="menuitemcheckbox" aria-checked={on} disabled={off} aria-label={`多选：${on ? "移除" : "记录"}${item.label}`} onClick={() => onToggleCycle(item.kind)}>{on ? <Check size={11} strokeWidth={2.6} aria-hidden="true" /> : null}</button>
            <button className="calendar-summary-cycle-label" type="button" role="menuitem" disabled={off} aria-label={`${on ? "移除" : "记录"}${item.label}，并关闭菜单`} onClick={() => onPickCycle(item.kind)}>{item.label}</button>
          </div>;
        })}
        {habits.map(habit => { const on = habit.dates.includes(date); return <div className="calendar-summary-cycle-row" role="none" key={habit.id}>
          <button className={"calendar-summary-checkbox " + (on ? "is-checked" : "")} type="button" role="menuitemcheckbox" aria-checked={on} disabled={busy || date > new Intl.DateTimeFormat("en-CA", { timeZone: USER_TIME_ZONE }).format(new Date())} aria-label={"多选：" + (on ? "移除" : "记录") + habit.name} onClick={() => onToggleHabit(habit)}>{on ? <Check size={11} /> : null}</button>
          <button className="calendar-summary-cycle-label" type="button" role="menuitem" disabled={busy || date > new Intl.DateTimeFormat("en-CA", { timeZone: USER_TIME_ZONE }).format(new Date())} onClick={() => { onClose(); onToggleHabit(habit); }}><HabitIcon name={habit.icon} size={14} />{habit.name}</button>
        </div>; })}
      </div> : null}
    </div>
    <button role="menuitem" type="button" onClick={onClose}><X size={14} strokeWidth={1.9} aria-hidden="true" /><span>取消</span></button>
  </div>;
}

export function CalendarView({ hideDemo = false, backgroundScope = "local", mode, onModeChange, onStep, anchor, today, habitActions, presentations, records, tasks = [], assets, summaries, aiEnabled, weatherByDate, loading, error, cycleModule, cyclePanelOpen, onOpenCycleModule, onCloseCycleModule, onOpenCycleSettings, onSaveCycleConfig, onAddCycleModuleEvent, onDeleteCycleModuleEvent, onSaveMobileCycleDay, onReloadCycleModule, onSavePeriodLength, onSaveCycleLength, onRetry, onOpenDay, settingsOpen, onToggleSettings, aiStatusState, onAiStatusChange, onRetryAiStatus, editMode, onEditModeChange, drafts, onDraftChange, summarySaving, onSaveDrafts, onDiscardDrafts, onRegenerateSummary, onRevertSummary, busyDate }: { hideDemo?: boolean; backgroundScope?: string; mode: CalendarMode; onModeChange: (mode: CalendarMode) => void; onStep: (direction: number) => void; anchor: string; today: string; habitActions: HabitActions; presentations: ReadonlyMap<string, CalendarPresentation>; records: readonly RecordView[] | null; tasks?: readonly RecordView[]; assets: readonly Asset[]; summaries: ReadonlyMap<string, DaySummary>; aiEnabled: boolean; weatherByDate: ReadonlyMap<string, CalendarWeather>; loading: boolean; error: string | null; cycleModule: CycleModuleResponse | null; cyclePanelOpen: boolean; onOpenCycleModule: () => void | Promise<void>; onCloseCycleModule: () => void; onOpenCycleSettings: () => void; onSaveCycleConfig: (config: CycleIntimacyModuleConfig) => Promise<void>; onAddCycleModuleEvent: (date: string, kind: CycleIntimacyEventKind) => Promise<void>; onDeleteCycleModuleEvent: (id: string) => Promise<void>; onSaveMobileCycleDay: (date: string, kinds: readonly MobileCycleKind[], revision: string) => Promise<CycleDayEditResponse>; onUndoMobileCycleDay: (token: string) => Promise<CycleDayUndoResponse>; onReloadCycleModule: () => Promise<CycleModuleResponse>; onSavePeriodLength: (days: number) => Promise<void>; onSaveCycleLength: (days: number) => Promise<void>; onRetry: () => void; onOpenDay: (date: string) => void; settingsOpen: boolean; onToggleSettings: () => void; aiStatusState: AiStatusState; onAiStatusChange: (status: AiStatus) => void; onRetryAiStatus: () => void; editMode: boolean; onEditModeChange: (value: boolean) => void | Promise<boolean>; drafts: ReadonlyMap<string, string>; onDraftChange: (date: string, text: string) => void; summarySaving: boolean; onSaveDrafts: () => void; onDiscardDrafts: () => void; onRegenerateSummary: (date: string) => Promise<void>; onRevertSummary: (date: string) => Promise<void>; busyDate: string | null }) {
  const dates = useMemo(() => (mode === "week" ? datesOfWeek(anchor) : monthGridDates(anchor)), [mode, anchor]);
  /** PC 周历下方的「上一周」预览（弱化可读；手机不显示）。 */
  const prevDates = useMemo(
    () => (mode === "week" ? datesOfWeek(shiftDate(anchor, -7)) : []),
    [mode, anchor],
  );
  // A week card has no summary line at all, so edit mode only means something in
  // the month grid. Deriving it once keeps every cell honest even if the two ever
  // disagree for a frame.
  const editable = editMode && mode === "month";
  const taskLabels = useCalendarTaskLabels(tasks, dates[0] ?? anchor, dates[dates.length - 1] ?? anchor, USER_TIME_ZONE, mode === "month" && !editable && !loading && !error);

  // Editing lives in the calendar, so the only state it needs of its own is where
  // the right-click menu sits and which day asked for the caret; the drafts are
  // owned above, because saving them is one request and the count has to survive
  // a re-render.
  const [summaryMenu, setSummaryMenu] = useState<{ date: string; x: number; y: number; marksOnly?: boolean } | null>(null);
  const mobileCyclePanelVisible = cyclePanelOpen || summaryMenu?.marksOnly === true;
  const holdMenuRef = useRef<HTMLDivElement>(null);
  const [holdMenuPosition, setHoldMenuPosition] = useState({ x: 8, y: 8 });
  useActionMenu(holdMenuRef, summaryMenu?.marksOnly === true, () => setSummaryMenu(null));
  useLayoutEffect(() => {
    const menu = holdMenuRef.current;
    if (!menu || !summaryMenu?.marksOnly) return;
    const viewport = window.visualViewport;
    const width = Math.min(document.documentElement.clientWidth, viewport?.width ?? window.innerWidth);
    const height = viewport?.height ?? window.innerHeight;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
    menu.style.maxHeight = "none";
    const rect = menu.getBoundingClientRect();
    const position = clampFixedMenuPosition(summaryMenu.x - left, summaryMenu.y - top, rect.width, rect.height, width, height);
    setHoldMenuPosition({ x: position.x + left, y: position.y + top });
  }, [summaryMenu, cycleModule]);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [cycleBusyDate, setCycleBusyDate] = useState<string | null>(null);
  const [cycleShortcutError, setCycleShortcutError] = useState<string | null>(null);
  const [mobileCycleDraft, setMobileCycleDraft] = useState<MobileCycleDraft | null>(null);
  const [mobileCycleDate, setMobileCycleDate] = useState(anchor);
  const cyclePopoverRef = useRef<HTMLDivElement>(null);
  const cycleWasOpen = useRef(false);
  const [cyclePopoverStyle, setCyclePopoverStyle] = useState<CSSProperties | null>(null);
  useActionMenu(cyclePopoverRef, cyclePanelOpen, onCloseCycleModule, undefined, {
    allowOutside: target => !!target.closest('.calendar-module-button[aria-controls="cycle-entry-panel"], .month-cell:not(.is-future):not(.is-outside), .week-card:not(.is-future)'),
    passthrough: true,
    followViewport: true,
  });
  const [mobileCycleBusy, setMobileCycleBusy] = useState(false);
  const [mobileCyclePendingKind, setMobileCyclePendingKind] = useState<MobileCycleKind | null>(null);
  const [mobileCycleError, setMobileCycleError] = useState<{ readonly message: string; readonly conflict: boolean } | null>(null);
  const [weatherIconsEnabled, setWeatherIconsEnabled] = useState(() => {
    try { return window.localStorage.getItem(MOBILE_CYCLE_WEATHER_KEY) === "1"; }
    catch { return false; }
  });
  const [dateArtPreferences, setDateArtPreferences] = useState(readCalendarDateArtPreferences);
  const dateArtPreferencesRef = useRef(dateArtPreferences);
  const updateDateArtPreferences = useCallback((patch: Partial<CalendarDateArtPreferences>) => {
    const next = { ...dateArtPreferencesRef.current, ...patch, version: 1 as const };
    dateArtPreferencesRef.current = next;
    setDateArtPreferences(next);
    try { window.localStorage.setItem(CALENDAR_DATE_ART_STORAGE_KEY, JSON.stringify(next)); }
    catch { /* Palette and layout remain usable when storage is unavailable. */ }
  }, []);
  const selectedDateArtPalette = CALENDAR_DATE_ART_PALETTES.find((palette) => palette.key === dateArtPreferences.scheme) ?? CALENDAR_DATE_ART_PALETTES[0]!;
  const dateArtStyle = useMemo(() => ({
    "--calendar-date-number-scale": dateArtPreferences.dateNumberScale,
    "--calendar-date-art-foreground": selectedDateArtPalette.foreground,
    "--calendar-date-art-tone-1": selectedDateArtPalette.colors[0],
    "--calendar-date-art-tone-2": selectedDateArtPalette.colors[1],
    "--calendar-date-art-tone-3": selectedDateArtPalette.colors[2],
    "--calendar-date-art-tone-4": selectedDateArtPalette.colors[3],
    "--calendar-date-art-tone-5": selectedDateArtPalette.colors[4],
    "--calendar-date-art-tone-6": selectedDateArtPalette.colors[5],
  } as CSSProperties), [selectedDateArtPalette, dateArtPreferences.dateNumberScale]);
  const mobileCycleBusyRef = useRef(false);
  const mobileCycleDraftRef = useRef<MobileCycleDraft | null>(null);
  const mobileCycleOpenRef = useRef(false);
  const mobileCycleDateRef = useRef(anchor);
  const mobileCycleGenerationRef = useRef(0);
  const cycleBusyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (cyclePanelOpen && !cycleWasOpen.current) {
      mobileCycleDateRef.current = today;
      setMobileCycleDate(today);
      setSummaryMenu(null);
    }
    cycleWasOpen.current = cyclePanelOpen;
    if (!cyclePanelOpen) setCyclePopoverStyle(null);
  }, [cyclePanelOpen, today]);
  useLayoutEffect(() => {
    const menu = cyclePopoverRef.current;
    if (!cyclePanelOpen || !menu) return;
    const cell = menu.closest('.calendar-section')?.querySelector<HTMLElement>(`${mode === 'month' ? '.month-cell' : '.week-card'}[data-date="${mobileCycleDate}"]`);
    if (!cell) return;
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const update = () => {
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 8, top = (viewport?.offsetTop ?? 0) + 8;
      const width = Math.min(document.documentElement.clientWidth, viewport?.width ?? window.innerWidth) - 16;
      const height = (viewport?.height ?? window.innerHeight) - 16;
      const source = cell.getBoundingClientRect();
      menu.style.width = `${Math.min(Math.max(152, source.width), 192, width)}px`;
      menu.style.maxHeight = "none";
      const bounds = menu.getBoundingClientRect();
      const x = Math.max(left, Math.min(source.left + (source.width - bounds.width) / 2, left + width - bounds.width));
      const above = source.top - bounds.height - 8;
      const heading = menu.closest('.calendar-section')?.querySelector<HTMLElement>('.calendar-section-heading')?.getBoundingClientRect();
      const overlapsHeading = (y: number) => heading && x < heading.right && x + bounds.width > heading.left && y < heading.bottom + 8 && y + bounds.height > heading.top - 8;
      const preferredY = above >= top && !overlapsHeading(above) ? above : source.bottom + 8;
      let y = Math.max(top, Math.min(preferredY, top + height - bounds.height));
      if (heading && overlapsHeading(y) && heading.bottom + 8 + bounds.height <= top + height) y = heading.bottom + 8;
      setCyclePopoverStyle(previous => previous?.left === x && previous?.top === y ? previous : { left: x, top: y });
    };
    update();
    let frame = 0;
    const schedule = (event?: Event) => {
      if (event?.target instanceof Node && menu.contains(event.target)) return;
      cancelAnimationFrame(frame); frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(() => schedule());
    observer.observe(cell); observer.observe(menu);
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [cyclePanelOpen, mobileCycleDate, mode, loading, error]);
  useEffect(() => {
    if (mobileCyclePanelVisible) {
      if (!mobileCycleOpenRef.current) {
        mobileCycleOpenRef.current = true;
        mobileCycleGenerationRef.current += 1;
        const targetDate = summaryMenu?.marksOnly ? summaryMenu.date : mobileCycleDateRef.current;
        mobileCycleDateRef.current = targetDate;
        setMobileCycleDate(targetDate);
        setMobileCycleError(null);
        const draft = cycleModule === null ? null : mobileCycleDraftForDate(targetDate, cycleModule);
        mobileCycleDraftRef.current = draft;
        setMobileCycleDraft(draft);
      } else if (cycleModule !== null) {
        // There is no unsaved mobile draft: whenever the module refreshes,
        // mirror the persisted state for the selected date and its revision.
        const draft = mobileCycleDraftForDate(mobileCycleDateRef.current, cycleModule);
        mobileCycleDraftRef.current = draft;
        setMobileCycleDraft(draft);
      }
      return;
    }
    if (mobileCycleOpenRef.current) {
      mobileCycleOpenRef.current = false;
      mobileCycleGenerationRef.current += 1;
      mobileCycleDraftRef.current = null;
      setMobileCycleDraft(null);
      setMobileCycleError(null);
      setMobileCyclePendingKind(null);
    }
  }, [mobileCyclePanelVisible, anchor, cycleModule, summaryMenu?.date]);
  useEffect(() => {
    mobileCycleDateRef.current = anchor;
    setMobileCycleDate(anchor);
    setMobileCycleError(null);
    const draft = cycleModule === null ? null : mobileCycleDraftForDate(anchor, cycleModule);
    mobileCycleDraftRef.current = draft;
    setMobileCycleDraft(draft);
  }, [anchor, backgroundScope]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 560px)");
    const reconcileMobileModes = () => {
      if (cyclePanelOpen && editMode) onCloseCycleModule();
    };
    reconcileMobileModes();
    query.addEventListener("change", reconcileMobileModes);
    return () => query.removeEventListener("change", reconcileMobileModes);
  }, [cyclePanelOpen, editMode, onCloseCycleModule]);
  // A horizontal touch gesture is a view-level shortcut. Keep it deliberately
  // conservative: interactive controls retain their native click behaviour,
  // while a clear swipe on the calendar surface toggles between the two views.
  const swipeRef = useRef<{ pointerId: number; startX: number; startY: number; horizontal: boolean; consumed: boolean; captureTarget: HTMLElement | null } | null>(null);
  const beginCalendarSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return;
    const target = event.target as Element | null;
    const control = target?.closest("button, a, input, textarea, select, [contenteditable=\"true\"]");
    // Calendar cells happen to be buttons for keyboard navigation. They are the
    // primary surface people swipe on, so only exempt the other interactive
    // controls; the captured synthetic click below protects a real swipe from
    // also opening that day.
    if (control !== null && control !== undefined && !control.matches(".week-card, .month-cell")) return;
    const dateCell = target?.closest(".week-card, .month-cell");
    const captureTarget = dateCell instanceof HTMLElement ? dateCell : event.currentTarget;
    swipeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, horizontal: false, consumed: false, captureTarget };
    // Capturing on the section makes a tap's pointerup target the section too;
    // Chrome then synthesizes click on that common ancestor instead of the day.
    // Keep capture on the day cell when the gesture starts there so touch taps
    // still activate the exact date after the swipe detector has watched them.
    captureTarget.setPointerCapture(event.pointerId);
  };
  const trackCalendarSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (swipe === null || swipe.pointerId !== event.pointerId) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.25) swipe.horizontal = true;
    // A swipe can change views and unmount the day that began the gesture.
    // Transfer capture to the stable section as soon as horizontal intent is
    // clear; a stationary tap keeps capture on its day and still clicks it.
    if (swipe.horizontal && swipe.captureTarget !== event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
      swipe.captureTarget = event.currentTarget;
    }
    // Switch as soon as the threshold is crossed. Touch browsers may emit a
    // pointercancel when they start native scrolling, so waiting for pointerup
    // would make the gesture unreliable on phones.
    if (!swipe.consumed && swipe.horizontal && Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      swipe.consumed = true;
      event.preventDefault();
      onModeChange(mode === "week" ? "month" : "week");
    }
  };
  const finishCalendarSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (swipe === null || swipe.pointerId !== event.pointerId) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (!swipe.consumed && swipe.horizontal && Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      swipe.consumed = true;
      event.preventDefault();
      onModeChange(mode === "week" ? "month" : "week");
    }
    if (swipe.captureTarget?.hasPointerCapture(event.pointerId)) swipe.captureTarget.releasePointerCapture(event.pointerId);
    // Keep the consumed bit through the synthetic click generated by a touch
    // release, so a swipe never also opens a day.
    window.setTimeout(() => { if (swipeRef.current === swipe) swipeRef.current = null; }, 0);
  };
  const cancelCalendarSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (swipe?.pointerId !== event.pointerId) return;
    if (!swipe.consumed) {
      swipeRef.current = null;
      return;
    }
    // Some touch paths cancel instead of ending a gesture normally. Keep
    // suppression through any synthetic click for this gesture, then clear it
    // on the same task boundary.
    window.setTimeout(() => { if (swipeRef.current === swipe) swipeRef.current = null; }, 0);
  };
  const suppressSwipeClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (swipeRef.current?.consumed) {
      event.preventDefault();
      event.stopPropagation();
      swipeRef.current = null;
    }
  };
  const closeSummaryMenu = useCallback(() => setSummaryMenu(null), []);
  const openSummaryMenu = (date: string, event: ReactMouseEvent) => {
    event.preventDefault();
    // 2026-10-15 蛋妞拍板：右键菜单对未来日期也开放（2026-10-12 的「不以未来卡片
    // 打开操作菜单」只保留在点击/键盘入口；右键是桌面端明确要回的入口）。
    setCycleShortcutError(null);
    setSummaryMenu({ date, x: event.clientX, y: event.clientY });
  };
  /** 「编辑小结」does not hunt for the day: it opens edit mode already on that one. */
  const editDaySummary = (date: string) => { if (!canEditDaySummary(date, today, buckets.get(date) ?? [])) return; setFocusDate(date); onEditModeChange(true); };
  // The field appears in the render that follows edit mode turning on, so the
  // caret is placed by an effect instead of by the click handler.
  useEffect(() => {
    if (focusDate === null || !editable) return;
    const field = document.querySelector<HTMLTextAreaElement>(`.calendar-section [data-summary-date="${focusDate}"]`);
    setFocusDate(null);
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [focusDate, editable, dates]);
  const toggleHabitOn = async (date: string, habit: CustomHabit) => {
    if (cycleBusyRef.current !== null || date > today) return;
    cycleBusyRef.current = date; setCycleBusyDate(date); setCycleShortcutError(null);
    try { await habitActions.mark(habit, date, !habit.dates.includes(date)); }
    catch (error) { setCycleShortcutError(error instanceof Error ? error.message : "习惯标记失败，请重试"); }
    finally { cycleBusyRef.current = null; setCycleBusyDate(null); }
  };
  /** The cycle submenu marks the day it was opened on, exactly like the panel's buttons. */
  const toggleCycleOn = async (date: string, kind: CycleIntimacyEventKind, onStarted?: () => void): Promise<boolean> => {
    if (cycleModule === null || cycleBusyRef.current !== null) return false;
    const existing = (cycleModule?.events ?? []).find((event) => event.date === date && event.kind === kind);
    cycleBusyRef.current = date;
    setCycleBusyDate(date);
    setCycleShortcutError(null);
    onStarted?.();
    try {
      if (!cycleModule.config.enabled) await onSaveCycleConfig({ ...cycleModule.config, enabled: true });
      if (existing === undefined) await onAddCycleModuleEvent(date, kind);
      else await onDeleteCycleModuleEvent(existing.id);
      return true;
    } catch (cause) {
      setCycleShortcutError(errorMessage(cause, "周期记录保存失败，请重试"));
      return false;
    } finally {
      cycleBusyRef.current = null;
      setCycleBusyDate(null);
    }
  };
  const replaceMobileCycleDraft = (draft: MobileCycleDraft | null) => {
    mobileCycleDraftRef.current = draft;
    setMobileCycleDraft(draft);
  };
  const isConflictError = (error: unknown) => typeof error === "object" && error !== null && "status" in error
    && (error as { readonly status?: unknown }).status === 409;
  const toggleMobileCycleKind = (kind: MobileCycleKind) => {
    if (mobileCycleBusyRef.current || cycleBusyRef.current !== null) return;
    const current = mobileCycleDraftRef.current;
    if (current === null) return;
    const kinds = MOBILE_CYCLE_EVENT_KINDS.map((item) => item.kind).filter((candidate) => candidate === kind
      ? !current.kinds.includes(candidate)
      : current.kinds.includes(candidate));
    const generation = mobileCycleGenerationRef.current;
    mobileCycleBusyRef.current = true;
    setMobileCycleBusy(true);
    setMobileCyclePendingKind(kind);
    setMobileCycleError(null);
    void onSaveMobileCycleDay(current.date, kinds, current.revision).then((result) => {
      if (!mobileCycleOpenRef.current || mobileCycleGenerationRef.current !== generation) return;
      const module = { ...result.module, eventRevision: result.eventRevision };
      const liveDate = mobileCycleDateRef.current;
      replaceMobileCycleDraft(mobileCycleDraftForDate(liveDate, module));
      setMobileCycleError(null);
    }).catch((caught: unknown) => {
      if (!mobileCycleOpenRef.current || mobileCycleGenerationRef.current !== generation) return;
      const message = errorMessage(caught, "周期记录保存失败，请重试");
      setMobileCycleError({ message: current.date === mobileCycleDateRef.current ? message : `${displayDate(current.date)}保存失败：${message}`, conflict: isConflictError(caught) });
    }).finally(() => {
      mobileCycleBusyRef.current = false;
      setMobileCycleBusy(false);
      setMobileCyclePendingKind(null);
    });
  };
  const openMobileCycleSettings = () => {
    if (mobileCycleBusyRef.current) return;
    onOpenCycleSettings();
  };
  const reloadMobileCycleDay = async () => {
    if (mobileCycleBusyRef.current) return;
    const generation = mobileCycleGenerationRef.current;
    const date = mobileCycleDraftRef.current?.date ?? mobileCycleDateRef.current;
    mobileCycleBusyRef.current = true;
    setMobileCycleBusy(true);
    setMobileCycleError(null);
    try {
      const module = await onReloadCycleModule();
      if (mobileCycleOpenRef.current && mobileCycleGenerationRef.current === generation) {
        const liveDate = mobileCycleDraftRef.current?.date ?? date;
        mobileCycleDateRef.current = liveDate;
        setMobileCycleDate(liveDate);
        replaceMobileCycleDraft(mobileCycleDraftForDate(liveDate, module));
      }
    } catch (caught) {
      if (mobileCycleOpenRef.current && mobileCycleGenerationRef.current === generation) {
        setMobileCycleError({ message: errorMessage(caught, "周期记录读取失败，请重试"), conflict: false });
      }
    } finally {
      mobileCycleBusyRef.current = false;
      setMobileCycleBusy(false);
    }
  };
  const pickMobileCycleDate = (date: string) => {
    mobileCycleDateRef.current = date;
    setMobileCycleDate(date);
    setMobileCycleError(null);
    replaceMobileCycleDraft(cycleModule === null ? null : mobileCycleDraftForDate(date, cycleModule));
  };
  const toggleWeatherIcons = () => setWeatherIconsEnabled((current) => {
    const next = !current;
    try { window.localStorage.setItem(MOBILE_CYCLE_WEATHER_KEY, next ? "1" : "0"); } catch { /* The default remains off when storage is unavailable. */ }
    return next;
  });
  const onCalendarDayClick = (date: string) => {
    if (date > today) return;
    pickMobileCycleDate(date);
    if (mobileCyclePanelVisible) {
      return;
    }
    onOpenDay(date);
  };
  // An editable field cannot live inside a <button>, so in edit mode the cell
  // renders as a plain container: same box, no navigation, one editable line.
  const CellTag = (editable ? "div" : "button") as "button";
  const draftCount = drafts.size;
  /**
   * How a day's summary is shown. Derived text is stripped of markers and
   * punctuation — that noise comes from records, not from a person. Text the
   * owner typed in edit mode is shown exactly as typed: if the box rewrote
   * 「风很大，走了很久」 into 「风很大走了很久」 the save would look like a loss.
   */
  const summaryDisplay = (summary: DaySummary): string =>
    summary.status === "manual" ? clampSummaryText(summary.text, SUMMARY_MAX_LENGTH) : trimSummaryText(summary.text, SUMMARY_MAX_LENGTH);
  /** What a field shows: the unsaved draft if there is one, otherwise the stored text. */
  const summaryValue = (date: string, summary: DaySummary | undefined): string =>
    drafts.get(date) ?? (summary === undefined ? "" : summaryDisplay(summary));
  const publicRecords = useMemo(() => (records ?? []).filter((record) => record.isPrivate !== true && (mode !== "month" || record.kind !== "task")), [records, mode]);
  // Include prev-week dates so the quiet row below is not an empty shell.
  const buckets = useMemo(
    () => recordsByDate(prevDates.length > 0 ? [...dates, ...prevDates] : dates, publicRecords),
    [dates, prevDates, publicRecords],
  );
  const inWindow = [...buckets.values()].reduce((total, items) => total + items.length, 0);
  const rangeStart = dates[0] ?? anchor;
  const rangeEnd = dates[6] ?? anchor;
  const label = mode === "week" ? `${rangeStart.slice(5).replace("-", "")}-${rangeEnd.slice(5).replace("-", "")}` : monthTitle(anchor);
  const rangeAriaLabel = mode === "week" ? `当前周：${displayDate(rangeStart)}至${displayDate(rangeEnd)}` : `当前月：${monthTitle(anchor)}`;
  // One observer supplies actual desktop/mobile cell ratios; resize reuses analysis.
  const monthGridRef = useRef<HTMLDivElement>(null);
  const [photoAspects, setPhotoAspects] = useState<Readonly<Record<string, number>>>({});
  useLayoutEffect(() => {
    if (mode !== "month" || monthGridRef.current === null) return;
    const cells = [...monthGridRef.current.querySelectorAll<HTMLElement>(".month-cell[data-date]")];
    const update = () => {
      const next: Record<string, number> = {};
      for (const cell of cells) {
        const width = cell.clientWidth, height = cell.clientHeight;
        if (width > 0 && height > 0 && cell.dataset.date) next[cell.dataset.date] = Math.round(width / height * 50) / 50;
      }
      setPhotoAspects((previous) => Object.keys(next).length === Object.keys(previous).length && Object.keys(next).every((date) => previous[date] === next[date]) ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    cells.forEach((cell) => observer?.observe(cell));
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [mode, dates, loading, error]);
  const hold = useCalendarHold(backgroundScope + "|" + mode + "|" + anchor + "|" + editable, (date, x, y) => {
    if (cyclePanelOpen) onCloseCycleModule();
    pickMobileCycleDate(date);
    setSummaryMenu({ date, x, y, marksOnly: true });
  });
  const markList = (menu: boolean) => <>
    <MobileCycleEntryPanel date={mobileCycleDate} draft={mobileCycleDraft} busy={mobileCycleBusy || cycleBusyDate !== null || mobileCycleDate > today} pendingKind={mobileCyclePendingKind} error={mobileCycleError?.message ?? cycleShortcutError} conflict={mobileCycleError?.conflict === true} onSelect={toggleMobileCycleKind} onReload={() => { void reloadMobileCycleDay(); }} onOpenSettings={openMobileCycleSettings} fitnessMarked={cycleModule?.events.some(event => event.date === mobileCycleDate && event.kind === "fitness") === true} onToggleFitness={() => { if (!mobileCycleBusyRef.current) void toggleCycleOn(mobileCycleDate, "fitness"); }} menu={menu} />
    <CustomHabitPanel compact menu={menu} disabled={mobileCycleBusy || cycleBusyDate !== null} habits={(cycleModule?.config.habits ?? []).slice(0, Math.max(0, 5 - CYCLE_EVENT_KINDS.length))} date={mobileCycleDate} today={today} actions={{ ...habitActions, mark: async (habit, date, marked) => { if (cycleBusyRef.current !== null || mobileCycleBusyRef.current) return; cycleBusyRef.current = date; setCycleBusyDate(date); try { await habitActions.mark(habit, date, marked); } finally { cycleBusyRef.current = null; setCycleBusyDate(null); } } }} />
    <div className="cycle-more-settings-group"><button className="cycle-mobile-action cycle-more-settings" type="button" role={menu ? "menuitem" : undefined} disabled={mobileCycleBusy || cycleBusyDate !== null} onClick={() => { setSummaryMenu(null); onCloseCycleModule(); openMobileCycleSettings(); }}><span className="cycle-checkbox-slot" aria-hidden="true" /><Settings className="cycle-mobile-action-icon" size={16} aria-hidden="true" /><span className="cycle-mobile-action-label">更多设置</span></button></div>
  </>;
  return <section className="calendar-section" aria-labelledby="calendar-title" data-date-art-palette={dateArtPreferences.scheme} data-date-art-desktop-layout={dateArtPreferences.desktopLayout} data-date-art-mobile-layout={dateArtPreferences.mobileLayout} style={dateArtStyle} onPointerDown={event => { hold.begin(event); beginCalendarSwipe(event); }} onPointerMove={event => { hold.move(event); if (!hold.consumed) trackCalendarSwipe(event); }} onPointerUp={event => { hold.end(event); finishCalendarSwipe(event); }} onPointerCancel={event => { hold.cancel(); cancelCalendarSwipe(event); }} onClickCapture={event => { if (!hold.consumeClick(event)) suppressSwipeClick(event); }}>
    <div className="section-heading calendar-section-heading">
      <div className="calendar-heading-primary">
        <div className="calendar-range-navigation" role="group" aria-label={rangeAriaLabel}>
          <button className="calendar-range-step" type="button" onClick={() => onStep(-1)} aria-label={mode === "week" ? "上一周" : "上个月"}><ChevronLeft size={17} strokeWidth={2} aria-hidden="true" /></button>
          <h2 id="calendar-title" className="calendar-range-label">{label}</h2>
          <button className="calendar-range-step" type="button" onClick={() => onStep(1)} aria-label={mode === "week" ? "下一周" : "下个月"}><ChevronRight size={17} strokeWidth={2} aria-hidden="true" /></button>
        </div>
      </div>
      <div className="calendar-heading-tools">
        {records !== null ? <span className="record-count">{inWindow} 条</span> : null}
        <button className={`calendar-module-button ${cyclePanelOpen || cycleModule?.config.enabled ? "is-enabled" : ""}`} type="button" onClick={() => { setSummaryMenu(null); void onOpenCycleModule(); }} aria-expanded={cyclePanelOpen} aria-controls="cycle-entry-panel" aria-label="打开周期记录面板" aria-haspopup="menu">
          <CalendarDays size={15} strokeWidth={1.9} aria-hidden="true" /><span>周期</span>
        </button>
        <button className="calendar-module-button cycle-mobile-weather-toggle" type="button" onClick={toggleWeatherIcons} aria-pressed={weatherIconsEnabled} aria-label={weatherIconsEnabled ? "隐藏日历天气图标" : "显示日历天气图标"}>
          <CloudSun size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <button className={`calendar-module-button calendar-gear-button ${settingsOpen ? "is-enabled" : ""}`} type="button" onClick={onToggleSettings} aria-expanded={settingsOpen} aria-controls="calendar-settings-panel" aria-label="打开日历设置" title="日历设置">
          <Settings size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
        {/* A week card has no summary line at all, so the pencil lives in the month view only. */}
        {mode === "month" ? <button className={`calendar-module-button calendar-edit-button ${editable ? "is-enabled" : ""}`} type="button" onClick={() => onEditModeChange(!editable)} aria-pressed={editable} aria-label={editable ? "退出编辑模式" : "进入编辑模式"} title={editable ? "退出编辑模式（未保存的改动会先存下）" : "编辑模式：就地改每一天的小结"}>
          <Pencil size={15} strokeWidth={1.9} aria-hidden="true" />
        </button> : null}
        <div className="mode-switcher" role="tablist" aria-label="日历范围">
          <button className={`mode-option ${mode === "week" ? "is-active" : ""}`} type="button" role="tab" aria-selected={mode === "week"} onClick={() => onModeChange("week")}>周</button>
          <button className={`mode-option ${mode === "month" ? "is-active" : ""}`} type="button" role="tab" aria-selected={mode === "month"} onClick={() => onModeChange("month")}>月</button>
        </div>
      </div>
    </div>
    {cyclePanelOpen ? <div ref={cyclePopoverRef} id="cycle-entry-panel" className="calendar-cycle-popover cycle-entry-compact cycle-quick-list" role="menu" aria-label={`给${displayDate(mobileCycleDate)}标记`} style={cyclePopoverStyle ?? { left: 8, top: 8 }} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
      {markList(true)}
    </div> : null}
    {settingsOpen ? <CalendarSettingsPanel statusState={aiStatusState} onStatusChange={onAiStatusChange} onRetry={onRetryAiStatus} onClose={onToggleSettings} dateArtPreferences={dateArtPreferences} onDateArtChange={updateDateArtPreferences} backgroundMonth={anchor.slice(0, 7)} hideDemo={hideDemo} backgroundScope={backgroundScope} /> : null}
    {editable ? <div className="calendar-edit-bar" role="status">
      <span className="calendar-edit-hint"><Edit3 size={14} strokeWidth={1.9} aria-hidden="true" /><span>{draftCount === 0 ? "点小结就能改；右键某一天还有更多操作" : `${draftCount} 处改动待保存`}</span></span>
      <span className="calendar-edit-actions">
        <button className="secondary-button" type="button" disabled={draftCount === 0 || summarySaving} onClick={onDiscardDrafts}>放弃</button>
        <button className="primary-button" type="button" disabled={draftCount === 0 || summarySaving} onClick={onSaveDrafts}>{summarySaving ? "保存中…" : "保存"}</button>
      </span>
    </div> : null}
    {loading && records === null ? <span role="status" className="record-count">正在读取日历…</span> : null}
    {error ? <ErrorState message={error} onRetry={onRetry} /> : null}
    {(mode === "week" ? <>
      <div className="week-grid">
      {dates.map((date) => {
        const items = buckets.get(date) ?? [];
        const photoIds = presentations.get(date)?.weekPhotos ?? [];
        const highlights = weekCardRecords(items).filter(record => recordText(record).trim());
        const weather = weatherByDate.get(date);
        const weatherBadge = weatherIconsEnabled && weather !== undefined ? <span className="calendar-day-weather-icon" aria-label={`天气：${weather.text}，${weather.tempMin}到${weather.tempMax}摄氏度`} title={`天气：${weather.text}`}><span aria-hidden="true">{getWeatherEmoji(weather.icon)}</span></span> : null;
        const picked = mobileCyclePanelVisible && date === mobileCycleDate;
        // No summary line on a week card at all: the day grid is where text lives.
        // Right-click still works here, but it only offers the cycle shortcuts.
        const markerLabels = [...cycleMarkerLabelsForDate(date, today, cycleModule), ...(cycleModule?.config.habits ?? []).filter(habit => habit.dates.includes(date)).map(habit => habit.name)];
        return <CellTag className={`week-card ${date === today ? "is-today" : ""} ${picked ? "is-picked" : ""} ${weatherBadge === null ? "" : "has-weather-icons"} ${photoIds.length === 0 ? "has-date-art" : ""} ${date > today ? "is-future" : ""}`} data-date={date} key={date} type="button" aria-disabled={date > today ? true : undefined} tabIndex={date > today ? -1 : undefined} onClick={() => onCalendarDayClick(date)} onContextMenu={(event: ReactMouseEvent) => { if (!hold.contextMenu(event)) openSummaryMenu(date, event); }} aria-label={`${displayDate(date)}，${items.length} 条记录${picked ? "，已选为周期记录日期" : ""}${markerLabels.length > 0 ? `，${markerLabels.join("，")}` : ""}`}>
          <span className="week-card-head"><span className="week-card-weekday">{weekdayShort(date)}</span><span className="week-card-day">{Number(date.slice(8, 10))}</span></span>
          {weatherBadge}
          <span className="week-card-body">
            {highlights.map((record) => <span className="week-card-line" key={record.id}><span className="week-card-time">{lifeTimeTime(record.occurredAt ?? record.createdAt)}</span><span className="week-card-text">{recordText(record)}</span></span>)}
          </span>
          <span className="week-card-foot">{items.length === 0 ? null : `${items.length} 条`}</span>
          <CalendarDayMarkers date={date} today={today} module={cycleModule} />
          {photoIds.length > 0 ? <span className={`week-card-art bands-${photoIds.length}`} aria-hidden="true">
            {photoIds.map((photo, index) => <span className="week-card-band" key={`${photo.assetId}-${index}`} style={{ "--week-art-index": index, "--week-art-count": photoIds.length, "--week-art-offset": `${(index * 100) / photoIds.length}%`, "--week-art-size": `${100 / photoIds.length}%` } as CSSProperties}>
              <img src={calendarPhotoUrl(photo)} alt="" loading="eager" decoding="async" />
            </span>)}
            <span className="week-card-veil" />
          </span> : <WeekDateArt date={date} showGlyph={items.length === 0} />}
        </CellTag>;
      })}
      </div>
      {prevDates.length > 0 ? <div className="week-grid week-grid-prev" aria-label="上一周">
        {prevDates.map((date) => {
          const items = buckets.get(date) ?? [];
          const photoIds = presentations.get(date)?.weekPhotos ?? [];
          const weather = weatherByDate.get(date);
          const weatherBadge = weatherIconsEnabled && weather !== undefined ? <span className="calendar-day-weather-icon" aria-label={`天气：${weather.text}，${weather.tempMin}到${weather.tempMax}摄氏度`} title={`天气：${weather.text}`}><span aria-hidden="true">{getWeatherEmoji(weather.icon)}</span></span> : null;
          // 上一周只留两条，整排比本周短一截。
          const highlights = weekCardRecords(items).filter(record => recordText(record).trim()).slice(0, 2);
          return <CellTag className={`week-card is-prev ${date === today ? "is-today" : ""} ${weatherBadge === null ? "" : "has-weather-icons"} ${photoIds.length === 0 ? "has-date-art" : ""} ${date > today ? "is-future" : ""}`} data-date={date} key={`prev-${date}`} type="button" aria-disabled={date > today ? true : undefined} tabIndex={date > today ? -1 : undefined} onClick={() => onCalendarDayClick(date)} aria-label={`上一周 ${displayDate(date)}，${items.length} 条记录`}>
            <span className="week-card-head"><span className="week-card-weekday">{weekdayShort(date)}</span><span className="week-card-day">{Number(date.slice(8, 10))}</span></span>
            {weatherBadge}
            <span className="week-card-body">
              {highlights.map((record) => <span className="week-card-line" key={record.id}><span className="week-card-time">{lifeTimeTime(record.occurredAt ?? record.createdAt)}</span><span className="week-card-text">{recordText(record)}</span></span>)}
            </span>
            <span className="week-card-foot">{items.length === 0 ? null : `${items.length} 条`}</span>
            {photoIds.length > 0 ? <span className={`week-card-art bands-${photoIds.length}`} aria-hidden="true">
              {photoIds.map((photo, index) => <span className="week-card-band" key={`prev-${photo.assetId}-${index}`} style={{ "--week-art-index": index, "--week-art-count": photoIds.length, "--week-art-offset": `${(index * 100) / photoIds.length}%`, "--week-art-size": `${100 / photoIds.length}%` } as CSSProperties}>
                <img src={calendarPhotoUrl(photo)} alt="" loading="eager" decoding="async" />
              </span>)}
              <span className="week-card-veil" />
            </span> : <WeekDateArt date={date} showGlyph={items.length === 0} />}
          </CellTag>;
        })}
      </div> : null}
    </> : <div className="month-grid" ref={monthGridRef}>
      {WEEKDAY_LABELS.map((label) => <span className="month-weekday" key={label}>{label}</span>)}
      {dates.map((date) => {
        const items = buckets.get(date) ?? [];
        const reminders = calendarTasksForDate(tasks, date);
        const summary = summaries.get(date);
        const weather = weatherByDate.get(date);
        const dayInfo = calendarDayInfo(date);
        const inMonth = date.slice(0, 7) === anchor.slice(0, 7);
        // Future cards may show planned content, but never open a day.
        const future = date > today;
        const aspect = photoAspects[date] ?? 1;
        const presentation = inMonth ? presentations.get(date) : undefined;
        const cellPhoto = presentation?.monthPhoto;
        const cover = calendarCoverForAspect(presentation, aspect);
        const dateDay = Number(date.slice(8, 10));
        const dateArtNames = calendarDateGlyphNames(dateDay);
        const hasDateArt = inMonth && cellPhoto === undefined && dateArtNames.length > 0;
        const dateArtTone = CALENDAR_DATE_ART_TONE_BY_DAY[dateDay - 1];
        const summaryText = summary === undefined ? "" : summaryDisplay(summary);
        const showDateGlyph = items.length === 0 && reminders.length === 0 && summaryValue(date, summary).trim() === "";
        const holidayLabel = dayInfo.holiday === undefined ? "" : `${dayInfo.holiday.name}，${dayInfo.holiday.kind === "holiday" ? "休息日" : "调休上班"}`;
        const weatherLabel = weather === undefined ? "" : `天气：${weather.text}，${weather.tempMin}~${weather.tempMax}°C`;
        const markerLabels = [...cycleMarkerLabelsForDate(date, today, cycleModule), ...(cycleModule?.config.habits ?? []).filter(habit => habit.dates.includes(date)).map(habit => habit.name)];
        const titleParts = [holidayLabel, dayInfo.solarTerm ? `节气：${dayInfo.solarTerm}` : "", weatherLabel, summaryText === "" ? "" : `${summaryText}（${summary?.status === "generated" ? `AI，${summary?.provider}` : summary?.status === "manual" ? "手写" : "规则生成"}）`].filter(Boolean);
        const weatherBadge = weatherIconsEnabled && weather !== undefined ? <span className="calendar-day-weather-icon" aria-label={`天气：${weather.text}，${weather.tempMin}到${weather.tempMax}摄氏度`} title={`天气：${weather.text}`}><span aria-hidden="true">{getWeatherEmoji(weather.icon)}</span></span> : null;
        const picked = mobileCyclePanelVisible && date === mobileCycleDate;
        return <CellTag className={`month-cell ${future ? "is-future" : ""} ${inMonth ? "" : "is-outside"} ${date === today ? "is-today" : ""} ${picked ? "is-picked" : ""} ${items.length === 0 ? "is-empty" : ""} ${reminders.length > 0 ? "has-calendar-tasks" : ""} ${editable ? "is-editing" : ""} ${weatherBadge === null ? "" : "has-weather-icons"} ${hasDateArt ? "has-date-art" : ""} ${hasDateArt && dayInfo.holiday ? "has-date-art-status" : ""} ${hasDateArt && dayInfo.solarTerm ? "has-date-art-solar" : ""} ${hasDateArt && markerLabels.length > 0 ? "has-date-art-markers" : ""}`} data-date={date} data-date-art-tone={hasDateArt ? dateArtTone : undefined} data-date-art-glyph-count={hasDateArt && showDateGlyph ? dateArtNames.length : undefined} key={date} type={editable ? undefined : "button"} onClick={editable || future ? undefined : () => onCalendarDayClick(date)} onContextMenu={inMonth ? (event: ReactMouseEvent) => { if (!hold.contextMenu(event)) openSummaryMenu(date, event); } : undefined} aria-disabled={future ? true : undefined} tabIndex={future && !editable ? -1 : undefined} aria-label={`${displayDate(date)}，${items.length} 条记录，${reminders.length} 项待办${picked ? "，已选为周期记录日期" : ""}${markerLabels.length > 0 ? `，${markerLabels.join("，")}` : ""}${titleParts.length > 0 ? `，${titleParts.join("，")}` : ""}`}>
          {cellPhoto !== undefined ? <span className="month-cell-art" aria-hidden="true"><img src={calendarPhotoUrl(cellPhoto)} alt="" loading="eager" decoding="async" style={cover === undefined ? undefined : { objectPosition: cover.position }} data-cover-aspect={aspect} data-cover-score={cover?.score} data-cover-text-penalty={cover?.textPenalty} /><span className="month-cell-veil" /></span> : hasDateArt ? <span className="month-cell-art month-cell-date-art" data-date-art-background data-date-art-tone={dateArtTone} aria-hidden="true">{showDateGlyph ? <span className="calendar-date-art-safe-area"><CalendarDateGlyph day={dateDay} /></span> : null}<span className="month-cell-veil" data-date-art-veil /></span> : null}
          <span className="month-cell-head"><span className="month-day-number">{dateDay}</span><span className="month-day-meta">{reminders.length > 2 ? <span className="month-task-overflow" aria-label={`还有${reminders.length - 2}项待办`}>+{reminders.length - 2}</span> : null}{dayInfo.holiday ? <span className={`month-day-status is-${dayInfo.holiday.kind}`} aria-label={holidayLabel}>{dayInfo.holiday.kind === "holiday" ? "休" : "班"}</span> : null}{weatherBadge}</span></span>
          {/* Only existing public journals on today or earlier can be edited. */}
          {editable && inMonth && canEditDaySummary(date, today, items)
            ? <textarea className="summary-field month-day-summary-field" data-summary-date={date} value={summaryValue(date, summary)} maxLength={SUMMARY_MAX_LENGTH} rows={2} onChange={(event) => onDraftChange(date, event.target.value)} onContextMenu={(event) => { if (!hold.contextMenu(event)) openSummaryMenu(date, event); }} aria-label={`${displayDate(date)} 的小结`} />
            : <span className="month-cell-copy">{reminders.slice(0, 2).map(task => <span className="month-task-line" key={task.id} title={`${calendarTaskStatus(task)}：${recordText(task)}`} aria-label={`${calendarTaskStatus(task)}：${recordText(task)}`}><span className={`calendar-task-circle ${task.kind === "task" && task.task.status === "done" ? "is-done" : ""} ${task.kind === "task" && task.task.status === "in_progress" ? "is-progress" : ""}`} aria-hidden="true" /><span className="month-task-label">{calendarTaskText(task, taskLabels)}</span></span>)}{reminders.length < 2 && summaryText !== "" ? <span className={`month-day-summary ${reminders.length === 1 ? "has-task-sibling" : ""} ${summary?.status === "fallback" ? "is-fallback" : ""}`}>{summaryText}</span> : null}</span>}
          {dayInfo.solarTerm || markerLabels.length > 0 ? <span className="month-cell-footer">
            {dayInfo.solarTerm ? <span className="month-day-solar" aria-label={`节气：${dayInfo.solarTerm}`}>{dayInfo.solarTerm}</span> : null}
            {markerLabels.length > 0 ? <CalendarDayMarkers date={date} today={today} module={cycleModule} /> : null}
          </span> : null}
        </CellTag>;
      })}
    </div>)}
    {cycleShortcutError !== null && !mobileCyclePanelVisible ? <p className="cycle-inline-error calendar-cycle-error" role="alert">{cycleShortcutError}</p> : null}
    {summaryMenu?.marksOnly ? <div ref={holdMenuRef} className="calendar-hold-menu cycle-entry-compact" role="menu" aria-label={`给${displayDate(summaryMenu.date)}标记`} style={{ left: holdMenuPosition.x, top: holdMenuPosition.y }} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>{markList(true)}</div> : summaryMenu !== null ? <CalendarSummaryMenu key={JSON.stringify([summaryMenu.date, summaryMenu.x, summaryMenu.y])} x={summaryMenu.x} y={summaryMenu.y} monthMode={mode === "month"} summaryEditable={canEditDaySummary(summaryMenu.date, today, buckets.get(summaryMenu.date) ?? [])} habits={cycleModule?.config.habits ?? []} date={summaryMenu.date} onToggleHabit={habit => { void toggleHabitOn(summaryMenu.date, habit); }} busy={busyDate === summaryMenu.date || cycleBusyDate === summaryMenu.date} cycleReady={cycleModule !== null} cycleEnabled={cycleModule?.config.enabled === true} recordedKinds={new Set((cycleModule?.events ?? []).filter((event) => event.date === summaryMenu.date).map((event) => event.kind))} onEdit={() => editDaySummary(summaryMenu.date)} onRegenerate={() => { void onRegenerateSummary(summaryMenu.date); }} onRevert={() => { void onRevertSummary(summaryMenu.date); }} onToggleCycle={(kind) => { void toggleCycleOn(summaryMenu.date, kind); }} onPickCycle={(kind) => { closeSummaryMenu(); void toggleCycleOn(summaryMenu.date, kind); }} onClose={closeSummaryMenu} /> : null}
  </section>;
}

export function CycleModuleDialog({ open, module, onClose, onSaveConfig }: { open: boolean; module: CycleIntimacyModuleData | null; onClose: () => void; onSaveConfig: (config: CycleIntimacyModuleConfig) => Promise<void>; selectedDate?: string; onAddEvent?: (date: string, kind: CycleIntimacyEventKind) => Promise<void>; onDeleteEvent?: (id: string) => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<CycleIntimacyModuleConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (module) setDraft(module.config); }, [module]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && module && !dialog.open) dialog.showModal();
    if ((!open || !module) && dialog.open) dialog.close();
  }, [open, module]);
  if (!module || !draft) return <dialog ref={dialogRef} className="modal-dialog" />;
  const perform = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await operation(); } catch (caught) { setError(errorMessage(caught, "周期设置暂时无法保存，请重试")); } finally { setBusy(false); }
  };
  return <dialog ref={dialogRef} className="modal-dialog cycle-module-dialog" aria-labelledby="cycle-module-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="dialog-header"><div><p className="eyebrow">周期</p><h2 id="cycle-module-title">周期设置</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭周期设置"><X size={17} aria-hidden="true" /></button></div>
    <div className="dialog-body">
      <label className="cycle-enable"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => current ? { ...current, enabled: event.target.checked } : current)} /><span><strong>在日历中启用</strong><small>关闭后不显示月亮或爱心，已有私密记录会保留。</small></span></label>
      <div className="dialog-fields-grid">
        <label className="dialog-field"><span>经期间隔（两次开始相隔天数）</span><input type="number" min="15" max="90" value={draft.cycleLength} onChange={(event) => setDraft((current) => current ? { ...current, cycleLength: Number(event.target.value) } : current)} /></label>
        <label className="dialog-field"><span>预计持续天数</span><input type="number" min="1" max="21" value={draft.periodLength} onChange={(event) => setDraft((current) => current ? { ...current, periodLength: Number(event.target.value) } : current)} /></label>
      </div>
      <label className="dialog-field"><span>最近一次经期开始（可选）</span><input type="date" value={draft.anchorStart ?? ""} onChange={(event) => setDraft((current) => { if (!current) return current; const { anchorStart: _anchorStart, ...rest } = current; return event.target.value ? { ...rest, anchorStart: event.target.value } : rest; })} /></label>
      <p className="cycle-dialog-note">虚影月亮只表示按以上间隔推算的预计日期；确认开始或结束后，会以实心月亮覆盖它。</p>
      <div className="cycle-settings-actions"><button className="primary-button" type="button" onClick={() => void perform(() => onSaveConfig(draft))} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{busy ? "保存中" : "保存周期设置"}</span></button></div>
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
