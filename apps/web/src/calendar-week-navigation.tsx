import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
// Existing chevrons match the owner's icon archive chevron-{left,right,down} paths.
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { consumeDateOutsidePress, useDatePopover } from "./date-popover";
import { datesOfWeek, displayDate, monthGridDates, monthTitle, shiftDate, shiftMonth, startOfWeek } from "./time";
import { weekRangeLabel } from "./calendar-week";
import { WEEKDAY_LABELS } from "./date-field";
import "./calendar-week.css";

export function CalendarWeekNavigation({ anchor, today, onStep, onSelect }: { anchor: string; today: string; onStep: (direction: number) => void; onSelect: (date: string) => void }) {
  const [open, setOpen] = useState(false), [month, setMonth] = useState(anchor), [focusedDate, setFocusedDate] = useState(anchor);
  const rootRef = useRef<HTMLDivElement>(null), panelRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  useDatePopover(open, rootRef, panelRef, false);
  const dates = datesOfWeek(anchor), selectedWeek = dates[0]!, current = selectedWeek === startOfWeek(today);
  const label = weekRangeLabel(selectedWeek, dates[6]!, today.slice(0, 4));
  const [from, to] = label.split("—");
  const grid = monthGridDates(month);
  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  const select = (date: string) => { onSelect(date); close(); };
  const pageMonth = (offset: number) => { const next = shiftMonth(month, offset); setMonth(next); setFocusedDate(next); };
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>(`[data-week-date="${pendingFocus.current ?? focusedDate}"]`)?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [open, month, focusedDate]);
  useEffect(() => { setOpen(false); }, [anchor]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && (triggerRef.current?.contains(event.target) || panelRef.current?.contains(event.target))) return;
      consumeDateOutsidePress(event); setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [open]);
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: string;
    if (event.key in offsets) next = shiftDate(date, offsets[event.key]!);
    else if (event.key === "Home") next = startOfWeek(date);
    else if (event.key === "End") next = shiftDate(startOfWeek(date), 6);
    else if (event.key === "PageUp" || event.key === "PageDown") next = shiftMonth(date, event.key === "PageUp" ? -1 : 1);
    else return;
    event.preventDefault(); pendingFocus.current = next; setFocusedDate(next);
    if (!grid.includes(next)) setMonth(next);
  };
  return <div ref={rootRef} className="calendar-week-navigation" role="group" aria-label={`当前周：${label}`}>
    <div className="calendar-week-navigation-row">
      <button className="calendar-range-step" type="button" onClick={() => onStep(-1)} aria-label="上一周"><ChevronLeft size={17} strokeWidth={2} aria-hidden="true" /></button>
      <h2 id="calendar-title" className="calendar-range-label"><button ref={triggerRef} className="calendar-week-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="calendar-week-picker" aria-label={`选择周，${label}`} onClick={() => { setMonth(anchor); setFocusedDate(anchor); setOpen(value => !value); }}><span className="calendar-week-range-text"><span>{from}—</span><wbr /><span>{to}</span></span><ChevronDown size={14} aria-hidden="true" /></button></h2>
      <button className="calendar-range-step" type="button" onClick={() => onStep(1)} aria-label="下一周"><ChevronRight size={17} strokeWidth={2} aria-hidden="true" /></button>
    </div>
    {current ? <span className="calendar-current-week">本周</span> : <button type="button" className="calendar-return-week" onClick={() => onSelect(today)}>回到本周</button>}
    {open ? createPortal(<div id="calendar-week-picker" ref={panelRef} className="calendar-week-picker date-control-popover" role="dialog" aria-label="选择一周">
      <header><button type="button" onClick={() => pageMonth(-1)} aria-label="上个月"><ChevronLeft size={17} /></button><span>{monthTitle(month)}</span><button type="button" onClick={() => pageMonth(1)} aria-label="下个月"><ChevronRight size={17} /></button></header>
      <div className="calendar-week-picker-grid" role="grid" aria-label={monthTitle(month)}><div className="calendar-week-picker-weekdays" role="row">{WEEKDAY_LABELS.map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
        {Array.from({ length: 6 }, (_, index) => grid.slice(index * 7, index * 7 + 7)).map(week => <div role="row" className={`calendar-week-picker-week ${week[0] === selectedWeek ? "is-selected" : ""}`} key={week[0]}>{week.map(date => <button type="button" role="gridcell" key={date} data-week-date={date} className={`${date.slice(0, 7) !== month.slice(0, 7) ? "is-outside" : ""} ${date === today ? "is-today" : ""}`} aria-label={`${displayDate(date)}，选择这一周`} aria-selected={week[0] === selectedWeek} tabIndex={date === focusedDate ? 0 : -1} onFocus={() => setFocusedDate(date)} onKeyDown={event => moveFocus(event, date)} onClick={() => select(date)}>{Number(date.slice(8, 10))}</button>)}</div>)}
      </div>
      <footer><button type="button" onClick={() => select(today)}>回到本周</button><button type="button" onClick={close}>关闭</button></footer>
    </div>, rootRef.current?.closest("dialog") ?? document.body) : null}
  </div>;
}
