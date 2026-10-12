import { useEffect, useId, useRef, useState } from "react";
import { PLACE_CITY_CATALOG, PLACE_ROLES, type Entity, type Place, type PlaceDetails } from "@lifeos/core";
import { apiRequest } from "./api";
import { describeWeatherLocation } from "./weather-locations";
import { PLACE_ROLE_LABELS, placeRoleLabel } from "./mention";
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
const popular: Readonly<Record<string, readonly string[]>> = {
  广东: ["广州", "深圳", "佛山", "东莞", "珠海", "惠州"], 浙江: ["杭州", "宁波", "温州", "绍兴", "嘉兴", "金华"], 江苏: ["南京", "苏州", "无锡", "常州", "扬州", "徐州"], 四川: ["成都", "绵阳", "乐山", "宜宾", "南充"], 福建: ["福州", "厦门", "泉州", "漳州", "莆田"], 山东: ["济南", "青岛", "烟台", "威海", "潍坊"], 湖北: ["武汉", "宜昌", "襄阳", "荆州"], 湖南: ["长沙", "株洲", "湘潭", "衡阳", "岳阳"], 河南: ["郑州", "洛阳", "开封", "南阳"], 河北: ["石家庄", "唐山", "保定", "秦皇岛"], 安徽: ["合肥", "芜湖", "黄山", "蚌埠"], 江西: ["南昌", "九江", "赣州", "景德镇"], 广西: ["南宁", "桂林", "柳州", "北海"], 云南: ["昆明", "大理", "丽江", "西双版纳"], 贵州: ["贵阳", "遵义", "安顺"], 陕西: ["西安", "咸阳", "宝鸡", "延安"], 山西: ["太原", "大同", "运城"], 辽宁: ["沈阳", "大连", "鞍山"], 吉林: ["长春", "吉林", "延边"], 黑龙江: ["哈尔滨", "齐齐哈尔", "大庆"], 海南: ["海口", "三亚", "儋州"], 甘肃: ["兰州", "天水", "酒泉"], 内蒙古: ["呼和浩特", "包头", "鄂尔多斯"], 新疆: ["乌鲁木齐", "喀什", "伊犁"], 西藏: ["拉萨", "林芝", "日喀则"], 青海: ["西宁", "海东"], 宁夏: ["银川", "中卫"], 台湾: ["台北", "高雄", "台中", "台南"], 北京: ["北京"], 上海: ["上海"], 天津: ["天津"], 重庆: ["重庆"], 香港: ["香港"], 澳门: ["澳门"],
};
interface SearchPayload { items: PlaceDraft[]; page: number; hasMore: boolean }
export function PlaceSearch({ entities, initialQuery = "", onPick, onManual }: { entities?: readonly Entity[]; initialQuery?: string; onPick: (choice: PlaceChoice) => Promise<void> | void; onManual?: (name: string) => void }) {
  const [local, setLocal] = useState<readonly Entity[]>(entities ?? []);
  const [query, setQuery] = useState(initialQuery);
  const [city, setCity] = useState("");
  const [weatherCity, setWeatherCity] = useState("");
  const [province, setProvince] = useState("");
  const [suggestions, setSuggestions] = useState<{ frequent: string[]; recent: string[] }>({ frequent: [], recent: [] });
  const [results, setResults] = useState<SearchPayload | null>(null);
  const [busy, setBusy] = useState(false), [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), token = useRef(0), cityEdited = useRef(false), selectionLock = useRef(false);
  const cityId = useId();
  useEffect(() => { if (entities) setLocal(entities); }, [entities]);
  useEffect(() => {
    let active = true;
    const load = new AbortController();
    if (!entities) void apiRequest<{ items: Entity[] }>("/api/entities?type=place", { signal: load.signal }).then(value => { if (active) setLocal(value.items); }).catch(() => {});
    void apiRequest<{ city?: string; locationId?: string }>("/api/weather/status", { signal: load.signal }).then(value => { if (!active) return; const location = describeWeatherLocation(value.locationId ?? ""); const name = location?.city ?? value.city ?? ""; setWeatherCity(name); setProvince(location?.province ?? ""); if (!cityEdited.current) setCity(name); }).catch(() => {});
    void apiRequest<{ frequent: string[]; recent: string[] }>("/api/places/cities", { signal: load.signal }).then(value => { if (active) setSuggestions(value); }).catch(() => {});
    return () => { active = false; load.abort(); controller.current?.abort(); token.current++; };
  }, []);
  const change = (nextQuery: string, nextCity: string) => { controller.current?.abort(); token.current++; setBusy(false); setResults(null); setError(""); setQuery(nextQuery); setCity(nextCity); };
  const search = async (page = 1) => {
    if (!query.trim() || busy || picking) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; const current = ++token.current;
    setBusy(true); setError("");
    try { const value = await apiRequest<SearchPayload>("/api/places/search", { method: "POST", body: JSON.stringify({ query: query.trim(), city: city.trim(), page }), signal: abort.signal }); if (current === token.current) setResults(value); }
    catch (cause) { if (current === token.current && !abort.signal.aborted) { setResults(null); setError(cause instanceof Error ? cause.message : "搜索失败，请重试"); } }
    finally { if (current === token.current) setBusy(false); }
  };
  const pick = async (choice: PlaceChoice) => { if (selectionLock.current || busy) return; selectionLock.current = true; setPicking(true); setError(""); try { await onPick(choice); } catch (cause) { setError(cause instanceof Error ? cause.message : "地点未能保存，请重试"); } finally { selectionLock.current = false; setPicking(false); } };
  const needle = query.trim().toLocaleLowerCase();
  const saved = local.filter((entity): entity is Place => entity.type === "place" && [entity.name, ...(entity.aliases ?? []), entity.city, entity.address].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle)).slice(0, 12);
  const group = (label: string, names: readonly string[]) => names.length ? <div className="place-city-group"><span>{label}</span><div>{[...new Set(names)].map(name => <button key={name} type="button" disabled={picking} className="place-city-button" aria-pressed={city === name} onClick={() => { cityEdited.current = true; change(query, name); }}>{name}</button>)}</div></div> : null;
  const featured = Object.entries(popular).find(([name]) => province.startsWith(name))?.[1] ?? (PLACE_CITY_CATALOG[province] ?? []).slice(0, 6);
  return <section className="place-search-panel" aria-label="搜索店铺和地址">
    <div className="place-search-inputs"><label><span>城市</span><input aria-label="搜索城市" list={cityId} maxLength={80} value={city} placeholder="全国，或输入城市" disabled={picking} onChange={event => { cityEdited.current = true; change(query, event.target.value); }} /><datalist id={cityId}>{Object.values(PLACE_CITY_CATALOG).flat().map(name => <option key={name} value={name} />)}</datalist></label><label><span>店铺或地址</span><input aria-label="搜索店铺或地址" value={query} maxLength={80} disabled={picking} placeholder="例如张三牛肉面、某条街道" onChange={event => change(event.target.value, city)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void search(); } }} /></label></div>
    <div className="place-city-suggestions">{group("天气城市", weatherCity ? [weatherCity] : [])}{group("近期常提", suggestions.recent)}{group("经常提到", suggestions.frequent)}{group("省内常用", featured)}</div>
    <div className="place-search-actions"><button className="primary-button" type="button" disabled={!query.trim() || busy || picking} onClick={() => void search()}>{busy ? "搜索中…" : "搜索高德地点"}</button>{onManual ? <button className="secondary-button" type="button" disabled={busy || picking} onClick={() => onManual(query.trim())}>手动新建地点</button> : null}</div>
    {error ? <p role="alert" className="dialog-error">{error}</p> : null}
    {saved.length ? <div className="place-search-list"><h4>已有地点</h4>{saved.map(place => <button type="button" className="place-search-result" key={place.id} disabled={busy || picking} onClick={() => void pick(place)}><span><strong>{place.name}</strong><small>{[place.city, place.address].filter(Boolean).join(" ")}</small></span><small>使用已有</small></button>)}</div> : null}
    {results ? <div className="place-search-list" aria-live="polite"><h4>高德搜索结果</h4>{results.items.length === 0 ? <p>没有找到匹配地点，试试其他关键词或城市，也可以手动新建。</p> : results.items.map((place, index) => { const existing = local.find(entity => entity.type === "place" && entity.amapId === place.amapId); return <button className="place-search-result" key={place.amapId ?? index} type="button" disabled={busy || picking} onClick={() => void pick(existing?.type === "place" ? existing : place)}>{place.photoUrl ? <img src={place.photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} /> : null}<span><strong>{place.name}</strong><small>{[place.province, place.city, place.district, place.address].filter(Boolean).join(" ")}</small>{place.phone ? <small>电话 {place.phone}</small> : null}</span><small>{existing ? "使用已有" : picking ? "处理中" : "选用"}</small></button>; })}<div className="place-search-actions"><button type="button" className="secondary-button" disabled={busy || picking || results.page === 1} onClick={() => void search(results.page - 1)}>上一页</button><span>第 {results.page} 页</span><button type="button" className="secondary-button" disabled={busy || picking || !results.hasMore} onClick={() => void search(results.page + 1)}>下一页</button></div><small className="place-search-credit">地点资料与图片来自高德地图，图片可能是店内照；缺失时可自行上传。</small></div> : null}
  </section>;
}
