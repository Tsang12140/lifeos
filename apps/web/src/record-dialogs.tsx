import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  CircleHelp,
  Edit3,
  History,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  MENTION_MARKERS,
  type Asset,
  type AssetLink,
  type AssetRole,
  type Entity,
  type EntityKind,
  type EntityRef,
  type NoteFormat,
  type TaskStatus,
} from "@lifeos/core";
import { apiRequest, type MovieEntity, type RecordView, type RecordWritePayload, type TaskRecordView } from "./api";
import type { CreateEntity } from "./app-types";
import {
  ASSET_ROLE_LABEL,
  ENTITY_KIND_ORDER,
  ENTITY_META,
  NOTE_FORMATS,
  assetRoleFor,
  entityRefKey,
  formatBytes,
  isLocalAsset,
  isMovieEntity,
  isTaskRecord,
  mentionVocabulary,
  noteFormatOf,
  relationLabelFor,
  recordText,
  statusLabel,
} from "./app-meta";
import { RecordText, entityHint } from "./mention";
import { AliasField, MentionBox, aliasListFrom } from "./entity-forms";
import { DateField } from "./date-field";
import { TaskScheduleField } from "./task-schedule";
import { ErrorState, LoadingState } from "./timeline-states";
import { instantFromInput, lifeTimeDate, lifeTimeToInput, shortDate } from "./time";

function noteUpdatedAt(record: RecordView): string {
  return shortDate(lifeTimeDate(record.updatedAt ?? record.createdAt) ?? "");
}

export interface RecordEditorDraft { content: string; occurredAt: string; dueAt: string; occurredDirty: boolean; dueDirty: boolean; isPrivate: boolean; isBackfill: boolean; status: TaskStatus; entityRefs: readonly EntityRef[]; relatedRecordIds: readonly string[]; assetRefs: readonly AssetLink[]; }

export type RelationDraftPatch = Partial<Pick<RecordEditorDraft, "entityRefs" | "relatedRecordIds" | "assetRefs">>;

