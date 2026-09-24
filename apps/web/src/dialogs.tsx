import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  CircleHelp,
  ContactRound,
  Edit3,
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
import type { Entity, EntityKind, PlacePeriod, PlaceRole } from "@lifeos/core";
import { PLACE_ROLES } from "@lifeos/core";
import { apiRequest, type AuthState, type EntitiesResponse, type MovieEntity, type RecordView } from "./api";
import type { AppView, CreateEntity, EntityCreateRequest } from "./app-types";
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
import { PLACE_ROLE_LABELS, RecordText, entityHint, mentionVocabulary } from "./mention";
import { MovieCardDialog } from "./movie";
import { lifeTimeDate, shortDate } from "./time";

export function ConfirmDialog({ record, busy, error, onClose, onConfirm }: { record: RecordView | null; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (record && !dialog.open) dialog.showModal(); if (!record && dialog.open) dialog.close(); }, [record]);
  if (!record) return <dialog ref={dialogRef} className="modal-dialog" />;
  return <dialog ref={dialogRef} className="modal-dialog confirm-dialog" aria-labelledby="delete-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">删除记录</p><h2 id="delete-title">确定要删除这条记录吗？</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={17} aria-hidden="true" /></button></div><p className="confirm-copy">原文会从时间轴移除。导出的备份不会被修改。</p><div className="confirm-preview">{recordText(record)}</div>{error ? <p className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" />{error}</p> : null}<div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>保留</button><button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Trash2 size={17} aria-hidden="true" />}<span>{busy ? "删除中" : "删除记录"}</span></button></div></dialog>;
}

export function PersonCardDialog({ entity, entities, onClose, onEdit, onViewRecords, onMovieSaved }: { entity: Entity | null; entities: readonly Entity[]; onClose: () => void; onEdit: (entity: Entity) => void; onViewRecords: (entity: Entity) => void; onMovieSaved: (movie: MovieEntity) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (entity && !dialog.open) dialog.showModal(); if (!entity && dialog.open) dialog.close(); }, [entity]);
  if (entity === null) return <dialog ref={dialogRef} className="modal-dialog" />;
  if (isMovieEntity(entity)) return <MovieCardDialog entity={entity} onClose={onClose} onSaved={onMovieSaved} />;
  const relationKind = relationKindFor(entity.id, entities);
  const relationItems = (entity.relations ?? []).filter((relation) => relation.entityId !== SELF_ENTITY_ID).map((relation) => ({ relation, target: entities.find((candidate) => candidate.id === relation.entityId) })).filter((item) => item.target !== undefined);
  return <dialog ref={dialogRef} className="modal-dialog person-card-dialog" aria-labelledby="person-card-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="person-card-hero"><div className="person-card-avatar"><ContactRound size={25} strokeWidth={1.7} aria-hidden="true" /></div><div className="person-card-heading"><p className="eyebrow">人物卡片</p><h2 id="person-card-title">{entity.name}</h2>{relationKind === undefined ? <span className="person-card-relation relation-kind-none">人物</span> : <span className={`person-card-relation relation-kind-${relationKind}`}><span className="relation-card-icon">{(() => { const Icon = RELATION_META[relationKind].icon; return <Icon size={13} strokeWidth={1.9} aria-hidden="true" />; })()}</span>{RELATION_META[relationKind].label}</span>}</div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭人物卡片"><X size={17} aria-hidden="true" /></button></div>
    <div className="person-card-body">
      {entity.aliases && entity.aliases.length > 0 ? <div className="person-card-field"><small>别名</small><div className="person-card-aliases">{entity.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div></div> : null}
      {entity.description ? <div className="person-card-field"><small>备注</small><p>{entity.description}</p></div> : <p className="person-card-empty">还没有人物备注，可以在编辑人物里补充。</p>}
      {relationItems.length > 0 ? <div className="person-card-field"><small>关系</small><div className="person-card-connections">{relationItems.map(({ relation, target }) => { const Icon = RELATION_META[relation.kind].icon; return <span className={`person-card-connection relation-kind-${relation.kind}`} key={`${relation.kind}-${target!.id}`}><Icon size={13} strokeWidth={1.9} aria-hidden="true" /><span>{target!.name}</span><small>{RELATION_META[relation.kind].label}</small></span>; })}</div></div> : null}
    </div>
    <div className="dialog-footer person-card-footer"><button className="secondary-button" type="button" onClick={() => onViewRecords(entity)}><ExternalLink size={15} aria-hidden="true" /><span>查看相关记录</span></button><button className="primary-button" type="button" onClick={() => onEdit(entity)}><Edit3 size={15} aria-hidden="true" /><span>编辑人物</span></button></div>
  </dialog>;
}

