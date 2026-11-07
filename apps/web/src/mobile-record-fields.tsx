import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Film, MapPin, User, X } from "lucide-react";
import type { Entity, EntityRef } from "@lifeos/core";
import { entitySearchTerms, normalizeEntitySearchTerm } from "@lifeos/core";
import type { ComposerProps } from "./composer";
import { asCoreEntity, isMovieRef } from "./app-meta";
import { movieMentionDecisions, movieRef, MovieAddPanel } from "./movie";
import { PlaceSearch, placeDetailsOf } from "./place-search";
import { EntityCreateForm } from "./entity-forms";
import { ContactMentionAvatar } from "./contact-avatar";
import { DateField } from "./date-field";
import { TaskScheduleField } from "./task-schedule";
import { lockDialogScroll } from "./dialog-scroll-lock";
import { localDateToday } from "./time";
import { ArchiveLockIcon } from "./icon-archive";

function FieldSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement, dialog = ref.current!;
    const unlock = lockDialogScroll(); dialog.showModal();
    const viewport = visualViewport;
    const update = () => { dialog.style.top = `${(viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight)}px`; dialog.style.maxHeight = `${(viewport?.height ?? innerHeight) - 12}px`; };
    update(); viewport?.addEventListener("resize", update); viewport?.addEventListener("scroll", update);
    return () => { viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update); dialog.close(); unlock(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className="mobile-field-sheet" aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientY < r.top || event.clientY > r.bottom || event.clientX < r.left || event.clientX > r.right) onClose(); } }}>
    <header><h2>{title}</h2><button type="button" onClick={onClose} aria-label={`关闭${title}`}><X size={19} /></button></header>{children}
  </dialog>;
}

