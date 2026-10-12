import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, MapPin, User, X } from "lucide-react";
import type { Entity, EntityCandidate, TextEntityDecision } from "@lifeos/core";
import { groupMentionContexts, type MentionContextGroup } from "./entity-mention-groups";
import { MentionCheckIcon } from "./entity-mention-check-icon";
import { layoutMentionContexts } from "./entity-mention-layout";
import "./entity-mention-context.css";

function optionLabel(entity: Entity): string {
  const detail = entity.type === "place" && entity.address ? entity.address : entity.description || (entity.aliases ?? []).join("、");
  return `${entity.name}（${entity.type === "person" ? "人物" : "地点"}${detail ? `，${detail}` : ""}）`;
}

export const occurrenceKey = (candidate: Pick<EntityCandidate, "start" | "end">) => `${candidate.start}:${candidate.end}`;

function GroupCheck({ checked, mixed, disabled, index, onChange }: {
  checked: boolean; mixed: boolean; disabled: boolean; index: number; onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Native clicks clear indeterminate, even if unresolved identities keep the group mixed.
  useEffect(() => { if (inputRef.current) inputRef.current.indeterminate = mixed; });
  const state = checked ? "all" : mixed ? "mixed" : "none";
  return <label className="mention-review-group-toggle" data-state={state} title={disabled ? "请先选择关联对象" : checked ? "取消本段全部标记" : "选中本段可关联的标记"}>
    <input ref={inputRef} type="checkbox" checked={checked} disabled={disabled} aria-label={`第 ${index + 1} 段全部标记`} onChange={onChange} />
    <span className="mention-review-group-box"><MentionCheckIcon state={state} /></span>
  </label>;
}

function FadedText({ value, before, after, expanded }: { value: string; before: boolean; after: boolean; expanded: boolean }) {
  if (expanded) return <span>{value}</span>;
  // Text between two targets fades away from both ends; the nearest ten characters stay readable.
  if (before && after && value.length <= 20) return <span className="context-near">{value}</span>;
  const middle = before && after ? Math.ceil(value.length / 2) : 0;
  const leading = after ? (before ? value.slice(0, middle) : value) : "";
  const trailing = before ? (after ? value.slice(middle) : value) : "";
  return <>{after ? <><span className="context-near">{leading.slice(0, 10)}</span><span className="context-far context-after">{leading.slice(10)}</span></> : null}{before ? <><span className="context-far context-before">{trailing.slice(0, -10)}</span><span className="context-near">{trailing.slice(-10)}</span></> : null}</>;
}

function Context({ text, group, renderWord }: { text: string; group: MentionContextGroup; renderWord: (candidate: EntityCandidate) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const { candidates, paragraphStart, paragraphEnd, start, end } = group;
  const firstStart = candidates[0]!.start;
  const truncated = start > paragraphStart || end < paragraphEnd || group.wordClipped;
  return <div className={`mention-review-context${expanded ? " is-expanded" : ""}${truncated ? " is-expandable" : ""}`} data-excerpt-start={start}>
      {truncated ? <button className="mention-review-context-toggle" type="button" aria-label={expanded ? "收起本段上下文" : "展开本段上下文"} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} /> : null}
      {candidates.map((candidate, index) => <Fragment key={occurrenceKey(candidate)}>
        <FadedText value={(index === 0 && !expanded && start > paragraphStart && start < firstStart ? "…" : "") + text.slice(index === 0 ? (expanded ? paragraphStart : start) : candidates[index - 1]!.end, candidate.start)} before after={index > 0} expanded={expanded} />
        {renderWord(candidate)}
      </Fragment>)}
      <FadedText value={text.slice(candidates[candidates.length - 1]!.end, expanded ? paragraphEnd : end) + (!expanded && end < paragraphEnd ? "…" : "")} before={false} after expanded={expanded} />
    </div>;
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
  const [layout, setLayout] = useState(() => ({ text, candidates, groups: groupMentionContexts(text, candidates) }));
  const groups = layout.text === text && layout.candidates === candidates ? layout.groups : groupMentionContexts(text, candidates);
  useLayoutEffect(() => {
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
  useLayoutEffect(() => {
    const body = dialogRef.current?.querySelector<HTMLElement>(".mention-review-body");
    if (!body) return;
    const measure = () => {
      const next = layoutMentionContexts(text, candidates, body);
      setLayout(current => current.text === text && current.candidates === candidates && current.groups.length === next.length && current.groups.every((group, index) => {
        const other = next[index]!;
        return group.start === other.start && group.end === other.end && group.wordClipped === other.wordClipped && group.candidates.length === other.candidates.length
          && group.candidates.every((candidate, item) => candidate === other.candidates[item]);
      }) ? current : { text, candidates, groups: next });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    const copy = body.querySelector(".mention-review-copy");
    if (copy) observer.observe(copy);
    document.fonts.addEventListener("loadingdone", measure);
    return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", measure); };
  }, [text, candidates, choices]);
  const renderWord = (candidate: EntityCandidate) => {
    const id = occurrenceKey(candidate), target = assignmentsRef.current.get(id) ?? "";
    const entity = candidate.entities.find((item) => item.id === target);
    const types = entity ? [entity.type] : [...new Set(candidate.entities.map((item) => item.type))];
    const checked = Boolean(choices.get(id)), index = candidates.indexOf(candidate);
    return <label className={`mention-review-word${checked ? " is-selected" : " is-unselected"}`} data-entity-type={types.length === 1 ? types[0] : "ambiguous"} data-occurrence-start={candidate.start} title={entity ? optionLabel(entity) : "请先选择关联对象"}>
      <input type="checkbox" checked={checked} disabled={!target} aria-label={`标记第 ${index + 1} 处 ${candidate.text.replace(/^[@#]/u, "")}`} onChange={(event) => setChoices((current) => new Map(current).set(id, event.target.checked ? target : ""))} />
      <span className="mention-review-circle"><Check size={14} strokeWidth={3} aria-hidden="true" /></span>
      <strong>{candidate.text.replace(/^[@#]/u, "")}</strong>
      {types.includes("person") ? <User className="mention-review-type-icon" size={15} strokeWidth={1.9} aria-hidden="true" /> : null}
      {types.includes("place") ? <MapPin className="mention-review-type-icon" size={15} strokeWidth={1.9} aria-hidden="true" /> : null}
    </label>;
  };
  return <dialog ref={dialogRef} className="modal-dialog mention-review-dialog" aria-labelledby="mention-review-title" onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <div className="dialog-header"><h2 id="mention-review-title">{preferredEntity ? `核对「${preferredEntity.name}」` : "核对标记"}</h2><button className="icon-button compact-icon-button" type="button" aria-label="关闭标记核对" onClick={onClose}><X size={17} aria-hidden="true" /></button></div>
    {candidates.length > 1 ? <div className="mention-review-tools"><span role="status">已选 {selected} / {candidates.length} 处</span><div className="mention-review-actions"><button className="text-button" type="button" onClick={() => select(candidates, true)}>全选</button><button className="text-button" type="button" onClick={() => select(candidates, false)}>全不选</button></div></div> : null}
    <div className="dialog-body mention-review-body">
      <ol className="mention-review-list">{groups.map((group, groupIndex) => {
        const selectedInGroup = group.candidates.filter((candidate) => Boolean(choices.get(occurrenceKey(candidate)))).length;
        const all = selectedInGroup === group.candidates.length;
        return <li className="mention-review-item mention-review-context-group" key={occurrenceKey(group.candidates[0]!)}>
        <GroupCheck checked={all} mixed={selectedInGroup > 0 && !all} disabled={group.candidates.every((candidate) => !assignmentsRef.current.get(occurrenceKey(candidate)))} index={groupIndex} onChange={() => select(group.candidates, !all)} />
        <div className="mention-review-copy"><Context text={text} group={group} renderWord={renderWord} />
          {group.candidates.map((candidate) => {
            const id = occurrenceKey(candidate), index = candidates.indexOf(candidate);
            const target = assignmentsRef.current.get(id) ?? "", entity = candidate.entities.find((item) => item.id === target), ambiguous = candidate.entities.length > 1;
            if (ambiguous && !preferredEntity) return <label className="mention-review-assignment" key={id}><span>第 {index + 1} 处「{candidate.text.replace(/^[@#]/u, "")}」</span><select aria-label={`第 ${index + 1} 处的关联对象`} value={target} onChange={(event) => { assignmentsRef.current.set(id, event.target.value); setChoices((current) => new Map(current).set(id, event.target.value)); }}><option value="">暂不关联，请选择对象</option>{candidate.entities.map((option) => <option key={option.id} value={option.id}>{optionLabel(option)}</option>)}</select></label>;
            return entity && entity.name !== candidate.text.replace(/^[@#]/u, "") ? <small className="mention-review-target" key={id}>{candidate.text.replace(/^[@#]/u, "")} → {entity.name}</small> : null;
          })}</div>
      </li>;
      })}</ol>
    </div>
    <div className="dialog-footer mention-review-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => {
      const changed = candidates.map((candidate): TextEntityDecision => { const id = choices.get(occurrenceKey(candidate)) || null; const entity = candidate.entities.find((item) => item.id === id) ?? candidate.entities[0]!; return { start: candidate.start, end: candidate.end, text: candidate.text, entityId: id, entityType: entity.type as "person" | "place" }; });
      const untouched = decisions.filter((decision) => !candidates.some((candidate) => candidate.start < decision.end && decision.start < candidate.end));
      onConfirm([...untouched, ...changed].sort((a, b) => a.start - b.start));
    }}>确认标记</button></div>
  </dialog>;
}