export function RelationPanel({ entities, assets, candidates, draft, onChange, onCreateEntity }: { entities: readonly Entity[]; assets: readonly Asset[]; candidates: readonly RecordView[]; draft: RecordEditorDraft; onChange: (patch: RelationDraftPatch) => void; onCreateEntity: CreateEntity }) {
  const [createKind, setCreateKind] = useState<EntityKind>("person");
  const [createName, setCreateName] = useState("");
  const [createAliases, setCreateAliases] = useState("");
  const [createAddress, setCreateAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const selectedEntityIds = useMemo(() => new Set(draft.entityRefs.map((ref) => ref.entityId)), [draft.entityRefs]);
  const selectedAssetIds = useMemo(() => new Set(draft.assetRefs.map((ref) => ref.assetId)), [draft.assetRefs]);
  const selectedRecordIds = useMemo(() => new Set(draft.relatedRecordIds), [draft.relatedRecordIds]);

  const toggleEntity = (entity: Entity) => {
    onChange(selectedEntityIds.has(entity.id)
      ? { entityRefs: draft.entityRefs.filter((ref) => ref.entityId !== entity.id) }
      : { entityRefs: [...draft.entityRefs, { entityType: entity.type, entityId: entity.id, label: entity.name }] });
  };
  const toggleAsset = (asset: Asset) => {
    onChange(selectedAssetIds.has(asset.id)
      ? { assetRefs: draft.assetRefs.filter((ref) => ref.assetId !== asset.id) }
      : { assetRefs: [...draft.assetRefs, { assetId: asset.id, role: assetRoleFor(asset.kind), ...(asset.originalName === undefined ? {} : { label: asset.originalName }) }] });
  };
  const submitEntity = async () => {
    const name = createName.trim();
    if (!name || creating) return;
    const aliases = aliasListFrom(createAliases);
    setCreating(true);
    try {
      const entity = await onCreateEntity(createKind, name, { ...(aliases.length > 0 ? { aliases } : {}), ...(createKind === "place" && createAddress.trim() ? { address: createAddress.trim() } : {}) });
      if (entity) {
        onChange({ entityRefs: [...draft.entityRefs, { entityType: entity.type, entityId: entity.id, label: entity.name }] });
        setCreateName("");
        setCreateAliases("");
        setCreateAddress("");
      }
    } finally {
      setCreating(false);
    }
  };

  return <section className="relation-panel" aria-label="关联">
    <div className="relation-heading"><div><p className="eyebrow">关联</p><h3>把这条记录接到人和事上</h3></div><span className="relation-count">{draft.entityRefs.length + draft.relatedRecordIds.length + draft.assetRefs.length}</span></div>
    <p className="relation-hint">正文里用 {MENTION_MARKERS[0]!.marker} 提到的人、{MENTION_MARKERS[1]!.marker} 提到的地点会自动关联过来，展示时不显示符号。连续输入两个相同符号（如 ##）可直接新建。项目、主题请在下面直接勾选。</p>

    <div className="relation-kind-row">
      {ENTITY_KIND_ORDER.map((kind) => { const KindIcon = ENTITY_META[kind].icon; const options = entities.filter((entity) => entity.type === kind); const selected = draft.entityRefs.filter((ref) => ref.entityType === kind).filter((ref) => !options.some((entity) => entity.id === ref.entityId)); return <div className="relation-group" key={kind}>
        <div className="relation-group-title"><KindIcon size={14} strokeWidth={1.8} aria-hidden="true" /><span>{ENTITY_META[kind].label}</span></div>
        {options.length === 0 && selected.length === 0 ? <p className="relation-hint">还没有{ENTITY_META[kind].label}，可在下面新建。</p> : null}
        {options.length > 0 || selected.length > 0 ? <div className="relation-chips">
          {options.map((entity) => { const relationLabel = relationLabelFor(entity.id, entities); return <button className={`relation-toggle ${selectedEntityIds.has(entity.id) ? "is-on" : ""}`} key={entity.id} type="button" aria-pressed={selectedEntityIds.has(entity.id)} onClick={() => toggleEntity(entity)}>{entity.name}{relationLabel === undefined ? null : <small>{relationLabel}</small>}</button>; })}
          {selected.map((ref) => <button className="relation-toggle is-on relation-toggle-orphan" key={entityRefKey(ref)} type="button" aria-pressed={true} title="关联对象已不在列表中" onClick={() => onChange({ entityRefs: draft.entityRefs.filter((item) => item.entityId !== ref.entityId) })}>{ref.label ?? ref.entityId}</button>)}
        </div> : null}
      </div>; })}
    </div>

    <div className="relation-create">
      <select value={createKind} onChange={(event) => setCreateKind(event.target.value as EntityKind)} aria-label="要新建的关联对象类型">{ENTITY_KIND_ORDER.map((kind) => <option value={kind} key={kind}>{ENTITY_META[kind].label}</option>)}</select>
      <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="名称" aria-label="新关联对象名称" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitEntity(); } }} />
      <AliasField value={createAliases} onChange={setCreateAliases} label="新关联对象别名" placeholder="别名（可选，用 / 分隔）" compact />
      {createKind === "place" ? <input value={createAddress} onChange={(event) => setCreateAddress(event.target.value)} placeholder="详细地址（可选）" aria-label="新地点详细地址" /> : null}
      <button className="secondary-button relation-create-button" type="button" onClick={() => void submitEntity()} disabled={!createName.trim() || creating}>{creating ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}<span>新建并关联</span></button>
    </div>

    <div className="relation-group">
      <div className="relation-group-title"><Link2 size={14} strokeWidth={1.8} aria-hidden="true" /><span>相关记录</span></div>
      {draft.relatedRecordIds.length > 0 ? <div className="relation-chips">{draft.relatedRecordIds.map((id) => { const target = candidates.find((record) => record.id === id); return <button className="relation-toggle is-on" key={id} type="button" aria-pressed={true} onClick={() => onChange({ relatedRecordIds: draft.relatedRecordIds.filter((item) => item !== id) })}>{target ? `${shortDate(lifeTimeDate(target.occurredAt ?? target.createdAt) ?? "")} ${recordText(target).slice(0, 12)}` : id}</button>; })}</div> : null}
      {candidates.length === 0 ? <p className="relation-hint">当前已加载的记录里还没有可关联的其他记录。</p> : <select className="relation-select" value="" onChange={(event) => { const target = candidates.find((record) => record.id === event.target.value); if (target) onChange({ relatedRecordIds: [...draft.relatedRecordIds, target.id] }); }} aria-label="添加相关记录"><option value="">关联一条已有记录…</option>{candidates.filter((record) => !selectedRecordIds.has(record.id)).map((record) => <option value={record.id} key={record.id}>{`${shortDate(lifeTimeDate(record.occurredAt ?? record.createdAt) ?? "")} · ${recordText(record).slice(0, 24)}`}</option>)}</select>}
    </div>

    <div className="relation-group">
      <div className="relation-group-title"><ImageIcon size={14} strokeWidth={1.8} aria-hidden="true" /><span>照片与资产</span></div>
      {assets.length === 0 ? <p className="relation-hint">还没有登记资产。LifeOS 只保存可替换的引用，不复制 NAS 上的原件。</p> : <div className="relation-chips">{assets.map((asset) => <button className={`relation-toggle ${selectedAssetIds.has(asset.id) ? "is-on" : ""}`} key={asset.id} type="button" aria-pressed={selectedAssetIds.has(asset.id)} onClick={() => toggleAsset(asset)}>{asset.originalName ?? asset.id}<small>{ASSET_ROLE_LABEL[assetRoleFor(asset.kind)]}{formatBytes(asset.sizeBytes) === undefined ? "" : ` · ${formatBytes(asset.sizeBytes)}`}</small></button>)}</div>}
    </div>
  </section>;
}

