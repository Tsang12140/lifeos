import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import "./assistant-history-range.css";

type SelectionStep = "start" | "end";

function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function toDateKey(value: Date): string {
  return String(value.getFullYear()).padStart(4, "0") + "-" +
    String(value.getMonth() + 1).padStart(2, "0") + "-" +
    String(value.getDate()).padStart(2, "0");
}

function monthKey(value: string): string {
  return value.slice(0, 7);
}

function monthDate(value: string): Date {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1, 12);
}

function shiftMonth(value: string, amount: number): string {
  const current = parseDateKey(value);
  const originalDay = current.getDate();
  const nextMonth = new Date(current.getFullYear(), current.getMonth() + amount, 1, 12);
  const lastDay = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0, 12).getDate();
  nextMonth.setDate(Math.min(originalDay, lastDay));
  return toDateKey(nextMonth);
}

function shiftDay(value: string, amount: number): string {
  const next = parseDateKey(value);
  next.setDate(next.getDate() + amount);
  return toDateKey(next);
}

function makeMonthDays(value: string): readonly Date[] {
  const first = monthDate(value);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset, 12);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function formatDateLabel(value: string): string {
  const date = parseDateKey(value);
  return String(date.getFullYear()) + "年" + String(date.getMonth() + 1) + "月" + String(date.getDate()) + "日";
}

