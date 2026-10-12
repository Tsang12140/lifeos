import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parse = (value: string) => new Date(`${value}T12:00:00`);

// Inline calendar: it grows the filter panel instead of creating another popover.
export function SearchDateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const [month, setMonth] = useState(() => (from || today).slice(0, 7));
  const [choosingEnd, setChoosingEnd] = useState(Boolean(from && !to));
  const first = parse(`${month}-01`), offset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index, 12));
  const shift = (amount: number) => setMonth(dateKey(new Date(first.getFullYear(), first.getMonth() + amount, 1, 12)).slice(0, 7));
  const choose = (value: string) => {
    if (!choosingEnd || !from || value < from) { onChange(value, ""); setChoosingEnd(true); }
    else { onChange(from, value); setChoosingEnd(false); }
    setMonth(value.slice(0, 7));
  };
  return <div className="search-range-calendar" aria-label="自定义日期范围">
    <div className="search-range-nav"><button className="record-search-icon" type="button" aria-label="上个月" onClick={() => shift(-1)}><ChevronLeft size={16} /></button><input type="month" aria-label="选择月份" value={month} onChange={event => { if (event.target.value) setMonth(event.target.value); }} /><button className="record-search-icon" type="button" aria-label="下个月" onClick={() => shift(1)}><ChevronRight size={16} /></button></div>
    <p className="record-search-hint" aria-live="polite">{choosingEnd ? "选择结束日期" : from && to ? `${from} 至 ${to}` : "选择开始日期"}</p>
    <div className="search-range-grid">{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>{day}</span>)}{days.map(date => {
      const key = dateKey(date), selected = key === from || key === to;
      return <button key={key} type="button" aria-label={`选择日期 ${key}`} aria-pressed={selected} aria-current={key === today ? "date" : undefined} className={`${key.slice(0, 7) !== month ? "is-other-month" : ""} ${selected ? "is-selected" : ""} ${from && to && key > from && key < to ? "is-in-range" : ""}`} onClick={() => choose(key)}>{date.getDate()}</button>;
    })}</div>
  </div>;
}
