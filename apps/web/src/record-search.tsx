import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { MapPin, Search, SlidersHorizontal, UserRound, X } from "lucide-react";
import { entitySearchTerms, normalizeEntitySearchTerm, type Entity } from "@lifeos/core";
import { EMPTY_SEARCH_FILTERS, hasSearchFilters, SearchFilterChips, SearchFilterFields, type SearchFilters } from "./search-filters";
import "./record-search.css";

type EntityKey = "personIds" | "placeIds" | "entityIds";
type Token = { key: EntityKey; id: string; entity?: Entity };
const tokenLabel = (token: Token) => token.key === "personIds" ? "人物" : token.key === "placeIds" ? "地点" : "对象";
type SearchProps = {
  query: string; filters: SearchFilters; entities: readonly Entity[];
  open: boolean; onOpenChange: (value: boolean) => void;
  onApply: (query: string, filters: SearchFilters) => void;
};

export function RecordSearch({ query, filters, entities, open, onOpenChange, onApply }: SearchProps) {
  const id = useId(), root = useRef<HTMLElement>(null), inputRef = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null), filterButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), composing = useRef(false);
  const latest = useRef({ filters, onApply });
  latest.current = { filters, onApply };
  const [input, setInput] = useState(query), [focused, setFocused] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false), [draft, setDraft] = useState(filters);
  const [editing, setEditing] = useState<Token | null>(null), [cursor, setCursor] = useState(0), [limit, setLimit] = useState(6);
  const [width, setWidth] = useState(192);
  const textMeasure = useRef<HTMLSpanElement>(null);
  const cancelPending = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useEffect(() => { cancelPending(); setInput(query); }, [query]);
  useEffect(() => { if (filters === EMPTY_SEARCH_FILTERS) { cancelPending(); setEditing(null); setInput(query); } }, [filters]);
  useEffect(() => {
    if (open) { setFocused(true); inputRef.current?.focus({ preventScroll: true }); root.current?.scrollIntoView({ block: "nearest" }); }
  }, [open]);
  const close = () => {
    setFocused(false); setFilterOpen(false); setCursor(0);
    if (editing) { setEditing(null); setInput(query); }
    onOpenChange(false);
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  });
  const commit = (text: string, next = filters) => { cancelPending(); onApply(text.trim(), next); };
  const changeInput = (text: string) => {
    setInput(text); setCursor(0); setLimit(6); setFilterOpen(false); cancelPending();
    // Keep Chinese composition intact. Plain text always remains a broad query.
    if (!composing.current && !editing) timer.current = setTimeout(() => latest.current.onApply(text.trim(), latest.current.filters), 180);
  };
  const tokens = (["personIds", "placeIds", "entityIds"] as const).flatMap(key => filters[key].map(id => ({ key, id, entity: entities.find(entity => entity.id === id) })));
  useLayoutEffect(() => {
    let active = true;
    const measure = () => {
      if (!active || window.innerWidth <= 600 || !root.current || !inputRef.current || !textMeasure.current) return;
      if (!input && tokens.length === 0 && !focused && !filterOpen) { setWidth(192); return; }
      const pill = root.current.querySelector<HTMLElement>(".record-search-pill");
      const content = root.current.querySelector<HTMLElement>(".record-search-input-content");
      if (!pill || !content) return;
      const px = (value: string) => Number.parseFloat(value) || 0;
      const style = getComputedStyle(pill), contentStyle = getComputedStyle(content);
      const icons = [...pill.querySelectorAll<HTMLElement>(":scope > .record-search-icon")];
      const tokenWidths = [...content.querySelectorAll<HTMLElement>(".record-search-token")].reduce((total, token) => {
        const name = token.querySelector<HTMLElement>(".record-search-token-name span");
        // scrollWidth recovers the full label even when a long token is truncated.
        return total + token.getBoundingClientRect().width + (name ? name.scrollWidth - name.getBoundingClientRect().width : 0);
      }, 0);
      const required = px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
        + icons.reduce((total, icon) => total + icon.getBoundingClientRect().width, 0) + px(style.columnGap) * icons.length
        + tokenWidths + px(contentStyle.columnGap) * tokens.length + Math.max(56, textMeasure.current.getBoundingClientRect().width + 16);
      const step = required <= 192 ? 192 : required <= 256 ? 256 : 320;
      // Keep the right edge anchored and retain expanded width while content remains.
      setWidth(previous => Math.max(previous, step));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (root.current?.parentElement) observer.observe(root.current.parentElement);
    window.addEventListener("resize", measure);
    void document.fonts.ready.then(measure);
    return () => { active = false; observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [input, filters.personIds, filters.placeIds, filters.entityIds, entities, focused, filterOpen]);
  const term = normalizeEntitySearchTerm(input);
  const matches = entities.filter(entity => (entity.type === "person" || entity.type === "place") && term && entitySearchTerms(entity).some(name => normalizeEntitySearchTerm(name).includes(term)))
    .filter(entity => !tokens.some(token => token.id === entity.id) || editing?.id === entity.id)
    .sort((a, b) => Number(entitySearchTerms(b).some(name => normalizeEntitySearchTerm(name) === term)) - Number(entitySearchTerms(a).some(name => normalizeEntitySearchTerm(name) === term)));
  const choices = matches.slice(0, limit);
  const matchKey = matches.map(entity => entity.id).join(",");
  useLayoutEffect(() => { setCursor(0); }, [input, matchKey]);
  const suggestionsOpen = focused && choices.length > 0 && !filterOpen;
  const popup = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    if (!suggestionsOpen && !filterOpen) return;
    const place = () => {
      if (!popup.current || !root.current) return;
      setAbove(window.innerWidth > 600 && root.current.getBoundingClientRect().top >= popup.current.offsetHeight + 24);
    };
    place();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [suggestionsOpen, filterOpen]);
  const choose = (entity: Entity) => {
    const key = entity.type === "person" ? "personIds" : "placeIds";
    const next = { ...filters };
    if (editing) next[editing.key] = next[editing.key].filter(id => id !== editing.id);
    next[key] = [...new Set([...next[key], entity.id])];
    setInput(""); setEditing(null); setCursor(0); commit("", next); inputRef.current?.focus();
  };
  const remove = (token: Token) => {
    const text = editing ? query : input;
    setEditing(null); setInput(text); commit(text, { ...filters, [token.key]: filters[token.key].filter(id => id !== token.id) });
    inputRef.current?.focus();
  };
  const auxiliary = { ...filters, personIds: [], placeIds: [], entityIds: [] };
  const filterCount = auxiliary.kinds.length + auxiliary.attachments.length + auxiliary.entityTypes.length + auxiliary.statuses.length + Number(Boolean(auxiliary.from || auxiliary.to)) + Number(Boolean(auxiliary.assisted || auxiliary.backfill === "ai")) + Number(auxiliary.backfill === "all");
  const invalidRange = Boolean(draft.from && draft.to && draft.from > draft.to);
  const applyFilters = () => {
    if (invalidRange) return;
    commit(editing ? query : input, { ...draft, personIds: filters.personIds, placeIds: filters.placeIds, entityIds: filters.entityIds });
    setFilterOpen(false); filterButton.current?.focus();
  };
  return <section ref={root} style={{ "--record-search-width": `${width}px` } as CSSProperties} className={`record-search ${open ? "is-search-open" : ""} ${focused || filterOpen ? "is-engaged" : ""}`} aria-label="搜索与筛选" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }} onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && !composing.current) {
      event.preventDefault(); event.stopPropagation();
      if (filterOpen) { setFilterOpen(false); filterButton.current?.focus(); }
      else { close(); if (window.matchMedia("(max-width: 600px)").matches) trigger.current?.focus(); else inputRef.current?.blur(); }
    }
  }}>
    <button ref={trigger} className={`record-search-mobile-trigger ${query || hasSearchFilters(filters) ? "is-active" : ""}`} type="button" aria-label="搜索记录" aria-expanded={open} aria-controls={`${id}-sheet`} onClick={() => onOpenChange(!open)}><Search size={18} aria-hidden="true" /></button>
    <div className="record-search-sheet" id={`${id}-sheet`}>
      <span className="record-search-measure-clip" aria-hidden="true"><span ref={textMeasure} className="record-search-measure">{input}</span></span>
      <form role="search" onSubmit={event => { event.preventDefault(); if (composing.current) return; if (filterOpen) applyFilters(); else { commit(input, editing ? { ...filters, [editing.key]: filters[editing.key].filter(id => id !== editing.id) } : filters); setEditing(null); setFocused(false); onOpenChange(false); inputRef.current?.blur(); } }}>
        <div className="record-search-pill">
          <button className="record-search-icon record-search-leading" type="submit" aria-label="提交搜索" disabled={filterOpen && invalidRange}><Search size={16} aria-hidden="true" /></button>
          <div className="record-search-input-content">
            {tokens.map(token => <span className={`record-search-token mention-chip ${token.entity?.type === "place" ? "is-place" : ""} ${editing?.id === token.id ? "is-editing" : ""}`} key={`${token.key}:${token.id}`}>
              <button className="record-search-token-name" type="button" title={token.entity?.name} aria-label={`重新选择${tokenLabel(token)} ${token.entity?.name ?? "已删除的对象"}`} onClick={() => { cancelPending(); setEditing(token); setInput(token.entity?.name ?? ""); setFocused(true); setFilterOpen(false); setCursor(0); setLimit(6); onOpenChange(true); inputRef.current?.focus(); }}>{token.entity?.type === "place" ? <MapPin size={12} aria-hidden="true" /> : null}<span>{token.entity?.name ?? "已删除的对象"}</span></button>
              <button className="record-search-token-remove" type="button" aria-label={`移除${tokenLabel(token)} ${token.entity?.name ?? "已删除的对象"}`} onClick={() => remove(token)}><X size={12} aria-hidden="true" /></button>
            </span>)}
            <input ref={inputRef} type="search" aria-label="搜索关键词" role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen && choices.length > 0} aria-controls={`${id}-choices`} aria-activedescendant={suggestionsOpen && choices[cursor] ? `${id}-choice-${cursor}` : undefined} value={input} onFocus={() => { setFocused(true); setCursor(0); }} onChange={event => changeInput(event.target.value)} onCompositionStart={() => { composing.current = true; cancelPending(); }} onCompositionEnd={event => { composing.current = false; changeInput(event.currentTarget.value); }} onKeyDown={event => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (suggestionsOpen && choices.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setCursor(current => event.key === "ArrowDown" ? (current + 1) % choices.length : (current <= 0 ? choices.length - 1 : current - 1)); }
              if (event.key === "Enter" && suggestionsOpen && cursor >= 0 && choices[cursor]) { event.preventDefault(); choose(choices[cursor]!); }
              if (event.key === "Backspace" && !input && tokens.length) { event.preventDefault(); remove(tokens[tokens.length - 1]!); }
            }} />
          </div>
          {input ? <button className="record-search-icon" type="button" aria-label="清空搜索" onClick={() => { setEditing(null); setInput(""); commit(""); inputRef.current?.focus(); }}><X size={15} aria-hidden="true" /></button> : null}
          <button ref={filterButton} className={`record-search-icon record-search-filter ${filterOpen || filterCount ? "is-active" : ""}`} type="button" aria-label="筛选记录" aria-haspopup="dialog" aria-expanded={filterOpen} aria-controls={`${id}-filters`} onClick={() => { if (!editing && input.trim() !== query) commit(input); setDraft(filters); setFilterOpen(!filterOpen); setFocused(false); if (editing) setInput(query); setEditing(null); }}><SlidersHorizontal size={16} aria-hidden="true" />{filterCount ? <span className="record-search-badge">{filterCount}</span> : null}</button>
        </div>
        {suggestionsOpen ? <div ref={popup} className={`record-search-suggestions record-search-popup ${above ? "is-above" : ""}`}>
          <div role="listbox" id={`${id}-choices`} aria-label="匹配的人物与地点">{choices.map((entity, index) => <button className="record-search-choice" role="option" aria-selected={cursor === index} id={`${id}-choice-${index}`} key={entity.id} type="button" aria-label={`限定${entity.type === "person" ? "人物" : "地点"} ${entity.name}`} onMouseDown={event => event.preventDefault()} onClick={() => choose(entity)}>{entity.type === "person" ? <UserRound size={15} aria-hidden="true" /> : <MapPin size={15} aria-hidden="true" />}<span>{entity.name}</span><small>{entity.type === "person" ? "人物" : "地点"}</small></button>)}</div>
          {matches.length > choices.length ? <button className="record-filter-link" type="button" onClick={() => setLimit(value => value + 6)}>再显示 {Math.min(6, matches.length - choices.length)} 项</button> : null}
        </div> : null}
        {filterOpen ? <div ref={popup} className={`record-search-panel record-search-popup ${above ? "is-above" : ""}`} id={`${id}-filters`} role="dialog" aria-label="筛选记录">
          <SearchFilterFields value={draft} onChange={setDraft} />
          {invalidRange ? <p className="record-search-error" role="alert">结束日期不能早于开始日期。</p> : null}
          <div className="record-search-footer"><button className="secondary-button" type="button" onClick={() => setDraft({ ...EMPTY_SEARCH_FILTERS, personIds: filters.personIds, placeIds: filters.placeIds, entityIds: filters.entityIds })}>清空</button><button className="primary-button" type="submit" disabled={invalidRange}>完成</button></div>
        </div> : null}
      </form>
    </div>
  </section>;
}

export function RecordSearchResults({ query, filters, entities, onApply, count, loading, error }: Omit<SearchProps, "open" | "onOpenChange"> & { count: number | null; loading: boolean; error: string | null }) {
  if (!query && !hasSearchFilters(filters)) return null;
  const countLabel = filters.personIds.length + filters.placeIds.length + filters.entityIds.length > 1 ? "全部符合" : "找到";
  return <div className="record-search-results">
    <div className="record-search-tags"><SearchFilterChips value={filters} entities={entities} hideEntities onChange={value => onApply(query, value)} /></div>
    <div className="record-search-result-actions"><span role="status">{error ? "结果读取失败" : loading || count === null ? "正在查找…" : `${countLabel} ${count} 条记录`}</span><button className="record-search-reset" type="button" onClick={() => onApply("", EMPTY_SEARCH_FILTERS)}>清空筛选</button></div>
  </div>;
}
