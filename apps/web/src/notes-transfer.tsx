import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Upload, X } from 'lucide-react';
import type { Asset, AssetLink, NoteFolder, TimelineRecord } from '@lifeos/core';
import { parseNativeNotesManifest, mapNativeNoteFolders } from './notes-native-manifest';
import { apiRequest, apiUploadRequest, type RecordView } from './api';
import { recordText } from './app-meta';
import { markdownToHtml } from './penmark/markdown.mjs';
import { Editor } from './penmark/editor.js';
import { noteHtmlText, sanitizeNoteHtml } from './note-html';
import { scopedKey } from './storage-scope';
export interface ImportFile {
    readonly path: string;
    readonly blob: Blob;
}
interface ImportNote {
    readonly path: string;
    readonly folder: string;
    readonly title: string;
    readonly html: string;
    readonly content: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly originalMarkdown?: string;
    readonly id?: string;
    readonly source?: string;
    readonly starred?: boolean;
    readonly pinned?: boolean;
    readonly isPrivate?: boolean;
}
export interface NoteImportPlan {
    readonly files: readonly ImportFile[];
    readonly notes: readonly ImportNote[];
    readonly warnings: readonly string[];
    readonly directories: readonly string[];
    readonly native?:ReturnType<typeof parseNativeNotesManifest>;
}
export function normalizeNotePath(path: string): string | null {
    const parts: string[] = [];
    for (const part of path.replaceAll('\\', '/').split('/')) {
        if (!part || part === '.')
            continue;
        if (part === '..') {
            if (!parts.length)
                return null;
            parts.pop();
        }
        else if (/[\u0000-\u001f]/.test(part))
            return null;
        else
            parts.push(part);
    }
    return parts.join('/');
}
function frontmatter(text: string): {
    body: string;
    meta: Record<string, string>;
} {
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const meta: Record<string, string> = {};
    if (!match)
        return { body: text, meta };
    for (const line of match[1].split(/\r?\n/)) {
        const field = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
        if (!field)
            continue;
        let value = field[2].trim();
        try {
            if (value.startsWith('"'))
                value = JSON.parse(value);
        }
        catch { }
        meta[field[1]] = value;
    }
    return { body: text.slice(match[0].length), meta };
}
export async function planNoteImport(input: readonly ImportFile[]): Promise<NoteImportPlan> {
    if (input.length > 10000)
        throw new Error('每次最多选择 10000 个文件，请分批导入');
    if (input.reduce((total, file) => total + file.blob.size, 0) > 200 * 1024 * 1024)
        throw new Error('本次文件超过 200 MB，请按文件夹分批导入');
    const files = input.flatMap(file => { const path = normalizeNotePath(file.path); return path ? [{ ...file, path }] : []; });
    const notes: ImportNote[] = [], warnings: string[] = [];
    const paths = new Map(files.map(file => [file.path, file]));
    const directories = new Set<string>();
    const manifest = paths.get('.lifeos/notes.json');
    let native:ReturnType<typeof parseNativeNotesManifest>|undefined;
    const manifestPaths = new Map<string, string>();
    if (manifest) {
        const value = parseNativeNotesManifest(JSON.parse(await manifest.blob.text()));native=value;
        if (value.format !== 'lifeos.notes' || value.version !== 1 || !Array.isArray(value.folders))
            throw new Error('笔记导出清单格式不支持');
        for (const folder of value.folders) {
            const parts = [folder.name], seen = new Set([folder.id]);
            let parent = folder.parentId;
            while (parent) {
                if (seen.has(parent))
                    throw new Error('导出清单的文件夹循环嵌套');
                seen.add(parent);
                const next = value.folders.find((item: NoteFolder) => item.id === parent);
                if (!next)
                    throw new Error('导出清单缺少上级文件夹');
                parts.unshift(next.name);
                parent = next.parentId;
            }
            const path = normalizeNotePath(parts.join('/'));
            if (path)
                directories.add(path);
            if (path)
                manifestPaths.set(folder.id, path);
        }
    }
    for (const file of files) {
        if (/(^|\/)(?:\.obsidian|\.trash|\.git|\.penmark|\.lifeos)(\/|$)/.test(file.path))
            continue;
        if (!/\.(?:md|markdown|html?)$/i.test(file.path)) {
            if (!/\.(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(file.path))
                warnings.push('待单独处理：' + file.path);
            continue;
        }
        if (file.blob.size > 2000000) {
            warnings.push('正文超过 2 MB，未选入：' + file.path);
            continue;
        }
        const text = await file.blob.text(), parsed = frontmatter(text);
        let html = /\.html?$/i.test(file.path) ? text : markdownToHtml(parsed.body);
        if (parsed.meta.source_html) {
            const original = paths.get(normalizeNotePath(parsed.meta.source_html) ?? '');
            if (original)
                html = await original.blob.text();
            else
                warnings.push('找不到富文本原件，将使用 Markdown：' + file.path);
        }
        html = sanitizeNoteHtml(html);
        const title = (Object.hasOwn(parsed.meta, 'title') ? parsed.meta.title : file.path.split('/').at(-1)!.replace(/\.(md|markdown|html?)$/i, '')).slice(0, 300);
        const content = noteHtmlText(html);
        if (!content && !/<img\b/i.test(html)) {
            warnings.push('空笔记，未选入：' + file.path);
            continue;
        }
        const validTime = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
        const folder = (manifest && parsed.meta.folder_id ? manifestPaths.get(parsed.meta.folder_id) : undefined) ?? (file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '');
        if (folder)
            directories.add(folder);
        notes.push({ path: file.path, folder, title, html, content: content || '（图片笔记）', createdAt: validTime(parsed.meta.created ?? parsed.meta.createdAt), updatedAt: validTime(parsed.meta.updated ?? parsed.meta.updatedAt), source: parsed.meta.source, starred: parsed.meta.starred === 'true', pinned: parsed.meta.pinned === 'true', isPrivate: parsed.meta.isPrivate === 'true', ...(manifest && parsed.meta.id ? { id: parsed.meta.id } : {}), ...(/\.md$/i.test(file.path) ? { originalMarkdown: text } : {}) });
    }
    for (const note of notes) {
        const doc = new DOMParser().parseFromString(note.html, 'text/html');
        for (const image of Array.from(doc.querySelectorAll('img'))) {
            const source = image.getAttribute('src') ?? '';
            if (!/^(?:https?:|data:image\/)/i.test(source) && !findImage({ files, notes, warnings, directories: [...directories] }, note, source))
                warnings.push('图片缺失或同名无法确定：' + note.path + ' → ' + source);
        }
    }
    return { files, notes, warnings, directories: [...directories],...(native?{native}:{}) };
}
async function stableId(value: string): Promise<string> { const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function findImage(plan: NoteImportPlan, note: ImportNote, source: string): ImportFile | null {
    let value = source;
    try {
        value = decodeURIComponent(value);
    }
    catch { }
    const directory = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
    const exact = normalizeNotePath((directory ? directory + '/' : '') + value);
    const hit = plan.files.find(file => file.path === exact);
    if (hit)
        return hit;
    const root = plan.files.find(file => file.path === normalizeNotePath(value));
    if (root)
        return root;
    const matches = plan.files.filter(file => file.path.split('/').at(-1) === value.split('/').at(-1));
    return matches.length === 1 ? matches[0] : null;
}
interface ImportReceipt {
    records: {
        id: string;
        revision: number;
    }[];
    folders: {
        id: string;
        revision: number;
    }[];
}
export function NotesTransfer({ folders, records, onClose, onImported, scope = 'local' }: {
    readonly folders: readonly NoteFolder[];
    readonly records: readonly RecordView[];
    readonly onClose: () => void;
    readonly onImported: () => void;
    readonly scope?: string;
}) {
    const ref = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), zipInput = useRef<HTMLInputElement>(null), cancel = useRef(false);
    const [plan, setPlan] = useState<NoteImportPlan | null>(null), [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState(''), [results, setResults] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false);
    useEffect(() => { ref.current?.showModal(); return () => { cancel.current = true; }; }, []);
    const receiptKey = scopedKey('lifeos:note-import:' + scope);
    const [receipt, setReceipt] = useState<ImportReceipt | null>(() => {
        try {
            const value = JSON.parse(sessionStorage.getItem(receiptKey) ?? 'null');
            return value && Array.isArray(value.records) && Array.isArray(value.folders) ? value : null;
        }
        catch {
            return null;
        }
    }), [undoConfirm, setUndoConfirm] = useState(false);
    const remember = (value: ImportReceipt) => {
        setReceipt({ ...value, records: [...value.records], folders: [...value.folders] });
        try {
            sessionStorage.setItem(receiptKey, JSON.stringify(value));
        }
        catch { }
    };
    const undoImport = async () => {
        if (!receipt || busy)
            return;
        if (!undoConfirm) {
            setUndoConfirm(true);
            return;
        }
        setBusy(true);
        const lines: string[] = [];
        const pending: ImportReceipt = { records: [], folders: [] };
        try {
            for (const item of receipt.records) {
                try {
                    await apiRequest('/api/records/' + encodeURIComponent(item.id), { method: 'DELETE', body: JSON.stringify({ revision: item.revision }) });
                    lines.push('已撤销：' + item.id);
                }
                catch (cause) {
                    pending.records.push(item);
                    lines.push('保留已修改或无法撤销的笔记：' + (cause as Error).message);
                }
            }
            for (const item of [...receipt.folders].reverse()) {
                try {
                    await apiRequest('/api/note-folders/' + encodeURIComponent(item.id) + '?revision=' + item.revision, { method: 'DELETE' });
                }
                catch {
                    pending.folders.unshift(item);
                }
            }
            if (pending.records.length || pending.folders.length)
                remember(pending);
            else {
                sessionStorage.removeItem(receiptKey);
                setReceipt(null);
            }
            setResults(lines);
            onImported();
        }
        finally {
            setBusy(false);
            setUndoConfirm(false);
        }
    };
    const prepare = async (files: ImportFile[]) => {
        setBusy(true);
        setError('');
        setResults([]);
        setConfirmed(false);
        try {
            setPlan(await planNoteImport(files));
        }
        catch (cause) {
            setError(String((cause as Error).message));
        }
        finally {
            setBusy(false);
        }
    };
    const selectZip = async (file: File) => {
        setBusy(true);
        setError('');
        try {
            await prepare(await readNoteZip(file));
        }
        catch (cause) {
            setError((cause as Error).message);
        }
        finally {
            setBusy(false);
        }
    };
    const runImport = async () => {
        if (!plan || !confirmed || busy)
            return;
        setBusy(true);
        setError('');
        cancel.current = false;
        const result: string[] = [], allFolders = [...folders], uploaded = new Map<string, Asset>();
        const batch: ImportReceipt = { records: [], folders: [] };
        let count = 0;
        try {
            const existing = (await apiRequest<{
                items: RecordView[];
            }>('/api/records?kind=note')).items;
            const nativeRecords=new Map(plan.native?.records.map(record=>[record.id,record])??[]);
            const pendingLinks:{id:string;links:readonly string[]}[]=[];
            const knownEntities=plan.native?(await apiRequest<{items:import('@lifeos/core').Entity[]}>('/api/entities')).items:[];
            const knownAssets=plan.native?new Set((await apiRequest<{items:Asset[]}>('/api/assets')).items.map(asset=>asset.id)):new Set<string>();
            const knownRecords=plan.native?new Set((await apiRequest<{items:RecordView[]}>('/api/records')).items.map(record=>record.id)):new Set<string>();
            if(plan.native){
                const mapped=mapNativeNoteFolders(plan.native.folders,allFolders,()=>crypto.randomUUID());
                if(mapped.folders.length){
                    await apiRequest('/api/import',{method:'POST',body:JSON.stringify({bundle:{format:'lifeos.export',version:1,exportedAt:{kind:'instant',value:new Date().toISOString()},records:[],entities:[],assets:[],modules:{notes:{folders:mapped.folders}}}})});
                    allFolders.push(...mapped.folders);batch.folders.push(...mapped.folders.map(folder=>({id:folder.id,revision:folder.revision})));remember(batch);
                }
            }

            for (const path of plan.directories) {
                if (cancel.current)
                    break;
                let parentId: string | null = null;
                for (const name of path.split('/').filter(Boolean)) {
                    let folder = allFolders.find(item => item.name === name && item.parentId === parentId);
                    if (!folder) {
                        folder = (await apiRequest<{
                            folder: NoteFolder;
                        }>('/api/note-folders', { method: 'POST', body: JSON.stringify({ name, parentId }) })).folder;
                        allFolders.push(folder);
                        batch.folders.push({ id: folder.id, revision: folder.revision });
                        remember(batch);
                    }
                    parentId = folder.id;
                }
            }
            for (const note of plan.notes) {
                if (cancel.current) {
                    result.push('已停止；已导入的笔记保留，可查看结果');
                    break;
                }
                setProgress(`正在导入 ${++count} / ${plan.notes.length}`);
                const id = note.id ?? ('note-import-' + await stableId(note.path));
                if (existing.some(record => record.id === id)) {
                    result.push('已存在，未覆盖：' + note.path);
                    continue;
                }
                try {
                    let folderId: string | undefined;
                    for (const name of note.folder.split('/').filter(Boolean)) {
                        let folder = allFolders.find(item => item.name === name && item.parentId === (folderId ?? null));
                        if (!folder) {
                            folder = (await apiRequest<{
                                folder: NoteFolder;
                            }>('/api/note-folders', { method: 'POST', body: JSON.stringify({ name, parentId: folderId ?? null }) })).folder;
                            allFolders.push(folder);
                            batch.folders.push({ id: folder.id, revision: folder.revision });
                            remember(batch);
                        }
                        folderId = folder.id;
                    }
                    const doc = new DOMParser().parseFromString(note.html, 'text/html'), refs: AssetLink[] = [];
                    const assetIdMap=new Map<string,string>();
                    const original=nativeRecords.get(id);
                    const entityRefs=(original?.entityRefs??[]).filter(ref=>knownEntities.some(entity=>entity.id===ref.entityId&&entity.type===ref.entityType));
                    if(original&&entityRefs.length<original.entityRefs.length)result.push('部分关联对象不在目标空间，原始关联保留在导出清单：'+note.path);
                    for (const image of Array.from(doc.querySelectorAll('img'))) {
                        const source = image.getAttribute('src') ?? '';
                        if (/^https?:\/\//i.test(source)) {
                            result.push('保留网络图片链接：' + note.path);
                            continue;
                        }
                        if (source.startsWith('data:image/')) {
                            const blob = await (await fetch(source)).blob(), asset = await apiUploadRequest<Asset>('/api/assets/uploads?name=note-image.png', blob, { contentType: blob.type });
                            image.src = '/api/assets/' + encodeURIComponent(asset.id) + '/content';
                            refs.push({ assetId: asset.id, role: 'photo' });
                            continue;
                        }
                        const file = findImage(plan, note, source);
                        if (!file)
                            throw new Error('图片缺失或同名无法确定：' + source);
                        let asset = uploaded.get(file.path);
                        if (!asset) {
                            asset = await apiUploadRequest<Asset>('/api/assets/uploads?name=' + encodeURIComponent(file.path.split('/').at(-1)!), file.blob, { contentType: file.blob.type || (/\.png$/i.test(file.path) ? 'image/png' : /\.webp$/i.test(file.path) ? 'image/webp' : /\.gif$/i.test(file.path) ? 'image/gif' : 'image/jpeg') });
                            uploaded.set(file.path, asset);
                        }
                        image.src = '/api/assets/' + encodeURIComponent(asset.id) + '/content';
                        const sourceName=file.path.split('/').at(-1)!;
                        try{assetIdMap.set(decodeURIComponent(sourceName.slice(0,sourceName.lastIndexOf('.'))),asset.id);}catch{}
                        if (!refs.some(ref => ref.assetId === asset!.id))
                            refs.push({ assetId: asset.id, role: 'photo' });
                    }
                    const now = new Date().toISOString();
                    for(const ref of original?.assetRefs??[]){const mapped=assetIdMap.get(ref.assetId)??(knownAssets.has(ref.assetId)?ref.assetId:undefined);if(mapped){const index=refs.findIndex(item=>item.assetId===mapped);const value={...ref,assetId:mapped};if(index<0)refs.push(value);else refs[index]=value;}else result.push('附件未能恢复，原件引用保留在导出清单：'+note.path);}
                    const body=original?{...original.body,...(original.body.entityMentions?{entityMentions:original.body.entityMentions.filter(decision=>decision.entityId===null||entityRefs.some(ref=>ref.entityId===decision.entityId))}:{}),...(original.body.transcriptRaw?{transcriptRaw:original.body.transcriptRaw.map(transcript=>({...transcript,assetId:assetIdMap.get(transcript.assetId)??transcript.assetId}))}:{})}:{original:note.content};
                    const record:TimelineRecord={...(original??{}),id,kind:'note',body,createdAt:original?.createdAt??{kind:'instant',value:note.createdAt??now},...(original?.updatedAt?{updatedAt:original.updatedAt}:note.updatedAt?{updatedAt:{kind:'instant' as const,value:note.updatedAt}}:{}),note:{format:'note',...(note.title?{title:note.title}:{}),html:doc.body.innerHTML,...(note.source?{source:note.source}:{}),starred:note.starred===true,pinned:note.pinned===true,...(folderId?{folderId}:{})},isPrivate:note.isPrivate===true,assetRefs:refs,entityRefs,relatedRecordIds:(original?.relatedRecordIds??[]).filter(link=>knownRecords.has(link)),aiDerived:original?.aiDerived??[]};

                    await apiRequest('/api/import', { method: 'POST', body: JSON.stringify({ bundle: { format: 'lifeos.export', version: 1, exportedAt: { kind: 'instant', value: now }, records: [record], entities: [], assets: [] } }) });
                    existing.push({ ...record, revision: 1 } as RecordView);
                    batch.records.push({ id: record.id, revision: 1 });
                    knownRecords.add(record.id);if(original?.relatedRecordIds.length)pendingLinks.push({id:record.id,links:original.relatedRecordIds});
                    remember(batch);
                    result.push('已导入：' + note.path);
                }
                catch (cause) {
                    result.push('失败：' + note.path + '，' + (cause as Error).message);
                }
                setResults([...result]);
            }
            for(const item of pendingLinks){const links=item.links.filter(id=>knownRecords.has(id));if(links.length<item.links.length)result.push('部分相关记录不在目标空间，原始引用保留在导出清单：'+item.id);if(!links.length)continue;try{const current=existing.find(record=>record.id===item.id)!;if(JSON.stringify(current.relatedRecordIds)===JSON.stringify(links))continue;const saved=await apiRequest<RecordView>('/api/records/'+encodeURIComponent(item.id),{method:'PATCH',body:JSON.stringify({revision:current.revision,relatedRecordIds:links})});const receipt=batch.records.find(record=>record.id===item.id);if(receipt)receipt.revision=saved.revision;remember(batch);}catch(cause){result.push('相关记录未能连接：'+item.id+'，'+(cause as Error).message);}}
        }
        catch (cause) {
            setError((cause as Error).message);
        }
        finally {
            setResults(result);
            setBusy(false);
            setProgress('');
            setConfirmed(false);
            onImported();
        }
    };
    const exportAll = async () => {
        setBusy(true);
        setError('');
        setProgress('正在准备导出');
        try {
            const all = (await apiRequest<{
                items: RecordView[];
            }>('/api/records?kind=note')).items;
            const allFolders = (await apiRequest<{
                folders: NoteFolder[];
            }>('/api/note-folders')).folders;
            const blob = await createNotesArchive(all, allFolders, setProgress);
            const url = URL.createObjectURL(blob), anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = 'LifeOS-笔记.zip';
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            setProgress('导出完成');
        }
        catch (cause) {
            setError((cause as Error).message);
            setProgress('');
        }
        finally {
            setBusy(false);
        }
    };
    return <dialog ref={ref} className="modal-dialog pm-transfer-dialog" aria-labelledby="notes-transfer-title" onCancel={event => {
            event.preventDefault();
            if (!busy)
                onClose();
        }}><header><h2 id="notes-transfer-title">笔记导入与导出</h2><button className="icon-button" type="button" aria-label="关闭导入与导出" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="pm-transfer-body"><p>按原文件夹导入 Markdown 或 HTML，图片随笔记保存。确认前只在此设备预览。</p><div className="pm-transfer-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => input.current?.click()}><Upload size={16}/>选择文件夹</button><button className="secondary-button" type="button" disabled={busy} onClick={() => zipInput.current?.click()}>选择 ZIP</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void exportAll()}><Download size={16}/>导出全部笔记</button></div><input ref={input} className="visually-hidden" type="file" multiple {...{ webkitdirectory: '' }} onChange={event => {
            let files = Array.from(event.target.files ?? []).map(file => ({ path: file.webkitRelativePath || file.name, blob: file as Blob }));
            const root = files[0]?.path.split('/')[0];
            if (root && files.every(file => file.path.startsWith(root + '/')))
                files = files.map(file => ({ ...file, path: file.path.slice(root.length + 1) }));
            void prepare(files);
            event.target.value = '';
        }}/><input ref={zipInput} className="visually-hidden" type="file" accept=".zip" onChange={event => {
            const file = event.target.files?.[0];
            if (file)
                void selectZip(file);
            event.target.value = '';
        }}/>
    {plan ? <><div className="pm-import-counts"><strong>{plan.notes.length} 篇笔记</strong><span>{new Set(plan.notes.map(note => note.folder).filter(Boolean)).size} 个目录</span></div><ul className="pm-import-list">{plan.notes.map(note => <li key={note.path}>{note.path}</li>)}</ul>{plan.warnings.length ? <details><summary>{plan.warnings.length} 项需要留意</summary><ul>{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}<label className="pm-import-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>确认导入以上笔记，已有同路径导入项保留，不覆盖修改</label></> : null}
    {receipt ? <div className="pm-import-undo"><p>可撤销本浏览器最近一次导入。导入后已修改的笔记会保留。</p><button className="secondary-button" type="button" disabled={busy} onClick={() => void undoImport()}>{undoConfirm ? '确认撤销 ' + receipt.records.length + ' 篇笔记' : '撤销上次导入'}</button>{undoConfirm ? <button className="secondary-button" type="button" disabled={busy} onClick={() => setUndoConfirm(false)}>取消</button> : null}</div> : null}{error ? <p className="pm-note-error" role="alert">{error}</p> : null}{progress ? <p role="status">{busy ? <LoaderCircle className="spin" size={15}/> : null}{progress}</p> : null}{results.length ? <details open><summary>导入结果</summary><ul>{results.map((result, index) => <li key={index}>{result}</li>)}</ul></details> : null}</div><footer><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>关闭</button>{busy ? <button className="secondary-button" type="button" onClick={() => { cancel.current = true; }}>处理完当前笔记后停止</button> : null}<button className="primary-button" type="button" disabled={busy || !plan?.notes.length || !confirmed} onClick={() => void runImport()}>确认导入</button></footer></dialog>;
}
export async function createNotesArchive(all: readonly RecordView[], allFolders: readonly NoteFolder[], onProgress: (value: string) => void = () => { }): Promise<Blob> {
    const JSZip = (await import('jszip')).default, zip = new JSZip();
    const folderPath = (id: string | undefined): string => { const folder = allFolders.find(item => item.id === id); return folder ? (folder.parentId ? folderPath(folder.parentId) + '/' : '') + folder.name.replace(/[<>:"/\\|?*]/g, '_') : ''; };
    const assets = new Map<string, string>();
    for (let index = 0; index < all.length; index++) {
        const record = all[index];
        if (record.kind !== 'note')
            continue;
        onProgress(`正在导出 ${index + 1} / ${all.length}`);
        const dir = folderPath(record.note?.folderId), base = (record.note?.title || '未命名笔记').replace(/[<>:"/\\|?*]/g, '_') + '--' + encodeURIComponent(record.id);
        const html = sanitizeNoteHtml(record.note?.html ?? markdownToHtml(recordText(record)));
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const image of Array.from(doc.querySelectorAll('img'))) {
            const source = image.getAttribute('src') ?? '';
            const id = /^\/api\/assets\/([^/]+)\/content(?:\?|$)/.exec(source)?.[1];
            if (!id)
                continue;
            let file = assets.get(id);
            if (!file) {
                const response = await fetch(source);
                if (!response.ok)
                    throw new Error('图片导出失败：' + id);
                const blob = await response.blob();
                file = '.lifeos/assets/' + id + '.' + (blob.type.split('/')[1] || 'bin');
                assets.set(id, file);
                zip.file(file, blob);
            }
            image.setAttribute('src', (dir ? '../'.repeat(dir.split('/').length) : '') + file);
        }
        const element = document.createElement('div');
        const editor = new Editor({ editor: element });
        try {
            editor.setHTML(doc.body.innerHTML);
            zip.file((dir ? dir + '/' : '') + base + '.md', `---\nid: ${JSON.stringify(record.id)}\ntitle: ${JSON.stringify(record.note?.title ?? '')}\nsource: ${JSON.stringify(record.note?.source ?? '')}\nstarred: ${record.note?.starred === true}\npinned: ${record.note?.pinned === true}\nisPrivate: ${record.isPrivate === true}\nfolder_id: ${JSON.stringify(record.note?.folderId ?? '')}\ncreated: ${record.createdAt.value}\nupdated: ${record.updatedAt?.value ?? record.createdAt.value}\nsource_html: ${JSON.stringify('.lifeos/source-html/' + encodeURIComponent(record.id) + '.html')}\n---\n\n` + editor.toMarkdown());
        }
        finally {
            editor.destroy();
        }
        zip.file('.lifeos/source-html/' + encodeURIComponent(record.id) + '.html', doc.body.innerHTML);
    }
    for (const folder of allFolders)
        zip.folder(folderPath(folder.id));
    zip.file('.lifeos/notes.json', JSON.stringify({ format: 'lifeos.notes', version: 1, folders: allFolders, records: all }, null, 2));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
export async function readNoteZip(file: Blob): Promise<ImportFile[]> {
    if (file.size > 200 * 1024 * 1024)
        throw new Error('压缩包超过 200 MB，请分批导入');
    const JSZip = (await import('jszip')).default, zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter(item => !item.dir);
    if (entries.length > 10000)
        throw new Error('压缩包文件过多，请分批导入');
    const inflated = entries.reduce((sum, item) => sum + Number((item as unknown as {
        _data?: {
            uncompressedSize: number;
        };
    })._data?.uncompressedSize ?? 0), 0);
    if (inflated > 200 * 1024 * 1024)
        throw new Error('解压后超过 200 MB，请分批导入');
    let files = await Promise.all(entries.map(async (entry) => ({ path: entry.name, blob: await entry.async('blob') })));
    const top = files[0]?.path.split('/')[0];
    if (top && files.every(item => item.path.startsWith(top + '/')))
        files = files.map(item => ({ ...item, path: item.path.slice(top.length + 1) }));
    return files;
}
