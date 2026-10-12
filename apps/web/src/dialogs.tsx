import { PlaceCardDialog } from "./place-card";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  CircleHelp,
  ContactRound,
  Edit3,
  Eye,
  EyeOff,
  ExternalLink,
  FileJson,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Plus,
  Search,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";
import type { Entity, EntityKind, PlaceDetails, PlacePeriod, PlaceRole } from "@lifeos/core";
import { PlaceSearch, PlaceRoleField, placeDetailsOf } from "./place-search";
import { CONTACT_ACTIVITY_HALF_LIFE_DAYS, PLACE_ROLES, type ContactActivity } from "@lifeos/core";
import { contactThreshold, selectContacts } from "./contact-library";
import "./contact-library.css";
import { ContactAvatar } from "./contact-avatar";
import { ContactStar, type ToggleContactStar } from "./contact-star";
import { apiRequest, type ApiError, type AuthState, type EntitiesResponse, type MovieEntity, type RecordView } from "./api";
import { EntityNameHistoryReview, type NameHistoryReview } from "./entity-name-history-review";
import type { AppView, CreateEntity, EntityCreateRequest, EntityEditPatch } from "./app-types";
import { AliasField, EntityCreateForm, aliasListFrom } from "./entity-forms";
import {
  ENTITY_KIND_ORDER,
  ENTITY_META,
  MOBILE_MORE_ITEMS,
  RELATION_META,
  SELF_ENTITY_ID,
  isMovieEntity,
  recordText,
  relationKindFor,
  relationLabelFor,
} from "./app-meta";
import { PLACE_ROLE_LABELS, placeRoleLabel, RecordText, entityHint, mentionVocabulary } from "./mention";
import { MovieCardDialog } from "./movie";
import { lifeTimeDate, shortDate } from "./time";

export function ConfirmDialog({ record, busy, error, onClose, onConfirm }: { record: RecordView | null; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (record && !dialog.open) dialog.showModal(); if (!record && dialog.open) dialog.close(); }, [record]);
  if (!record) return <dialog ref={dialogRef} className="modal-dialog" />;
  return <dialog ref={dialogRef} className="modal-dialog confirm-dialog" aria-labelledby="delete-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">删除记录</p><h2 id="delete-title">确定要删除这条记录吗？</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={17} aria-hidden="true" /></button></div><p className="confirm-copy">原文会从时间轴移除。导出的备份不会被修改。</p><div className="confirm-preview">{recordText(record)}</div>{error ? <p className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" />{error}</p> : null}<div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>保留</button><button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Trash2 size={17} aria-hidden="true" />}<span>{busy ? "删除中" : "删除记录"}</span></button></div></dialog>;
}

