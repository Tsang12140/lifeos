import { useEffect, useId, useRef, useState } from "react";
import { PLACE_CITY_CATALOG, PLACE_ROLES, type Entity, type Place, type PlaceDetails } from "@lifeos/core";
import { apiRequest } from "./api";
import { describeWeatherLocation } from "./weather-locations";
import { PLACE_ROLE_LABELS, placeRoleLabel } from "./mention";
import { placeSearchPoint, recommendedPlaceCities, placeDistanceLabel, type DevicePoint } from "./place-search-options";
import "./place-search.css";

export interface PlaceDraft extends PlaceDetails { name: string; address?: string; role?: string }
export type PlaceChoice = Place | PlaceDraft;
export function placeDetailsOf(value: PlaceDetails): PlaceDetails {
  return Object.fromEntries((["phone", "city", "province", "district", "longitude", "latitude", "amapId", "photoUrl"] as const).flatMap(key => value[key] === undefined ? [] : [[key, value[key]]]));
}
export function PlaceRoleField({ value, onChange, disabled = false, entities = [] }: { value: string; onChange: (value: string) => void; disabled?: boolean; entities?: readonly Entity[] }) {
  const id = useId();
  const [known, setKnown] = useState<readonly Entity[]>([]);
  useEffect(() => { const controller = new AbortController(); void apiRequest<{ items: Entity[] }>("/api/entities?type=place", { signal: controller.signal }).then(value => setKnown(value.items)).catch(() => {}); return () => controller.abort(); }, []);
  const options = [...new Set([...PLACE_ROLES, ...[...known, ...entities].flatMap(entity => entity.type === "place" && entity.role ? [entity.role] : [])])];
  return <label className="dialog-field place-role-field"><span>地点角色</span><input aria-label="地点角色" maxLength={30} list={id} value={placeRoleLabel(value)} disabled={disabled} placeholder="选择或输入新角色，例如咖啡馆" onChange={event => { const label = event.target.value; onChange(Object.keys(PLACE_ROLE_LABELS).find(key => PLACE_ROLE_LABELS[key] === label) ?? label); }} /><datalist id={id}>{options.map(role => <option key={role} value={placeRoleLabel(role)} />)}</datalist><small>输入新角色后随地点一起保存，也可用于筛选。</small></label>;
}
interface SearchItem extends PlaceDraft { distanceMeters?: number }
interface SearchPayload { items: SearchItem[]; page: number; hasMore: boolean; mode: "nearby" | "text"; origin?: Pick<DevicePoint, "latitude" | "longitude" | "accuracy"> }
export function PlaceSearch({ entities, initialQuery = "", onPick, onManual }: { entities?: readonly Entity[]; initialQuery?: string; onPick: (choice: PlaceChoice) => Promise<void> | void; onManual?: (name: string) => void }) {
  const [local, setLocal] = useState<readonly Entity[]>(entities ?? []);
  const [query, setQuery] = useState(initialQuery), [city, setCity] = useState("");
  const [weatherCity, setWeatherCity] = useState("");
  const [suggestions, setSuggestions] = useState<{ frequent: string[]; recent: string[] }>({ frequent: [], recent: [] });
  const [geo, setGeo] = useState<{ ready: boolean; point: DevicePoint | null }>({ ready: false, point: null });
  const [nationwide, setNationwide] = useState(false), [radius, setRadius] = useState(5000);
  const [page, setPage] = useState(1), [retry, setRetry] = useState(0), [composing, setComposing] = useState(false);
  const [results, setResults] = useState<SearchPayload | null>(null);
  const [busy, setBusy] = useState(false), [picking, setPicking] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), token = useRef(0), selectionLock = useRef(false), immediate = useRef(false);
  const cityId = useId();
  useEffect(() => { if (entities) setLocal(entities); }, [entities]);
  useEffect(() => {
    let active = true;
    const load = new AbortController();
    if (!entities) void apiRequest<{ items: Entity[] }>("/api/entities?type=place", { signal: load.signal }).then(value => { if (active) setLocal(value.items); }).catch(() => {});
    void apiRequest<{ city?: string; locationId?: string }>("/api/weather/status", { signal: load.signal }).then(value => { if (active) setWeatherCity(describeWeatherLocation(value.locationId ?? "")?.city ?? value.city ?? ""); }).catch(() => {});
    void apiRequest<{ frequent: string[]; recent: string[] }>("/api/places/cities", { signal: load.signal }).then(value => { if (active) setSuggestions(value); }).catch(() => {});
    void placeSearchPoint().then(point => { if (active) setGeo({ ready: true, point }); });
    return () => { active = false; load.abort(); controller.current?.abort(); token.current++; };
  }, []);
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
  const saved = local.filter((entity): entity is Place => entity.type === "place" && !returnedIds.has(entity.amapId) && [entity.name, ...(entity.aliases ?? []), entity.city, entity.address].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle)).slice(0, 12);
  const cities = recommendedPlaceCities(weatherCity, suggestions.recent, suggestions.frequent);
  const savedList = saved.length ? <div className="place-search-list"><h4>已有地点</h4>{saved.map(place => <button type="button" className="place-search-result" key={place.id} disabled={busy || picking} onClick={() => void pick(place)}><span><strong>{place.name}</strong><small>{[place.city, place.address].filter(Boolean).join(" ")}</small></span><small>使用已有</small></button>)}</div> : null;
  const refresh = () => { reset(); immediate.current = true; setRetry(value => value + 1); };
  return <section className="place-search-panel" aria-label="搜索店铺和地址">
    <div className="place-search-inputs"><label><span>店铺或地址</span><input aria-label="搜索店铺或地址" value={query} maxLength={80} disabled={picking} placeholder="输入后自动搜索" onCompositionStart={() => { reset(); setComposing(true); }} onCompositionEnd={() => setComposing(false)} onChange={event => change(event.target.value, city)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); refresh(); } }} /></label><label><span>城市（可选）</span><input aria-label="搜索城市" list={cityId} maxLength={80} value={city} placeholder={geo.point && !nationwide ? "当前位置附近" : "不限城市"} disabled={picking} onChange={event => change(query, event.target.value)} /><datalist id={cityId}>{Object.values(PLACE_CITY_CATALOG).flat().map(name => <option key={name} value={name} />)}</datalist></label></div>
    {cities.length ? <div className="place-city-suggestions" aria-label="推荐城市">{cities.map(name => <button key={name} type="button" disabled={picking} className="place-city-button" aria-pressed={city.replace(/市$/u, "") === name} onClick={() => change(query, city.replace(/市$/u, "") === name ? "" : name)}>{name}</button>)}</div> : null}
    <div className="place-search-actions">
      {city || nationwide ? <button className="secondary-button" type="button" disabled={picking} onClick={() => { reset(); setCity(""); setNationwide(false); }}>附近优先</button> : null}
      {!city && !nationwide ? <button className="secondary-button" type="button" disabled={picking} onClick={() => { reset(); setNationwide(true); }}>不限城市</button> : null}
      {results?.mode === "nearby" && radius < 50000 ? <button className="secondary-button" type="button" disabled={picking} onClick={() => { reset(); setRadius(50000); }}>扩大范围</button> : null}
      {onManual ? <button className="secondary-button" type="button" disabled={picking} onClick={() => onManual(query.trim())}>手动新建地点</button> : null}
    </div>
    {busy || (!geo.ready && query.trim() && !city && !nationwide) ? <p className="place-search-status" role="status">{busy ? "搜索中…" : "正在获取当前位置…"}</p> : null}
    {error ? <div><p role="alert" className="dialog-error">{error}</p><div className="place-search-actions"><button className="secondary-button" type="button" disabled={picking} onClick={refresh}>重试</button></div></div> : null}
    {results?.mode !== "nearby" ? savedList : null}
    {results ? <div className="place-search-list" aria-live="polite"><h4>{results.mode === "nearby" ? "附近结果" : "搜索结果"}</h4>{results.mode === "nearby" ? <small className="place-search-credit">距离为大约的直线距离</small> : null}{results.items.length === 0 ? <p>没有找到匹配地点，试试其他关键词、扩大范围或切换城市。</p> : results.items.map((place, index) => {
      const existing = local.find((entity): entity is Place => entity.type === "place" && entity.amapId === place.amapId);
      const distance = placeDistanceLabel(place.distanceMeters, results.origin?.accuracy ?? Infinity);
      // Search-only distance/position fields must never enter persistent entities.
      const draft: PlaceDraft = { name: place.name, ...placeDetailsOf(place), ...(place.address ? { address: place.address } : {}), ...(place.role ? { role: place.role } : {}) };
      return <button className="place-search-result" key={place.amapId ?? index} type="button" disabled={busy || picking} onClick={() => void pick(existing ?? draft)}>{place.photoUrl ? <img src={place.photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} /> : null}<span><strong>{place.name}</strong><small>{[place.province, place.city, place.district, place.address].filter(Boolean).join(" ")}</small>{place.phone ? <small>电话 {place.phone}</small> : null}{distance ? <small className="place-search-distance">{distance}</small> : null}</span><small>{existing ? "使用已有" : picking ? "处理中" : "选用"}</small></button>;
    })}<div className="place-search-actions"><button type="button" className="secondary-button" disabled={busy || picking || results.page === 1} onClick={() => { immediate.current = true; setPage(results.page - 1); }}>上一页</button><span>第 {results.page} 页</span><button type="button" className="secondary-button" disabled={busy || picking || !results.hasMore} onClick={() => { immediate.current = true; setPage(results.page + 1); }}>下一页</button></div></div> : null}
    {results?.mode === "nearby" ? savedList : null}
  </section>;
}
