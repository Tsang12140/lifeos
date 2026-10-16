import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import "./record-search.css";

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  label: string;
  filter?: {
    label: string;
    value: string;
    defaultValue: string;
    options: readonly { value: string; label: string }[];
    onChange: (value: string) => void;
  };
};

/** The library uses the home search's pill, sizing steps and mobile sheet. */
export function LibrarySearch({ query, onQueryChange, label, filter }: Props) {
  const value = filter?.value ?? "", defaultValue = filter?.defaultValue ?? "";
  const id = useId(), root = useRef<HTMLElement>(null), inputRef = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null), filterButton = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null), popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), composing = useRef(false);
  const latest = useRef(onQueryChange); latest.current = onQueryChange;
  const [input, setInput] = useState(query), [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false), [filterOpen, setFilterOpen] = useState(false);
  const [draft, setDraft] = useState(value), [width, setWidth] = useState(192), [above, setAbove] = useState(false);
  const cancelPending = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const commit = (text: string) => { cancelPending(); latest.current(text.trim()); };
  const change = (text: string) => {
    setInput(text); setFilterOpen(false); cancelPending();
    if (!composing.current) timer.current = setTimeout(() => latest.current(text.trim()), 180);
  };
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useEffect(() => { cancelPending(); setInput(query); }, [query]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { setOpen(false); setFilterOpen(false); setFocused(false); }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useLayoutEffect(() => {
    let active = true;
    const measure = () => {
      if (!active || window.innerWidth <= 600 || !root.current || !measureRef.current) return;
      if (!input && !focused && !filterOpen) { setWidth(192); return; }
      const pill = root.current.querySelector<HTMLElement>(".record-search-pill");
      if (!pill) return;
      const style = getComputedStyle(pill), px = (s: string) => Number.parseFloat(s) || 0;
      const icons = [...pill.querySelectorAll<HTMLElement>(":scope > .record-search-icon")];
      const required = px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
        + icons.reduce((sum, icon) => sum + icon.getBoundingClientRect().width, 0) + px(style.columnGap) * icons.length
        + Math.max(56, measureRef.current.getBoundingClientRect().width + 16);
      const step = required <= 192 ? 192 : required <= 256 ? 256 : 320;
      setWidth(previous => Math.max(previous, step));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (root.current?.parentElement) observer.observe(root.current.parentElement);
    window.addEventListener("resize", measure); void document.fonts.ready.then(measure);
    return () => { active = false; observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [input, focused, filterOpen]);
  useLayoutEffect(() => {
    if (!filterOpen) return;
    const place = () => { if (popup.current && root.current) setAbove(window.innerWidth > 600 && root.current.getBoundingClientRect().top >= popup.current.offsetHeight + 24); };
    place(); const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [filterOpen]);
  const finish = () => { filter?.onChange(draft); setFilterOpen(false); filterButton.current?.focus(); };
  const active = Boolean(filter && value !== defaultValue);
  return <section ref={root} className={`record-search library-search ${open ? "is-search-open" : ""} ${focused || filterOpen ? "is-engaged" : ""}`} style={{ "--record-search-width": `${width}px` } as CSSProperties} aria-label={label + (filter ? "与筛选" : "")} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }} onKeyDown={event => {
    if (event.key !== "Escape" || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault(); event.stopPropagation();
    if (filterOpen) { setFilterOpen(false); filterButton.current?.focus(); }
    else { setOpen(false); setFocused(false); if (window.innerWidth <= 600) trigger.current?.focus(); else inputRef.current?.blur(); }
  }}>
    <button ref={trigger} type="button" className={`record-search-mobile-trigger ${query || active ? "is-active" : ""}`} aria-label={label} aria-expanded={open} aria-controls={`${id}-sheet`} onClick={() => { setOpen(!open); setFilterOpen(false); if (!open) requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })); }}><Search size={18} aria-hidden="true" /></button>
    <div className="record-search-sheet" id={`${id}-sheet`}>
      <span className="record-search-measure-clip" aria-hidden="true"><span ref={measureRef} className="record-search-measure">{input}</span></span>
      <form role="search" onSubmit={event => { event.preventDefault(); if (composing.current) return; commit(input); if (filterOpen) finish(); else { setOpen(false); setFocused(false); inputRef.current?.blur(); } }}>
        <div className="record-search-pill">
          <button className="record-search-icon record-search-leading" type="submit" aria-label="提交搜索"><Search size={16} aria-hidden="true" /></button>
          <div className="record-search-input-content"><input ref={inputRef} type="search" aria-label={label} value={input} onFocus={() => setFocused(true)} onChange={event => change(event.target.value)} onCompositionStart={() => { composing.current = true; cancelPending(); }} onCompositionEnd={event => { composing.current = false; change(event.currentTarget.value); }} onKeyDown={event => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} /></div>
          {input ? <button className="record-search-icon" type="button" aria-label="清空搜索" onClick={() => { setInput(""); commit(""); inputRef.current?.focus(); }}><X size={15} aria-hidden="true" /></button> : null}
          {filter ? <button ref={filterButton} className={`record-search-icon record-search-filter ${filterOpen || active ? "is-active" : ""}`} type="button" aria-label={filter.label} aria-haspopup="dialog" aria-expanded={filterOpen} aria-controls={`${id}-filters`} onClick={() => { commit(input); setDraft(value); setFilterOpen(!filterOpen); }}><SlidersHorizontal size={16} aria-hidden="true" />{active ? <span className="record-search-badge">1</span> : null}</button> : null}
        </div>
        {filter && filterOpen ? <div ref={popup} id={`${id}-filters`} className={`record-search-panel record-search-popup ${above ? "is-above" : ""}`} role="dialog" aria-label={filter.label}>
          <div className="record-search-options" role="group" aria-label={filter.label}>{filter.options.map(option => <button key={option.value} type="button" className="record-filter-option" aria-pressed={draft === option.value} onClick={() => setDraft(option.value)}>{option.label}</button>)}</div>
          <div className="record-search-footer"><button className="secondary-button" type="button" onClick={() => setDraft(defaultValue)}>清空</button><button className="primary-button" type="submit">完成</button></div>
        </div> : null}
      </form>
    </div>
  </section>;
}