export function RecordEditorDialog({ record, saving, reloading, error, entities, assets, candidates, onClose, onSave, onReloadLatest, onCreateEntity }: { record: RecordView | null; saving: boolean; reloading: boolean; error: string | null; entities: readonly Entity[]; assets: readonly Asset[]; candidates: readonly RecordView[]; onClose: () => void; onSave: (record: RecordView, draft: RecordEditorDraft) => void; onReloadLatest: () => void; onCreateEntity: CreateEntity }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<RecordEditorDraft>({ content: "", occurredAt: "", dueAt: "", occurredDirty: false, dueDirty: false, isPrivate: false, isBackfill: false, status: "todo", entityRefs: [], relatedRecordIds: [], assetRefs: [] });
  const recordId = record?.id ?? null;
  useEffect(() => { if (record) setDraft({ content: recordText(record), occurredAt: lifeTimeToInput(record.occurredAt), dueAt: isTaskRecord(record) ? lifeTimeToInput(record.task.dueAt) : "", occurredDirty: false, dueDirty: false, isPrivate: record.isPrivate === true, isBackfill: record.isBackfill === true, status: isTaskRecord(record) ? record.task.status : "todo", entityRefs: record.entityRefs, relatedRecordIds: record.relatedRecordIds, assetRefs: record.assetRefs }); }, [recordId]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (record && !dialog.open) { dialog.showModal(); window.requestAnimationFrame(() => editorTextareaRef.current?.focus()); } if (!record && dialog.open) dialog.close(); }, [record]);
  if (!record) return <dialog ref={dialogRef} className="modal-dialog" />;
  const task = isTaskRecord(record) ? record : undefined;
  return <dialog ref={dialogRef} className="modal-dialog editor-dialog" aria-labelledby="editor-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}><div className="dialog-header"><div><p className="eyebrow">编辑记录</p><h2 id="editor-title">保留原文，更新当前内容</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭编辑"><X size={17} aria-hidden="true" /></button></div><div className="dialog-body"><div className="original-block"><div className="original-block-label"><span>原文</span><span>只读保留</span></div><p><RecordText text={record.body.original || "（原文为空）"} entities={mentionVocabulary(record, entities)} /></p></div>{error?.includes("最新版本") ? <div className="server-current-block"><div className="original-block-label"><span>最新服务端内容</span><span>草稿仍在编辑框中</span></div><p><RecordText text={recordText(record)} entities={mentionVocabulary(record, entities)} /></p></div> : null}<label className="dialog-field"><span>当前内容</span><MentionBox textareaRef={editorTextareaRef} autoFocus value={draft.content} onChange={(value) => setDraft((current) => ({ ...current, content: value }))} entities={entities} onCreateEntity={onCreateEntity} rows={5} ariaLabel="当前内容" /></label><div className="dialog-fields-grid">{task ? <div className="dialog-field dialog-field-wide"><span>任务时间</span><TaskScheduleField start={draft.occurredAt} end={draft.dueAt} onStartChange={(value) => setDraft((current) => ({ ...current, occurredAt: value, occurredDirty: true }))} onEndChange={(value) => setDraft((current) => ({ ...current, dueAt: value, dueDirty: true }))} className="composer-date-control" label="任务时间" /></div> : <div className="dialog-field"><span>发生时间</span>{/* 非任务记录仍 capped：日志记的是已经发生的事。 */}<DateField value={draft.occurredAt} onChange={(value) => setDraft((current) => ({ ...current, occurredAt: value, occurredDirty: true }))} label="发生时间" showTime capped /></div>}</div><div className="dialog-toggle-row"><label className={`backfill-toggle ${draft.isBackfill ? "is-on" : ""}`}><input type="checkbox" checked={draft.isBackfill} onChange={(event) => setDraft((current) => ({ ...current, isBackfill: event.target.checked }))} /><History size={14} strokeWidth={1.9} aria-hidden="true" /><span>补记</span></label><label className={`privacy-toggle dialog-privacy-toggle ${draft.isPrivate ? "is-on" : ""}`}><input type="checkbox" checked={draft.isPrivate} onChange={(event) => setDraft((current) => ({ ...current, isPrivate: event.target.checked }))} /><LockKeyhole size={14} strokeWidth={1.9} aria-hidden="true" /><span>隐私模式</span><small>日历隐藏，时间轴点击后显示</small></label></div>{task ? <label className="dialog-field"><span>任务状态</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))}><option value="todo">待办</option><option value="in_progress">进行中</option><option value="done">已完成</option><option value="cancelled">已取消</option></select></label> : null}<RelationPanel entities={entities} assets={assets} candidates={candidates} draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} onCreateEntity={onCreateEntity} />{error ? <div className="dialog-error" role="alert"><CircleHelp size={17} aria-hidden="true" /><span>{error}</span>{error.includes("冲突") || error.includes("409") || error.includes("最新版本") ? <button className="text-button" type="button" onClick={onReloadLatest} disabled={reloading}>{reloading ? "读取中" : error.includes("最新版本") ? "再次读取最新版本" : "读取最新版本，保留草稿"}</button> : null}</div> : null}</div><div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onSave(record, draft)} disabled={!draft.content.trim() || saving}>{saving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{saving ? "保存中" : "保存修改"}</span></button></div></dialog>;
}

