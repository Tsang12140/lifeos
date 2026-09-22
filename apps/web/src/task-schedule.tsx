import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { ScrollSlotStrip } from "./ScrollSlotStrip";
import {
  combineDateTime,
  datePartOf,
  dayLabel,
  hourOptions,
  isDaySunday,
  localDateToday,
  localNowInput,
  MINUTE_STEP_COARSE,
  MINUTE_STEP_FINE,
  minuteOptions,
  monthGridDates,
  monthTitle,
  shiftDate,
  shiftMonth,
  timePartOf,
} from "./time";

/**
 * The task schedule: one control that holds both ends of a task's time.
 *
 * A task used to wear two of the single-day pickers, side by side — "when it
 * happened" and "due". Two problems came out of that, and both were the
 * owner's, in these words: paging to another month took two clicks (open the
 * month header first, then the arrow), and the start could not be in the
 * future at all, because the occurrence field is capped at "now" — which makes
 * "a task that starts a month from today" literally unsettable.
 *
 * So this control is a *range*: pick the start, pick the end, and the days in
 * between light up. Neither end is capped. The month arrows are always on
 * screen, one click per month, and four quick picks ("今天 / 明天 / 一周后 /
 * 一个月后") cover the far dates that would otherwise be twelve clicks away.
 *
 * The two ends are two *targets*, not a single toggle. The row above the grid
 * says which one the next calendar click will write, and after the start is set
 * the target flips to the end on its own — so the common path really is "click
 * a day, click another day, done".
 *
 * The end is never allowed to land before the start. Rewriting the start day
 * behind the owner's back (what most range pickers do) is worse than a refusal
 * with a sentence saying why: moving the start is one tap on its own chip.
 */

/** Monday first, matching `monthGridDates`, which starts on the week's Monday. */
const WEEKDAYS: readonly string[] = ["一", "二", "三", "四", "五", "六", "日"];

/**
 * A day has no time until somebody gives it one. These are the times a task
 * means when nobody said: morning for the start, end of the working day for the
 * end. They are only ever used to fill a blank — a value already on the record
 * is shown and kept exactly as it is.
 */
const DEFAULT_START_TIME = "09:00";
const DEFAULT_END_TIME = "18:00";

const QUICK_PICKS: readonly { readonly label: string; readonly at: (today: string) => string }[] = [
  { label: "今天", at: (today) => today },
  { label: "明天", at: (today) => shiftDate(today, 1) },
  { label: "一周后", at: (today) => shiftDate(today, 7) },
  // A month, not 30 days: "the 22nd of next month" is what a person means, and
  // it stays the 22nd across a 31-day month the way a calendar would.
  { label: "一个月后", at: (today) => shiftMonth(today, 1) },
];

