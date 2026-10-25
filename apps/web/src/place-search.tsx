import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PLACE_CITY_CATALOG, PLACE_ROLES, type Entity, type Place, type PlaceDetails } from "@lifeos/core";
import { apiRequest } from "./api";
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, LocateFixed, Plus, Search, X } from "lucide-react";
import { consumeDateOutsidePress as consumeOutsidePress } from "./date-popover";
import { describeWeatherLocation } from "./weather-locations";
import { PLACE_ROLE_LABELS, placeRoleLabel } from "./mention";
import { placeSearchPoint, requestPlaceSearchPoint, recommendedPlaceCities, type DevicePoint } from "./place-search-options";
import "./place-search.css";

export interface PlaceDraft extends PlaceDetails { name: string; address?: string; role?: string; category?: string }
export type PlaceChoice = Place | PlaceDraft;
export function placeDetailsOf(value: PlaceDetails): PlaceDetails {
  return Object.fromEntries((["phone", "city", "province", "district", "longitude", "latitude", "amapId", "photoUrl"] as const).flatMap(key => value[key] === undefined ? [] : [[key, value[key]]]));
}
export function PlaceRoleField({ value, onChange, disabled = false, entities = [], suggestFor }: { value: string; onChange: (value: string) => void; disabled?: boolean; entities?: readonly Entity[]; suggestFor?: { name: string; address: string; category?: string } }) {
  const id = useId();
  const touched = useRef(false), lastAuto = useRef("");
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  const [recommendation, setRecommendation] = useState<"pending" | "suggested" | null>(null);
  useEffect(() => {
    if (!suggestFor || disabled || touched.current || latest.current.value && latest.current.value !== lastAuto.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (lastAuto.current && latest.current.value === lastAuto.current) { lastAuto.current = ""; latest.current.onChange(""); }
      setRecommendation("pending");
      void apiRequest<{ role: string | null; source: string }>("/api/places/role-suggestion", { method: "POST", signal: controller.signal, body: JSON.stringify(suggestFor) }).then(result => {
        if (controller.signal.aborted || touched.current) return;
        if (result.role) { lastAuto.current = result.role; latest.current.onChange(result.role); setRecommendation("suggested"); }
        else setRecommendation(null);
      }).catch(() => { if (!controller.signal.aborted) setRecommendation(null); });
    }, 650);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [suggestFor?.name, suggestFor?.address, suggestFor?.category, disabled]);
  const [known, setKnown] = useState<readonly Entity[]>([]);
  useEffect(() => { const controller = new AbortController(); void apiRequest<{ items: Entity[] }>("/api/entities?type=place", { signal: controller.signal }).then(value => setKnown(value.items)).catch(() => {}); return () => controller.abort(); }, []);
  const options = [...new Set([...PLACE_ROLES, ...[...known, ...entities].flatMap(entity => entity.type === "place" && entity.role ? [entity.role] : [])])];
  return <label className="dialog-field place-role-field"><span>地点角色</span><input aria-label="地点角色" maxLength={30} list={id} value={placeRoleLabel(value)} disabled={disabled} placeholder="选填" onChange={event => { touched.current = true; setRecommendation(null); const label = event.target.value; onChange(Object.keys(PLACE_ROLE_LABELS).find(key => PLACE_ROLE_LABELS[key] === label) ?? label); }} /><datalist id={id}>{options.map(role => <option key={role} value={placeRoleLabel(role)} />)}</datalist>{recommendation ? <small role="status">{recommendation === "pending" ? "推荐中…" : "已推荐，可修改"}</small> : null}</label>;
}
interface SearchItem extends PlaceDraft { distanceMeters?: number }
interface SearchPayload { items: SearchItem[]; page: number; hasMore: boolean; mode: "nearby" | "text"; origin?: Pick<DevicePoint, "latitude" | "longitude" | "accuracy"> }
export function PlaceSearch({ entities, initialQuery = "", recentPlaceIds = [], includePrivate = false, hideDemo = false, onPick, onManual, onDismiss, manualLabel = "新建地点", createOnly = false }: { entities?: readonly Entity[]; initialQuery?: string; recentPlaceIds?: readonly string[]; includePrivate?: boolean; hideDemo?: boolean; onPick: (choice: PlaceChoice) => Promise<void> | void; onManual?: (name: string) => void; onDismiss?: () => void; manualLabel?: string; createOnly?: boolean }) {
  const [local, setLocal] = useState<readonly Entity[]>(entities ?? []);
  const [query, setQuery] = useState(initialQuery), [city, setCity] = useState("");
  const [weatherCity, setWeatherCity] = useState("");
  const [suggestions, setSuggestions] = useState<{ frequent: string[]; recent: string[] }>({ frequent: [], recent: [] });
  const [recent, setRecent] = useState<readonly string[] | null>(null);
  const [geo, setGeo] = useState<{ ready: boolean; point: DevicePoint | null }>({ ready: createOnly, point: null });
  const [nationwide, setNationwide] = useState(createOnly), [radius, setRadius] = useState(5000);
  const [locateBusy, setLocateBusy] = useState(false), [locationError, setLocationError] = useState("");
  const locateVersion = useRef(0), locateController = useRef<AbortController | null>(null);
  const [localReady, setLocalReady] = useState(!!entities), [localError, setLocalError] = useState("");
  const [page, setPage] = useState(1), [retry, setRetry] = useState(0), [composing, setComposing] = useState(false);
  const [results, setResults] = useState<SearchPayload | null>(null);
  const [busy, setBusy] = useState(false), [picking, setPicking] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), token = useRef(0), selectionLock = useRef(false), immediate = useRef(false);
  const cityId = useId();
  const [scopeOpen, setScopeOpen] = useState(false);
  // The scope panel used to rely on a native <datalist>, which only offered a
  // handful of browser-filtered rows and could not be browsed. The city list is
  // now a real expandable picker over the full local catalog.
  const [cityPickerOpen, setCityPickerOpen] = useState(false), [cityFilter, setCityFilter] = useState(""), [selectedProvince, setSelectedProvince] = useState("");
  const cityCatalog = useMemo(() => Object.entries(PLACE_CITY_CATALOG).flatMap(([province, names]) => names.map(name => ({ province, name }))), []);
  const cityGroups = useMemo(() => {
    const needle = cityFilter.trim();
    const grouped = new Map<string, string[]>();
    for (const item of cityCatalog) {
      if (needle && !item.name.includes(needle) && !item.province.includes(needle)) continue;
      const list = grouped.get(item.province);
      if (list) list.push(item.name); else grouped.set(item.province, [item.name]);
    }
    return [...grouped];
  }, [cityFilter, cityCatalog]);
  const rootRef = useRef<HTMLElement>(null), scopeRef = useRef<HTMLButtonElement>(null);
  // Only the direct composer chooser owns the floating shell; embedded search
  // in the create form retains its surrounding layout.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!root || !host?.matches(".entity-picker-popover")) return;
    const anchor = host.parentElement;
    if (!anchor) return;
    let frame = 0;
    const place = () => {
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const box = anchor.getBoundingClientRect();
      const above = Math.max(0, box.top - y - 20), below = Math.max(0, y + height - box.bottom - 20);
      const room = Math.max(above, below), available = room < 220 ? height - 24 : room;
      host.style.position = "fixed"; host.style.width = `${Math.max(1, Math.min(360, width - 24))}px`;
      host.style.maxHeight = `${Math.max(1, available)}px`;
      root.style.maxHeight = `${Math.max(1, available - 14)}px`;
      const panelHeight = host.getBoundingClientRect().height;
      host.style.left = `${Math.max(x + 12, Math.min(box.left, x + width - host.getBoundingClientRect().width - 12))}px`;
      const top = below >= above ? box.bottom + 8 : box.top - 8 - panelHeight;
      host.style.top = `${Math.max(y + 12, Math.min(top, y + height - panelHeight - 12))}px`;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(anchor);
    window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule); window.visualViewport?.addEventListener("scroll", schedule);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule); };
  }, []);
  useEffect(() => {
    if (!onDismiss) return;
    const outside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!(event.target instanceof Node) || root?.contains(event.target) || root?.parentElement?.parentElement?.contains(event.target)) return;
      consumeOutsidePress(event); onDismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onDismiss]);
  useEffect(() => {
    const load = new AbortController();
    if (entities) { setLocal(entities); setLocalReady(true); return; }
    setLocalError("");
    void apiRequest<{ items: Entity[] }>("/api/entities?type=place", { signal: load.signal }).then(value => { if (!load.signal.aborted) { setLocal(value.items); setLocalReady(true); } }).catch(() => { if (!load.signal.aborted) setLocalError("暂时无法核对已有地点，请重试"); });
    return () => load.abort();
  }, [entities, retry]);
  useEffect(() => {
    let active = true;
    const load = new AbortController();
    void apiRequest<{ city?: string; locationId?: string }>("/api/weather/status", { signal: load.signal }).then(value => { if (active) setWeatherCity(describeWeatherLocation(value.locationId ?? "")?.city ?? value.city ?? ""); }).catch(() => {});
    if (!createOnly) void placeSearchPoint().then(point => { if (active) setGeo({ ready: true, point }); });
    return () => { active = false; load.abort(); controller.current?.abort(); token.current++; locateVersion.current++; locateController.current?.abort(); };
  }, []);
  useEffect(() => {
    const load = new AbortController();
    setRecent(null);
    void apiRequest<{ frequent: string[]; recent: string[]; recentPlaceIds?: string[] }>(`/api/places/cities?includePrivate=${includePrivate ? "1" : "0"}&hideDemo=${hideDemo ? "1" : "0"}`, { signal: load.signal }).then(value => {
      if (!load.signal.aborted) { setSuggestions(value); setRecent(value.recentPlaceIds ?? null); }
    }).catch(() => {});
    return () => load.abort();
  }, [includePrivate, hideDemo]);
  const reset = () => { controller.current?.abort(); token.current++; setBusy(false); setResults(null); setError(""); setPage(1); };
  const change = (nextQuery: string, nextCity: string) => { reset(); setQuery(nextQuery); setCity(nextCity); };
  const point = !city.trim() && !nationwide ? geo.point : null;
  const locating = !city.trim() && !nationwide && !geo.ready;
  useEffect(() => {
    controller.current?.abort();
    const current = ++token.current;
    if (!query.trim() || composing || picking || locating) return;
    const abort = new AbortController(); controller.current = abort;
    const delay = immediate.current ? 0 : 600; immediate.current = false;
    const timer = setTimeout(() => {
      setBusy(true); setError("");
      void apiRequest<SearchPayload>("/api/places/search", { method: "POST", body: JSON.stringify({ query: query.trim(), city: city.trim(), page, ...(point ? { location: { latitude: point.latitude, longitude: point.longitude, accuracy: point.accuracy }, radius } : {}) }), signal: abort.signal })
        .then(value => { if (current === token.current) setResults(value); })
        .catch(cause => { if (current === token.current && !abort.signal.aborted) { setResults(null); setError(cause instanceof Error ? cause.message : "搜索失败，请重试"); } })
        .finally(() => { if (current === token.current) setBusy(false); });
    }, delay);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [query, city, point, locating, radius, page, retry, composing, picking]);
  const pick = async (choice: PlaceChoice) => {
    if (selectionLock.current || busy) return;
    selectionLock.current = true; setPicking(true); setError("");
    try {
      if ("id" in choice && choice.amapId && choice.photoUrl && !choice.avatarAssetId) {
        const result = await apiRequest<{ entity: Place }>(`/api/entities/${encodeURIComponent(choice.id)}/photo/import`, { method: "POST" });
        choice = result.entity; setLocal(current => current.map(item => item.id === result.entity.id ? result.entity : item));
      }
      await onPick(choice);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "地点未能保存，请重试"); }
    finally { selectionLock.current = false; setPicking(false); }
  };
  const needle = query.trim().toLocaleLowerCase();
  const returnedIds = new Set(results?.items.map(item => item.amapId));
  const rank = new Map((recent ?? recentPlaceIds).map((id, index) => [id, index]));
  const saved = createOnly ? [] : local.filter((entity): entity is Place => entity.type === "place" && !returnedIds.has(entity.amapId)
    && (!city.trim() || entity.city?.trim().replace(/市$/u, "") === city.trim().replace(/市$/u, ""))
    && [entity.name, ...(entity.aliases ?? []), entity.city, entity.address].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle))
    .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)).slice(0, 12);
  const showCity = !city.trim();
  const cities = [...new Set([city, ...recommendedPlaceCities(weatherCity, suggestions.recent, suggestions.frequent)].filter(Boolean).map(name => name.replace(/市$/u, "")))];
  const visibleItems = (results?.items ?? []).filter(place => !createOnly || localReady && !local.some(entity => entity.type === "place" && !!place.amapId && entity.amapId === place.amapId));
  const mixed = saved.length > 0 && visibleItems.length > 0;
  const compactAddress = (place: PlaceDraft) => {
    let address = place.address?.trim() ?? "";
    for (const prefix of [place.province, place.city]) if (prefix && address.startsWith(prefix)) address = address.slice(prefix.length).trim();
    return [showCity ? undefined : place.city, address || place.district].filter(Boolean).join(" ");
  };
  const savedList = saved.length ? <div className="place-search-list">
    {mixed ? <h4>已有地点</h4> : null}
    {saved.map(place => {
      const duplicate = local.some(other => other.type === "place" && other.id !== place.id && other.name === place.name);
      return <button type="button" className="place-search-result" key={place.id} disabled={busy || picking} onClick={() => void pick(place)} title={[place.name, place.city, place.address].filter(Boolean).join(" ")}>
        <span><strong>{place.name}</strong>{duplicate ? <small className="place-search-address">{compactAddress(place)}</small> : null}</span>
        {showCity && place.city?.trim() ? <small className="place-search-city" title={place.city}>{place.city}</small> : null}
      </button>;
    })}
  </div> : null;
  const refresh = () => { reset(); immediate.current = true; setRetry(value => value + 1); };
  const selectScope = (nextCity: string, nextNationwide: boolean) => {
    locateVersion.current++; locateController.current?.abort(); setLocateBusy(false); setLocationError("");
    reset(); setCity(nextCity); setNationwide(nextNationwide); setScopeOpen(false); setCityPickerOpen(false); setCityFilter(""); setSelectedProvince(""); scopeRef.current?.focus();
  };
  const locate = async () => {
    if (locateBusy || picking) return;
    const version = ++locateVersion.current;
    locateController.current?.abort(); const abort = new AbortController(); locateController.current = abort;
    setLocateBusy(true); setLocationError(""); reset();
    try {
      const point = await requestPlaceSearchPoint(); if (version !== locateVersion.current) return;
      const result = await apiRequest<{ city: string }>("/api/places/locate", { method: "POST", signal: abort.signal, body: JSON.stringify({ latitude: point.latitude, longitude: point.longitude, accuracy: point.accuracy }) });
      if (version !== locateVersion.current || abort.signal.aborted) return;
      if (!result.city?.trim()) throw new Error("未能确定当前城市，请手动选择");
      setGeo({ ready: true, point }); setNationwide(false); setCity(result.city.trim()); setCityPickerOpen(false); setCityFilter(""); setSelectedProvince(""); setScopeOpen(false); immediate.current = true; setRetry(value => value + 1);
    } catch (cause) { if (version === locateVersion.current && !abort.signal.aborted) setLocationError(cause instanceof Error ? cause.message : "定位失败，请手动选择城市"); }
    finally { if (version === locateVersion.current) setLocateBusy(false); }
  };
  const scopeLabel = city.trim() || (nationwide || (geo.ready && !geo.point) ? "不限城市" : "附近");
  return <section ref={rootRef} className="place-search-panel" data-create-only={createOnly || undefined} aria-label="地址搜索" onKeyDown={event => {
    if (event.key === "Escape" && scopeOpen) { event.preventDefault(); event.stopPropagation(); setScopeOpen(false); scopeRef.current?.focus(); return; }
    if (event.key === "Escape" && onDismiss) {
      event.preventDefault(); event.stopPropagation();
      rootRef.current?.closest(".place-anchor")?.querySelector<HTMLButtonElement>('button[aria-label="插入地点"]')?.focus({ preventScroll: true });
      onDismiss(); return;
    }
    const root = rootRef.current;
    if (!root || event.target instanceof HTMLInputElement && (scopeOpen || event.key !== "ArrowDown")) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".place-search-scroll button:not(:disabled)")).filter(button => button.getClientRects().length > 0);
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: "nearest" });
  }}>
    <div className="place-search-bar">
      <Search size={16} strokeWidth={1.8} aria-hidden="true" />
      <input aria-label="搜索地址" value={query} maxLength={80} disabled={picking} placeholder="搜索地址" autoFocus
        onCompositionStart={() => { reset(); setComposing(true); }} onCompositionEnd={() => setComposing(false)}
        onChange={event => { setScopeOpen(false); change(event.target.value, city); }}
        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); refresh(); } }} />
      {query ? <button className="place-search-clear" type="button" aria-label="清空地点搜索" disabled={picking} onClick={() => change("", city)}><X size={14} aria-hidden="true" /></button> : null}
       <button ref={scopeRef} className="place-scope-trigger" type="button" aria-label={`搜索范围：${scopeLabel}`} aria-expanded={scopeOpen} aria-controls={cityId + "-scope"} disabled={picking} onClick={() => { setCityPickerOpen(false); setCityFilter(""); setSelectedProvince(""); setScopeOpen(value => !value); }}>
        <span>{scopeLabel}</span><ChevronDown size={14} aria-hidden="true" />
      </button>
      <button className="place-search-locate" data-place-locate type="button" aria-label="定位当前城市" title="定位当前城市" aria-busy={locateBusy} disabled={picking || locateBusy} onClick={() => void locate()}>{locateBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LocateFixed size={16} aria-hidden="true" />}</button>
    </div>
    {locateBusy ? <p className="place-search-status" role="status">正在定位城市…</p> : null}
    {locationError ? <p className="place-search-location-error" role="alert">{locationError}</p> : null}
    <div className="place-search-scroll">
      {scopeOpen ? <div id={cityId + "-scope"} className="place-scope-options" role="group" aria-label="选择搜索范围">
        {!createOnly ? <button type="button" className="place-scope-option" aria-pressed={!city && !nationwide && !!geo.point} onClick={() => selectScope("", false)}><span>附近</span>{!city && !nationwide && geo.point ? <Check size={15} aria-hidden="true" /> : null}</button> : null}
        <button type="button" className="place-scope-option" aria-pressed={!city && (nationwide || geo.ready && !geo.point)} onClick={() => selectScope("", true)}><span>不限城市</span>{!city && (nationwide || geo.ready && !geo.point) ? <Check size={15} aria-hidden="true" /> : null}</button>
        {cities.map(name => <button key={name} type="button" className="place-scope-option" aria-pressed={city.replace(/市$/u, "") === name} onClick={() => selectScope(name, false)}><span>{name}</span>{city.replace(/市$/u, "") === name ? <Check size={15} aria-hidden="true" /> : null}</button>)}
        <div className="place-city-picker" data-open={cityPickerOpen || undefined}>
           <button type="button" className="place-city-toggle" aria-expanded={cityPickerOpen} aria-controls={cityId + "-cities"} onClick={() => { setCityPickerOpen(value => !value); setCityFilter(""); setSelectedProvince(""); }}>
            <span>其他城市</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          {cityPickerOpen ? <div className="place-city-drop">
             <input aria-label="搜索城市" value={cityFilter} maxLength={80} placeholder="搜索城市名，如 佛山" disabled={picking} autoFocus onChange={event => { setCityFilter(event.target.value); setSelectedProvince(""); }}
              onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setCityPickerOpen(false); return; }
                 if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".place-city-list button")?.focus({ preventScroll: true }); return; }
                 if (event.key === "Enter" && cityFilter.trim() && !event.nativeEvent.isComposing) { event.preventDefault(); const first = cityGroups[0]?.[1][0]; if (first) selectScope(first, false); else selectScope(cityFilter.trim(), false); }
              }} />
             <div id={cityId + "-cities"} className="place-city-list" role="group" aria-label={cityFilter.trim() ? "匹配城市" : selectedProvince || "选择省份"}>
               {!cityFilter.trim() && selectedProvince ? <button type="button" className="place-city-back" onClick={() => setSelectedProvince("")}><ChevronLeft size={16} aria-hidden="true" /><span>{selectedProvince}，返回省份</span></button> : null}
               {cityFilter.trim() ? cityGroups.length > 0 ? cityGroups.flatMap(([province, names]) => names.map(name => <button type="button" key={`${province}-${name}`} className="place-city-option" disabled={picking} onClick={() => selectScope(name, false)}><span>{name}</span><small>{province}</small></button>)) : <p className="place-search-status">没有匹配城市，可直接用下面的名称</p>
                 : selectedProvince ? <div className="place-city-rows">{(PLACE_CITY_CATALOG[selectedProvince] ?? []).map(name => <button type="button" key={name} className="place-city-option" aria-pressed={city.replace(/市$/u, "") === name.replace(/市$/u, "")} disabled={picking} onClick={() => selectScope(name, false)}><span>{name}</span>{city.replace(/市$/u, "") === name.replace(/市$/u, "") ? <Check size={14} aria-hidden="true" /> : null}</button>)}</div>
                 : <div className="place-province-rows">{Object.keys(PLACE_CITY_CATALOG).map(province => <button type="button" key={province} className="place-province-option" onClick={() => setSelectedProvince(province)}><span>{province}</span><ChevronRight size={14} aria-hidden="true" /></button>)}</div>}
            </div>
            {cityFilter.trim() ? <button type="button" className="place-city-custom" disabled={picking} onClick={() => selectScope(cityFilter.trim(), false)}>使用「{cityFilter.trim()}」</button> : null}
          </div> : null}
        </div>
      </div> : <>
        {busy || locating && query.trim() ? <p className="place-search-status" role="status">{busy ? "搜索中…" : "定位中…"}</p> : null}
        {picking ? <p className="place-search-status" role="status">处理中…</p> : null}
        {error ? <div className="place-search-error"><p role="alert">{error}</p><button type="button" disabled={picking} onClick={refresh}>重试</button></div> : null}
        {createOnly && localError ? <div className="place-search-error"><p role="alert">{localError}</p><button type="button" disabled={picking} onClick={refresh}>重试</button></div> : null}
        {results?.mode !== "nearby" ? savedList : null}
        {results && visibleItems.length > 0 ? <div className="place-search-list" aria-live="polite">
          {mixed ? <h4>{results.mode === "nearby" ? "附近结果" : "搜索结果"}</h4> : null}
          {visibleItems.map((place, index) => {
            const existing = local.find((entity): entity is Place => entity.type === "place" && entity.amapId === place.amapId);
            // Visual simplification keeps complete metadata and the existing
            // dedup/import path. Search-only distance fields never persist.
            const draft: PlaceDraft = { name: place.name, ...placeDetailsOf(place), ...(place.address ? { address: place.address } : {}), ...(place.category ? { category: place.category } : {}), ...(place.role ? { role: place.role } : {}) };
            return <button className="place-search-result" key={place.amapId ?? index} type="button" disabled={busy || picking} onClick={() => void pick(existing ?? draft)} title={[place.name, place.city, place.address].filter(Boolean).join(" ")}>
              <span><strong>{place.name}</strong><small className="place-search-address">{compactAddress(place)}</small></span>
              {showCity && place.city?.trim() ? <small className="place-search-city" title={place.city}>{place.city}</small> : null}
            </button>;
          })}
        </div> : null}
        {results?.mode === "nearby" ? savedList : null}
        {!busy && !locating && !error && (!createOnly || localReady) && saved.length === 0 && (!results || visibleItems.length === 0) && (!createOnly || query.trim()) ? <p className="place-search-status">{query.trim() ? "没有匹配地址" : "还没有地点"}</p> : null}
        {results && (results.page > 1 || results.hasMore) ? <div className="place-search-pagination" aria-label="结果分页">
          <button type="button" aria-label="上一页" disabled={busy || picking || results.page === 1} onClick={() => { immediate.current = true; setPage(results.page - 1); }}><ChevronLeft size={16} aria-hidden="true" /></button>
          <span aria-label={`第${results.page}页`}>{results.page}</span>
          <button type="button" aria-label="下一页" disabled={busy || picking || !results.hasMore} onClick={() => { immediate.current = true; setPage(results.page + 1); }}><ChevronRight size={16} aria-hidden="true" /></button>
        </div> : null}
      </>}
    </div>
    {onManual || results?.mode === "nearby" && radius < 50000 ? <div className="place-search-footer">
      {onManual ? <button type="button" disabled={picking} onClick={() => onManual(query.trim())}><Plus size={15} strokeWidth={1.8} aria-hidden="true" /><span>{manualLabel}</span></button> : null}
      {results?.mode === "nearby" && radius < 50000 && !scopeOpen ? <button type="button" disabled={picking} onClick={() => { reset(); setRadius(50000); }}>扩大范围</button> : null}
    </div> : null}
  </section>;
}