export interface NoteDraft {
  readonly format: NoteFormat;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  /** Legacy notes stay metadata-free unless the owner explicitly edits a format field. */
  readonly metadataTouched: boolean;
}

export type NoteSaveResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
export type NoteSaveHandler = (record: RecordView | null, draft: NoteDraft) => Promise<NoteSaveResult>;

export function NoteEditorDialog({ record, createOpen, entities, onCreateEntity, onClose, onSave }: { readonly record: RecordView | null; readonly createOpen: boolean; readonly entities: readonly Entity[]; readonly onCreateEntity: CreateEntity; readonly onClose: () => void; readonly onSave: NoteSaveHandler }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const open = createOpen || record !== null;
  const [draft, setDraft] = useState<NoteDraft>({ format: "fragment", title: "", content: "", source: "", metadataTouched: createOpen });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const recordId = record?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const details = record?.kind === "note" ? record.note : undefined;
    setDraft({
      format: details?.format ?? "fragment",
      title: details?.title ?? "",
      content: record === null ? "" : recordText(record),
      source: details?.source ?? "",
      metadataTouched: record === null,
    });
    setSaveError(null);
    setSaving(false);
  }, [open, recordId, createOpen]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => bodyRef.current?.focus({ preventScroll: true }));
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return <dialog ref={dialogRef} className="modal-dialog" />;
  const valid = draft.content.trim().length > 0 && (draft.format !== "article" || draft.title.trim().length > 0);
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await onSave(record, draft);
    setSaving(false);
    if (result.ok) onClose();
    else setSaveError(result.message);
  };
  return <dialog ref={dialogRef} className="modal-dialog note-editor-dialog" aria-labelledby="note-editor-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} onClose={onClose}>
    <div className="dialog-header"><div><p className="eyebrow">{record === null ? "新建笔记" : "编辑笔记"}</p><h2 id="note-editor-title">{record === null ? "留下一点值得回看的文字" : "更新这条笔记"}</h2></div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭笔记编辑器"><X size={17} aria-hidden="true" /></button></div>
    <div className="dialog-body note-editor-body" data-note-editor>
      <div className="note-format-picker" role="tablist" aria-label="笔记格式">{NOTE_FORMATS.map((item) => <button className={`note-format-option ${draft.format === item.value ? "is-active" : ""}`} data-note-format={item.value} type="button" role="tab" aria-selected={draft.format === item.value} key={item.value} onClick={() => { setSaveError(null); setDraft((current) => ({ ...current, format: item.value, metadataTouched: true })); }}><span className="note-format-option-title">{item.label}</span><small>{item.hint}</small></button>)}</div>
      {draft.format === "article" ? <label className="dialog-field note-title-field"><span>标题</span><input data-note-title value={draft.title} maxLength={300} onChange={(event) => { setSaveError(null); setDraft((current) => ({ ...current, title: event.target.value, metadataTouched: true })); }} placeholder="给文章一个清楚的标题" /></label> : null}
      <label className="dialog-field note-body-field"><span>{draft.format === "quote" ? "引文" : "正文"}</span><MentionBox textareaRef={bodyRef} value={draft.content} onChange={(value) => { setSaveError(null); setDraft((current) => ({ ...current, content: value })); }} entities={entities} onCreateEntity={onCreateEntity} rows={8} ariaLabel={draft.format === "quote" ? "引文正文" : "笔记正文"} placeholder={draft.format === "quote" ? "粘贴或输入值得保存的引文……" : draft.format === "article" ? "写下文章内容……" : "记下此刻的想法……"} /></label>
      {draft.format === "quote" ? <label className="dialog-field note-source-field"><span>出处（可选）</span><input data-note-source value={draft.source} maxLength={1000} onChange={(event) => { setSaveError(null); setDraft((current) => ({ ...current, source: event.target.value, metadataTouched: true })); }} placeholder="书名、作者或网页链接" /></label> : null}
      {saveError ? <p className="dialog-error note-editor-error" data-note-save-error role="alert"><CircleHelp size={17} aria-hidden="true" /><span>{saveError}</span></p> : null}
    </div>
    <div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" data-note-save type="button" onClick={() => void submit()} disabled={!valid || saving}>{saving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{saving ? "保存中" : "保存笔记"}</span></button></div>
  </dialog>;
}

