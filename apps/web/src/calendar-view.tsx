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
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
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
  Send,
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
import { apiRequest, type AiStatus, type AiStatusState, type MovieEntity, type RecordView } from "./api";
import type { AppView, CalendarMode, ComposerKind, CreateEntity, SettingsPageId } from "./app-types";
import { calendarDayInfo } from "./calendarData";
import { peekScore, scorePhoto, storyWeight } from "./photoScore";
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
import { ErrorState, LoadingState } from "./timeline-states";
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
  assetThumbUrl,
  dayPhotoCandidates,
  dayPhotoIds,
  monthCellPhoto,
  nextPredictedStart,
  periodMoonForDate,
  recordsByDate,
  type CalendarMarker,
} from "./timeline";

function CalendarDayMarkers({ date, today, module }: { readonly date: string; readonly today: string; readonly module: CycleIntimacyModuleData | null }) {
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
 * Only two things live here: how the calendar's summaries are produced, and
 * whether its text is editable. The prompt is shown in full on purpose — it is
 * the one knob that changes what every cell says, and hiding it behind a rebuild
 * would make tuning it a code change.
 */
export function CalendarSettingsPanel({ statusState, onStatusChange, onRetry }: { statusState: AiStatusState; onStatusChange: (status: AiStatus) => void; onRetry: () => void }) {
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

  /** The key is write-only: it is sent only when a new one has been typed. */
  const body = () => JSON.stringify({ enabled, baseUrl, model, ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }) });
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
    setMessage({ text: saved.keyConfigured ? "已保存。回到日历，下一屏的小结就用新设置。" : "已保存。还没有密钥，暂时用离线规则兜底。", tone: "ok" });
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
  return <section id="calendar-settings-panel" className="calendar-settings-panel" aria-labelledby="calendar-settings-title">
    <div className="cycle-inline-head"><div><p className="eyebrow">日历设置</p><h3 id="calendar-settings-title">小结与提示词</h3></div>{custom ? <span className="calendar-settings-badge">自定义提示词</span> : null}</div>
    <div className="calendar-settings-block">
      <p className="eyebrow">AI 小结</p>
      <div className="calendar-settings-switch"><span>用 AI 生成小结<small>{statusReady ? keyConfigured ? "已配置密钥" : "还没有密钥，暂时用离线规则" : "状态确认后才能修改"}</small></span><button className={"toggle-button" + (enabled ? " is-on" : "")} type="button" role="switch" aria-checked={enabled} disabled={!statusReady} onClick={() => setEnabled(!enabled)} aria-label="用 AI 生成小结"><span className="toggle-knob" /></button></div>
      {statusState.phase === "failed" ? <div className="settings-config-read-error" role="alert"><span>{statusState.error}</span><button className="secondary-button" type="button" onClick={onRetry}>重试读取</button></div> : null}
      {status === null ? <p className="settings-config-unavailable">状态暂时不可读取；保存、测试和提示词调整已锁定。</p> : null}
      <div className="calendar-settings-grid">
        <label><span>服务地址</span><input value={baseUrl} disabled={!statusReady} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com" aria-label="AI 服务地址" /></label>
        <label><span>模型</span><input value={model} disabled={!statusReady} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-flash" aria-label="AI 模型" /></label>
        <label className="calendar-settings-wide"><span>API Key{keyConfigured ? "（留空则沿用已存的）" : ""}</span><input type="password" value={apiKey} disabled={!statusReady} onChange={(event) => setApiKey(event.target.value)} placeholder={keyConfigured ? "已保存，留空不修改" : "填入密钥"} aria-label="AI API Key" autoComplete="off" /></label>
      </div>
      <label className="calendar-settings-prompt"><span>给 AI 的提示词</span><textarea value={prompt} disabled={!statusReady} onChange={(event) => setPrompt(event.target.value)} rows={9} spellCheck={false} aria-label="给 AI 的提示词" /></label>
      <div className="calendar-settings-actions">
        <button className="primary-button" type="button" onClick={() => void save()} disabled={!statusReady || busy !== null}>{busy === "save" ? "保存中…" : "保存"}</button>
        <button className="secondary-button" type="button" onClick={() => void test()} disabled={!statusReady || busy !== null}>{busy === "test" ? "测试中…" : "测试连接"}</button>
        <button className="secondary-button" type="button" onClick={() => void resetPrompt()} disabled={!statusReady || busy !== null || !custom}>换回内置提示词</button>
      </div>
      {message !== null ? <p className={"settings-ai-note " + (message.tone === "bad" ? "settings-inline-error" : "settings-inline-success")} role="status">{message.text}</p> : null}
      <p className="settings-ai-note">密钥保存在这台机器的数据目录里（加密存放），不会随日历一起显示。</p>
    </div>
  </section>;
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

