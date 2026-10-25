import { ListChecks, Plus, Rows3 } from "lucide-react";
import type { ReactNode } from "react";
import { TASK_SORT_MODES, type TaskSortMode } from "./task-presentation";

export type TaskPageFilter = "all" | "incomplete";

interface Props {
  readonly expanded: boolean;
  readonly editing: boolean;
  readonly draft: string;
  readonly controls: ReactNode;
  readonly count?: number;
  readonly onOpenComposer: () => void;
  readonly onTeaserRef?: (node: HTMLButtonElement | null) => void;
}

export function TaskPageHeader({ expanded, editing, draft, controls, count, onOpenComposer, onTeaserRef }: Props) {
  const summary = Array.from(draft.trim()).slice(0, 180).join("");
  return <>
    <div className="task-page-header">
      <div className="task-page-heading"><ListChecks size={20} aria-hidden="true" /><h1 id="task-page-title">任务</h1>{count !== undefined && count > 0 ? <span className="record-count">{count} 条</span> : null}</div>
      <div className="task-page-tools">{controls}</div>
    </div>
    {!expanded && !editing ? <button ref={onTeaserRef} className="task-create-teaser" type="button" onClick={onOpenComposer} aria-label={summary ? `继续编辑任务：${summary}` : "添加任务"}>
      <span className="task-create-teaser-input"><Plus size={17} strokeWidth={1.9} aria-hidden="true" /><span className="task-create-teaser-copy"><span className="task-create-teaser-label">添加任务</span>{summary ? <span className="task-create-teaser-summary">{summary}</span> : null}</span></span>
    </button> : null}
  </>;
}

export function TaskPageFilters({ filter, onFilterChange }: { readonly filter: TaskPageFilter; readonly onFilterChange: (filter: TaskPageFilter) => void }) {
  return <div className="entities-library-toolbar task-page-status">
    <div className="entities-tabs" role="group" aria-label="任务状态筛选">
      <button className={`entities-tab ${filter === "all" ? "is-active" : ""}`} type="button" aria-pressed={filter === "all"} onClick={() => onFilterChange("all")}>全部</button>
      <button className={`entities-tab ${filter === "incomplete" ? "is-active" : ""}`} type="button" aria-pressed={filter === "incomplete"} onClick={() => onFilterChange("incomplete")}>未完成</button>
    </div>
  </div>;
}

/** Same segmented shape as the status filter, so the two read as one toolbar. */
export function TaskPageSort({ sort, onSortChange }: { readonly sort: TaskSortMode; readonly onSortChange: (sort: TaskSortMode) => void }) {
  return <div className="entities-library-toolbar task-page-sort">
    <div className="entities-tabs" role="group" aria-label="任务排序方式">
      {TASK_SORT_MODES.map(mode => <button key={mode.id} className={`entities-tab ${sort === mode.id ? "is-active" : ""}`} type="button" aria-pressed={sort === mode.id} aria-label={mode.hint} title={mode.hint} onClick={() => onSortChange(mode.id)}>{mode.label}</button>)}
    </div>
  </div>;
}

export function TaskPageDensity({ compact, onToggle }: { readonly compact: boolean; readonly onToggle: () => void }) {
  return <button className={`task-density-toggle ${compact ? "is-active" : ""}`} type="button" aria-pressed={compact} aria-label={compact ? "切回标准卡片" : "极简模式：单列，点击正文展开"} title={compact ? "切回标准卡片" : "极简模式：单列，点击正文展开"} onClick={onToggle}>
    <Rows3 size={15} strokeWidth={1.9} aria-hidden="true" /><span>极简</span>
  </button>;
}
