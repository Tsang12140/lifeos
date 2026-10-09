export interface SearchFilters { assisted?: boolean; kinds: string[]; backfill: "" | "all" | "ai"; from: string; to: string; attachments: string[]; entityTypes: string[]; statuses: string[]; }
export const EMPTY_SEARCH_FILTERS: SearchFilters = { kinds: [], backfill: "", from: "", to: "", attachments: [], entityTypes: [], statuses: [] };
export function hasSearchFilters(f: SearchFilters): boolean { return Boolean(f.assisted || f.kinds.length || f.backfill || f.from || f.to || f.attachments.length || f.entityTypes.length || f.statuses.length); }
export function searchFilterParams(filters: SearchFilters, params: URLSearchParams): void {
  for (const [key, values] of [["kinds", filters.kinds], ["attachments", filters.attachments], ["entityTypes", filters.entityTypes], ["statuses", filters.statuses]] as const) if (values.length) params.set(key, values.join(","));
  if (filters.backfill === "all") params.set("backfill", "all");
  if (filters.assisted || filters.backfill === "ai") params.set("assisted", "true");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("search", "1");
}
export function SearchFilterChips({ value, onChange }: { value: SearchFilters; onChange: (value: SearchFilters) => void }) {
  const names: Record<string, string> = { journal: "日记", task: "任务", event: "事件", note: "笔记", photo: "有照片", file: "有附件", person: "人物", place: "地点", movie: "电影", project: "项目", todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
  return <div className="search-filter-chips">{(["kinds", "attachments", "entityTypes", "statuses"] as const).flatMap((key) => value[key].map((id) => <button className="secondary-button" type="button" key={`${key}:${id}`} aria-label={`移除筛选 ${names[id] ?? id}`} onClick={() => onChange({ ...value, [key]: value[key].filter((v) => v !== id), ...(key === "kinds" && id === "task" ? { statuses: [] } : {}) })}>{names[id] ?? id} ×</button>))}{value.backfill === "all" ? <button className="secondary-button" type="button" aria-label="移除补记筛选" onClick={() => onChange({ ...value, backfill: "" })}>补记 ×</button> : null}{value.assisted || value.backfill === "ai" ? <button className="secondary-button" type="button" aria-label="移除辅记筛选" onClick={() => onChange({ ...value, assisted: false, backfill: value.backfill === "ai" ? "" : value.backfill })}>辅记 ×</button> : null}{value.from || value.to ? <button className="secondary-button" type="button" aria-label="移除日期筛选" onClick={() => onChange({ ...value, from: "", to: "" })}>{value.from || "不限"} 至 {value.to || "不限"} ×</button> : null}</div>;
}
export function SearchFilterFields({ value, onChange }: { value: SearchFilters; onChange: (value: SearchFilters) => void }) {
  const group = (key: "kinds" | "attachments" | "entityTypes" | "statuses", label: string, values: readonly (readonly [string, string])[]) => <fieldset className="search-filter-group"><legend>{label}</legend>{values.map(([id, name]) => <label key={id}><input type="checkbox" checked={value[key].includes(id)} onChange={(e) => onChange({ ...value, [key]: e.target.checked ? [...value[key], id] : value[key].filter((v) => v !== id) })} />{name}</label>)}</fieldset>;
  return <div className="search-filter-fields">
    {group("kinds", "记录类型", [["journal", "日记"], ["task", "任务"], ["event", "事件"], ["note", "笔记"]])}
    <fieldset className="search-filter-group"><legend>记录标记</legend><label><input type="checkbox" checked={value.assisted === true || value.backfill === "ai"} onChange={e => onChange({ ...value, assisted: e.target.checked, backfill: value.backfill === "ai" ? "" : value.backfill })} />辅记</label><label><input type="checkbox" checked={value.backfill === "all"} onChange={e => onChange({ ...value, backfill: e.target.checked ? "all" : "", assisted: value.assisted || value.backfill === "ai" })} />补记</label></fieldset>
    <div className="backfill-row"><label className="backfill-field"><span>开始日期</span><input type="date" aria-label="筛选开始日期" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /></label><label className="backfill-field"><span>结束日期</span><input type="date" aria-label="筛选结束日期" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></label></div>
    <div className="search-filter-presets">{[["今天", 1], ["近 7 天", 7], ["近 30 天", 30]].map(([label, days]) => <button className="secondary-button" type="button" key={label} onClick={() => { const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()); const start = new Date(today + "T12:00:00+08:00"); start.setUTCDate(start.getUTCDate() - Number(days) + 1); const from = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(start); onChange({ ...value, from, to: today }); }}>{label}</button>)}</div>
    {group("attachments", "附带内容", [["photo", "有照片"], ["file", "有附件"]])}
    {group("entityTypes", "关联对象", [["person", "人物"], ["place", "地点"], ["movie", "电影"], ["project", "项目"]])}
    {value.kinds.includes("task") ? group("statuses", "任务状态", [["todo", "待办"], ["in_progress", "进行中"], ["done", "已完成"], ["cancelled", "已取消"]]) : null}
  </div>;
}