export function MobileRecordFields(props: ComposerProps) {
  const { kind, occurredAt, dueAt, onOccurredAtChange, onDueAtChange, entities, movieRefs: refs, onMovieRefsChange: changeRefs, saving, onNotify } = props;
  const [sheet, setSheet] = useState<"place" | "person" | "movie" | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const resolve = (ref: EntityRef) => entities.find(entity => entity.id === ref.entityId)?.name ?? ref.label ?? "已移除";
  const places = refs.filter(ref => ref.entityType === "place"), people = refs.filter(ref => ref.entityType === "person"), movies = refs.filter(isMovieRef);
  const attach = (entity: Entity) => {
    const next = refs.filter(ref => ref.entityId !== entity.id && (entity.type !== "place" || ref.entityType !== "place"));
    changeRefs([...next, { entityType: entity.type, entityId: entity.id, label: entity.name }]);
  };
  const close = () => { if (!busy) { setSheet(null); setCreating(false); setSearch(""); } };
  const needle = normalizeEntitySearchTerm(search);
  const candidates = entities.filter(entity => entity.type === "person" && (!needle || entitySearchTerms(entity).some(term => normalizeEntitySearchTerm(term).includes(needle))));
  return <>
    <fieldset className="mobile-record-fields" disabled={saving}>
      {kind === "task" ? <TaskScheduleField sheet start={occurredAt} end={dueAt} onStartChange={onOccurredAtChange} onEndChange={onDueAtChange} /> : <DateField sheet value={occurredAt} onChange={onOccurredAtChange} label="发生时间" showTime capped />}
      {props.photoTimeHint && props.onUseNow ? <button type="button" className="mobile-photo-time" onClick={props.onUseNow}>来自照片，改回现在</button> : null}
      <button className="mobile-record-row" type="button" onClick={() => setSheet("place")}><MapPin size={20} strokeWidth={1.7} /><span>所在位置</span><span className="mobile-record-value">{places.map(resolve).join("、") || "未选择"}</span><ChevronRight size={17} /></button>
      <button className="mobile-record-row" type="button" onClick={() => setSheet("person")}><User size={20} strokeWidth={1.7} /><span>相关人物</span><span className="mobile-record-value">{people.map(resolve).join("、") || "未选择"}</span><ChevronRight size={17} /></button>
      {props.movieEnabled ? <button className="mobile-record-row" type="button" onClick={() => setSheet("movie")}><Film size={20} strokeWidth={1.7} /><span>相关影片</span><span className="mobile-record-value">{movies.map(resolve).join("、") || "未选择"}</span><ChevronRight size={17} /></button> : null}
      <label className="mobile-record-row mobile-record-toggle"><ArchiveLockIcon /><span>隐私记录</span><input type="checkbox" checked={props.isPrivate} onChange={event => props.onPrivateChange(event.target.checked)} /><span className="mobile-record-switch" aria-hidden="true" /></label>
      {kind === "journal" && occurredAt && occurredAt.slice(0, 10) < localDateToday() ? <label className="mobile-record-row mobile-record-toggle"><span>补记</span><input type="checkbox" checked={props.isBackfill} onChange={event => props.onBackfillChange(event.target.checked)} /><span className="mobile-record-switch" aria-hidden="true" /></label> : null}
    </fieldset>
    {sheet ? <FieldSheet title={sheet === "place" ? "所在位置" : sheet === "movie" ? "相关影片" : "相关人物"} onClose={close}>
      {creating ? null : sheet === "movie" ? <><button className="mobile-place-clear" type="button" disabled={busy} onClick={() => { changeRefs(refs.filter(ref => !isMovieRef(ref))); close(); }}>不添加影片{movies.length === 0 ? <Check size={17} /> : null}</button><MovieAddPanel enabled={props.movieEnabled} compact onAttach={movie => { props.onMovieEntity(movie); changeRefs([...refs.filter(ref => !isMovieRef(ref)), movieRef(movie) as unknown as EntityRef]); // Same rule as the desktop box: naming the film marks it, no second confirmation.
  const marked = movieMentionDecisions(props.content, entities, props.decisions, asCoreEntity(movie)); if (marked !== null) { props.onDecisionsChange(marked); onNotify(`已标记为影片《${movie.name}》`); } setSheet(null); }} /></> : sheet === "place" ? <><button className="mobile-place-clear" type="button" disabled={busy} onClick={() => { changeRefs(refs.filter(ref => ref.entityType !== "place")); close(); }}>不添加位置{places.length === 0 ? <Check size={17} /> : null}</button><PlaceSearch entities={entities} recentPlaceIds={props.recentPlaceIds} includePrivate={props.placeIncludePrivate} hideDemo={props.placeHideDemo} onDismiss={close} onPick={async choice => {
        setBusy(true);
        try { const entity = "id" in choice ? choice : await props.onCreateEntity("place", choice.name, { address: choice.address, role: choice.role, ...placeDetailsOf(choice) }); if (!entity) throw new Error("地点未能保存，请重试"); attach(entity); setSheet(null); }
        finally { setBusy(false); }
      }} onManual={name => { setSearch(name); setCreating(true); }} /></> : <><input className="mobile-people-search" type="search" aria-label="搜索相关人物" placeholder="搜索人物" value={search} onChange={event => setSearch(event.target.value)} /><div className="mobile-people-list">{candidates.map(entity => { const checked = people.some(ref => ref.entityId === entity.id); return <button type="button" key={entity.id} className="mobile-person-choice" aria-pressed={checked} onClick={() => checked ? changeRefs(refs.filter(ref => ref.entityId !== entity.id)) : attach(entity)}><ContactMentionAvatar entity={entity} /><span>{entity.name}</span><span className="mobile-person-check">{checked ? <Check size={16} /> : null}</span></button>; })}{candidates.length === 0 ? <p>没有匹配的人物</p> : null}</div><button type="button" className="mobile-person-new" onClick={() => setCreating(true)}>＋ 新建人物</button><footer><button type="button" onClick={close}>完成</button></footer></>}
      {creating && sheet !== "movie" ? <EntityCreateForm fixedType defaultType={sheet} defaultName={search} onCancel={() => setCreating(false)} submitLabel="创建并关联" onCreate={async request => {
        setBusy(true);
        try { const { type, name, ...extras } = request; const entity = request.existing ?? await props.onCreateEntity(type, name, extras); if (!entity) return false; attach(entity); setCreating(false); if (type === "place") setSheet(null); return true; }
        catch { onNotify("未能创建，请重试", "warn"); return false; }
        finally { setBusy(false); }
      }} /> : null}
    </FieldSheet> : null}
  </>;
}