export function PersonCardDialog({ entity, entities, scope, onEditAvatar, onToggleStar, onClose, onEdit, onViewRecords, onMovieSaved, onPlaceSaved }: { entity: Entity | null; entities: readonly Entity[]; scope: string; onEditAvatar: (entity: Entity) => void; onToggleStar: ToggleContactStar; onClose: () => void; onEdit: (entity: Entity) => void; onViewRecords: (entity: Entity) => void; onMovieSaved: (movie: MovieEntity) => void; onPlaceSaved: (entity: Entity) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (entity && !dialog.open) dialog.showModal(); if (!entity && dialog.open) dialog.close(); }, [entity]);
  if (entity === null) return <dialog ref={dialogRef} className="modal-dialog" />;
  if (isMovieEntity(entity)) return <MovieCardDialog entity={entity} onClose={onClose} onSaved={onMovieSaved} />;
  if (entity.type === "place") return <PlaceCardDialog key={entity.id} entity={entity} scope={scope} onClose={onClose} onEdit={onEdit} onEditAvatar={onEditAvatar} onViewRecords={onViewRecords} onSaved={onPlaceSaved} />;
  const relationKind = relationKindFor(entity.id, entities);
  const relationItems = (entity.relations ?? []).filter((relation) => relation.entityId !== SELF_ENTITY_ID).map((relation) => ({ relation, target: entities.find((candidate) => candidate.id === relation.entityId) })).filter((item) => item.target !== undefined);
  return <dialog ref={dialogRef} className="modal-dialog person-card-dialog" aria-labelledby="person-card-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="person-card-hero">{entity.type === "person" ? <ContactAvatar entity={entity} scope={scope} onEdit={onEditAvatar} /> : <div className="person-card-avatar"><ContactRound size={25} strokeWidth={1.7} aria-hidden="true" /></div>}<div className="person-card-heading"><div className="person-card-name"><h2 id="person-card-title">{entity.name}</h2><ContactStar entity={entity} onToggle={onToggleStar} /></div>{relationKind === undefined ? null : <span className={`person-card-relation relation-kind-${relationKind}`}><span className="relation-card-icon">{(() => { const Icon = RELATION_META[relationKind].icon; return <Icon size={13} strokeWidth={1.9} aria-hidden="true" />; })()}</span>{RELATION_META[relationKind].label}</span>}</div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭人物卡片"><X size={17} aria-hidden="true" /></button></div>
    <div className="person-card-body">
      {entity.aliases && entity.aliases.length > 0 ? <div className="person-card-field"><small>别名</small><div className="person-card-aliases">{entity.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div></div> : null}
      {entity.description ? <div className="person-card-field"><small>备注</small><p>{entity.description}</p></div> : <p className="person-card-empty">还没有人物备注，可以在编辑人物里补充。</p>}
      {relationItems.length > 0 ? <div className="person-card-field"><small>关系</small><div className="person-card-connections">{relationItems.map(({ relation, target }) => { const Icon = RELATION_META[relation.kind].icon; return <span className={`person-card-connection relation-kind-${relation.kind}`} key={`${relation.kind}-${target!.id}`}><Icon size={13} strokeWidth={1.9} aria-hidden="true" /><span>{target!.name}</span><small>{RELATION_META[relation.kind].label}</small></span>; })}</div></div> : null}
    </div>
    <div className="dialog-footer person-card-footer"><button className="secondary-button" type="button" onClick={() => onViewRecords(entity)}><ExternalLink size={15} aria-hidden="true" /><span>查看相关记录</span></button><button className="primary-button" type="button" onClick={() => onEdit(entity)}><Edit3 size={15} aria-hidden="true" /><span>编辑人物</span></button></div>
  </dialog>;
}