/**
 * The right-click menu on a day. It does not depend on edit mode: changing one
 * day's summary and marking a cycle event are both things you reach for from the
 * grid itself. Summaries only exist in the month grid, so the three summary items
 * are month-only; the cycle shortcuts are there in either view.
 */
export function CalendarSummaryMenu({ x, y, monthMode, busy, cycleEnabled, recordedKinds, onEdit, onRegenerate, onRevert, onToggleCycle, onPickCycle, onClose }: { x: number; y: number; monthMode: boolean; busy: boolean; cycleEnabled: boolean; recordedKinds: ReadonlySet<CycleIntimacyEventKind>; onEdit: () => void; onRegenerate: () => void; onRevert: () => void; onToggleCycle: (kind: CycleIntimacyEventKind) => void; onPickCycle: (kind: CycleIntimacyEventKind) => void; onClose: () => void }) {
  const [cycleOpen, setCycleOpen] = useState(false);
  /** Near the right edge the submenu would fall off screen, so it opens leftwards. */
  const flip = x > window.innerWidth - 380;
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);
  return <div className="calendar-summary-menu" role="menu" aria-label="日历操作" style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    {/* Picking an action dismisses the menu. The window listener cannot do it:
        a click inside the panel stops its `pointerdown` from reaching the window.
        The cycle items are the exception — the menu stays up, so two things can be
        marked on the same day without right-clicking again. */}
    {monthMode ? <button role="menuitem" type="button" onClick={() => { onClose(); onEdit(); }}><Pencil size={14} strokeWidth={1.9} aria-hidden="true" /><span>编辑小结</span></button> : null}
    {monthMode ? <button role="menuitem" type="button" disabled={busy} onClick={() => { onClose(); onRegenerate(); }}><RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" /><span>AI 重新生成小结</span></button> : null}
    {monthMode ? <button role="menuitem" type="button" disabled={busy} onClick={() => { onClose(); onRevert(); }}><Eraser size={14} strokeWidth={1.9} aria-hidden="true" /><span>恢复原样</span></button> : null}
    <div className="calendar-summary-submenu-host" onMouseEnter={() => setCycleOpen(true)} onMouseLeave={() => setCycleOpen(false)}>
      <button role="menuitem" type="button" aria-haspopup="menu" aria-expanded={cycleOpen} className={cycleOpen ? "is-open" : ""} onClick={() => setCycleOpen(true)}><CalendarDays size={14} strokeWidth={1.9} aria-hidden="true" /><span>周期</span><ChevronRight className="calendar-summary-caret" size={14} strokeWidth={1.9} aria-hidden="true" /></button>
      {cycleOpen ? <div className={`calendar-summary-submenu ${flip ? "is-flipped" : ""}`} role="menu" aria-label="周期">
        {/* Two click targets per row on purpose. The box is the multi-select half —
            tick several marks in a row without the menu getting in the way — while
            the label is the single-select half: pick this one thing and be done, so
            the menu closes behind it. */}
        {CYCLE_EVENT_KINDS.map((item) => {
          const on = recordedKinds.has(item.kind);
          const off = busy || !cycleEnabled;
          return <div className="calendar-summary-cycle-row" role="none" key={item.kind}>
            <button className={`calendar-summary-checkbox ${on ? "is-checked" : ""}`} type="button" role="menuitemcheckbox" aria-checked={on} disabled={off} aria-label={`多选：${on ? "移除" : "记录"}${item.label}`} onClick={() => onToggleCycle(item.kind)}>{on ? <Check size={11} strokeWidth={2.6} aria-hidden="true" /> : null}</button>
            <button className="calendar-summary-cycle-label" type="button" role="menuitem" disabled={off} aria-label={`${on ? "移除" : "记录"}${item.label}，并关闭菜单`} onClick={() => onPickCycle(item.kind)}>{item.label}</button>
          </div>;
        })}
      </div> : null}
    </div>
    <button role="menuitem" type="button" onClick={onClose}><X size={14} strokeWidth={1.9} aria-hidden="true" /><span>取消</span></button>
  </div>;
}