export function EntityEditDialog({ entity, onClose, onSave }: { entity: Entity | null; onClose: () => void; onSave: (entity: Entity, patch: { name: string; aliases: readonly string[]; description?: string; address?: string | null }) => Promise<Entity | null> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [description, setDescription] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  // Existing aliases come back slash-separated, matching what the field now
  // accepts -- round-tripping through the old comma join would have shown them
  // as one unseparated run the moment anything was edited.
  useEffect(() => { if (entity) { setName(entity.name); setAliases(entity.aliases?.join(" / ") ?? ""); setDescription(entity.description ?? ""); setAddress(entity.type === "place" ? entity.address ?? "" : ""); } }, [entity?.id]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (entity && !dialog.open) dialog.showModal(); if (!entity && dialog.open) dialog.close(); }, [entity]);
  if (entity === null) return <dialog ref={dialogRef} className="modal-dialog" />;
  const submit = async () => {
    const nextName = name.trim();
    if (!nextName || saving) return;
    setSaving(true);
    const result = await onSave(entity, { name: nextName, aliases: aliasListFrom(aliases), description: description.trim(), ...(entity.type === "place" ? { address: address.trim() || null } : {}) });
    setSaving(false);
    if (result) onClose();
  };
  return <dialog ref={dialogRef} className="modal-dialog entity-edit-dialog" aria-labelledby="entity-edit-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">{entity.type === "place" ? "地点资料" : "联系人资料"}</p><h2 id="entity-edit-title">编辑 {entity.name}</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭编辑"><X size={17} aria-hidden="true" /></button></div><div className="entity-edit-body"><label className="dialog-field"><span>{entity.type === "place" ? "名称" : "姓名"}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="dialog-field"><span>别名</span><AliasField value={aliases} onChange={setAliases} label="别名，用斜杠分隔" placeholder="多个别名用 / 分隔" /></label>{entity.type === "place" ? <label className="dialog-field"><span>详细地址</span><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="可选；平时不会展开" /></label> : null}<label className="dialog-field"><span>备注</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={entity.type === "place" ? "写下这个地点的一些背景" : "写下这个人的一些背景"} /></label></div><div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => void submit()} disabled={!name.trim() || saving}>{saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}<span>{saving ? "保存中" : "保存"}</span></button></div></dialog>;
}

export function entityRelatedRecords(entity: Entity, records: readonly RecordView[]): readonly RecordView[] {
  return records.filter((record) => record.entityRefs.some((ref) => ref.entityId === entity.id)).slice(0, 3);
}

