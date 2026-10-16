import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { RouteHandler } from './route-context.js';
import type { NoteShare } from './note-shares.js';
import { HttpError, setEmpty, setJson } from './http-kit.js';
import { readBody, requireJsonContentType } from './http-body.js';
import { hasOnlyKeys, jsonObject, revisionField, stringField, booleanField } from './field-validate.js';
import { patchRecord } from './record-builders.js';
import { handleAssetsRoutes } from './routes-assets.js';
import type { SqliteRecordRepository } from './repository.js';
const TTL = 7 * 24 * 60 * 60 * 1000;
const failures = new WeakMap<SqliteRecordRepository, Map<string, {
    count: number;
    at: number;
}>>();
const work = new WeakMap<SqliteRecordRepository, number>();
const publicPattern = /^\/api\/public\/notes\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{43})(?:\/(unlock|assets\/[^/]+))?$/;
export function publicNoteSpace(path: string): string | null { return publicPattern.exec(path)?.[1] ?? null; }
function derive(password: string, salt: string): Promise<Buffer> { return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))); }
function equal(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function cookieName(share: NoteShare): string { return 'lifeos_note_' + share.token.slice(0, 12); }
function signature(share: NoteShare, expires: string): string { return createHmac('sha256', share.secret).update(share.token + ':' + expires).digest('base64url'); }
function publicView(share: NoteShare | null) { return share ? { enabled: true, token: share.token, protected: share.passwordHash !== null, canEdit: share.canEdit === true, updatedAt: share.updatedAt } : { enabled: false }; }
export const handlePublicNoteRoutes: RouteHandler = async (ctx, req, res, pathname, url) => {
    if (!pathname.startsWith('/api/public/notes/'))
        return false;
    const match = publicPattern.exec(pathname);
    if (!match)
        throw new HttpError(404, 'not_found', '分享不存在或已关闭');
    if (!ctx.config.gatewayAuthenticated && match[1] !== 'local')
        throw new HttpError(404, 'not_found', '分享不存在或已关闭');
    const share = ctx.repository.notes.shares.byToken(match[2]!);
    const record = share ? ctx.repository.findById(share.recordId) : null;
    if (!share || record?.kind !== 'note')
        throw new HttpError(404, 'not_found', '分享不存在或已关闭');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    const path = '/api/public/notes/' + match[1] + '/' + share.token;
    if (match[3] === 'unlock' && req.method === 'POST') {
        requireJsonContentType(req);
        const input = jsonObject(await readBody(req, 8192), 'body');
        hasOnlyKeys(input, ['password']);
        const password = stringField(input.password, 'password');
        if (password.length > 128)
            throw new HttpError(400, 'invalid_password', '密码长度无效');
        let buckets = failures.get(ctx.repository);
        if (!buckets) {
            buckets = new Map();
            failures.set(ctx.repository, buckets);
        }
        const now = Date.now();
        for (const [key, bucket] of buckets)
            if (now - bucket.at > 60000)
                buckets.delete(key);
        const key = req.socket.remoteAddress ?? 'unknown', bucket = buckets.get(key);
        if ((bucket && bucket.count >= 5) || (buckets.size >= 4096 && !bucket) || (work.get(ctx.repository) ?? 0) >= 4) {
            res.setHeader('retry-after', '60');
            throw new HttpError(429, 'share_rate_limited', '尝试过多，请稍后再试');
        }
        if (share.passwordHash) {
            work.set(ctx.repository, (work.get(ctx.repository) ?? 0) + 1);
            let valid = false;
            try {
                const [salt, hash] = share.passwordHash.split(':');
                valid = equal((await derive(password, salt!)).toString('hex'), hash!);
            }
            finally {
                work.set(ctx.repository, (work.get(ctx.repository) ?? 1) - 1);
            }
            if (!valid) {
                buckets.set(key, { count: (bucket?.count ?? 0) + 1, at: now });
                throw new HttpError(401, 'share_password_required', '访问密码不正确');
            }
            // A password change or revoke while scrypt was running invalidates this attempt.
            if (ctx.repository.notes.shares.byToken(share.token)?.secret !== share.secret)
                throw new HttpError(401, 'share_password_required', '分享设置已变化，请重新访问');
        }
        buckets.delete(key);
        const expires = String(Date.now() + TTL), cookie = expires + '.' + signature(share, expires);
        res.setHeader('set-cookie', `${cookieName(share)}=${cookie}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}${ctx.config.cookieSecure ? '; Secure' : ''}`);
        setJson(res, 200, { ok: true });
        return true;
    }
    if (req.method !== 'GET' && !(req.method === 'PUT' && !match[3]))
        throw new HttpError(405, 'method_not_allowed', '分享仅供阅读');
    if (share.passwordHash) {
        const raw = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName(share) + '='))?.slice(cookieName(share).length + 1) ?? '';
        const [expires, mac] = raw.split('.');
        if (!expires || !mac || !/^\d{13}$/.test(expires) || Number(expires) <= Date.now() || !equal(signature(share, expires), mac))
            throw new HttpError(401, 'share_password_required', '请输入访问密码');
    }
    if (match[3]?.startsWith('assets/')) {
        let id: string;
        try {
            id = decodeURIComponent(match[3].slice(7));
        }
        catch {
            throw new HttpError(400, 'invalid_id', '图片编号无效');
        }
        const asset = ctx.repository.findAssetById(id);
        if (!asset || asset.kind !== 'photo' || !record.assetRefs.some(ref => ref.assetId === id))
            throw new HttpError(404, 'not_found', '分享中没有这张图片');
        const canonical = '/api/assets/' + encodeURIComponent(id) + '/content';
        await handleAssetsRoutes(ctx, req, res, canonical, new URL(canonical, url));
        return true;
    }
    let visible = record;
    if (req.method === 'PUT') {
        if (!share.canEdit)
            throw new HttpError(403, 'share_readonly', '主人未允许编辑这篇笔记');
        requireJsonContentType(req);
        const input = jsonObject(await readBody(req, ctx.config.bodyLimitBytes), 'body');
        hasOnlyKeys(input, ['revision', 'title', 'content', 'html']);
        const revision = revisionField(input.revision), content = stringField(input.content, 'content'), html = stringField(input.html, 'html'), title = stringField(input.title, 'title').trim();
        const latestGrant = ctx.repository.notes.shares.byToken(share.token);
        if (!latestGrant?.canEdit || latestGrant.secret !== share.secret)
            throw new HttpError(403, 'share_readonly', '分享权限已变化，请重新打开');
        if (!content.trim() && !/<img\b/i.test(html))
            throw new HttpError(400, 'empty_note', '请输入正文或保留图片');
        const { title: _title, ...base } = record.note ?? { format: 'note' as const };
        const patched = patchRecord(record, { revision, content: content.trim() ? content : '（图片笔记）', note: { ...base, format: 'note', ...(title ? { title } : {}), html } }, ctx.repository);
        if (!ctx.repository.update(patched.record, patched.expectedRevision))
            throw new HttpError(409, 'revision_conflict', '笔记已被其他人更新，当前草稿仍保留，请重新读取后合并');
        const saved = ctx.repository.findById(record.id);
        if (saved?.kind !== 'note')
            throw new HttpError(404, 'not_found', '笔记已不可用');
        visible = saved;
        ctx.calendarDays.schedule();
        ctx.calendarBackgrounds.changed();
    }
    const assets = Object.fromEntries(visible.assetRefs.filter(ref => ctx.repository.findAssetById(ref.assetId)?.kind === 'photo').map(ref => [ref.assetId, path + '/assets/' + encodeURIComponent(ref.assetId)]));
    setJson(res, 200, { title: visible.note?.title ?? '', html: visible.note?.html ?? null, content: visible.body.edited ?? visible.body.original, source: visible.note?.source ?? '', updatedAt: visible.updatedAt ?? visible.createdAt, revision: visible.revision, canEdit: share.canEdit === true, assets });
    return true;
};
export const handleNoteShareRoutes: RouteHandler = async ({ repository, config }, req, res, pathname) => {
    const match = /^\/api\/notes\/([^/]+)\/share$/.exec(pathname);
    if (!match)
        return false;
    const id = decodeURIComponent(match[1]!), record = repository.findById(id);
    if (record?.kind !== 'note')
        throw new HttpError(404, 'not_found', '笔记不存在');
    const store = repository.notes.shares;
    if (req.method === 'GET') {
        setJson(res, 200, publicView(store.get(id)));
        return true;
    }
    if (req.method === 'DELETE') {
        store.revoke(id);
        setEmpty(res, 204);
        return true;
    }
    if (req.method !== 'POST')
        return false;
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, 8192), 'body');
    hasOnlyKeys(input, ['revision', 'password', 'canEdit']);
    const revision = revisionField(input.revision);
    if (record.revision !== revision)
        throw new HttpError(409, 'revision_conflict', '笔记已变化，请先保存或重新打开');
    let passwordHash = store.get(id)?.passwordHash ?? null;
    if (input.password === null)
        passwordHash = null;
    else if (input.password !== undefined) {
        const password = stringField(input.password, 'password');
        if (password.length < 4 || password.length > 128)
            throw new HttpError(400, 'invalid_password', '访问密码需为 4–128 个字符');
        const salt = randomBytes(16).toString('hex');
        passwordHash = salt + ':' + (await derive(password, salt)).toString('hex');
    }
    if (repository.findById(id)?.revision !== revision)
        throw new HttpError(409, 'revision_conflict', '笔记已变化，请先保存或重新打开');
    const canEdit = input.canEdit === undefined ? store.get(id)?.canEdit === true : booleanField(input.canEdit, 'canEdit');
    setJson(res, 200, publicView(store.save(id, passwordHash, canEdit)));
    return true;
};