export function CalendarView({ mode, onModeChange, onStep, onOpenBackfill, anchor, today, records, assets, summaries, aiEnabled, weatherByDate, loading, error, cycleModule, cyclePanelOpen, onOpenCycleModule, onOpenCycleSettings, onAddCycleModuleEvent, onDeleteCycleModuleEvent, onSavePeriodLength, onRetry, onOpenDay, settingsOpen, onToggleSettings, aiStatusState, onAiStatusChange, onRetryAiStatus, editMode, onEditModeChange, drafts, onDraftChange, summarySaving, onSaveDrafts, onDiscardDrafts, onRegenerateSummary, onRevertSummary, busyDate }: { mode: CalendarMode; onModeChange: (mode: CalendarMode) => void; onStep: (direction: number) => void; onOpenBackfill: () => void; anchor: string; today: string; records: readonly RecordView[] | null; assets: readonly Asset[]; summaries: ReadonlyMap<string, DaySummary>; aiEnabled: boolean; weatherByDate: ReadonlyMap<string, CalendarWeather>; loading: boolean; error: string | null; cycleModule: CycleIntimacyModuleData | null; cyclePanelOpen: boolean; onOpenCycleModule: () => void; onOpenCycleSettings: () => void; onAddCycleModuleEvent: (date: string, kind: CycleIntimacyEventKind) => Promise<void>; onDeleteCycleModuleEvent: (id: string) => Promise<void>; onSavePeriodLength: (days: number) => Promise<void>; onRetry: () => void; onOpenDay: (date: string) => void; settingsOpen: boolean; onToggleSettings: () => void; aiStatusState: AiStatusState; onAiStatusChange: (status: AiStatus) => void; onRetryAiStatus: () => void; editMode: boolean; onEditModeChange: (value: boolean) => void; drafts: ReadonlyMap<string, string>; onDraftChange: (date: string, text: string) => void; summarySaving: boolean; onSaveDrafts: () => void; onDiscardDrafts: () => void; onRegenerateSummary: (date: string) => Promise<void>; onRevertSummary: (date: string) => Promise<void>; busyDate: string | null }) {
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
  // Editing lives in the calendar, so the only state it needs of its own is where
  // the right-click menu sits and which day asked for the caret; the drafts are
  // owned above, because saving them is one request and the count has to survive
  // a re-render.
  const [summaryMenu, setSummaryMenu] = useState<{ date: string; x: number; y: number } | null>(null);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [cycleBusyDate, setCycleBusyDate] = useState<string | null>(null);
  // A horizontal touch gesture is a view-level shortcut. Keep it deliberately
  // conservative: interactive controls retain their native click behaviour,
  // while a clear swipe on the calendar surface toggles between the two views.
  const swipeRef = useRef<{ pointerId: number; startX: number; startY: number; horizontal: boolean; consumed: boolean } | null>(null);
  const beginCalendarSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return;
    const target = event.target as Element | null;
    const control = target?.closest("button, a, input, textarea, select, [contenteditable=\"true\"]");
    // Calendar cells happen to be buttons for keyboard navigation. They are the
    // primary surface people swipe on, so only exempt the other interactive
    // controls; the captured synthetic click below protects a real swipe from
    // also opening that day.
    if (control !== null && control !== undefined && !control.matches(".week-card, .month-cell")) return;
    swipeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, horizontal: false, consumed: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const trackCalendarSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (swipe === null || swipe.pointerId !== event.pointerId) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.25) swipe.horizontal = true;
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // Keep the consumed bit through the synthetic click generated by a touch
    // release, so a swipe never also opens a day.
    window.setTimeout(() => { if (swipeRef.current === swipe) swipeRef.current = null; }, 0);
  };
  const cancelCalendarSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    const swipe = swipeRef.current;
    if (swipe?.pointerId === event.pointerId && !swipe.consumed) swipeRef.current = null;
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
    setSummaryMenu({ date, x: event.clientX, y: event.clientY });
  };
  /** 「编辑小结」does not hunt for the day: it opens edit mode already on that one. */
  const editDaySummary = (date: string) => { setFocusDate(date); onEditModeChange(true); };
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
  /** The cycle submenu marks the day it was opened on, exactly like the panel's buttons. */
  const toggleCycleOn = async (date: string, kind: CycleIntimacyEventKind) => {
    const existing = (cycleModule?.events ?? []).find((event) => event.date === date && event.kind === kind);
    setCycleBusyDate(date);
    try {
      if (existing === undefined) await onAddCycleModuleEvent(date, kind);
      else await onDeleteCycleModuleEvent(existing.id);
    } finally {
      setCycleBusyDate(null);
    }
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
  const publicRecords = useMemo(() => (records ?? []).filter((record) => record.isPrivate !== true), [records]);
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
        for (const candidate of dayPhotoCandidates(buckets.get(date) ?? [], assets)) {
          await scorePhoto(assetThumbUrl(candidate.assetId, 1200));
          if (cancelled) return;
          setPhotoTick((tick) => tick + 1);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [mode, dates, buckets, assets]);
  return <section className="calendar-section" aria-labelledby="calendar-title" onPointerDown={beginCalendarSwipe} onPointerMove={trackCalendarSwipe} onPointerUp={finishCalendarSwipe} onPointerCancel={cancelCalendarSwipe} onClickCapture={suppressSwipeClick}>
    <div className="section-heading calendar-section-heading">
      <div className="calendar-heading-primary">
        <div className="calendar-range-navigation" role="group" aria-label={rangeAriaLabel}>
          <button className="calendar-range-step" type="button" onClick={() => onStep(-1)} aria-label={mode === "week" ? "上一周" : "上个月"}><ChevronLeft size={17} strokeWidth={2} aria-hidden="true" /></button>
          <h2 id="calendar-title" className="calendar-range-label">{label}</h2>
          <button className="calendar-range-step" type="button" onClick={() => onStep(1)} aria-label={mode === "week" ? "下一周" : "下个月"}><ChevronRight size={17} strokeWidth={2} aria-hidden="true" /></button>
        </div>
        <button className="calendar-module-button calendar-backfill-button" type="button" onClick={onOpenBackfill} aria-label="补记一条记录"><Send size={15} strokeWidth={1.9} aria-hidden="true" /><span>补记</span></button>
      </div>
      <div className="calendar-heading-tools">
        {records !== null ? <span className="record-count">{inWindow} 条</span> : null}
        <button className={`calendar-module-button ${cyclePanelOpen || cycleModule?.config.enabled ? "is-enabled" : ""}`} type="button" onClick={onOpenCycleModule} aria-expanded={cyclePanelOpen} aria-controls="cycle-entry-panel" aria-label="打开周期记录面板">
          <CalendarDays size={15} strokeWidth={1.9} aria-hidden="true" /><span>周期</span>
        </button>
        <button className={`calendar-module-button calendar-gear-button ${settingsOpen ? "is-enabled" : ""}`} type="button" onClick={onToggleSettings} aria-expanded={settingsOpen} aria-controls="calendar-settings-panel" aria-label="打开日历设置" title="日历设置：AI 小结与编辑模式">
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
    {mode === "month" ? <div className="calendar-note"><span className="calendar-holiday-legend"><span className="month-day-status is-holiday">休</span><span>法定休息</span><span className="month-day-status is-workday">班</span><span>调休上班</span></span></div> : null}
    {cyclePanelOpen ? <CycleModulePanel module={cycleModule} selectedDate={anchor} today={today} onOpenSettings={onOpenCycleSettings} onAddEvent={onAddCycleModuleEvent} onDeleteEvent={onDeleteCycleModuleEvent} onSavePeriodLength={onSavePeriodLength} /> : null}
    {settingsOpen ? <CalendarSettingsPanel statusState={aiStatusState} onStatusChange={onAiStatusChange} onRetry={onRetryAiStatus} /> : null}
    {editable ? <div className="calendar-edit-bar" role="status">
      <span className="calendar-edit-hint"><Edit3 size={14} strokeWidth={1.9} aria-hidden="true" /><span>{draftCount === 0 ? "点小结就能改；右键某一天还有更多操作" : `${draftCount} 处改动待保存`}</span></span>
      <span className="calendar-edit-actions">
        <button className="secondary-button" type="button" disabled={draftCount === 0 || summarySaving} onClick={onDiscardDrafts}>放弃</button>
        <button className="primary-button" type="button" disabled={draftCount === 0 || summarySaving} onClick={onSaveDrafts}>{summarySaving ? "保存中…" : "保存"}</button>
      </span>
    </div> : null}
    {loading ? <LoadingState /> : null}
    {!loading && error ? <ErrorState message={error} onRetry={onRetry} /> : null}
    {!loading && !error ? (mode === "week" ? <>
      <div className="week-grid">
      {dates.map((date) => {
        const items = buckets.get(date) ?? [];
        const photoIds = dayPhotoIds(items, assets);
        const highlights = weekCardRecords(items);
        const picked = cyclePanelOpen && date === anchor;
        // No summary line on a week card at all: the day grid is where text lives.
        // Right-click still works here, but it only offers the cycle shortcuts.
        return <CellTag className={`week-card ${date === today ? "is-today" : ""} ${picked ? "is-picked" : ""}`} key={date} type="button" onClick={() => onOpenDay(date)} onContextMenu={(event: ReactMouseEvent) => openSummaryMenu(date, event)} aria-label={`${displayDate(date)}，${items.length} 条记录${picked ? "，已选为周期记录日期" : ""}`}>
          <span className="week-card-head"><span className="week-card-weekday">{weekdayShort(date)}</span><span className="week-card-day">{Number(date.slice(8, 10))}</span></span>
          <span className="week-card-body">
            {items.length === 0 ? <span className="week-card-empty">没有记录</span> : highlights.map((record) => <span className="week-card-line" key={record.id}><span className="week-card-time">{lifeTimeTime(record.occurredAt ?? record.createdAt)}</span><span className="week-card-text">{recordText(record)}</span></span>)}
          </span>
          <span className="week-card-foot">{items.length === 0 ? "—" : `${items.length} 条`}</span>
          <CalendarDayMarkers date={date} today={today} module={cycleModule} />
          {photoIds.length > 0 ? <span className={`week-card-art bands-${photoIds.length}`} aria-hidden="true">
            {photoIds.map((assetId, index) => <span className="week-card-band" key={`${assetId}-${index}`} style={{ "--week-art-index": index, "--week-art-count": photoIds.length, "--week-art-offset": `${(index * 100) / photoIds.length}%`, "--week-art-size": `${100 / photoIds.length}%` } as CSSProperties}>
              <img src={assetThumbUrl(assetId, 1200)} alt="" loading="lazy" decoding="async" />
            </span>)}
            <span className="week-card-veil" />
          </span> : null}
        </CellTag>;
      })}
      </div>
      {prevDates.length > 0 ? <div className="week-grid week-grid-prev" aria-label="上一周">
        {prevDates.map((date) => {
          const items = buckets.get(date) ?? [];
          const photoIds = dayPhotoIds(items, assets);
          // 上一周只留两条，整排比本周短一截。
          const highlights = weekCardRecords(items).slice(0, 2);
          return <CellTag className={`week-card is-prev ${date === today ? "is-today" : ""}`} key={`prev-${date}`} type="button" onClick={() => onOpenDay(date)} aria-label={`上一周 ${displayDate(date)}，${items.length} 条记录`}>
            <span className="week-card-head"><span className="week-card-weekday">{weekdayShort(date)}</span><span className="week-card-day">{Number(date.slice(8, 10))}</span></span>
            <span className="week-card-body">
              {items.length === 0 ? <span className="week-card-empty">没有记录</span> : highlights.map((record) => <span className="week-card-line" key={record.id}><span className="week-card-time">{lifeTimeTime(record.occurredAt ?? record.createdAt)}</span><span className="week-card-text">{recordText(record)}</span></span>)}
            </span>
            <span className="week-card-foot">{items.length === 0 ? "—" : `${items.length} 条`}</span>
            {photoIds.length > 0 ? <span className={`week-card-art bands-${photoIds.length}`} aria-hidden="true">
              {photoIds.map((assetId, index) => <span className="week-card-band" key={`prev-${assetId}-${index}`} style={{ "--week-art-index": index, "--week-art-count": photoIds.length, "--week-art-offset": `${(index * 100) / photoIds.length}%`, "--week-art-size": `${100 / photoIds.length}%` } as CSSProperties}>
                <img src={assetThumbUrl(assetId, 1200)} alt="" loading="lazy" decoding="async" />
              </span>)}
              <span className="week-card-veil" />
            </span> : null}
          </CellTag>;
        })}
      </div> : null}
    </> : <div className="month-grid">
      {WEEKDAY_LABELS.map((label) => <span className="month-weekday" key={label}>{label}</span>)}
      {dates.map((date) => {
        const items = buckets.get(date) ?? [];
        const summary = summaries.get(date);
        const weather = weatherByDate.get(date);
        const dayInfo = calendarDayInfo(date);
        const inMonth = date.slice(0, 7) === anchor.slice(0, 7);
        const cellPhoto = inMonth ? monthCellPhoto(dayPhotoCandidates(items, assets)) : undefined;
        const summaryText = summary === undefined ? "" : summaryDisplay(summary);
        const holidayLabel = dayInfo.holiday === undefined ? "" : `${dayInfo.holiday.name} · ${dayInfo.holiday.kind === "holiday" ? "休息日" : "调休上班"}`;
        const weatherLabel = weather === undefined ? "" : `天气：${weather.text}，${weather.tempMin}~${weather.tempMax}°C`;
        const titleParts = [holidayLabel, dayInfo.solarTerm ? `节气：${dayInfo.solarTerm}` : "", weatherLabel, summaryText === "" ? "" : `${summaryText}（${summary?.status === "generated" ? `AI · ${summary?.provider}` : summary?.status === "manual" ? "手写" : "规则生成"}）`].filter(Boolean);
        return <CellTag className={`month-cell ${inMonth ? "" : "is-outside"} ${date === today ? "is-today" : ""} ${cyclePanelOpen && date === anchor ? "is-picked" : ""} ${items.length === 0 ? "is-empty" : ""} ${editable ? "is-editing" : ""}`} key={date} type={editable ? undefined : "button"} onClick={editable ? undefined : () => onOpenDay(date)} onContextMenu={inMonth ? (event: ReactMouseEvent) => openSummaryMenu(date, event) : undefined} aria-label={`${displayDate(date)}，${items.length} 条记录${cyclePanelOpen && date === anchor ? "，已选为周期记录日期" : ""}${titleParts.length > 0 ? `，${titleParts.join("，")}` : ""}`} title={titleParts.length > 0 ? titleParts.join(" · ") : undefined}>
          {cellPhoto !== undefined ? <span className="month-cell-art" aria-hidden="true"><img src={assetThumbUrl(cellPhoto, 1200)} alt="" loading="lazy" decoding="async" /><span className="month-cell-veil" /></span> : null}
          <span className="month-cell-head"><span className="month-day-number">{Number(date.slice(8, 10))}</span><span className="month-day-meta">{dayInfo.holiday ? <span className={`month-day-status is-${dayInfo.holiday.kind}`} aria-label={holidayLabel}>{dayInfo.holiday.kind === "holiday" ? "休" : "班"}</span> : null}{items.length > 0 ? <span className="month-day-count">{items.length}</span> : null}{weather !== undefined ? <span className="month-day-weather" aria-label={`天气：${weather.text}，${weather.tempMin}到${weather.tempMax}摄氏度`} title={`天气：${weather.text}，${weather.tempMin}~${weather.tempMax}°C`}><span aria-hidden="true">{getWeatherEmoji(weather.icon)}</span></span> : null}</span></span>
          {/* While editing, every in-month day gets a field — even an empty one. The
              menu's「编辑小结」promises to open the day that was right-clicked, and a
              day with nothing on it still has a summary slot to write into. */}
          {editable && inMonth
            ? <textarea className="summary-field month-day-summary-field" data-summary-date={date} value={summaryValue(date, summary)} maxLength={SUMMARY_MAX_LENGTH} rows={2} placeholder="写一句小结" onChange={(event) => onDraftChange(date, event.target.value)} onContextMenu={(event) => openSummaryMenu(date, event)} aria-label={`${displayDate(date)} 的小结`} />
            : summaryText !== "" ? <span className={`month-day-summary ${summary?.status === "fallback" ? "is-fallback" : ""}`}>{summaryText}</span> : null}
          {dayInfo.solarTerm ? <span className="month-day-solar" aria-label={`节气：${dayInfo.solarTerm}`}>{dayInfo.solarTerm}</span> : null}
          <CalendarDayMarkers date={date} today={today} module={cycleModule} />
        </CellTag>;
      })}
    </div>) : null}
    {summaryMenu !== null ? <CalendarSummaryMenu x={summaryMenu.x} y={summaryMenu.y} monthMode={mode === "month"} busy={busyDate === summaryMenu.date || cycleBusyDate === summaryMenu.date} cycleEnabled={cycleModule !== null && cycleModule.config.enabled} recordedKinds={new Set((cycleModule?.events ?? []).filter((event) => event.date === summaryMenu.date).map((event) => event.kind))} onEdit={() => editDaySummary(summaryMenu.date)} onRegenerate={() => { void onRegenerateSummary(summaryMenu.date); }} onRevert={() => { void onRevertSummary(summaryMenu.date); }} onToggleCycle={(kind) => { void toggleCycleOn(summaryMenu.date, kind); }} onPickCycle={(kind) => { closeSummaryMenu(); void toggleCycleOn(summaryMenu.date, kind); }} onClose={closeSummaryMenu} /> : null}
  </section>;
}