export function NotesLibrary({ records, loading, error, entities, onRetry, onCreateEntity, onSave, onDelete }: { readonly records: readonly RecordView[] | null; readonly loading: boolean; readonly error: string | null; readonly entities: readonly Entity[]; readonly onRetry: () => void; readonly onCreateEntity: CreateEntity; readonly onSave: NoteSaveHandler; readonly onDelete: (record: RecordView) => void }) {
  const [filter, setFilter] = useState<NoteFormat | "all">("all");
  const [editorRecord, setEditorRecord] = useState<RecordView | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const items = useMemo(() => [...(records ?? [])]
    .filter((record) => record.kind === "note")
    .filter((record) => filter === "all" || noteFormatOf(record) === filter)
    .sort((left, right) => Date.parse(right.updatedAt?.value ?? right.createdAt.value) - Date.parse(left.updatedAt?.value ?? left.createdAt.value)), [records, filter]);
  const closeEditor = () => { setEditorRecord(null); setCreateOpen(false); };
  return <section className="notes-library" data-view="notes" aria-labelledby="notes-library-title">
    <div className="page-heading notes-library-heading"><div><p className="eyebrow">文字资料库</p><h1 id="notes-library-title">笔记</h1><p>按内容浏览、检索和续写文章、碎片与摘抄。</p></div><button className="primary-button" data-note-create type="button" onClick={() => { setEditorRecord(null); setCreateOpen(true); }}><Plus size={16} aria-hidden="true" /><span>新建笔记</span></button></div>
    <div className="notes-filter-tabs" role="tablist" aria-label="笔记格式筛选">{(["all", ...NOTE_FORMATS.map((item) => item.value)] as const).map((value) => { const label = value === "all" ? "全部" : NOTE_FORMATS.find((item) => item.value === value)?.label ?? value; return <button className={`notes-filter-tab ${filter === value ? "is-active" : ""}`} data-note-filter={value} type="button" role="tab" aria-selected={filter === value} key={value} onClick={() => setFilter(value)}>{label}</button>; })}</div>
    {loading ? <LoadingState /> : null}
    {!loading && error ? <ErrorState message={error} onRetry={onRetry} /> : null}
    {!loading && !error && items.length === 0 ? <div className="notes-empty" data-note-empty><BookOpen size={24} aria-hidden="true" /><strong>还没有笔记。先记下一点想法或摘抄。</strong></div> : null}
    {!loading && !error && items.length > 0 ? <div className="notes-grid">{items.map((record) => {
      const format = noteFormatOf(record);
      const details = record.kind === "note" ? record.note : undefined;
      return <article className="note-card" data-note-card data-note-format={format} key={record.id}>
        <button className="note-card-main" type="button" onClick={() => { setCreateOpen(false); setEditorRecord(record); }}>
          <div className="note-card-meta"><span className="note-format-label">{NOTE_FORMATS.find((item) => item.value === format)?.label ?? "碎片"}</span><time data-note-updated>{noteUpdatedAt(record)}</time></div>
          {format === "article" ? <h2 data-note-title>{details?.title}</h2> : null}
          <p className="note-card-excerpt">{recordText(record)}</p>
          {format === "quote" && details?.source ? <p className="note-card-source" data-note-source>出处：{details.source}</p> : null}
        </button>
        <div className="note-card-actions"><button className="text-button" type="button" onClick={() => { setCreateOpen(false); setEditorRecord(record); }}><Edit3 size={14} aria-hidden="true" /><span>编辑</span></button><button className="text-button note-card-delete" type="button" onClick={() => onDelete(record)}><Trash2 size={14} aria-hidden="true" /><span>删除</span></button></div>
      </article>;
    })}</div> : null}
    <NoteEditorDialog record={editorRecord} createOpen={createOpen} entities={entities} onCreateEntity={onCreateEntity} onClose={closeEditor} onSave={onSave} />
  </section>;
}
