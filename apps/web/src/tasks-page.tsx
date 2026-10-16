import { ListChecks, Plus } from "lucide-react";

export type TaskPageFilter = "all" | "incomplete";

interface Props {
  readonly expanded: boolean;
  readonly editing: boolean;
  readonly draft: string;
  readonly onOpenComposer: () => void;
  readonly onTeaserRef?: (node: HTMLButtonElement | null) => void;
}

export function TaskPageHeader({ expanded, editing, draft, onOpenComposer, onTeaserRef }: Props) {
  const summary = Array.from(draft.trim()).slice(0, 180).join("");
  return <>
    <div className="task-page-heading"><ListChecks size={20} aria-hidden="true" /><h1>任务</h1></div>
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