export function EntityEditDialog({ entity, onClose, onSave, onRecordsChanged }: { entity: Entity | null; onClose: () => void; onSave: (entity: Entity, patch: EntityEditPatch) => Promise<Entity | null>; onRecordsChanged: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<PlaceRole | "">("");
  const [hasPeriod, setHasPeriod] = useState(false);
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [hasAddress, setHasAddress] = useState(false);
  const [address, setAddress] = useState("");
  const [details, setDetails] = useState<PlaceDetails>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviews, setReviews] = useState<readonly NameHistoryReview[]>([]);
  const [saveError, setSaveError] = useState("");
  // Existing aliases come back slash-separated, matching what the field now
  // accepts -- round-tripping through the old comma join would have shown them
  // as one unseparated run the moment anything was edited.
  useEffect(() => { if (entity) {
    setName(entity.name);
    setReviews([]);
    setSaveError("");
    setAliases(JSON.stringify(entity.aliases?.length ? entity.aliases : [""]));
    setDescription(entity.description ?? "");
    setRole(entity.type === "place" ? entity.role ?? "" : "");
    setHasPeriod(entity.type === "place" && entity.period !== undefined);
    setFrom(entity.type === "place" ? entity.period?.from ?? "" : "");
    setUntil(entity.type === "place" ? entity.period?.until ?? "" : "");
    setHasAddress(entity.type === "place" && Boolean(entity.address));
    setAddress(entity.type === "place" ? entity.address ?? "" : "");
    setDetails(entity.type === "place" ? placeDetailsOf(entity) : {}); setSearchOpen(false);
  } }, [entity?.id]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (entity && !dialog.open) dialog.showModal(); if (!entity && dialog.open) dialog.close(); }, [entity]);
  if (entity === null) return <dialog ref={dialogRef} className="modal-dialog" />;
  const submit = async () => {
    const nextName = name.trim();
    if (!nextName || saving) return;
    setSaving(true);
    setSaveError("");
    try {
    const result = await onSave(entity, {
      name: nextName,
      aliases: aliasListFrom(aliases),
      description: description.trim(),
      ...(entity.type === "place" ? {
        role: role || null,
        period: hasPeriod && (from || until) ? { ...(from ? { from } : {}), ...(until ? { until } : {}) } : null,
        address: hasAddress ? address.trim() || null : null,
        ...placeDetailsOf(details), phone: details.phone?.trim() || null, city: details.city?.trim() || null,
      } : {}),
    });
    if (result) onClose();
    } catch (error) {
      const apiError = error as ApiError;
      const details = apiError.details as { review?: readonly NameHistoryReview[] } | undefined;
      if (apiError.code === "entity_name_review_required" && details?.review) setReviews(details.review);
      else setSaveError(error instanceof Error ? error.message : "保存失败，请重试");
    } finally { setSaving(false); }
  };
  return <dialog ref={dialogRef} className="modal-dialog entity-edit-dialog" aria-labelledby="entity-edit-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="dialog-header"><div><p className="eyebrow">{entity.type === "place" ? "地点资料" : "联系人资料"}</p><h2 id="entity-edit-title">编辑 {entity.name}</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭编辑"><X size={17} aria-hidden="true" /></button></div>
    <div className="entity-edit-body">
      <label className="dialog-field"><span>{entity.type === "place" ? "名称" : "姓名"}</span><input disabled={saving} value={name} onChange={(event) => setName(event.target.value)} />{entity.type === "person" && name.trim() && name.trim() !== entity.name ? <small className="alias-paste-hint">保存后，原名称“{entity.name}”会保留为别名。历史日记仍使用原称呼。</small> : null}</label>
      <div className="dialog-field"><span>别名</span><AliasField key={entity.id} preserveHistory={entity.type === "person" || entity.type === "place"} disabled={saving} value={aliases} onChange={setAliases} label="别名，用斜杠分隔" /></div>
      {entity.type === "place" ? <>
        <div className="place-search-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setSearchOpen(value => !value)}>{searchOpen ? "收起地点搜索" : "搜索补全资料"}</button></div>
        {searchOpen ? <PlaceSearch initialQuery={name} onPick={choice => { setName(choice.name); setAddress(choice.address ?? ""); setHasAddress(Boolean(choice.address)); setRole(choice.role ?? role); setDetails(placeDetailsOf(choice)); setSearchOpen(false); }} /> : null}
        <PlaceRoleField value={role} onChange={setRole} disabled={saving} />
        <label className="dialog-field"><span>城市</span><input aria-label="地点所在城市" value={details.city ?? ""} disabled={saving} onChange={event => setDetails(value => ({ ...value, city: event.target.value }))} /></label>
        <label className="dialog-field"><span>电话</span><input aria-label="地点电话" type="tel" value={details.phone ?? ""} disabled={saving} onChange={event => setDetails(value => ({ ...value, phone: event.target.value }))} /></label>
        <div className="entity-create-optional-row"><label className="entity-optional-toggle"><input type="checkbox" checked={hasPeriod} onChange={(event) => setHasPeriod(event.target.checked)} />添加时期</label><label className="entity-optional-toggle"><input type="checkbox" checked={hasAddress} onChange={(event) => setHasAddress(event.target.checked)} />添加详细地址</label></div>
        {hasPeriod ? <div className="dialog-field"><span>时期</span><div className="entity-edit-period"><input type="month" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="开始年月" /><span>至</span><input type="month" value={until} onChange={(event) => setUntil(event.target.value)} aria-label="结束年月，留空表示至今" /></div></div> : null}
        {hasAddress ? <label className="dialog-field"><span>详细地址</span><input value={address} onChange={(event) => setAddress(event.target.value)} /></label> : null}
      </> : null}
      <label className="dialog-field"><span>备注</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      {reviews.length ? <EntityNameHistoryReview reviews={reviews} onReviewed={id => setReviews(current => current.filter(review => review.recordId !== id))} onChanged={onRecordsChanged} /> : null}
      {saveError ? <p className="dialog-error" role="alert">{saveError}</p> : null}
    </div>
    <div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="button" onClick={() => void submit()} disabled={!name.trim() || saving}>{saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}<span>{saving ? "保存中" : "保存"}</span></button></div>
  </dialog>;
}

export function entityRelatedRecords(entity: Entity, records: readonly RecordView[]): readonly RecordView[] {
  return records.filter((record) => record.entityRefs.some((ref) => ref.entityId === entity.id)).slice(0, 3);
}