export function CycleModulePanel({ module, selectedDate, today, onOpenSettings, onAddEvent, onDeleteEvent, onSavePeriodLength }: { module: CycleIntimacyModuleData | null; selectedDate: string; today: string; onOpenSettings: () => void; onAddEvent: (date: string, kind: CycleIntimacyEventKind) => Promise<void>; onDeleteEvent: (id: string) => Promise<void>; onSavePeriodLength: (days: number) => Promise<void> }) {
  const [entryDate, setEntryDate] = useState(selectedDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lengthDraft, setLengthDraft] = useState(module?.config.periodLength ?? 7);
  useEffect(() => setEntryDate(selectedDate), [selectedDate]);
  useEffect(() => { if (module) setLengthDraft(module.config.periodLength); }, [module]);
  if (!module) return <section id="cycle-entry-panel" className="cycle-inline-panel" aria-label="周期记录"><span className="muted">周期模块正在加载…</span></section>;
  const quickDates = [
    { label: "前天", date: shiftDate(today, -2) },
    { label: "昨天", date: shiftDate(today, -1) },
    { label: "今天", date: today },
  ];
  const eventsForDate = module.events.filter((event) => event.date === entryDate);
  const eventFor = (kind: CycleIntimacyEventKind) => eventsForDate.find((event) => event.kind === kind);
  const perform = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await operation(); } catch (caught) { setError(errorMessage(caught, "周期记录暂时无法保存，请重试")); } finally { setBusy(false); }
  };
  const toggleEvent = (kind: CycleIntimacyEventKind) => {
    const existing = eventFor(kind);
    void perform(() => existing ? onDeleteEvent(existing.id) : onAddEvent(entryDate, kind));
  };
  const predicted = nextPredictedStart(module, today);
  /** How long a run lasts lives here because it is the number she actually tunes. */
  const commitLength = () => {
    const days = Math.min(21, Math.max(1, Math.round(Number.isFinite(lengthDraft) ? lengthDraft : 1)));
    setLengthDraft(days);
    if (days === module.config.periodLength) return;
    void perform(() => onSavePeriodLength(days));
  };
  return <section id="cycle-entry-panel" className="cycle-inline-panel" aria-labelledby="cycle-inline-title">
    <div className="cycle-inline-head"><div><p className="eyebrow">私密记录</p><h3 id="cycle-inline-title">周期</h3></div><button className="cycle-settings-link" type="button" onClick={onOpenSettings} aria-label="打开周期设置"><SlidersHorizontal size={15} aria-hidden="true" /><span>设置</span></button></div>
    {!module.config.enabled ? <div className="cycle-disabled-note" role="status"><span>周期记录尚未启用</span><button type="button" onClick={onOpenSettings}>去设置并启用</button></div> : null}
    <div className="cycle-date-row" aria-label="选择记录日期">
      {quickDates.map((item) => <button className={`cycle-date-option ${entryDate === item.date ? "is-selected" : ""}`} type="button" key={item.date} onClick={() => setEntryDate(item.date)} aria-pressed={entryDate === item.date}>{item.label}<small>{item.date.slice(5)}</small></button>)}
      <label className={`cycle-date-picker ${quickDates.some((item) => item.date === entryDate) ? "" : "is-selected"}`}><span>选择日期</span><input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} aria-label="选择周期记录日期" /></label>
    </div>
    <p className="cycle-entry-target">记录到 <strong>{displayDate(entryDate)}</strong></p>
    <div className="cycle-forecast-row">
      <span className="cycle-forecast-next">预测经期开始 <strong>{predicted === undefined ? "还没有依据" : displayDate(predicted)}</strong></span>
      <label className="cycle-forecast-length"><span>持续</span><input type="number" min="1" max="21" value={lengthDraft} onChange={(event) => setLengthDraft(Number(event.target.value))} onBlur={commitLength} onKeyDown={(event) => { if (event.key === "Enter") commitLength(); }} aria-label="预计经期持续天数" disabled={busy || !module.config.enabled} /><span>天</span></label>
    </div>
    <div className="cycle-event-row" aria-label={`${entryDate} 的周期事件`}>
      {CYCLE_EVENT_KINDS.map((option) => { const active = eventFor(option.kind) !== undefined; return <button className={`cycle-event-option ${active ? "is-active" : ""}`} type="button" key={option.kind} onClick={() => toggleEvent(option.kind)} disabled={busy || !module.config.enabled} aria-pressed={active} aria-label={`${active ? option.activeLabel : `记录${option.label}`}，${active ? "再次点击移除" : "点击记录"}`} title={active ? `${option.activeLabel}（再次点击移除）` : `记录${option.label}`}><span className="cycle-event-icon">{option.icon}</span><span>{active ? option.activeLabel : option.label}</span></button>; })}
    </div>
    {error ? <p className="cycle-inline-error" role="alert"><CircleHelp size={16} aria-hidden="true" />{error}</p> : null}
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
        <label className="dialog-field"><span>周期天数</span><input type="number" min="15" max="90" value={draft.cycleLength} onChange={(event) => setDraft((current) => current ? { ...current, cycleLength: Number(event.target.value) } : current)} /></label>
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
