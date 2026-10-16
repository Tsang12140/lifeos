import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, LockKeyhole, Share2, X } from 'lucide-react';
import { apiRequest, type RecordView } from './api';
import { sanitizeNoteHtml, textToNoteHtml } from './note-html';
import { Editor } from './penmark/editor.js';
import { noteHtmlText } from './note-html';
import './note-sharing.css';
interface ShareState {
    enabled: boolean;
    token?: string;
    protected?: boolean;
    canEdit?: boolean;
}
export function NoteShareDialog({ record, scope, onClose }: {
    record: RecordView;
    scope: string;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null), linkInput = useRef<HTMLInputElement>(null);
    const [share, setShare] = useState<ShareState | null>(null), [protectedShare, setProtected] = useState(false), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [canEdit, setCanEdit] = useState(false);
    const endpoint = '/api/notes/' + encodeURIComponent(record.id) + '/share';
    useEffect(() => {
        ref.current?.showModal();
        let active = true;
        apiRequest<ShareState>(endpoint).then(value => {
            if (active) {
                setShare(value);
                setProtected(value.protected === true);
                setCanEdit(value.canEdit === true);
            }
        }).catch(cause => {
            if (active)
                setError(cause.message);
        });
        return () => { active = false; };
    }, [endpoint]);
    const link = share?.enabled && share.token ? location.origin + '/?noteShare=' + encodeURIComponent(scope + '.' + share.token) : '';
    const save = async () => {
        if (busy)
            return;
        setBusy(true);
        setError('');
        try {
            const value = await apiRequest<ShareState>(endpoint, { method: 'POST', body: JSON.stringify({ revision: record.revision, canEdit, ...(!protectedShare ? { password: null } : password ? { password } : share?.protected ? {} : { password: '' }) }) });
            setShare(value);
            setPassword('');
            setNotice('分享设置已保存');
        }
        catch (cause) {
            setError((cause as Error).message);
        }
        finally {
            setBusy(false);
        }
    };
    const revoke = async () => {
        if (busy)
            return;
        setBusy(true);
        setError('');
        try {
            await apiRequest(endpoint, { method: 'DELETE' });
            setShare({ enabled: false });
            setNotice('分享已关闭，旧链接已失效');
        }
        catch (cause) {
            setError((cause as Error).message);
        }
        finally {
            setBusy(false);
        }
    };
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(link);
            setNotice('链接已复制');
        }
        catch {
            linkInput.current?.focus();
            linkInput.current?.select();
            setNotice('链接已选中，可以复制');
        }
    };
    return <dialog ref={ref} className="modal-dialog pm-share-dialog" aria-labelledby="note-share-title" onKeyDown={event => event.stopPropagation()} onCancel={event => {
            event.preventDefault();
            if (!busy)
                onClose();
        }}><header><h2 id="note-share-title">分享笔记</h2><button className="icon-button" type="button" aria-label="关闭分享设置" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="pm-share-body"><p>链接展示这篇笔记已保存的最新内容，默认仅供阅读。</p>{record.isPrivate ? <p className="pm-share-private">这篇笔记标记为私密。开启分享后，持有链接的人也可以阅读。</p> : null}
    <label className="pm-share-protect"><input type="checkbox" checked={protectedShare} disabled={busy || share === null} onChange={event => setProtected(event.target.checked)}/><LockKeyhole size={16}/><span>使用访问密码</span></label>{protectedShare ? <label className="pm-share-password"><span>访问密码</span><input type="password" autoComplete="new-password" aria-label="分享访问密码" value={password} minLength={4} maxLength={128} placeholder={share?.protected ? '留空继续使用当前密码' : '4–128 个字符'} disabled={busy} onChange={event => setPassword(event.target.value)}/></label> : null}
    <label className="pm-share-protect"><input type="checkbox" checked={canEdit} disabled={busy || share === null} onChange={event => setCanEdit(event.target.checked)}/><span>允许访客编辑标题和正文</span></label>
    {link ? <div className="pm-share-link"><label htmlFor="note-share-link">分享链接</label><input id="note-share-link" ref={linkInput} value={link} readOnly/><div><button className="secondary-button" type="button" onClick={() => void copy()}><Copy size={15}/>复制链接</button><a className="secondary-button" href={link} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/>打开预览</a></div></div> : null}{error ? <p className="pm-note-error" role="alert">{error}</p> : null}{notice ? <p className="pm-share-notice" role="status">{notice}</p> : null}</div><footer>{share?.enabled ? <button className="danger-button" type="button" disabled={busy} onClick={() => void revoke()}>关闭分享</button> : null}<button className="secondary-button" type="button" disabled={busy} onClick={onClose}>返回</button><button className="primary-button" type="button" disabled={busy || share === null} onClick={() => void save()}>{busy ? <LoaderCircle size={15} className="spin"/> : <Share2 size={15}/>}<span>{share?.enabled ? '保存设置' : '开启分享'}</span></button></footer></dialog>;
}
interface PublicNote {
    title: string;
    html: string | null;
    content: string;
    source: string;
    assets: Record<string, string>;
    revision: number;
    canEdit: boolean;
}
export function SharedNotePage({ space, token }: {
    space: string;
    token: string;
}) {
    const valid = /^[A-Za-z0-9_-]{1,128}$/.test(space) && /^[A-Za-z0-9_-]{43}$/.test(token);
    const endpoint = '/api/public/notes/' + encodeURIComponent(space) + '/' + encodeURIComponent(token);
    const [note, setNote] = useState<PublicNote | null>(null), [locked, setLocked] = useState(false), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
    const load = async () => {
        if (!valid) {
            setError('分享链接无效');
            setLoading(false);
            return;
        }
        try {
            const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' });
            const value = await response.json();
            if (response.status === 401) {
                setLocked(true);
                setNote(null);
                return;
            }
            if (!response.ok)
                throw new Error(value.message ?? '分享不存在或已关闭');
            setNote(value);
            setLocked(false);
            setError('');
            document.title = (value.title || '笔记') + ' - LifeOS';
        }
        catch (cause) {
            setError((cause as Error).message);
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { void load(); }, [endpoint]);
    const unlock = async () => {
        if (busy)
            return;
        setBusy(true);
        setError('');
        try {
            const response = await fetch(endpoint + '/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
            const value = await response.json();
            if (!response.ok)
                throw new Error(value.message ?? '无法打开分享');
            setPassword('');
            await load();
        }
        catch (cause) {
            setError((cause as Error).message);
        }
        finally {
            setBusy(false);
        }
    };
    const [editing, setEditing] = useState(false);
    const savePublic = async (payload: {
        title: string;
        html: string;
        content: string;
    }) => { const response = await fetch(endpoint, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, revision: note!.revision }) }); const value = await response.json(); if (!response.ok)
        throw new Error(value.message ?? '保存失败'); setNote(value); setEditing(false); };
    let html = '';
    if (note) {
        const doc = new DOMParser().parseFromString(sanitizeNoteHtml(note.html ?? textToNoteHtml(note.content)), 'text/html');
        for (const image of Array.from(doc.querySelectorAll('img'))) {
            const src = image.getAttribute('src') ?? '', id = /^\/api\/assets\/([^/]+)\/content(?:\?|$)/.exec(src)?.[1];
            if (id) {
                let decoded = '';
                try {
                    decoded = decodeURIComponent(id);
                }
                catch { }
                const url = note.assets[decoded];
                if (url)
                    image.src = url;
                else
                    image.remove();
            }
            else if (!/^https?:\/\//i.test(src) && !src.startsWith('data:image/'))
                image.remove();
        }
        html = doc.body.innerHTML;
    }
    return <main className="pm-shared-page"><header><span>LifeOS</span><span>分享笔记</span></header>{loading ? <p role="status">正在打开笔记</p> : null}{locked ? <form className="pm-shared-lock" onSubmit={event => { event.preventDefault(); void unlock(); }}><LockKeyhole size={26}/><h1>这篇笔记需要访问密码</h1><label><span>访问密码</span><input autoFocus type="password" autoComplete="current-password" value={password} maxLength={128} onChange={event => setPassword(event.target.value)}/></label><button className="primary-button" type="submit" disabled={busy || !password}>{busy ? '正在验证' : '打开笔记'}</button></form> : null}{error ? <p className="pm-note-error" role="alert">{error}</p> : null}{note && editing ? <SharedNoteEditor note={note} html={html} onSave={savePublic} onCancel={() => setEditing(false)}/> : null}{note && !editing ? <article>{note.canEdit ? <button className="secondary-button pm-share-edit" type="button" onClick={() => setEditing(true)}>编辑笔记</button> : null}<h1>{note.title || '无标题笔记'}</h1><div className="pm-editor-host"><div className="editor pm-shared-content" dangerouslySetInnerHTML={{ __html: html }}/></div>{note.source ? <p className="pm-shared-source">出处：{note.source}</p> : null}</article> : null}</main>;
}
function SharedNoteEditor({ note, html, onSave, onCancel }: {
    note: PublicNote;
    html: string;
    onSave: (value: {
        title: string;
        html: string;
        content: string;
    }) => Promise<void>;
    onCancel: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null), engine = useRef<Editor | null>(null);
    const [title, setTitle] = useState(note.title), [busy, setBusy] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
    useEffect(() => { const editor = new Editor({ editor: ref.current!, onUpdate: () => setDirty(true), onToast: setError }); editor.setHTML(html); engine.current = editor; setDirty(false); return () => { editor.destroy(); engine.current = null; }; }, []);
    useEffect(() => { if (!dirty)
        return; const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
    const save = async () => { if (!engine.current || busy)
        return; setBusy(true); setError(''); try {
        const doc = new DOMParser().parseFromString(sanitizeNoteHtml(engine.current.getHTML()), 'text/html');
        for (const image of Array.from(doc.querySelectorAll('img'))) {
            const source = image.getAttribute('src') ?? '';
            const id = Object.entries(note.assets).find(([, url]) => new URL(url, location.origin).href === new URL(source, location.origin).href)?.[0];
            if (id)
                image.src = '/api/assets/' + encodeURIComponent(id) + '/content';
        }
        await onSave({ title, html: doc.body.innerHTML, content: noteHtmlText(doc.body.innerHTML) });
    }
    catch (cause) {
        setError((cause as Error).message);
    }
    finally {
        setBusy(false);
    } };
    return <section className="pm-public-edit"><input className="pm-note-title" aria-label="共享笔记标题" value={title} maxLength={300} disabled={busy} onChange={event => { setTitle(event.target.value); setDirty(true); }}/><div className="pm-editor-toolbar" role="toolbar" aria-label="共享笔记文字格式" onMouseDown={event => event.preventDefault()}>{[['加粗', 'bold'], ['斜体', 'italic'], ['列表', 'insertUnorderedList']].map(([label, command]) => <button type="button" className="text-button" disabled={busy} key={command} onClick={() => engine.current?.exec(command)}>{label}</button>)}</div><div className="pm-editor-host"><div ref={ref} className="editor pm-shared-content" aria-label="共享笔记正文" role="textbox" aria-multiline="true" contentEditable={!busy} suppressContentEditableWarning onPasteCapture={event => { const html = event.clipboardData.getData('text/html'); if (html) {
        event.preventDefault();
        event.stopPropagation();
        document.execCommand('insertHTML', false, sanitizeNoteHtml(html));
        setDirty(true);
    } }}/></div>{error ? <p className="pm-note-error" role="alert">{error}</p> : null}<div className="pm-public-edit-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消编辑</button><button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中' : '保存修改'}</button></div></section>;
}
