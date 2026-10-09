import { useEffect, useRef, useState } from "react";
import { Check, MapPin, User, X } from "lucide-react";
import type { Entity, EntityCandidate, TextEntityDecision } from "@lifeos/core";

function optionLabel(entity: Entity): string {
  const detail = entity.type === "place" && entity.address ? entity.address : entity.description || (entity.aliases ?? []).join("、");
  return `${entity.name}（${entity.type === "person" ? "人物" : "地点"}${detail ? `，${detail}` : ""}）`;
}

export const occurrenceKey = (candidate: Pick<EntityCandidate, "start" | "end">) => `${candidate.start}:${candidate.end}`;

function Context({ text, candidate }: { text: string; candidate: EntityCandidate }) {
  const [expanded, setExpanded] = useState(false);
  const paragraphStart = text.lastIndexOf("\n", candidate.start - 1) + 1;
  const nextBreak = text.indexOf("\n", candidate.end);
  const paragraphEnd = nextBreak < 0 ? text.length : nextBreak;
  const before = text.slice(Math.max(paragraphStart, candidate.start - 32), candidate.start);
  const after = text.slice(candidate.end, Math.min(paragraphEnd, candidate.end + 32));
  return <button className={`mention-review-context${expanded ? " is-expanded" : ""}`} type="button" aria-label={expanded ? "收起上下文" : "展开完整上下文"} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
    {expanded ? <><span>{text.slice(paragraphStart, candidate.start)}</span><strong>{candidate.text.replace(/^[@#]/u, "")}</strong><span>{text.slice(candidate.end, paragraphEnd)}</span></> : <><span className="context-far context-before">{before.slice(0, -10)}</span><span className="context-near">{before.slice(-10)}</span><strong>{candidate.text.replace(/^[@#]/u, "")}</strong><span className="context-near">{after.slice(0, 10)}</span><span className="context-far context-after">{after.slice(10)}</span></>}
  </button>;
}

export function EntityMentionReview({ text, candidates, decisions, preferredEntity, onConfirm, onClose }: {
  text: string; candidates: readonly EntityCandidate[]; decisions: readonly TextEntityDecision[];
  preferredEntity?: Entity; onConfirm: (decisions: readonly TextEntityDecision[]) => void; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState(() => new Map(candidates.map((candidate) => {
    const previous = decisions.find((decision) => decision.start === candidate.start && decision.end === candidate.end);
    const id = previous ? previous.entityId ?? "" : preferredEntity?.id ?? (candidate.entities.length === 1 ? candidate.entities[0]!.id : "");
    return [occurrenceKey(candidate), id];
  })));
  const assignmentsRef = useRef(new Map(candidates.map((candidate) => [occurrenceKey(candidate), choices.get(occurrenceKey(candidate)) || preferredEntity?.id || (candidate.entities.length === 1 ? candidate.entities[0]!.id : "")])));
  const groups = new Map<string, EntityCandidate[]>();
  for (const candidate of candidates) {
    const group = candidate.entities.length === 1 ? candidate.entities[0]!.id : candidate.entities.map((entity) => entity.id).sort().join("|");
    groups.set(group, [...(groups.get(group) ?? []), candidate]);
  }
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  const select = (items: readonly EntityCandidate[], checked: boolean) => setChoices((current) => {
    const next = new Map(current);
    for (const item of items) next.set(occurrenceKey(item), checked ? assignmentsRef.current.get(occurrenceKey(item)) ?? "" : "");
    return next;
  });
  const selected = candidates.filter((candidate) => Boolean(choices.get(occurrenceKey(candidate)))).length;
  return <dialog ref={dialogRef} className="modal-dialog mention-review-dialog" aria-labelledby="mention-review-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header"><div><h2 id="mention-review-title">{preferredEntity ? `核对「${preferredEntity.name}」` : "核对人物与地点"}</h2><p>保留正文原名，取消不属于这个对象的勾选。</p></div><button className="icon-button compact-icon-button" type="button" aria-label="关闭标记核对" onClick={onClose}><X size={17} aria-hidden="true" /></button></div>
    <div className="mention-review-tools"><span role="status">已选 {selected} / {candidates.length} 处</span><div className="mention-review-actions"><button className="secondary-button" type="button" onClick={() => select(candidates, true)}>全选</button><button className="secondary-button" type="button" onClick={() => select(candidates, false)}>全不选</button></div></div>
    <div className="dialog-body mention-review-body">
      {[...groups].map(([key, items]) => { const first = items[0]!, entity = first.entities[0]!, ambiguous = first.entities.length > 1; const Icon = entity.type === "place" ? MapPin : User;
        return <section className="mention-review-group" key={key}><div className="mention-review-group-heading"><strong><Icon size={14} aria-hidden="true" />{ambiguous ? `「${first.text.replace(/^[@#]/u, "")}」有多个对象，请选择归属` : entity.name}</strong><div className="mention-review-actions"><button className="secondary-button" type="button" onClick={() => select(items, true)}>全选</button><button className="secondary-button" type="button" onClick={() => select(items, false)}>全不选</button></div></div>
          <ol className="mention-review-list">{items.map((candidate) => { const id = occurrenceKey(candidate), choice = choices.get(id) ?? "", previous = decisions.find((decision) => decision.start === candidate.start && decision.end === candidate.end); const target = assignmentsRef.current.get(id) ?? "";
            return <li className="mention-review-item" key={id} data-occurrence-start={candidate.start}><label className="mention-review-check"><input type="checkbox" checked={Boolean(choice)} disabled={!target} aria-label={`标记第 ${candidates.indexOf(candidate) + 1} 处 ${candidate.text.replace(/^[@#]/u, "")}`} onChange={(event) => setChoices((current) => new Map(current).set(id, event.target.checked ? target : ""))} /><span className="mention-review-checkmark"><Check size={12} aria-hidden="true" /></span></label><span className="mention-review-number">{candidates.indexOf(candidate) + 1}</span><div className="mention-review-copy"><Context text={text} candidate={candidate} />{ambiguous && !preferredEntity ? <select aria-label={`第 ${candidates.indexOf(candidate) + 1} 处的关联对象`} value={target} onChange={(event) => { assignmentsRef.current.set(id, event.target.value); setChoices((current) => new Map(current).set(id, event.target.value)); }}><option value="">暂不关联，请选择对象</option>{candidate.entities.map((option) => <option key={option.id} value={option.id}>{optionLabel(option)}</option>)}</select> : null}{previous?.entityId === null ? <small>上次已取消关联</small> : null}</div></li>;
          })}</ol></section>;
      })}
    </div>
    <div className="dialog-footer mention-review-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => {
      const changed = candidates.map((candidate): TextEntityDecision => { const id = choices.get(occurrenceKey(candidate)) || null; const entity = candidate.entities.find((item) => item.id === id) ?? candidate.entities[0]!; return { start: candidate.start, end: candidate.end, text: candidate.text, entityId: id, entityType: entity.type as "person" | "place" }; });
      const untouched = decisions.filter((decision) => !candidates.some((candidate) => candidate.start < decision.end && decision.start < candidate.end));
      onConfirm([...untouched, ...changed].sort((a, b) => a.start - b.start));
    }}>确认标记</button></div>
  </dialog>;
}