export function TaskScheduleField({ start, end, onStartChange, onEndChange, className = "composer-date-control", label = "任务时间" }: {
  readonly start: string;
  readonly end: string;
  readonly onStartChange: (value: string) => void;
  readonly onEndChange: (value: string) => void;
  readonly className?: string;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<"start" | "end">("start");
  const [monthAnchor, setMonthAnchor] = useState(() => datePartOf(start) || localDateToday());
  const [fineMinutes, setFineMinutes] = useState(false);
  const [note, setNote] = useState("");
  const [placement, setPlacement] = useState<"above" | "below">("above");
  const [room, setRoom] = useState(380);
  const [panelShiftX, setPanelShiftX] = useState(0);
  const [fixedBox, setFixedBox] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const startDate = datePartOf(start);
  const startTime = timePartOf(start) || DEFAULT_START_TIME;
  const endDate = datePartOf(end);
  const endTime = timePartOf(end) || DEFAULT_END_TIME;
  const activeDate = target === "start" ? startDate : endDate;
  const activeTime = target === "start" ? startTime : endTime;

  const grid = useMemo(() => monthGridDates(monthAnchor), [monthAnchor]);
  /*
   * The band is drawn between the two ends in order, not between start and end
   * as named. A record whose due date sits before its occurrence (an old one, or
   * one written through the API) would otherwise paint an empty band while the
   * two filled endpoints sat there looking wrong.
   */
  const bandLo = startDate === "" || endDate === "" ? "" : endDate < startDate ? endDate : startDate;
  const bandHi = startDate === "" || endDate === "" ? "" : endDate < startDate ? startDate : endDate;

  const minuteStep = fineMinutes ? MINUTE_STEP_FINE : MINUTE_STEP_COARSE;
  const minuteSlot = String(Math.round(Number(activeTime.slice(3, 5)) / minuteStep) * minuteStep % 60).padStart(2, "0");

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event: PointerEvent) => {
      const target_ = event.target;
      if (target_ instanceof Node && rootRef.current?.contains(target_) === true) return;
      // The panel is placed by its own styles and can land outside the root's
      // box, so a click on it is still a click on this control.
      if (target_ instanceof Element && target_.closest(".task-schedule-panel") !== null) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const openPanel = () => {
    setNote("");
    setTarget("start");
    setMonthAnchor(startDate || localDateToday());
    /*
     * 往上开还是往下开，**量两边再定**。
     *
     * 单日选择器（`DateField`）写死向上开，理由是「输入框在视口底部」。今天视图的
     * 记录编辑器并不总在底部：2026-09-22 实测触发点在 y=384，上方只有 384px、下方有 600px，
     * 而面板内容要 500px 上下 —— 向上开时 `max-height` 把整月网格压到 67px（只剩两行），
     * 点第二下日历基本点不着。既然空间是量得出来的，就不要猜。
     */
    const box = rootRef.current?.getBoundingClientRect();
    if (box === undefined) {
      setPlacement("above");
      setRoom(380);
      setPanelShiftX(0);
      setFixedBox(null);
    } else {
      const above = box.top - 16;
      const below = window.innerHeight - box.bottom - 16;
      const next = below > above ? "below" : "above";
      setPlacement(next);
      setRoom(Math.max(300, Math.min(560, next === "below" ? below : above)));
      // Same phone-overflow clamp as DateField (todo §13.1).
      const panelWidth = Math.min(320, window.innerWidth - 24);
      const overflow = box.left + panelWidth + 12 - window.innerWidth;
      setPanelShiftX(overflow > 0 ? -overflow : 0);
      // `.dialog-body { overflow-y: auto }` (and any other scroll ancestor) will
      // clip an absolutely positioned panel. When that is the case, lift the
      // panel to the viewport with `position: fixed` (todo §14).
      let clipped = false;
      const rootEl = rootRef.current;
      for (let el: HTMLElement | null = rootEl?.parentElement ?? null; el !== null; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflow !== "visible" || style.overflowY !== "visible" || style.overflowX !== "visible") {
          clipped = true;
          break;
        }
      }
      if (clipped) {
        const width = Math.min(320, window.innerWidth - 24);
        const left = Math.max(12, Math.min(box.left, window.innerWidth - width - 12));
        const top = next === "below" ? box.bottom + 8 : undefined;
        const bottom = next === "above" ? window.innerHeight - box.top + 8 : undefined;
        setFixedBox({ left, top: top ?? (bottom === undefined ? box.bottom + 8 : window.innerHeight - bottom - room) });
        // For "above" we anchor by bottom edge via top calculation with room.
        if (next === "above" && bottom !== undefined) {
          setFixedBox({ left, top: Math.max(8, box.top - 8 - room) });
        }
      } else {
        setFixedBox(null);
      }
    }
    setOpen((current) => !current);
  };

  // Keep the fixed panel glued to the trigger when the dialog body scrolls.
  useEffect(() => {
    if (!open || fixedBox === null) return undefined;
    const sync = () => {
      const box = rootRef.current?.getBoundingClientRect();
      if (box === undefined) return;
      const width = Math.min(320, window.innerWidth - 24);
      const left = Math.max(12, Math.min(box.left, window.innerWidth - width - 12));
      setFixedBox((current) => current === null ? null : ({
        left,
        top: placement === "below" ? box.bottom + 8 : Math.max(8, box.top - 8 - room),
      }));
    };
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [open, fixedBox, placement, room]);

  /*
   * Writing the start is the one move that can invalidate the end. Clearing it
   * rather than dragging it along is the honest repair: the old end belonged to
   * the old start, and the target has already flipped to the end, so the next
   * click finishes the range.
   */
  const writeStart = (date: string) => {
    onStartChange(combineDateTime(date, startTime));
    setMonthAnchor(date);
    if (endDate !== "" && endDate < date) {
      onEndChange("");
      setNote("结束已清空，请重选结束日");
    } else {
      setNote("");
    }
    setTarget("end");
  };

  const writeEnd = (date: string) => {
    if (startDate !== "" && date < startDate) {
      setNote("结束不能早于开始");
      return;
    }
    setNote("");
    onEndChange(combineDateTime(date, endTime));
    setMonthAnchor(date);
  };

  const pickDay = (date: string) => {
    if (target === "start") writeStart(date);
    else writeEnd(date);
  };

  const pickQuick = (at: (today: string) => string) => {
    const date = at(localDateToday());
    if (target === "start") writeStart(date);
    else writeEnd(date);
  };

  const writeTime = (time: string) => {
    if (target === "start") {
      // A time alone cannot make the start land after the end on the same day.
      const date = startDate || localDateToday();
      if (endDate !== "" && date === endDate && time > endTime) {
        setNote("开始不能晚于结束");
        return;
      }
      setNote("");
      onStartChange(combineDateTime(date, time));
      return;
    }
    const date = endDate || startDate || localDateToday();
    if (startDate !== "" && date === startDate && time < startTime) {
      setNote("结束不能早于开始");
      return;
    }
    setNote("");
    onEndChange(combineDateTime(date, time));
  };

  return <div className={`task-schedule ${className} ${open ? "is-open" : ""}`} ref={rootRef} data-task-schedule="on" data-range-start={start} data-range-end={end}>
    <button type="button" className="task-schedule-trigger" onClick={openPanel} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}：开始 ${startDate === "" ? "未设置" : `${dayLabel(startDate)} ${startTime}`}，结束 ${endDate === "" ? "未设置" : `${dayLabel(endDate)} ${endTime}`}`}>
      <CalendarRange size={15} strokeWidth={1.8} aria-hidden="true" />
      <span className="task-schedule-part">{startDate === "" ? "开始" : dayLabel(startDate)}<span className="task-schedule-clock">{startTime}</span></span>
      <span className="task-schedule-arrow" aria-hidden="true">→</span>
      <span className={`task-schedule-part ${endDate === "" ? "is-blank" : ""}`}>{endDate === "" ? "结束" : dayLabel(endDate)}<span className="task-schedule-clock">{endTime}</span></span>
    </button>
    {open ? (() => {
      const panelStyle: CSSProperties & { [key: string]: string | number | undefined } = {
        "--task-panel-room": `${room}px`,
      };
      if (fixedBox !== null) {
        panelStyle.position = "fixed";
        panelStyle.left = `${fixedBox.left}px`;
        panelStyle.top = `${fixedBox.top}px`;
        panelStyle.right = "auto";
        panelStyle.bottom = "auto";
        panelStyle.width = `${Math.min(320, window.innerWidth - 24)}px`;
      } else if (panelShiftX !== 0) {
        panelStyle.left = `${panelShiftX}px`;
      }
      return <div
      className={`task-schedule-panel is-${placement}${fixedBox !== null ? " is-fixed" : ""}`}
      role="dialog"
      aria-label={`${label}选择器`}
      data-placement={placement}
      style={panelStyle}
    >
      {/* Always-on month paging. The single-day picker hides its month grid
          behind the header, which is what made crossing a month boundary a
          two-step errand; here the arrows are part of the panel. */}
      <div className="task-panel-head">
        <button type="button" className="task-panel-step" onClick={() => setMonthAnchor((current) => shiftMonth(current, -1))} aria-label="上个月"><ChevronLeft size={15} aria-hidden="true" /></button>
        <span className="task-panel-month">{monthTitle(monthAnchor)}</span>
        <button type="button" className="task-panel-step" onClick={() => setMonthAnchor((current) => shiftMonth(current, 1))} aria-label="下个月"><ChevronRight size={15} aria-hidden="true" /></button>
        <button type="button" className="task-panel-anchor" onClick={() => setMonthAnchor(activeDate || localDateToday())} aria-label="回到选中日所在的月份">本月</button>
      </div>
      <div className="task-panel-targets" role="group" aria-label="选择要设置的端点">
        {(["start", "end"] as const).map((which) => {
          const date = which === "start" ? startDate : endDate;
          const time = which === "start" ? startTime : endTime;
          return <button key={which} type="button" className={`task-target ${target === which ? "is-active" : ""} ${date === "" ? "is-blank" : ""}`} data-target={which} data-active={target === which ? "on" : "off"} aria-pressed={target === which} onClick={() => { setTarget(which); setNote(""); if (date !== "") setMonthAnchor(date); }}>
            <span className="task-target-label">{which === "start" ? "开始" : "结束"}</span>
            <span className="task-target-value">{date === "" ? "点日历选" : `${dayLabel(date)} ${time}`}</span>
          </button>;
        })}
      </div>
      <div className="task-cal">
        <div className="task-cal-weekdays">{WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
        <div className="task-cal-grid">
          {grid.map((date) => {
            const inBand = bandLo !== "" && date >= bandLo && date <= bandHi;
            const isStart = date === startDate;
            const isEnd = date === endDate;
            return <button
              key={date}
              type="button"
              className={`task-cal-day ${date.slice(0, 7) === monthAnchor.slice(0, 7) ? "" : "is-outside"} ${date === localDateToday() ? "is-today" : ""} ${isDaySunday(date) ? "is-weekend" : ""} ${inBand ? "is-band" : ""} ${isStart ? "is-start" : ""} ${isEnd ? "is-end" : ""}`}
              data-date={date}
              onClick={() => pickDay(date)}
              aria-pressed={isStart || isEnd}
              aria-label={`${dayLabel(date)}${isStart ? "（开始）" : ""}${isEnd ? "（结束）" : ""}`}
            >{Number(date.slice(8, 10))}</button>;
          })}
        </div>
      </div>
      <div className="task-quick" role="group" aria-label={`快捷设置${target === "start" ? "开始" : "结束"}`}>
        <span className="task-quick-label">{target === "start" ? "开始" : "结束"}</span>
        {QUICK_PICKS.map((pick) => <button key={pick.label} type="button" className="task-quick-chip" onClick={() => pickQuick(pick.at)}>{pick.label}</button>)}
      </div>
      <div className="task-panel-time">
        <ScrollSlotStrip className="date-time-column" scrollKey={`${target}-${activeDate}`}>
          {hourOptions().map((hour) => <button key={hour} type="button" className={`date-time-slot ${activeTime.startsWith(`${hour}:`) ? "is-selected" : ""}`} onClick={() => writeTime(`${hour}:${minuteSlot}`)} aria-pressed={activeTime.startsWith(`${hour}:`)}>{hour}</button>)}
        </ScrollSlotStrip>
        <span className="date-time-sep" aria-hidden="true">:</span>
        <ScrollSlotStrip className="date-time-column" scrollKey={`${target}-${activeDate}-minute`}>
          {minuteOptions(minuteStep).map((minute) => <button key={minute} type="button" className={`date-time-slot ${minute === minuteSlot ? "is-selected" : ""}`} onClick={() => writeTime(`${activeTime.slice(0, 2)}:${minute}`)} aria-pressed={minute === minuteSlot}>{minute}</button>)}
        </ScrollSlotStrip>
        <div className="task-panel-time-side">
          <label className="task-panel-fine"><input type="checkbox" checked={fineMinutes} onChange={(event) => setFineMinutes(event.target.checked)} /><span>精细</span></label>
          {/* Only the start can mean "now". Offering it for the end would put the
              end before the start and then refuse the click. */}
          {target === "start" ? <button type="button" className="text-button" onClick={() => { const now = localNowInput(); setNote(""); onStartChange(now); setMonthAnchor(datePartOf(now) || monthAnchor); }}>此刻</button> : null}
        </div>
      </div>
      <div className="task-panel-foot">
        <span className="task-panel-note" role="status">{note !== "" ? note : `点日历设${target === "start" ? "开始" : "结束"}`}</span>
        <button type="button" className="text-button" disabled={end === ""} onClick={() => { setNote(""); onEndChange(""); }}>清除结束</button>
      </div>
    </div>;
    })() : null}
  </div>;
}
