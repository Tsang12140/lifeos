import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, BookOpen, Bold, Check, ChevronDown, ChevronRight, Code2, Download, Edit3, Folder, FolderPlus, Heading, History, ImagePlus, Italic, Link2, List, ListOrdered, LoaderCircle, LockKeyhole, Maximize2, Minimize2, MoreHorizontal, Pin, Plus, Quote, Redo2, Search, Star, Table2, Trash2, Underline, Undo2, Upload, X } from 'lucide-react';
import type { Asset, AssetLink, Entity, NoteDetails, NoteFolder, NoteFormat } from '@lifeos/core';
import { apiRequest, apiUploadRequest, type RecordView } from './api';
import type { CreateEntity } from './app-types';
import { recordText } from './app-meta';
import { RecordDeleteUndo, RecordDeletionContext } from './record-deletion';
import { useNoteMasonry } from './note-masonry';
import { Editor } from './penmark/editor.js';
import { sanitizeNoteHtml, textToNoteHtml } from './note-html';
import { NotesTransfer } from './notes-transfer';
import { NoteShareDialog } from './note-sharing';
import { scopedKey } from './storage-scope';
import './penmark/editor.css';
import './notes-library.css';
export interface NoteDraft {
    readonly format: NoteFormat;
    readonly title: string;
    readonly content: string;
    readonly source: string;
    readonly metadataTouched: boolean;
    readonly html?: string;
    readonly folderId?: string;
    readonly starred?: boolean;
    readonly pinned?: boolean;
    readonly assetRefs?: readonly AssetLink[];
    readonly isPrivate?: boolean;
}
export type NoteSaveResult = {
    readonly ok: true;
    readonly record?: RecordView;
} | {
    readonly ok: false;
    readonly message: string;
};
export type NoteSaveHandler = (record: RecordView | null, draft: NoteDraft) => Promise<NoteSaveResult>;
export function noteDetails(draft: NoteDraft): NoteDetails { return { format: 'note', ...(draft.title.trim() ? { title: draft.title.trim() } : {}), ...(draft.source.trim() ? { source: draft.source.trim() } : {}), ...(draft.html === undefined ? {} : { html: draft.html }), ...(draft.folderId ? { folderId: draft.folderId } : {}), starred: draft.starred === true, pinned: draft.pinned === true }; }
function initialDraft(record: RecordView | null, folderId?: string): NoteDraft { const note = record?.kind === 'note' ? record.note : undefined; return { format: 'note', title: note?.title ?? '', content: record ? recordText(record) : '', source: note?.source ?? '', html: note?.html, folderId: note?.folderId ?? folderId, starred: note?.starred, pinned: note?.pinned, isPrivate: record?.isPrivate === true, assetRefs: record?.assetRefs ?? [], metadataTouched: true }; }
function folderPath(folder: NoteFolder, folders: readonly NoteFolder[]): string {
    const parts = [folder.name], seen = new Set([folder.id]);
    let id = folder.parentId;
    while (id) {
        const parent = folders.find(item => item.id === id);
        if (!parent || seen.has(id))
            break;
        seen.add(id);
        parts.unshift(parent.name);
        id = parent.parentId;
    }
    return parts.join(' / ');
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试'; }
export function NoteEditorDialog({ record, createOpen, entities: _entities, onCreateEntity: _onCreateEntity, onClose, onSave, folders = [], initialFolderId, scope = 'local' }: {
    readonly record: RecordView | null;
    readonly createOpen: boolean;
    readonly entities: readonly Entity[];
    readonly onCreateEntity: CreateEntity;
    readonly onClose: () => void;
    readonly onSave: NoteSaveHandler;
    readonly folders?: readonly NoteFolder[];
    readonly initialFolderId?: string;
    readonly scope?: string;
}) {
    const open = createOpen || record !== null;
    const dialog = useRef<HTMLDialogElement>(null), surface = useRef<HTMLDivElement>(null), engine = useRef<Editor | null>(null), fileInput = useRef<HTMLInputElement>(null);
    const current = useRef(record), saved = useRef(''), draftRef = useRef<NoteDraft>(initialDraft(record, initialFolderId));
    const [draft, setDraft] = useState(draftRef.current), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [reading, setReading] = useState(false), [outline, setOutline] = useState<{
        text: string;
        index: number;
    }[]>([]), [selectedImage, setSelectedImage] = useState<HTMLElement | null>(null), [versions, setVersions] = useState<{
        id: string;
        revision: number;
        createdAt: string;
        record: RecordView;
    }[] | null>(null), [historyError, setHistoryError] = useState(''), [shortcuts, setShortcuts] = useState(false), [restored, setRestored] = useState(false);
    const busyRef = useRef(false), changeVersion = useRef(0), alive = useRef(true), saveRef = useRef<() => Promise<void>>(async () => { }), [changed, setChanged] = useState(0);
    const key = scopedKey(`lifeos:note-draft:${scope}:${record?.id ?? 'new'}`);
    const [loadedFolders, setLoadedFolders] = useState<NoteFolder[]>([]);
    const availableFolders = folders.length ? folders : loadedFolders;
    useEffect(() => {
        if (!open)
            return;
        let active = true;
        apiRequest<{
            folders: NoteFolder[];
        }>('/api/note-folders').then(value => {
            if (active)
                setLoadedFolders(value.folders);
        }).catch(() => { });
        return () => { active = false; };
    }, [open, scope]);
    const storageKey = () => scopedKey(`lifeos:note-draft:${scope}:${current.current?.id ?? 'new'}`);
    const [sharing, setSharing] = useState(false);
    const patch = useCallback((value: Partial<NoteDraft>) => { changeVersion.current++; draftRef.current = { ...draftRef.current, ...value }; setDraft(draftRef.current); setChanged(n => n + 1); setError(''); setMessage('草稿已保留'); }, []);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    useEffect(() => {
        if (!open)
            return;
        current.current = record;
        let value = initialDraft(record, initialFolderId);
        saved.current = JSON.stringify(value);
        setRestored(false);
        let recoveredConflict = false;
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const cache = JSON.parse(raw);
                if (cache && cache.draft && typeof cache.draft.content === 'string') {
                    value = { ...value, ...cache.draft };
                    setRestored(true);
                    recoveredConflict = (cache.revision ?? null) !== (record?.revision ?? null);
                }
            }
        }
        catch { }
        draftRef.current = value;
        setDraft(value);
        setError('');
        setMessage('');
        setReading(false);
        setVersions(null);
        setChanged(0);
        changeVersion.current = 0;
        if (recoveredConflict)
            setError('服务端已有更新，此处恢复了本机草稿。请先核对历史版本，确认后保存。');
        if (dialog.current && !dialog.current.open)
            dialog.current.showModal();
        const editor = new Editor({ editor: surface.current!, onUpdate: () => {
                if (!engine.current)
                    return;
                const html = engine.current.getHTML(), content = engine.current.toPlainText();
                patch({ html, content });
                setOutline(Array.from(surface.current!.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el, index) => ({ text: el.textContent ?? '', index })));
            }, onToast: setMessage, onImageSelect: setSelectedImage });
        // The initial write belongs to mounting, not to an input transaction.
        editor.setHTML(sanitizeNoteHtml(value.html ?? textToNoteHtml(value.content)));
        engine.current = editor;
        setOutline(Array.from(surface.current!.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el, index) => ({ text: el.textContent ?? '', index })));
        const frame = requestAnimationFrame(() => editor.focus());
        return () => { cancelAnimationFrame(frame); editor.destroy(); engine.current = null; };
    }, [open, record?.id, key]);
    useEffect(() => {
        if (!open && dialog.current?.open)
            dialog.current.close();
    }, [open]);
    useEffect(() => {
        if (!open || !changed)
            return;
        const timer = setTimeout(() => {
            try {
                localStorage.setItem(storageKey(), JSON.stringify({ revision: current.current?.revision ?? null, draft: draftRef.current }));
                setMessage(navigator.onLine ? '草稿已保留在此设备' : '离线草稿已保留在此设备');
            }
            catch {
                setError('此设备无法保存草稿，请保持页面打开并保存笔记');
            }
        }, 250);
        return () => clearTimeout(timer);
    }, [changed, key, open]);
    const save = async () => {
        if (busyRef.current || !engine.current)
            return;
        const version = changeVersion.current;
        const snapshot = { ...draftRef.current, html: engine.current.getHTML(), content: engine.current.toPlainText() };
        if (!snapshot.content.trim() && !/<img\b/i.test(snapshot.html ?? '')) {
            setError('先写一点内容或添加图片');
            return;
        }
        busyRef.current = true;
        setBusy(true);
        setError('');
        try {
            const doc = new DOMParser().parseFromString(sanitizeNoteHtml(snapshot.html ?? ''), 'text/html');
            const refs = new Map((snapshot.assetRefs ?? []).map(ref => [ref.assetId, ref]));
            for (const image of Array.from(doc.querySelectorAll('img'))) {
                const source = image.getAttribute('src') ?? '';
                if (source.startsWith('data:image/')) {
                    const blob = await (await fetch(source)).blob();
                    const asset = await apiUploadRequest<Asset>('/api/assets/uploads?name=' + encodeURIComponent('笔记图片.' + (blob.type.split('/')[1] || 'png')), blob, { contentType: blob.type });
                    image.src = `/api/assets/${encodeURIComponent(asset.id)}/content`;
                    refs.set(asset.id, { assetId: asset.id, role: 'photo' });
                }
                else {
                    const id = /^\/api\/assets\/([^/]+)\/content(?:\?|$)/.exec(source)?.[1];
                    if (id)
                        refs.set(decodeURIComponent(id), { assetId: decodeURIComponent(id), role: 'photo' });
                }
            }
            const payload = { ...snapshot, content: snapshot.content.trim() ? snapshot.content : '（图片笔记）', html: doc.body.innerHTML, assetRefs: [...refs.values()] };
            const result = await onSave(current.current, payload);
            if (!alive.current)
                return;
            if (!result.ok) {
                setError(result.message);
                return;
            }
            if (result.record)
                current.current = result.record;
            saved.current = JSON.stringify(payload);
            if (version === changeVersion.current) {
                draftRef.current = payload;
                setDraft(payload);
                engine.current?.setHTML(payload.html);
                localStorage.removeItem(key);
                localStorage.removeItem(storageKey());
                setChanged(0);
                setRestored(false);
                setMessage('已保存');
            }
            else {
                setMessage('已保存，正在保留后续修改');
                try {
                    localStorage.setItem(storageKey(), JSON.stringify({ revision: current.current?.revision ?? null, draft: draftRef.current }));
                }
                catch { }
            }
        }
        catch (cause) {
            if (alive.current)
                setError(errorText(cause));
        }
        finally {
            busyRef.current = false;
            if (alive.current)
                setBusy(false);
        }
    };
    saveRef.current = save;
    // Existing documents auto-save after a pause; a new page is created on its first explicit save.
    useEffect(() => {
        if (!open || !changed || !current.current || busy || error)
            return;
        const timer = setTimeout(() => void saveRef.current(), 1400);
        return () => clearTimeout(timer);
    }, [changed, open, busy, error]);
    useEffect(() => {
        if (!open)
            return;
        const warn = (event: BeforeUnloadEvent) => {
            if (changed || busyRef.current) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [changed, open]);
    const close = () => {
        if (busyRef.current)
            return;
        if (changed) {
            try {
                localStorage.setItem(storageKey(), JSON.stringify({ revision: current.current?.revision ?? null, draft: draftRef.current }));
            }
            catch {
                setError('草稿暂未保存，请先保存笔记');
                return;
            }
        }
        onClose();
    };
    const command = (run: (editor: Editor) => void) => {
        if (!reading && engine.current)
            run(engine.current);
    };
    const files = async (list: File[]) => {
        for (const file of list) {
            if (!file.type.startsWith('image/'))
                continue;
            const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
            if (engine.current)
                engine.current.insertImage(url);
        }
    };
    const exportOne = (format: 'md' | 'html') => {
        if (!engine.current)
            return;
        const text = format === 'md' ? engine.current.toMarkdown() : engine.current.buildSelfContainedHTML();
        const url = URL.createObjectURL(new Blob([text], { type: format === 'md' ? 'text/markdown' : 'text/html' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = (draft.title || '未命名笔记').replace(/[<>:"/\\|?*]/g, '_') + '.' + format;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const history = async () => {
        if (!current.current)
            return;
        setHistoryError('');
        try {
            setVersions((await apiRequest<{
                versions: typeof versions;
            }>(`/api/notes/${encodeURIComponent(current.current.id)}/versions`)).versions);
        }
        catch (cause) {
            setHistoryError(errorText(cause));
        }
    };
    if (!open)
        return <dialog ref={dialog} className="modal-dialog pm-note-dialog"/>;
    return <dialog ref={dialog} className={`modal-dialog pm-note-dialog${reading ? ' is-reading' : ''}`} aria-labelledby="note-editor-title" onCancel={event => {
            event.preventDefault();
            if (reading) {
                setReading(false);
                return;
            }
            if (changed) {
                setMessage('草稿尚未保存，请保存，或点击返回保留草稿后离开');
                return;
            }
            close();
        }} onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void saveRef.current();
            }
            if ((event.ctrlKey || event.metaKey) && event.key === '/') {
                event.preventDefault();
                setShortcuts(value => !value);
            }
            if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'r') {
                event.preventDefault();
                setReading(value => !value);
            }
        }}>
    <header className="pm-note-header"><button className="icon-button" type="button" aria-label="返回笔记" disabled={busy} onClick={close}><ArrowLeft size={19}/></button><span id="note-editor-title">{reading ? '阅读笔记' : '笔记'}</span><span className="pm-save-state" role="status">{busy ? '保存中' : message}</span><button className="icon-button" type="button" title="阅读模式 Ctrl+Alt+R" aria-label="阅读模式" onClick={() => setReading(value => !value)}>{reading ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button><button className="primary-button" data-note-save type="button" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}<span>保存</span></button></header>
    <div className="pm-note-scroll"><div className="pm-note-meta"><select aria-label="笔记所在文件夹" value={draft.folderId ?? ''} disabled={reading || busy} onChange={event => patch({ folderId: event.target.value || undefined })}><option value="">未分类</option>{availableFolders.map(folder => <option key={folder.id} value={folder.id}>{folderPath(folder, availableFolders)}</option>)}</select><button type="button" className="icon-button" aria-label="收藏笔记" aria-pressed={draft.starred === true} onClick={() => patch({ starred: !draft.starred })}><Star size={17} fill={draft.starred ? 'currentColor' : 'none'}/></button><button type="button" className="icon-button" aria-label="置顶笔记" aria-pressed={draft.pinned === true} onClick={() => patch({ pinned: !draft.pinned })}><Pin size={17}/></button><button type="button" className="icon-button" aria-label="笔记隐私" aria-pressed={draft.isPrivate === true} onClick={() => patch({ isPrivate: !draft.isPrivate })}><LockKeyhole size={17}/></button></div>
    <input className="pm-note-title" data-note-title aria-label="笔记标题" placeholder="无标题" value={draft.title} maxLength={300} readOnly={reading} onChange={event => patch({ title: event.target.value })}/>
    {!reading ? <div className="pm-editor-toolbar" role="toolbar" aria-label="文字格式" onMouseDown={event => {
                if ((event.target as HTMLElement).closest('button'))
                    event.preventDefault();
            }}>
      <select aria-label="段落样式" defaultValue="p" onChange={event => command(editor => editor.formatBlock(event.target.value))}><option value="p">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option></select>
      {([{ label: '加粗 Ctrl+B', Icon: Bold, run: (e: Editor) => e.exec('bold') }, { label: '斜体 Ctrl+I', Icon: Italic, run: (e: Editor) => e.exec('italic') }, { label: '下划线 Ctrl+U', Icon: Underline, run: (e: Editor) => e.exec('underline') }, { label: '无序列表 Ctrl+Shift+8', Icon: List, run: (e: Editor) => e.exec('insertUnorderedList') }, { label: '有序列表 Ctrl+Shift+7', Icon: ListOrdered, run: (e: Editor) => e.exec('insertOrderedList') }, { label: '引用 Ctrl+Alt+Q', Icon: Quote, run: (e: Editor) => e.insertQuote() }, { label: '代码块 Ctrl+Alt+C', Icon: Code2, run: (e: Editor) => e.insertCodeBlock() }, { label: '表格 Ctrl+Alt+T', Icon: Table2, run: (e: Editor) => e.insertTable(3, 3) }, { label: '链接 Ctrl+K', Icon: Link2, run: (e: Editor) => e.insertLink() }, { label: '撤销 Ctrl+Z', Icon: Undo2, run: (e: Editor) => e.undo() }, { label: '重做 Ctrl+Shift+Z', Icon: Redo2, run: (e: Editor) => e.redo() }]).map(({ label, Icon, run }) => <button key={label} className="icon-button" type="button" aria-label={label} title={label} onClick={() => command(run)}><Icon size={16}/></button>)}
      <button className="icon-button" type="button" aria-label="插入图片" title="插入图片" onClick={() => fileInput.current?.click()}><ImagePlus size={17}/></button><input ref={fileInput} className="visually-hidden" type="file" multiple accept="image/*" onChange={event => { void files(Array.from(event.target.files ?? [])).catch(cause => setError(errorText(cause))); event.target.value = ''; }}/>
    </div> : null}
    {error ? <p className="pm-note-error" role="alert">{error}</p> : null}{restored ? <p className="pm-note-recovery" role="status">已恢复此设备上未保存的草稿</p> : null}
    <div className="pm-writing-layout"><div className="pm-editor-host"><div ref={surface} className="editor pm-note-content" data-note-body role="textbox" aria-label="笔记正文" aria-multiline="true" contentEditable={!reading && !busy} suppressContentEditableWarning onPasteCapture={event => {
            const html = event.clipboardData.getData('text/html');
            if (!html)
                return;
            event.preventDefault();
            event.stopPropagation();
            document.execCommand('insertHTML', false, sanitizeNoteHtml(html));
            engine.current?.fixImageContainers();
            engine.current?.normalizeTables();
            patch({ html: engine.current?.getHTML(), content: engine.current?.toPlainText() ?? '' });
        }}/></div>{outline.length ? <aside className="pm-note-outline" aria-label="正文大纲">{outline.map(item => <button key={item.index} type="button" onClick={() => surface.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[item.index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>{item.text}</button>)}</aside> : null}</div>
    {selectedImage && !reading ? <div className="pm-image-actions"><span>图片</span>{[['左对齐', () => engine.current?.alignImage(selectedImage, 'left')], ['居中', () => engine.current?.alignImage(selectedImage, 'center')], ['适应宽度', () => engine.current?.fitImageWidth(selectedImage)], ['缩小', () => engine.current?.smallImageSize(selectedImage)], ['移除', () => { engine.current?.deleteImage(selectedImage); setSelectedImage(null); }]].map(([label, run]) => <button className="text-button" type="button" key={String(label)} onClick={run as () => void}>{String(label)}</button>)}</div> : null}
    {!reading ? <label className="pm-note-source"><span>出处</span><input data-note-source value={draft.source} placeholder="可选，保留原文链接或出处" maxLength={1000} onChange={event => patch({ source: event.target.value })}/></label> : draft.source ? <p className="pm-source-copy">{draft.source}</p> : null}
    {shortcuts ? <div className="pm-shortcuts">Ctrl / ⌘ + S 保存，B 加粗，I 斜体，U 下划线，K 链接；Ctrl + Alt + Q 引用、C 代码、T 表格、R 阅读。Ctrl / ⌘ + / 收起快捷键。</div> : null}
    {historyError ? <p role="alert">{historyError}</p> : null}{versions !== null ? <section className="pm-note-versions"><div><strong>版本历史</strong><button type="button" className="icon-button" aria-label="关闭版本历史" onClick={() => setVersions(null)}><X size={16}/></button></div>{versions.length ? versions.map(version => <details key={version.id}><summary>{new Date(version.createdAt).toLocaleString()} 第 {version.revision} 版</summary><p>{version.record.kind === 'note' ? version.record.note?.title : ''}</p><pre>{recordText(version.record)}</pre><button className="secondary-button" type="button" onClick={() => { const value = initialDraft(version.record, draft.folderId); patch({ ...value, folderId: availableFolders.some(folder => folder.id === value.folderId) ? value.folderId : undefined }); engine.current?.setHTML(sanitizeNoteHtml(value.html ?? textToNoteHtml(value.content))); setVersions(null); setMessage('已载入历史内容，保存后生效'); }}>载入此版本</button></details>) : <p>首次修改保存后会保留历史版本。</p>}</section> : null}
    </div><footer className="pm-note-footer"><span>{draft.content.replace(/\s/g, '').length} 字</span><div><button type="button" className="text-button" onClick={() => setShortcuts(value => !value)}>快捷键</button><button type="button" className="text-button" disabled={!current.current} onClick={() => void history()}><History size={14}/>历史</button><button type="button" className="text-button" disabled={busy || changed > 0 || !current.current} title="保存后分享已保存的最新内容" onClick={() => setSharing(true)}>分享</button><button type="button" className="text-button" onClick={() => exportOne('md')}>导出 MD</button><button type="button" className="text-button" onClick={() => exportOne('html')}>导出 HTML</button></div></footer>
    {sharing && current.current ? <NoteShareDialog record={current.current} scope={scope} onClose={() => setSharing(false)}/> : null}
  </dialog>;
}
export function NotesLibrary({ records, loading, error, onRetry, onSave, onEdit, onDelete, entities, onCreateEntity, editor, scope = 'local' }: {
    readonly records: readonly RecordView[] | null;
    readonly loading: boolean;
    readonly error: string | null;
    readonly entities: readonly Entity[];
    readonly onRetry: () => void;
    readonly onCreateEntity: CreateEntity;
    readonly onSave: NoteSaveHandler;
    readonly onEdit: (record: RecordView) => void;
    readonly onDelete: (record: RecordView) => void;
    readonly editor?: ReactNode;
    readonly scope?: string;
}) {
    const deletion = useContext(RecordDeletionContext);
    const [folders, setFolders] = useState<NoteFolder[]>([]), [selected, setSelected] = useState('all'), [collapsed, setCollapsed] = useState<Set<string>>(new Set()), [folderError, setFolderError] = useState(''), [createOpen, setCreateOpen] = useState(false), [transfer, setTransfer] = useState(false), [query, setQuery] = useState(''), [menu, setMenu] = useState<string | null>(null), [form, setForm] = useState<{
        id?: string;
        parentId: string | null;
        name: string;
    } | null>(null), [folderBusy, setFolderBusy] = useState(false), [mobileFolders, setMobileFolders] = useState(false);
    const loadFolders = useCallback(async () => {
        try {
            const payload = await apiRequest<{
                folders: NoteFolder[];
            }>('/api/note-folders');
            setFolders(payload.folders);
            setFolderError('');
        }
        catch (cause) {
            setFolderError(errorText(cause));
        }
    }, []);
    useEffect(() => { void loadFolders(); }, [loadFolders, scope]);
    const items = useMemo(() => [...(records ?? [])].filter(record => record.kind === 'note').filter(record => { const n = record.kind === 'note' ? record.note : undefined; return selected === 'all' || (selected === 'unfiled' ? !n?.folderId : selected === 'starred' ? n?.starred : n?.folderId === selected); }).filter(record => !query || (recordText(record) + ' ' + (record.kind === 'note' ? record.note?.title ?? '' : '')).toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => Number(b.kind === 'note' && b.note?.pinned) - Number(a.kind === 'note' && a.note?.pinned) || Date.parse(b.updatedAt?.value ?? b.createdAt.value) - Date.parse(a.updatedAt?.value ?? a.createdAt.value)), [records, selected, query]);
    const masonry = useNoteMasonry(items, records !== null && items.length > 0);
    const selectedFolder = folders.find(folder => folder.id === selected);
    const title = selected === 'all' ? '全部笔记' : selected === 'unfiled' ? '未分类' : selected === 'starred' ? '收藏' : selectedFolder?.name ?? '全部笔记';
    const saveFolder = async () => {
        if (!form || folderBusy)
            return;
        setFolderBusy(true);
        setFolderError('');
        try {
            const current = folders.find(folder => folder.id === form.id);
            const result = await apiRequest<{
                folder: NoteFolder;
            }>('/api/note-folders' + (current ? '/' + encodeURIComponent(current.id) : ''), { method: current ? 'PATCH' : 'POST', body: JSON.stringify({ name: form.name, parentId: form.parentId, ...(current ? { revision: current.revision } : {}) }) });
            await loadFolders();
            setSelected(result.folder.id);
            setForm(null);
        }
        catch (cause) {
            setFolderError(errorText(cause));
        }
        finally {
            setFolderBusy(false);
        }
    };
    const deleteFolder = async (folder: NoteFolder) => {
        setFolderError('');
        try {
            await apiRequest('/api/note-folders/' + encodeURIComponent(folder.id) + '?revision=' + folder.revision, { method: 'DELETE' });
            await loadFolders();
            if (selected === folder.id)
                setSelected('all');
        }
        catch (cause) {
            setFolderError(errorText(cause));
        }
        setMenu(null);
    };
    const tree = (parentId: string | null, depth = 0): ReactNode => folders.filter(folder => folder.parentId === parentId).map(folder => <div key={folder.id} className="pm-folder-branch"><div className={`pm-folder-row${selected === folder.id ? ' is-active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}><button className="icon-button" type="button" aria-label={(collapsed.has(folder.id) ? '展开' : '收起') + folder.name} onClick={() => setCollapsed(previous => {
            const next = new Set(previous);
            if (next.has(folder.id))
                next.delete(folder.id);
            else
                next.add(folder.id);
            return next;
        })}>{folders.some(item => item.parentId === folder.id) ? collapsed.has(folder.id) ? <ChevronRight size={13}/> : <ChevronDown size={13}/> : <Folder size={14}/>}</button><button type="button" className="pm-folder-label" onClick={() => { setSelected(folder.id); setMobileFolders(false); }} title={folder.name}>{folder.name}</button><button className="icon-button" type="button" aria-label={'管理' + folder.name} onClick={() => setMenu(menu === folder.id ? null : folder.id)}><MoreHorizontal size={15}/></button></div>{menu === folder.id ? <div className="pm-folder-menu"><button type="button" onClick={() => { setForm({ parentId: folder.id, name: '' }); setMenu(null); }}>新建子文件夹</button><button type="button" onClick={() => { setForm({ id: folder.id, parentId: folder.parentId, name: folder.name }); setMenu(null); }}>重命名 / 移动</button><button type="button" onClick={() => void deleteFolder(folder)}>删除空文件夹</button></div> : null}{!collapsed.has(folder.id) ? tree(folder.id, depth + 1) : null}</div>);
    return <section className="notes-library pm-notes-library" data-view="notes" aria-labelledby="notes-library-title"><div className="page-heading notes-library-heading"><div><h1 id="notes-library-title">笔记</h1><p>{(records ?? []).filter(record => record.kind === 'note').length} 则笔记</p></div><div className="pm-library-actions"><button className="secondary-button" type="button" onClick={() => setTransfer(true)}><Upload size={15}/><span>导入 / 导出</span></button><button className="primary-button" data-note-create type="button" onClick={() => setCreateOpen(true)}><Plus size={16}/><span>新建笔记</span></button></div></div>
    <div className="pm-notes-workspace"><aside className={`pm-folder-pane${mobileFolders ? ' is-open' : ''}`} aria-label="笔记文件夹"><div className="pm-folder-heading"><span>文件夹</span><button type="button" className="icon-button" aria-label="新建文件夹" onClick={() => setForm({ parentId: null, name: '' })}><FolderPlus size={17}/></button></div>{[['all', '全部笔记'], ['unfiled', '未分类'], ['starred', '收藏']].map(([id, label]) => <button key={id} type="button" className={`pm-folder-shortcut${selected === id ? ' is-active' : ''}`} data-note-folder={id} onClick={() => { setSelected(id); setMobileFolders(false); }}>{id === 'starred' ? <Star size={15}/> : <BookOpen size={15}/>}<span>{label}</span></button>)}<div className="pm-folder-tree">{tree(null)}</div>{folderError ? <div className="pm-note-error" role="alert">{folderError}<button type="button" className="text-button" onClick={() => void loadFolders()}>重新读取</button></div> : null}</aside>
    <div className="pm-notes-main"><div className="pm-notes-subhead"><button type="button" className="pm-mobile-folder-button secondary-button" onClick={() => setMobileFolders(value => !value)}><Folder size={15}/>{title}</button><h2>{title}<small>{items.length}</small></h2><label className="pm-notes-search"><Search size={15}/><input aria-label="搜索当前文件夹" placeholder="搜索笔记" value={query} onChange={event => setQuery(event.target.value)}/></label></div>{loading && records === null ? <p role="status">正在读取笔记</p> : null}{error ? <p className="pm-note-error" role="alert">{error}<button className="text-button" type="button" onClick={onRetry}>重试</button></p> : null}{!loading && !error && !items.length ? <div className="notes-empty" data-note-empty><BookOpen size={24}/><strong>{query ? '没有找到匹配的笔记' : '这里还没有笔记'}</strong></div> : null}
    {items.length ? <div ref={masonry} className="notes-grid">{items.map(record => { const note = record.kind === 'note' ? record.note : undefined, pending = deletion.entries.some(entry => entry.record.id === record.id), folder = folders.find(item => item.id === note?.folderId); return <article className={`note-card${pending ? ' is-delete-pending' : ''}`} data-note-card data-record-id={record.id} key={record.id}><button className="note-card-main" type="button" inert={pending} onClick={() => onEdit(record)}><div className="note-card-meta"><span className="pm-card-folder">{note?.pinned ? <Pin size={12}/> : null}{note?.starred ? <Star size={12}/> : null}{folder?.name ?? '未分类'}</span><time data-note-updated>{new Date(record.updatedAt?.value ?? record.createdAt.value).toLocaleDateString()}</time></div>{note?.title ? <h2 data-note-title>{note.title}</h2> : null}<p className="note-card-excerpt">{recordText(record)}</p>{note?.source ? <p className="note-card-source" data-note-source>{note.source}</p> : null}</button><div className="note-card-actions" inert={pending}><button className="text-button" type="button" onClick={() => onEdit(record)}><Edit3 size={14}/>打开</button><button className="text-button note-card-delete" type="button" onClick={() => onDelete(record)}><Trash2 size={14}/>删除</button></div><RecordDeleteUndo id={record.id}/></article>; })}</div> : null}</div></div>
    {editor}
    <NoteEditorDialog record={null} createOpen={createOpen} entities={entities} onCreateEntity={onCreateEntity} onClose={() => setCreateOpen(false)} onSave={onSave} folders={folders} initialFolderId={selectedFolder?.id} scope={scope}/>
    {form ? <FolderForm value={form} folders={folders} busy={folderBusy} error={folderError} onChange={setForm} onClose={() => {
                if (!folderBusy)
                    setForm(null);
            }} onSave={() => void saveFolder()}/> : null}
    {transfer ? <NotesTransfer scope={scope} folders={folders} records={records ?? []} onClose={() => setTransfer(false)} onImported={() => { onRetry(); void loadFolders(); }}/> : null}
  </section>;
}
function FolderForm({ value, folders, busy, error, onChange, onClose, onSave }: {
    value: {
        id?: string;
        parentId: string | null;
        name: string;
    };
    folders: readonly NoteFolder[];
    busy: boolean;
    error: string;
    onChange: (value: {
        id?: string;
        parentId: string | null;
        name: string;
    }) => void;
    onClose: () => void;
    onSave: () => void;
}) { const ref = useRef<HTMLDialogElement>(null); useEffect(() => { ref.current?.showModal(); }, []); return <dialog ref={ref} className="modal-dialog pm-folder-dialog" onCancel={event => { event.preventDefault(); onClose(); }}><form onSubmit={event => { event.preventDefault(); onSave(); }}><h2>{value.id ? '整理文件夹' : '新建文件夹'}</h2><label>名称<input autoFocus aria-label="文件夹名称" maxLength={100} value={value.name} onChange={event => onChange({ ...value, name: event.target.value })}/></label><label>位置<select aria-label="上级文件夹" value={value.parentId ?? ''} onChange={event => onChange({ ...value, parentId: event.target.value || null })}><option value="">笔记根目录</option>{folders.filter(folder => folder.id !== value.id).map(folder => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}</select></label>{error ? <p className="pm-note-error" role="alert">{error}</p> : null}<div className="pm-folder-form-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !value.name.trim()}>{busy ? '保存中' : '保存'}</button></div></form></dialog>; }