function formatMonthLabel(value: string): string {
  const date = monthDate(value);
  return String(date.getFullYear()) + "年" + String(date.getMonth() + 1) + "月";
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

export function AssistantHistoryRangePicker({
  fromDate,
  toDate,
  onChange,
  disabled,
  open,
  onOpenChange,
}: {
  readonly fromDate: string;
  readonly toDate: string;
  readonly onChange: (from: string, to: string) => void;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const controlRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRender = useRef(false);
  const popoverId = useId();
  const headingId = useId();
  const [step, setStep] = useState<SelectionStep>("start");
  const [visibleMonth, setVisibleMonth] = useState(() => monthKey(fromDate || shanghaiToday()));
  const [focusedDate, setFocusedDate] = useState(() => fromDate || shanghaiToday());
  const today = shanghaiToday();
  const days = useMemo(() => makeMonthDays(visibleMonth), [visibleMonth]);
  const rangeComplete = fromDate.length > 0 && toDate.length > 0;
  const stepState = rangeComplete ? "complete" : step;
  const year = Number(visibleMonth.slice(0, 4));
  const month = Number(visibleMonth.slice(5, 7));
  const firstYear = Math.min(year, 1970);
  const lastYear = Math.max(year, new Date().getFullYear() + 1);
  const years = useMemo(() => Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index), [firstYear, lastYear]);
  const rangeLabel = fromDate.length === 0
    ? "全部日期"
    : toDate.length === 0
      ? "从 " + formatDateLabel(fromDate) + " 开始，选择结束日期"
      : formatDateLabel(fromDate) + " 至 " + formatDateLabel(toDate);

  useEffect(() => {
    if (disabled && open) {
      onOpenChange(false);
      return;
    }
    if (!open) return;
    const initial = fromDate || shanghaiToday();
    setVisibleMonth(monthKey(initial));
    setFocusedDate(initial);
    setStep(fromDate.length > 0 && toDate.length === 0 ? "end" : "start");
    focusAfterRender.current = true;
  }, [open, disabled]);

  useEffect(() => {
    if (!open || disabled) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [disabled, onOpenChange, open]);

  useLayoutEffect(() => {
    if (!open || disabled) return;
    const fitPopover = () => {
      const popover = popoverRef.current;
      if (!popover) return;
      const top = popover.getBoundingClientRect().top;
      const dialogBottom = controlRef.current?.closest("dialog")?.getBoundingClientRect().bottom ?? window.innerHeight;
      const available = Math.max(80, Math.min(520, window.innerHeight - top - 12, dialogBottom - top - 12));
      popover.style.maxHeight = `${available}px`;
    };
    fitPopover();
    window.addEventListener("resize", fitPopover);
    window.addEventListener("scroll", fitPopover, true);
    return () => {
      window.removeEventListener("resize", fitPopover);
      window.removeEventListener("scroll", fitPopover, true);
    };
  }, [open, disabled, fromDate, toDate]);

  useEffect(() => {
    if (!open || !focusAfterRender.current) return;
    dayButtons.current.get(focusedDate)?.focus();
    focusAfterRender.current = false;
  }, [focusedDate, open, visibleMonth]);

  const changeVisibleMonth = (amount: number) => {
    const next = shiftMonth(visibleMonth + "-01", amount);
    setVisibleMonth(monthKey(next));
  };

  const chooseDate = (value: string) => {
    if (step === "start" || fromDate.length === 0) {
      onChange(value, "");
      setStep("end");
      if (monthKey(value) !== visibleMonth) setVisibleMonth(monthKey(value));
      return;
    }
    if (value < fromDate) {
      onChange(value, "");
      setStep("end");
      if (monthKey(value) !== visibleMonth) setVisibleMonth(monthKey(value));
      return;
    }
    onChange(fromDate, value);
    setStep("start");
    onOpenChange(false);
  };

  const handleDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseDate(value);
      return;
    }
    let next: string | null = null;
    if (event.key === "ArrowLeft") next = shiftDay(value, -1);
    else if (event.key === "ArrowRight") next = shiftDay(value, 1);
    else if (event.key === "ArrowUp") next = shiftDay(value, -7);
    else if (event.key === "ArrowDown") next = shiftDay(value, 7);
    else if (event.key === "Home") next = shiftDay(value, -((parseDateKey(value).getDay() + 6) % 7));
    else if (event.key === "End") next = shiftDay(value, 6 - ((parseDateKey(value).getDay() + 6) % 7));
    else if (event.key === "PageUp") next = shiftMonth(value, event.shiftKey ? -12 : -1);
    else if (event.key === "PageDown") next = shiftMonth(value, event.shiftKey ? 12 : 1);
    if (next === null) return;
    event.preventDefault();
    setFocusedDate(next);
    setVisibleMonth(monthKey(next));
    focusAfterRender.current = true;
  };

  const stepDescription = rangeComplete
    ? "当前范围已选好，点一个日期可重新选择开始日期"
    : step === "start"
      ? "第 1 步：选择开始日期"
      : "第 2 步：选择结束日期，开始于 " + formatDateLabel(fromDate);

  return <div className="assistant-history-range-control" ref={controlRef}>
    <button
      className="secondary-button assistant-history-range-trigger"
      type="button"
      disabled={disabled}
      aria-label={"日期范围：" + rangeLabel}
      aria-expanded={open}
      aria-controls={popoverId}
      data-testid="assistant-history-range-trigger"
      data-start={fromDate}
      data-end={toDate}
      onClick={() => onOpenChange(!open)}
    >
      <CalendarDays size={16} aria-hidden="true" />
      <span>{rangeLabel}</span>
    </button>
    {open && !disabled ? <div ref={popoverRef} className="assistant-history-range-popover" id={popoverId} data-testid="assistant-history-range-popover" data-selection-step={stepState} data-start={fromDate} data-end={toDate} role="group" aria-labelledby={headingId}>
      <div className="assistant-history-range-popover-head">
        <p className="assistant-history-range-step" aria-live="polite">{stepDescription}</p>
        <button className="assistant-history-range-clear" type="button" onClick={() => {
          onChange("", "");
          setStep("start");
          onOpenChange(false);
        }}>全部日期</button>
      </div>
      <div className="assistant-history-range-month-nav">
        <button className="assistant-history-range-month-button" type="button" data-month-shift="-1" aria-label="上个月" onClick={() => changeVisibleMonth(-1)}><ChevronLeft size={17} aria-hidden="true" /></button>
        <h3 className="assistant-history-range-month-title" id={headingId} data-visible-month={visibleMonth} aria-live="polite">
          <span className="assistant-history-range-visually-hidden">{formatMonthLabel(visibleMonth)}</span>
          <select className="assistant-history-range-month-select" aria-label="选择年份" value={year} onChange={(event) => {
            const nextYear = Number(event.target.value);
            setVisibleMonth(String(nextYear).padStart(4, "0") + "-" + String(month).padStart(2, "0"));
          }}>
            {years.map((item) => <option value={item} key={item}>{item}年</option>)}
          </select>
          <select className="assistant-history-range-month-select" aria-label="选择月份" value={month} onChange={(event) => {
            setVisibleMonth(String(year).padStart(4, "0") + "-" + String(Number(event.target.value)).padStart(2, "0"));
          }}>
            {Array.from({ length: 12 }, (_, index) => index + 1).map((item) => <option value={item} key={item}>{item}月</option>)}
          </select>
        </h3>
        <button className="assistant-history-range-month-button" type="button" data-month-shift="1" aria-label="下个月" onClick={() => changeVisibleMonth(1)}><ChevronRight size={17} aria-hidden="true" /></button>
      </div>
      <div className="assistant-history-range-grid" role="grid" aria-label={formatMonthLabel(visibleMonth) + "日期"}>
        <div className="assistant-history-range-week" role="row">
          {["一", "二", "三", "四", "五", "六", "日"].map((label) => <span role="columnheader" key={label}>{label}</span>)}
        </div>
        {Array.from({ length: 6 }, (_, week) => <div className="assistant-history-range-week" role="row" key={visibleMonth + "-" + week}>
          {days.slice(week * 7, week * 7 + 7).map((date) => {
            const value = toDateKey(date);
            const isStart = value === fromDate;
            const isEnd = value === toDate && toDate.length > 0;
            const isInRange = fromDate.length > 0 && (toDate.length === 0
              ? value === fromDate
              : value >= fromDate && value <= toDate);
            const isOutsideMonth = monthKey(value) !== visibleMonth;
            const classes = [
              "assistant-history-range-day",
              isOutsideMonth ? "is-outside-month" : "",
              isInRange ? "is-in-range" : "",
              isStart ? "is-range-start" : "",
              isEnd ? "is-range-end" : "",
              value === today ? "is-today" : "",
            ].filter(Boolean).join(" ");
            return <span role="gridcell" key={value}>
              <button
                className={classes}
                type="button"
                data-date={value}
                aria-label={formatDateLabel(value) + (isStart ? "，开始日期" : "") + (isEnd ? "，结束日期" : "")}
                aria-pressed={isStart || isEnd}
                aria-current={value === today ? "date" : undefined}
                ref={(element) => {
                  if (element === null) dayButtons.current.delete(value);
                  else dayButtons.current.set(value, element);
                }}
                onKeyDown={(event) => handleDayKeyDown(event, value)}
                onClick={() => chooseDate(value)}
              >{date.getDate()}</button>
            </span>;
          })}
        </div>)}
      </div>
      <p className="assistant-history-range-hint">开始和结束日期都包含在搜索范围内。</p>
    </div> : null}
  </div>;
}
