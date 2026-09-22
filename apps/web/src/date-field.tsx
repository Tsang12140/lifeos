import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { ScrollSlotStrip } from "./ScrollSlotStrip";
import {
  DAY_WINDOW,
  combineDateTime,
  datePartOf,
  dayLabel,
  dayWindow,
  displayDate,
  hourOptions,
  isDaySunday,
  isFutureDay,
  isFutureMonth,
  lastWholeHour,
  localDateToday,
  localNowInput,
  MINUTE_STEP_COARSE,
  MINUTE_STEP_FINE,
  minuteCapFor,
  minuteOptions,
  monthGridWeeks,
  monthTitle,
  shiftDate,
  shiftMonth,
  timePartOf,
  weekdayShort,
} from "./time";

export const WEEKDAY_LABELS: readonly string[] = ["一", "二", "三", "四", "五", "六", "日"];

const DAY_STEP_LONG_PRESS = 6;
const DAY_STEP_REPEAT_MS = 90;

export function DateField({ value, onChange, label, showTime = false, capped = false, className = "composer-date-control" }: { readonly value: string; readonly onChange: (value: string) => void; readonly label: string; readonly showTime?: boolean; readonly capped?: boolean; readonly className?: string }) {
  const [open, setOpen] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState(value || localDateToday());
  const [gridOpen, setGridOpen] = useState(false);
  const [longPressStepping, setLongPressStepping] = useState(false);
  const [fineMinutes, setFineMinutes] = useState(false);
  const [panelShiftX, setPanelShiftX] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ timer: number; repeat: number } | null>(null);

  // The day the panel works on. Falls back to today for an empty or malformed
  // value, which is what makes the capsule readable before anything is picked.
  const day = datePartOf(value) || localDateToday();
  const time = timePartOf(value);
  const strip = useMemo(() => dayWindow(day), [day]);
  const weeks = useMemo(() => monthGridWeeks(monthAnchor), [monthAnchor]);
  const selectedIndex = strip.indexOf(day);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : DAY_WINDOW;

  /*
   * A journal records what already happened, so nothing later than now is a
   * legal value: not a later hour, not a later minute, not tomorrow. The cap is
   * derived from the clock rather than stored, so it is re-read every time the
   * panel opens and a panel left open across midnight (or across the top of the
   * hour) cannot offer a slot that has since expired.
   *
   * `capNow` only applies to "when it happened". A task's due date is the one
   * field whose whole meaning is in the future, so the caller opts out of the
   * cap rather than the other way round.
   */
  const capNow = capped ? localNowInput() : "";
  const capHour = capNow === "" ? "" : capNow.slice(11, 13);
  const minuteStep = fineMinutes ? MINUTE_STEP_FINE : MINUTE_STEP_COARSE;
  /*
   * Which minute slot is lit.
   *
   * The value can carry a minute the coarse column does not have — the composer
   * seeds itself with the exact minute, and an old record may have been written
   * before the grain changed. Snapping the highlight to the nearest slot keeps
   * the column truthful ("roughly here") without rewriting the stored value on
   * mere opening; the value only changes when a slot is actually clicked.
   */
  const minuteSlot = time === "" ? "" : String(Math.round(Number(time.slice(3, 5)) / minuteStep) * minuteStep % 60).padStart(2, "0");
  // Only today is bounded by the clock; an earlier day is wholly in the past.
  const dayBounded = capNow !== "" && day === localDateToday();
  const hourLocked = (hour: string) => dayBounded && hour > capHour;
  const minuteLocked = (hour: string, minute: string) => {
    if (!dayBounded) return false;
    if (hour < capHour) return false;
    const cap = minuteCapFor(hour, capNow, minuteStep);
    return cap !== "" && minute > cap;
  };

  useEffect(() => {
    if (open) setMonthAnchor(day);
  }, [open, day]);

  useEffect(() => {
    if (!open) return undefined;
    const isInside = (target: EventTarget | null) => target instanceof Node && rootRef.current?.contains(target) === true;
    const handlePointer = (event: PointerEvent) => {
      if (isInside(event.target)) return;
      const target = event.target;
      // The panel is positioned by its own styles and can land outside the
      // root's box, so a click on it is still a click on this control.
      if (target instanceof Element && target.closest(".date-panel") !== null) return;
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

  useEffect(() => () => {
    if (pressRef.current === null) return;
    window.clearTimeout(pressRef.current.timer);
    window.clearInterval(pressRef.current.repeat);
  }, []);

  const commitDate = (next: string) => {
    onChange(showTime ? combineDateTime(next, time === "" ? "09:00" : time) : next);
  };
  const commitTime = (next: string) => {
    if (next === "") return;
    onChange(combineDateTime(day, next));
  };
  // Held down, the arrows walk further: a week per beat once the button has
  // been held past the point where a person would have let go of a click.
  const startDayStep = (offset: number) => {
    window.clearTimeout(pressRef.current?.timer);
    window.clearInterval(pressRef.current?.repeat);
    pressRef.current = {
      timer: window.setTimeout(() => {
        setLongPressStepping(true);
        pressRef.current = { timer: 0, repeat: window.setInterval(() => commitDate(shiftDate(day, offset * DAY_STEP_LONG_PRESS)), DAY_STEP_REPEAT_MS) };
      }, 400),
      repeat: 0,
    };
  };
  const endDayStep = () => {
    if (pressRef.current === null) return;
    window.clearTimeout(pressRef.current.timer);
    window.clearInterval(pressRef.current.repeat);
    pressRef.current = null;
    setLongPressStepping(false);
  };
  const openPanel = () => {
    setMonthAnchor(day);
    setGridOpen(false);
    /*
     * An empty time gets the most recent whole hour rather than the exact
     * minute. It is the value a person actually means: the entry is usually
     * "this morning", not "07:54". Existing values are never touched — coming
     * back to a panel you already set must show what you set, not reset it.
     */
    if (capped && showTime && time === "") {
      const seed = lastWholeHour(localNowInput());
      if (seed !== "") onChange(combineDateTime(day, seed));
    }
    // The panel is `left: 0` against the trigger. On a phone the trigger can sit
    // near the middle (composer date at left≈154 on a 430px viewport), and a
    // 320px panel would stick out past the right edge (todo §13.1). Shift it
    // left just enough to fit, never past the left gutter.
    const box = rootRef.current?.getBoundingClientRect();
    if (box === undefined) {
      setPanelShiftX(0);
    } else {
      const panelWidth = Math.min(320, window.innerWidth - 24);
      const overflow = box.left + panelWidth + 12 - window.innerWidth;
      setPanelShiftX(overflow > 0 ? Math.min(0, -overflow) : 0);
    }
    setOpen((current) => !current);
  };
  // How much room the panel has before its own top edge leaves the screen. It
  // hangs off the trigger's top, so this is the distance from that edge to the
  // viewport top — minus the 8px gap it sits above the capsule, and a little
  // breathing space so it never touches the edge. Measured on open rather than
  // guessed, because the composer's position depends on how much text is in it.
  const panelRoom = () => {
    const box = rootRef.current?.getBoundingClientRect();
    return box === undefined ? 360 : Math.max(220, Math.min(420, Math.round(box.top - 24)));
  };

  return <div className={`date-field ${className} ${open ? "is-open" : ""}`} ref={rootRef} data-date-value={value} data-date-time={showTime ? "on" : "off"} data-date-capped={capped ? "on" : "off"}>
    {/* A button, not a text input. The native field was typed into by accident
        and cleared by accident with it; a button opens the panel and nothing
        else, and it is the only thing in here that can take focus. */}
    <button type="button" className="date-trigger" onClick={openPanel} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}：${displayDate(day)}${showTime && time ? ` ${time}` : ""}`}>
      <CalendarDays size={15} strokeWidth={1.8} aria-hidden="true" />
      <span className="date-trigger-value">{dayLabel(day)}</span>
      {showTime ? <span className="date-trigger-time">{time || "全天"}</span> : null}
    </button>
    {open ? <div className="date-panel" role="dialog" aria-label={`${label}选择器`} style={{ "--date-panel-room": `${panelRoom()}px`, ...(panelShiftX !== 0 ? { left: `${panelShiftX}px` } : {}) } as CSSProperties}>
      <div className="date-panel-head">
        <button type="button" className={`date-panel-step ${longPressStepping ? "is-fast" : ""}`} onClick={() => commitDate(shiftDate(day, -1))} onPointerDown={() => startDayStep(-1)} onPointerUp={endDayStep} onPointerLeave={endDayStep} aria-label="前一天"><ChevronLeft size={15} aria-hidden="true" /></button>
        <button type="button" className="date-panel-title" onClick={() => setGridOpen((current) => !current)} aria-expanded={gridOpen} title="选择其他日期"><span>{monthTitle(monthAnchor)}</span><ChevronDown size={14} aria-hidden="true" /></button>
        <button type="button" className={`date-panel-step ${longPressStepping ? "is-fast" : ""}`} onClick={() => commitDate(shiftDate(day, 1))} onPointerDown={() => startDayStep(1)} onPointerUp={endDayStep} onPointerLeave={endDayStep} aria-label="后一天"><ChevronRight size={15} aria-hidden="true" /></button>
        <button type="button" className="date-panel-today" onClick={() => commitDate(localDateToday())} disabled={day === localDateToday()}>今天</button>
      </div>
        {gridOpen ? <div className="date-panel-grid">
          <div className="date-grid-head">
            <button type="button" className="date-panel-step" onClick={() => setMonthAnchor((current) => shiftMonth(current, -1))} aria-label="上个月"><ChevronLeft size={15} aria-hidden="true" /></button>
            <span className="date-grid-title">{monthTitle(monthAnchor)}</span>
            <button type="button" className="date-panel-step" onClick={() => setMonthAnchor((current) => shiftMonth(current, 1))} aria-label="下个月" disabled={capped && isFutureMonth(shiftMonth(monthAnchor, 1))}><ChevronRight size={15} aria-hidden="true" /></button>
          </div>
          <div className="date-grid-weekdays">{WEEKDAY_LABELS.map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
          {weeks.map((week) => <div className="date-grid-week" key={week[0]}>
            {week.map((date) => {
              // Shown but unclickable, not hidden: a grid that suddenly loses
              // its bottom rows reads as broken, while a greyed row explains
              // itself. Same call as the locked hour slots below.
              const locked = capped && isFutureDay(date);
              return <button
                type="button"
                className={`date-grid-day ${date === day ? "is-selected" : ""} ${date === localDateToday() ? "is-today" : ""} ${date.slice(0, 7) === monthAnchor.slice(0, 7) ? "" : "is-outside"} ${locked ? "is-locked" : ""}`}
                key={date}
                disabled={locked}
                onClick={() => { commitDate(date); setGridOpen(false); }}
                aria-pressed={date === day}
                aria-label={displayDate(date)}
              >{Number(date.slice(8, 10))}</button>;
            })}
          </div>)}
        </div> : <ScrollSlotStrip className="date-day-strip" scrollKey={strip[0] ?? ""} activeIndex={activeIndex}>
          {strip.map((date) => {
            const locked = capped && isFutureDay(date);
            return <button
              type="button"
              className={`date-day-slot ${date === day ? "is-selected" : ""} ${date === localDateToday() ? "is-today" : ""} ${isDaySunday(date) ? "is-weekend" : ""} ${locked ? "is-locked" : ""}`}
              key={date}
              disabled={locked}
              onClick={() => commitDate(date)}
              aria-pressed={date === day}
            >
              <span className="date-day-weekday">{weekdayShort(date)}</span>
              <span className="date-day-number">{Number(date.slice(8, 10))}</span>
            </button>;
          })}
        </ScrollSlotStrip>}
        {showTime ? <div className="date-panel-time">
          <ScrollSlotStrip className="date-time-column" scrollKey={day}>
            {hourOptions().map((hour) => {
              const locked = hourLocked(hour);
              // Picking an earlier hour keeps the minute you already chose.
              // Picking the current hour has to drag the minute back with it,
              // because that hour's later slots are in the future.
              const pickedMinute = hour === capHour && dayBounded
                ? minuteCapFor(hour, capNow, minuteStep)
                : (time.slice(3, 5) || "00");
              return <button type="button" className={`date-time-slot ${time.startsWith(`${hour}:`) ? "is-selected" : ""} ${locked ? "is-locked" : ""}`} key={hour} disabled={locked} onClick={() => commitTime(`${hour}:${pickedMinute}`)} aria-pressed={time.startsWith(`${hour}:`)}>{hour}</button>;
            })}
          </ScrollSlotStrip>
          <span className="date-time-sep" aria-hidden="true">:</span>
          <ScrollSlotStrip className="date-time-column" scrollKey={`${day}-minute`}>
            {minuteOptions(minuteStep).map((minute) => {
              const locked = minuteLocked(time.slice(0, 2) || capHour, minute);
              return <button type="button" className={`date-time-slot ${minute === minuteSlot ? "is-selected" : ""} ${locked ? "is-locked" : ""}`} key={minute} disabled={locked} onClick={() => commitTime(`${time.slice(0, 2) || capHour}:${minute}`)} aria-pressed={minute === minuteSlot}>{minute}</button>;
            })}
          </ScrollSlotStrip>
          <div className="date-panel-time-side">
            <button type="button" className="text-button" onClick={() => commitTime(localNowInput().slice(11))}>此刻</button>
            <button type="button" className="text-button" onClick={() => commitDate(localDateToday())}>今天</button>
          </div>
        </div> : null}
        {showTime && capped ? <label className="date-panel-fine">
          <input type="checkbox" checked={fineMinutes} onChange={(event) => setFineMinutes(event.target.checked)} />
          <span>精细到分钟</span>
          <span className="date-panel-fine-note">{capNow === "" ? "" : `不能晚于 ${capNow.slice(11)}`}</span>
        </label> : null}
    </div> : null}
  </div>;
}