export function locationSearchUrl(address: string): string {
  return `https://uri.amap.com/search?keyword=${encodeURIComponent(address)}`;
}

export function entityPeriodLabel(entity: Entity): string | null {
  if (entity.type !== "place" || entity.period === undefined) return null;
  const from = entity.period.from ?? "更早";
  const until = entity.period.until ?? "至今";
  return `${from}—${until}`;
}

export function EntitiesView({ entities, records, scope, generation, hideDemo, includePrivate, onCreateEntity, onToggleStar, onEditAvatar, onEdit, onViewRecords, onOpenEntity }: { readonly entities: readonly Entity[]; readonly records: readonly RecordView[]; readonly scope: string; readonly generation: number; readonly hideDemo: boolean; readonly includePrivate: boolean; readonly onCreateEntity: CreateEntity; readonly onToggleStar: ToggleContactStar; readonly onEditAvatar: (entity: Entity) => void; readonly onEdit: (entity: Entity) => void; readonly onViewRecords: (entity: Entity) => void; readonly onOpenEntity: (entity: Entity) => void }) {
  const [tab, setTab] = useState<"person" | "place">("person");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [mode, setMode] = useState<"common" | "all">("common");
  const [query, setQuery] = useState("");
  const [placeRole, setPlaceRole] = useState("");
  const [placeSearchOpen, setPlaceSearchOpen] = useState(false);
  const thresholdKey = `lifeos.contacts.threshold:${scope}`;
  const [threshold, setThreshold] = useState(() => { try { return contactThreshold(localStorage.getItem(thresholdKey)); } catch { return contactThreshold(null); } });
  const [retry, setRetry] = useState(0);
  const currentDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const [day, setDay] = useState(currentDay);
  useEffect(() => { const timer = window.setInterval(() => setDay(currentDay()), 60_000); return () => window.clearInterval(timer); }, []);
  const activityKey = `${scope}|${generation}|${hideDemo}|${includePrivate}|${retry}|${day}`;
  const [activityState, setActivityState] = useState<{ key: string; items: readonly ContactActivity[]; error?: string } | null>(null);
  useEffect(() => {
    if (tab !== "person") return;
    const controller = new AbortController();
    apiRequest<{ items: readonly ContactActivity[] }>(`/api/contacts/activity?hideDemo=${hideDemo ? 1 : 0}&includePrivate=${includePrivate ? 1 : 0}`, { signal: controller.signal })
      .then(payload => { if (!controller.signal.aborted) setActivityState({ key: activityKey, items: payload.items }); })
      .catch(() => { if (!controller.signal.aborted) setActivityState({ key: activityKey, items: [], error: "提及热度暂时无法读取。可以重试，或查看全部联系人。" }); });
    return () => controller.abort();
  }, [activityKey, tab, hideDemo, includePrivate]);
  const activity = activityState?.key === activityKey ? activityState.items : [];
  const activityError = activityState?.key === activityKey ? activityState.error : undefined;
  const activityLoading = activityState?.key !== activityKey;
  const people = entities.filter(entity => entity.type === "person");
  const common = selectContacts(entities, activity, "common", "", threshold);
  const items = tab === "person" ? selectContacts(entities, activity, mode, query, threshold) : entities.filter(entity => entity.type === "place" && (!placeRole || entity.role === placeRole) && [entity.name, ...(entity.aliases ?? []), entity.address, entity.city].filter(Boolean).join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const create = async (request: EntityCreateRequest): Promise<boolean> => {
    const { type, name, ...extras } = request;
    const entity = await onCreateEntity(type, name, extras);
    if (entity !== null) setCreateOpen(false);
    return entity !== null;
  };
  return <section className="entities-section" aria-labelledby="entities-title">
    <div className="page-heading entities-heading"><div><p className="eyebrow">关联对象</p><h1 id="entities-title">联系人与地点</h1><p>集中管理会出现在时间轴里的联系人与地点。</p></div><button className="primary-button" type="button" onClick={() => { setCreateName(""); setCreateOpen((current) => !current); }}><Plus size={16} aria-hidden="true" /><span>新建{tab === "person" ? "联系人" : "地点"}</span></button></div>
    {createOpen ? <div className="entities-create-panel"><EntityCreateForm defaultType={tab} defaultName={createName} onCreate={create} onCancel={() => setCreateOpen(false)} submitLabel={`创建${tab === "person" ? "联系人" : "地点"}`} /></div> : null}
    <div className="entities-tabs" role="tablist" aria-label="联系人与地点分类">
      <button type="button" role="tab" aria-selected={tab === "person"} className={`entities-tab ${tab === "person" ? "is-active" : ""}`} onClick={() => { setTab("person"); setCreateOpen(false); }}><User size={16} aria-hidden="true" />联系人<span>{entities.filter((entity) => entity.type === "person").length}</span></button>
      <button type="button" role="tab" aria-selected={tab === "place"} className={`entities-tab ${tab === "place" ? "is-active" : ""}`} onClick={() => { setTab("place"); setCreateOpen(false); }}><MapPin size={16} aria-hidden="true" />地点<span>{entities.filter((entity) => entity.type === "place").length}</span></button>
    </div>
    {tab === "place" ? <div className="place-library-controls"><div className="place-search-actions"><label className="contacts-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索已有地点" value={query} placeholder="查找已有地点、城市或地址" onChange={event => setQuery(event.target.value)} /></label><button type="button" className="secondary-button" onClick={() => setPlaceSearchOpen(value => !value)}>{placeSearchOpen ? "收起搜索" : "搜索店铺或地址"}</button></div><div className="place-role-filters" role="group" aria-label="按地点角色筛选">{["", ...new Set([...PLACE_ROLES, ...entities.flatMap(entity => entity.type === "place" && entity.role ? [entity.role] : [])])].map(role => <button key={role} type="button" aria-pressed={placeRole === role} onClick={() => setPlaceRole(role)}>{role ? placeRoleLabel(role) : "全部地点"}</button>)}</div>{placeSearchOpen ? <PlaceSearch entities={entities} initialQuery={query} onManual={name => { setCreateName(name); setCreateOpen(true); setPlaceSearchOpen(false); }} onPick={async choice => { if (!("id" in choice)) { const { name, ...extras } = choice; if (!await onCreateEntity("place", name, extras)) throw new Error("地点未能保存，请重试"); } setPlaceSearchOpen(false); setQuery(""); setPlaceRole(""); }} /> : null}</div> : null}
    {tab === "person" ? <div className="contacts-controls">
      <div className="contacts-toolbar"><div className="contacts-modes" role="group" aria-label="联系人显示范围"><button type="button" className={mode === "common" ? "primary-button" : "secondary-button"} aria-pressed={mode === "common"} onClick={() => setMode("common")}>常用联系人</button><button type="button" className={mode === "all" ? "primary-button" : "secondary-button"} aria-pressed={mode === "all"} onClick={() => setMode("all")}>全部联系人</button></div><label className="contacts-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索全部联系人的姓名或别名" placeholder="搜索姓名或别名" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <p className="contacts-description">{query.trim() ? `搜索全部联系人，找到 ${items.length} 位` : mode === "all" ? `全部 ${people.length} 位，按姓名拼音顺序排列` : `常见或已收藏联系人 ${common.length} 位，按近期提及热度排列；其余 ${people.length - common.length} 位可在全部联系人中查看。`}</p>
      <details className="contacts-rules"><summary>显示规则</summary><p>每条关联记录计一次提及，重复出现同一个名字只计一次。每过 {CONTACT_ACTIVITY_HALF_LIFE_DAYS} 天，贡献减半；达到门槛或已收藏的联系人会默认显示。沉底只影响展示，关联记录始终保留。</p><label className="contacts-threshold"><span>常用门槛</span><input type="number" aria-label="常用联系人热度门槛" min="0.5" max="20" step="0.5" value={threshold} onChange={event => { if (!event.target.validity.valid || !event.target.value) return; const value = contactThreshold(event.target.value); setThreshold(value); try { localStorage.setItem(thresholdKey, String(value)); } catch { /* Still usable when local storage is unavailable. */ } }} /><span>次近期提及的等效分值</span></label><p>门槛越高，默认显示的人越少。点亮星星即可收藏，已收藏的联系人不受门槛影响。</p></details>
      {activityLoading ? <p className="contacts-description" role="status">正在读取提及热度…</p> : null}
      {activityError ? <div className="contacts-error" role="alert"><p>{activityError}</p><button className="secondary-button" type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div> : null}
    </div> : null}
    <div className="entities-grid" role="tabpanel" aria-label={tab === "person" ? "联系人" : "地点"}>
      {items.length === 0 && !(tab === "person" && !query.trim() && mode === "common" && (activityLoading || activityError)) ? <div className="entities-empty"><ContactRound size={24} aria-hidden="true" /><strong>{tab === "person" && query.trim() ? "没有匹配的联系人" : tab === "person" && people.length > 0 ? "暂时没有达到门槛的联系人" : `还没有${tab === "person" ? "联系人" : "地点"}`}</strong><span>{tab === "person" && query.trim() ? "试试其他姓名或别名。" : tab === "person" && people.length > 0 ? "可以查看全部联系人，点亮星星收藏在意的人。" : `从右上角新建一个，之后可以在记录中用 ${tab === "person" ? "@" : "#"} 提及。`}</span></div> : items.map((entity) => {
        const recent = entityRelatedRecords(entity, records);
        const relation = entity.type === "person" ? relationLabelFor(entity.id, entities) : undefined;
        const period = entityPeriodLabel(entity);
        return <article className={`entity-library-card entity-library-card--${entity.type}`} key={entity.id} data-entity-card={entity.id}>
          <div className="entity-library-card-head">{<ContactAvatar entity={entity} scope={scope} small onEdit={onEditAvatar} />}<div><h2>{entity.type === "place" ? <button className="place-library-name" type="button" onClick={() => onOpenEntity(entity)} aria-label={`查看地点：${entity.name}`}>{entity.name}</button> : entity.name}</h2>{relation ? <span className="entity-library-role">{relation}</span> : entity.type === "place" && entity.role ? <span className="entity-library-role">{placeRoleLabel(entity.role)}</span> : null}</div><div className="entity-library-card-actions"><ContactStar entity={entity} onToggle={onToggleStar} /><button className="icon-button compact-icon-button" type="button" onClick={() => onEdit(entity)} aria-label={`编辑${entity.type === "person" ? "联系人" : "地点"}${entity.name}`}><Edit3 size={15} aria-hidden="true" /></button></div></div>
          <div className="entity-library-meta">{entity.aliases && entity.aliases.length > 0 ? <span>别名：{entity.aliases.join("、")}</span> : null}{period ? <span>时期：{period}</span> : null}</div>
          {entity.type === "place" && entity.phone ? <a className="entity-library-phone" href={`tel:${entity.phone.split(/[;,；]/)[0]?.replace(/[^0-9+*#-]/g, "")}`} aria-label={`拨打${entity.name}电话`}>{entity.phone}</a> : null}{entity.type === "place" && entity.address ? <div className="entity-library-address"><a href={entity.longitude !== undefined && entity.latitude !== undefined ? `https://uri.amap.com/marker?position=${entity.longitude},${entity.latitude}&name=${encodeURIComponent(entity.name)}` : locationSearchUrl(entity.address)} target="_blank" rel="noreferrer" aria-label={`一键定位${entity.name}`}>一键定位</a><details><summary>查看详细地址</summary><span>{entity.address}</span></details></div> : null}
          <div className="entity-library-recent"><small>最近关联记录</small>{recent.length > 0 ? recent.map((record) => <button type="button" className="entity-library-record" key={record.id} onClick={() => onViewRecords(entity)}><time>{shortDate(lifeTimeDate(record.occurredAt ?? record.createdAt) ?? "")}</time><span>{record.isPrivate ? "隐私记录" : recordText(record).slice(0, 32)}</span></button>) : <span className="entity-library-muted">暂无关联记录</span>}</div>
          <button className="entity-library-view" type="button" onClick={() => onViewRecords(entity)}>查看全部关联记录 <ExternalLink size={13} aria-hidden="true" /></button>
        </article>;
      })}
    </div>
  </section>;
}

export function MobileMenuDialog({ open, activeView, onClose, onNavigate, onOpenSearch }: { open: boolean; activeView: AppView; onClose: () => void; onNavigate: (view: AppView) => void; onOpenSearch: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The parent hands down a fresh callback on every render. Holding it in a ref
  // keeps the positioning effect from tearing down and re-focusing the first
  // item every time anything else on the page changes.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  // Layout effects, not passive ones: the popover has to be moved into place in
  // the same frame it is shown, otherwise it flashes at its static position.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.show();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const trigger = document.getElementById("mobile-more-trigger");
    if (!dialog) return;

    const positionMenu = () => {
      if (!dialog.open) return;
      if (!trigger || trigger.getClientRects().length === 0) {
        closeRef.current();
        return;
      }
      const anchor = trigger.getBoundingClientRect();
      const menu = dialog.getBoundingClientRect();
      const edge = 10;
      const gap = 8;
      const left = Math.max(edge, Math.min(anchor.left + anchor.width / 2 - menu.width / 2, window.innerWidth - menu.width - edge));
      const top = Math.max(edge, Math.min(anchor.top - menu.height - gap, window.innerHeight - menu.height - edge));
      dialog.style.left = `${left}px`;
      dialog.style.top = `${top}px`;
    };
    const onOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (dialog.contains(target) || trigger?.contains(target))) return;
      closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
      trigger?.focus({ preventScroll: true });
    };

    positionMenu();
    dialog.querySelector<HTMLButtonElement>(".mobile-menu-nav-item")?.focus({ preventScroll: true });
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  return <dialog ref={dialogRef} id="mobile-more-menu" className="mobile-menu-dialog" aria-label="更多功能" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><nav className="mobile-menu-nav" aria-label="移动端更多功能">{MOBILE_MORE_ITEMS.map((item) => { const Icon = item.icon; return <button className={`mobile-menu-nav-item ${activeView === item.id ? "is-active" : ""}`} type="button" key={item.id} onClick={() => { onNavigate(item.id); onClose(); }} aria-current={activeView === item.id ? "page" : undefined}><Icon size={18} aria-hidden="true" /><span>{item.label}</span></button>; })}<button className="mobile-menu-nav-item mobile-menu-nav-item--search" type="button" onClick={() => { onClose(); onOpenSearch(); }}><Search size={18} aria-hidden="true" /><span>搜索记录</span></button></nav></dialog>;
}

