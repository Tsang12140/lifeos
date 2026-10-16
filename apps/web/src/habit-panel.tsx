import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Plus, X } from "lucide-react";
import { HABIT_ICONS, type CustomHabit } from "@lifeos/core";
import { HabitIcon } from "./habit-icon";
import "./habits.css";

export interface HabitActions {
  readonly save: (habit: CustomHabit | null, name: string, icon: string) => Promise<void>;
  readonly mark: (habit: CustomHabit, date: string, marked: boolean) => Promise<void>;
}

export function HabitDayMarkers({ habits, date }: { readonly habits: readonly CustomHabit[]; readonly date: string }) {
  return <>{habits.filter(habit => habit.dates.includes(date)).map(habit => <span className="habit-day-marker" data-habit-marker={habit.id} aria-label={habit.name} title={habit.name} key={habit.id}><HabitIcon name={habit.icon} size={13} /></span>)}</>;
}

export function CustomHabitPanel({ habits, date: initialDate, today, actions, compact = false, menu = false, disabled = false, management = false }: { readonly management?: boolean; readonly compact?: boolean; readonly menu?: boolean; readonly disabled?: boolean; readonly habits: readonly CustomHabit[]; readonly date: string; readonly today: string; readonly actions: HabitActions }) {
  const [localDate, setDate] = useState(initialDate);
  useEffect(() => setDate(initialDate), [initialDate]);
  const date = compact ? initialDate : localDate;
  const [editor, setEditor] = useState<CustomHabit | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("BookOpen");
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [ownBusy, setBusy] = useState(false);
  const busy = ownBusy || disabled;
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (editor !== undefined) dialog.current?.showModal(); }, [editor]);
  const openEditor = (habit: CustomHabit | null) => {
    setEditor(habit); setName(habit?.name ?? ""); setIcon(habit?.icon ?? "BookOpen"); setCategory("全部"); setQuery(""); setError("");
  };
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await work(); } catch (err) { setError(err instanceof Error ? err.message : "操作失败，请重试"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const categories = ["全部", ...new Set(HABIT_ICONS.map(item => item.category))];
  const icons = HABIT_ICONS.filter(item => (category === "全部" || item.category === category) && (!query.trim() || [item.id, item.label, item.category].join(" ").toLowerCase().includes(query.trim().toLowerCase())));
  return <section className={"custom-habit-panel" + (compact ? " is-compact" : "") + (management ? " is-management" : "")} aria-label="自定义习惯" aria-busy={busy}>
    <div className="habit-panel-heading">{!compact ? <><strong>我的习惯</strong>{!management ? <label className="habit-date"><span>标记日期</span><input aria-label="习惯标记日期" type="date" value={date} max={today} disabled={busy} onChange={event => { if (event.target.value) setDate(event.target.value); }} /></label> : null}</> : null}<button className="secondary-button habit-new-button" type="button" disabled={busy} onClick={() => openEditor(null)}><Plus size={14} />新建习惯</button></div>
    {habits.length === 0 ? <p className="habit-empty">{management ? "添加习惯，设置图标和名称。" : "添加一个习惯，选择图标和名称，再按日期标记完成。"}</p> : <div className="habit-list">{habits.map(habit => {
      const marked = habit.dates.includes(date);
      return <div className="habit-row" key={habit.id} data-habit-id={habit.id}>
        {management ? <span className="habit-management-label"><HabitIcon name={habit.icon} /><span>{habit.name}</span></span> : <button className={`habit-mark-button ${marked ? "is-marked" : ""}`} type="button" role={menu ? "menuitemcheckbox" : compact ? "checkbox" : undefined} aria-checked={compact ? marked : undefined} aria-pressed={compact ? undefined : marked} aria-label={`${marked ? "移除" : "标记"}${habit.name} ${date}`} disabled={busy || date > today} onClick={() => void run(() => actions.mark(habit, date, !marked))}><span className="habit-check">{marked ? <Check size={12} /> : null}</span><HabitIcon name={habit.icon} /><span>{habit.name}</span></button>}
        <button className="icon-button compact-icon-button" type="button" disabled={busy} aria-label={`编辑习惯 ${habit.name}`} onClick={() => openEditor(habit)}><Pencil size={14} /></button>
      </div>;
    })}</div>}
    {!management && date > today ? <p className="habit-empty">未来日期尚未发生，不能标记完成。</p> : null}
    {error && editor === undefined ? <p className="habit-error" role="alert">{error}</p> : null}
    {editor !== undefined ? <dialog ref={dialog} className="habit-dialog" aria-label={editor ? "编辑习惯" : "新建习惯"} onCancel={event => { event.preventDefault(); if (!busy) setEditor(undefined); }}>
      <form onSubmit={event => { event.preventDefault(); void run(async () => { await actions.save(editor ?? null, name.trim(), icon); setEditor(undefined); }); }}>
        <div className="habit-dialog-header"><strong>{editor ? "编辑习惯" : "新建习惯"}</strong><button className="icon-button" type="button" disabled={busy} aria-label="关闭习惯编辑" onClick={() => setEditor(undefined)}><X size={18} /></button></div>
        <div className="habit-dialog-body">
          <label className="habit-field"><span>名称</span><input aria-label="习惯名称" value={name} maxLength={40} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <div className="habit-icon-preview"><HabitIcon name={icon} size={24} /><span>{HABIT_ICONS.find(item => item.id === icon)?.label}</span><small>{HABIT_ICONS.length} 个图标，12 个分类</small></div>
          <label className="habit-field"><span>搜索图标</span><input aria-label="搜索习惯图标" type="search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
          <div className="habit-icon-categories" aria-label="图标分类">{categories.map(item => <button type="button" key={item} aria-pressed={category === item} disabled={busy} onClick={() => setCategory(item)}>{item}</button>)}</div>
          <div className="habit-icon-grid" aria-label="习惯图标">{icons.map(item => <button type="button" key={item.id} data-habit-icon={item.id} aria-label={item.label} aria-pressed={icon === item.id} disabled={busy} onClick={() => setIcon(item.id)} title={item.label}><HabitIcon name={item.id} size={22} /><span>{item.label}</span></button>)}</div>
          {icons.length === 0 ? <p className="habit-empty">没有匹配图标，可更换分类或搜索词。</p> : null}
          {error ? <p className="habit-error" role="alert">{error}</p> : null}
        </div>
        <div className="habit-dialog-footer habit-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setEditor(undefined)}>取消</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "保存中" : "保存习惯"}</button></div>
      </form>
    </dialog> : null}
  </section>;
}