export function locationSearchUrl(address: string): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`;
}

export function entityPeriodLabel(entity: Entity): string | null {
  if (entity.type !== "place" || entity.period === undefined) return null;
  const from = entity.period.from ?? "更早";
  const until = entity.period.until ?? "至今";
  return `${from}—${until}`;
}

export function EntitiesView({ entities, records, onCreateEntity, onEdit, onViewRecords }: { readonly entities: readonly Entity[]; readonly records: readonly RecordView[]; readonly onCreateEntity: CreateEntity; readonly onEdit: (entity: Entity) => void; readonly onViewRecords: (entity: Entity) => void }) {
  const [tab, setTab] = useState<"person" | "place">("person");
  const [createOpen, setCreateOpen] = useState(false);
  const items = entities.filter((entity) => entity.type === tab);
  const create = async (request: EntityCreateRequest): Promise<boolean> => {
    const entity = await onCreateEntity(request.type, request.name, {
      ...(request.aliases === undefined ? {} : { aliases: request.aliases }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.period === undefined ? {} : { period: request.period }),
      ...(request.address === undefined ? {} : { address: request.address }),
    });
    if (entity !== null) setCreateOpen(false);
    return entity !== null;
  };
  return <section className="entities-section" aria-labelledby="entities-title">
    <div className="page-heading entities-heading"><div><p className="eyebrow">关联对象</p><h1 id="entities-title">联系人与地点</h1><p>集中管理会出现在时间轴里的联系人与地点。</p></div><button className="primary-button" type="button" onClick={() => setCreateOpen((current) => !current)}><Plus size={16} aria-hidden="true" /><span>新建{tab === "person" ? "联系人" : "地点"}</span></button></div>
    {createOpen ? <div className="entities-create-panel"><EntityCreateForm defaultType={tab} defaultName="" onCreate={create} onCancel={() => setCreateOpen(false)} submitLabel={`创建${tab === "person" ? "联系人" : "地点"}`} /></div> : null}
    <div className="entities-tabs" role="tablist" aria-label="联系人与地点分类">
      <button type="button" role="tab" aria-selected={tab === "person"} className={`entities-tab ${tab === "person" ? "is-active" : ""}`} onClick={() => { setTab("person"); setCreateOpen(false); }}><User size={16} aria-hidden="true" />联系人<span>{entities.filter((entity) => entity.type === "person").length}</span></button>
      <button type="button" role="tab" aria-selected={tab === "place"} className={`entities-tab ${tab === "place" ? "is-active" : ""}`} onClick={() => { setTab("place"); setCreateOpen(false); }}><MapPin size={16} aria-hidden="true" />地点<span>{entities.filter((entity) => entity.type === "place").length}</span></button>
    </div>
    <div className="entities-grid" role="tabpanel" aria-label={tab === "person" ? "联系人" : "地点"}>
      {items.length === 0 ? <div className="entities-empty"><ContactRound size={24} aria-hidden="true" /><strong>还没有{tab === "person" ? "联系人" : "地点"}</strong><span>从右上角新建一个，之后可以在记录中用 {tab === "person" ? "@" : "#"} 提及。</span></div> : items.map((entity) => {
        const recent = entityRelatedRecords(entity, records);
        const relation = entity.type === "person" ? relationLabelFor(entity.id, entities) : undefined;
        const period = entityPeriodLabel(entity);
        return <article className={`entity-library-card entity-library-card--${entity.type}`} key={entity.id} data-entity-card={entity.id}>
          <div className="entity-library-card-head"><div className="entity-library-icon" aria-hidden="true">{entity.type === "person" ? <User size={18} /> : <MapPin size={18} />}</div><div><h2>{entity.name}</h2>{relation ? <span className="entity-library-role">{relation}</span> : entity.type === "place" && entity.role ? <span className="entity-library-role">{PLACE_ROLE_LABELS[entity.role]}</span> : null}</div><button className="icon-button compact-icon-button" type="button" onClick={() => onEdit(entity)} aria-label={`编辑${entity.type === "person" ? "联系人" : "地点"}${entity.name}`}><Edit3 size={15} aria-hidden="true" /></button></div>
          <div className="entity-library-meta">{entity.aliases && entity.aliases.length > 0 ? <span>别名：{entity.aliases.join("、")}</span> : null}{period ? <span>时期：{period}</span> : null}</div>
          {entity.type === "place" && entity.address ? <div className="entity-library-address"><a href={locationSearchUrl(entity.address)} target="_blank" rel="noreferrer" aria-label={`一键定位${entity.name}`}>一键定位</a><details><summary>查看详细地址</summary><span>{entity.address}</span></details></div> : null}
          <div className="entity-library-recent"><small>最近关联记录</small>{recent.length > 0 ? recent.map((record) => <button type="button" className="entity-library-record" key={record.id} onClick={() => onViewRecords(entity)}><time>{shortDate(lifeTimeDate(record.occurredAt ?? record.createdAt) ?? "")}</time><span>{record.isPrivate ? "隐私记录" : recordText(record).slice(0, 32)}</span></button>) : <span className="entity-library-muted">暂无关联记录</span>}</div>
          <button className="entity-library-view" type="button" onClick={() => onViewRecords(entity)}>查看全部关联记录 <ExternalLink size={13} aria-hidden="true" /></button>
        </article>;
      })}
    </div>
  </section>;
}

export function SearchDialog({ open, initialQuery, onClose, onSearch }: { open: boolean; initialQuery: string; onClose: () => void; onSearch: (query: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (open && !dialog.open) { dialog.showModal(); window.requestAnimationFrame(() => searchInputRef.current?.focus()); } if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={dialogRef} className="modal-dialog search-dialog" aria-labelledby="search-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">查找</p><h2 id="search-title">搜索你的记录</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭搜索"><X size={17} aria-hidden="true" /></button></div><form onSubmit={(event) => { event.preventDefault(); onSearch(query.trim()); onClose(); }}><label className="search-dialog-input"><Search size={17} aria-hidden="true" /><input ref={searchInputRef} autoFocus aria-label="搜索关键词" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label><div className="dialog-footer"><button className="secondary-button" type="button" onClick={() => { setQuery(""); onSearch(""); onClose(); }}>清空</button><button className="primary-button" type="submit"><Search size={17} aria-hidden="true" /><span>搜索</span></button></div></form></dialog>;
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
  return <main className="auth-screen"><div className="auth-panel surface" role="dialog" aria-modal="true" aria-labelledby="auth-title"><div className="auth-icon"><LockKeyhole size={21} strokeWidth={1.8} aria-hidden="true" /></div><p className="eyebrow">LifeOS</p><h1 id="auth-title">{accountMode ? "登录你的空间" : "输入访问密码"}</h1><p className="auth-description">这是一个自托管的私人空间。</p><form onSubmit={(event) => { event.preventDefault(); onLogin(username, password); }}>{accountMode ? <label className="auth-label"><span>账号</span><input autoFocus type="text" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label> : null}<label className="auth-label"><span>密码</span><input autoFocus={!accountMode} type="password" name="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error ? <p className="auth-error" role="alert">{error}</p> : null}<button className="primary-button auth-submit" type="submit" disabled={!password || (accountMode && !username) || loading}>{loading ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <LockKeyhole size={17} aria-hidden="true" />}<span>{loading ? "验证中" : "进入 LifeOS"}</span></button></form></div></main>;
}