export function ImportDialog({ file, busy, error, onClose, onConfirm }: { file: File | null; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (file && !dialog.open) dialog.showModal(); if (!file && dialog.open) dialog.close(); }, [file]);
  if (!file) return <dialog ref={dialogRef} className="modal-dialog" />;
  return <dialog ref={dialogRef} className="modal-dialog confirm-dialog" aria-labelledby="import-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">导入备份</p><h2 id="import-title">确认恢复这份 JSON？</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={17} aria-hidden="true" /></button></div><p className="confirm-copy">LifeOS 会把这份备份交给 API 校验后恢复。先确认文件来自你信任的备份。</p><div className="confirm-preview import-file"><FileJson size={18} aria-hidden="true" /><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></div>{error ? <p className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" />{error}</p> : null}<div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Upload size={17} aria-hidden="true" />}<span>{busy ? "导入中" : "确认导入"}</span></button></div></dialog>;
}

export function LoginGate({ onLogin, error, loading, accountMode = false }: { onLogin: (username: string, password: string) => void; error: string | null; loading: boolean; accountMode?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  return <main className="auth-screen"><div className="auth-panel surface" role="dialog" aria-modal="true" aria-labelledby="auth-title"><div className="auth-icon"><LockKeyhole size={21} strokeWidth={1.8} aria-hidden="true" /></div><p className="eyebrow">LifeOS</p><h1 id="auth-title">{accountMode ? "登录你的空间" : "输入访问密码"}</h1><p className="auth-description">这是一个自托管的私人空间。</p><form onSubmit={(event) => { event.preventDefault(); onLogin(username, password); }}>{accountMode ? <label className="auth-label"><span>账号</span><input type="text" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label> : null}<div className="auth-label"><label htmlFor="auth-password">密码</label><div className="auth-password-field"><input id="auth-password" type={passwordVisible ? "text" : "password"} name="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" aria-label={passwordVisible ? "隐藏密码" : "显示密码"} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((current) => !current)}>{passwordVisible ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}</button></div></div>{error ? <p className="auth-error" role="alert">{error}</p> : null}<button className="primary-button auth-submit" type="submit" disabled={!password || (accountMode && !username) || loading}>{loading ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <LockKeyhole size={17} aria-hidden="true" />}<span>{loading ? "验证中" : "进入 LifeOS"}</span></button></form></div></main>;
}
