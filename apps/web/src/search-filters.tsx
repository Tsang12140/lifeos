import { useState } from "react";
import { X } from "lucide-react";
import { type Entity } from "@lifeos/core";
import { SearchDateRange } from "./search-date-range";

export interface SearchFilters {
  assisted?: boolean; kinds: string[]; backfill: "" | "all" | "ai"; from: string; to: string;
  personIds: string[]; placeIds: string[]; entityIds: string[];
  attachments: string[]; entityTypes: string[]; statuses: string[];
}
export const EMPTY_SEARCH_FILTERS: SearchFilters = { kinds: [], backfill: "", from: "", to: "", personIds: [], placeIds: [], entityIds: [], attachments: [], entityTypes: [], statuses: [] };
export function hasSearchFilters(f: SearchFilters): boolean {
  return Boolean(f.assisted || f.backfill || f.from || f.to || [f.kinds, f.personIds, f.placeIds, f.entityIds, f.attachments, f.entityTypes, f.statuses].some(values => values.length));
}
export function searchFilterParams(filters: SearchFilters, params: URLSearchParams): void {
  for (const key of ["kinds", "personIds", "placeIds", "entityIds", "attachments", "entityTypes", "statuses"] as const) if (filters[key].length) params.set(key, filters[key].join(","));
  if (filters.backfill === "all") params.set("backfill", "all");
  if (filters.assisted || filters.backfill === "ai") params.set("assisted", "true");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("search", "1");
  params.set("entityMatch", "all");
}
export function SearchFilterChips({ value, entities, hideEntities = false, onChange }: { value: SearchFilters; entities: readonly Entity[]; hideEntities?: boolean; onChange: (value: SearchFilters) => void }) {
  const names: Record<string, string> = { journal: "日记", task: "任务", event: "事件", note: "笔记", photo: "有照片", file: "有附件", person: "关联人物", place: "关联地点", movie: "关联电影", project: "关联项目", todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
  const chip = (id: string, label: string, remove: () => void) => <button className="secondary-button" type="button" key={id} title={label} aria-label={`移除筛选 ${label}`} onClick={remove}><span>{label}</span><X size={13} aria-hidden="true" /></button>;
  return <div className="search-filter-chips">
    {(["kinds", "attachments", "entityTypes", "statuses"] as const).flatMap(key => value[key].map(id => chip(`${key}:${id}`, names[id] ?? id, () => onChange({ ...value, [key]: value[key].filter(v => v !== id), ...(key === "kinds" && id === "task" ? { statuses: [] } : {}) }))))}
    {!hideEntities && (["personIds", "placeIds", "entityIds"] as const).flatMap(key => value[key].map(id => chip(`${key}:${id}`, `${key === "personIds" ? "人物" : key === "placeIds" ? "地点" : "对象"}：${entities.find(entity => entity.id === id)?.name ?? "已删除的对象"}`, () => onChange({ ...value, [key]: value[key].filter(v => v !== id) }))))}
    {value.backfill === "all" ? chip("backfill", "补记", () => onChange({ ...value, backfill: "" })) : null}
    {value.assisted || value.backfill === "ai" ? chip("assisted", "辅记", () => onChange({ ...value, assisted: false, backfill: value.backfill === "ai" ? "" : value.backfill })) : null}
    {value.from || value.to ? chip("date", `${value.from || "不限"} 至 ${value.to || "不限"}`, () => onChange({ ...value, from: "", to: "" })) : null}
  </div>;
}
export function SearchFilterFields({ value, onChange }: { value: SearchFilters; onChange: (value: SearchFilters) => void }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const presets = [["今天", 1], ["近7天", 7], ["近30天", 30]] as const;
  const presetStart = (days: number) => { const date = new Date(`${today}T12:00:00+08:00`); date.setUTCDate(date.getUTCDate() - days + 1); return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date); };
  const [custom, setCustom] = useState(() => Boolean((value.from || value.to) && !presets.some(([, days]) => value.from === presetStart(days) && value.to === today)));
  const group = (key: "kinds" | "attachments" | "entityTypes" | "statuses", label: string, values: readonly (readonly [string, string])[]) => <div className="record-filter-row" role="group" aria-label={label}><span className="record-filter-label">{label}</span><div className="record-search-options">{values.map(([id, name]) => <button className="record-filter-option" type="button" key={id} aria-pressed={value[key].includes(id)} onClick={() => onChange({ ...value, [key]: value[key].includes(id) ? value[key].filter(v => v !== id) : [...value[key], id], ...(key === "kinds" && id === "task" && value.kinds.includes(id) ? { statuses: [] } : {}) })}>{name}</button>)}</div></div>;
  return <div className="search-filter-fields">
    {group("kinds", "类型", [["journal", "日记"], ["task", "任务"], ["event", "事件"], ["note", "笔记"]])}
    {value.kinds.includes("task") ? group("statuses", "状态", [["todo", "待办"], ["in_progress", "进行中"], ["done", "已完成"], ["cancelled", "已取消"]]) : null}
    <div className="record-filter-row" role="group" aria-label="时间"><span className="record-filter-label">时间</span><div className="record-filter-values"><div className="record-search-options">{presets.map(([label, days]) => <button className="record-filter-option" type="button" key={label} aria-pressed={value.from === presetStart(days) && value.to === today} onClick={() => { const active = value.from === presetStart(days) && value.to === today; onChange({ ...value, from: active ? "" : presetStart(days), to: active ? "" : today }); setCustom(false); }}>{label}</button>)}<button className="record-filter-link" type="button" aria-expanded={custom} onClick={() => setCustom(!custom)}>自定义…</button>{value.from || value.to ? <button className="record-filter-link" type="button" onClick={() => { onChange({ ...value, from: "", to: "" }); setCustom(false); }}>不限</button> : null}</div>{custom ? <SearchDateRange from={value.from} to={value.to} onChange={(from, to) => onChange({ ...value, from, to })} /> : null}</div></div>
    {group("attachments", "附带", [["photo", "有照片"], ["file", "有附件"]])}
    <details className="record-search-more"><summary>更多条件</summary>
      <div className="record-filter-row" role="group" aria-label="标记"><span className="record-filter-label">标记</span><div className="record-search-options"><button className="record-filter-option" type="button" aria-pressed={value.assisted === true || value.backfill === "ai"} onClick={() => onChange({ ...value, assisted: !(value.assisted || value.backfill === "ai"), backfill: value.backfill === "ai" ? "" : value.backfill })}>辅记</button><button className="record-filter-option" type="button" aria-pressed={value.backfill === "all"} onClick={() => onChange({ ...value, backfill: value.backfill === "all" ? "" : "all", assisted: value.assisted || value.backfill === "ai" })}>补记</button></div></div>
      {group("entityTypes", "关联", [["person", "人物"], ["place", "地点"], ["movie", "电影"], ["project", "项目"]])}
    </details>
  </div>;
}
