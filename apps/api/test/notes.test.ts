import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import { SqliteRecordRepository } from '../src/repository.js';
import { spaceFingerprint } from '../src/portable-space.js';
import { assertValidNoteDetails, createExportBundle, parseExportJson, serializeExportJson } from '@lifeos/core';
test('note folders preserve hierarchy, CAS, history and portable JSON without mutating legacy notes', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'lifeos-notes-'));
    const { server, app } = createHttpServer(readConfig({ LIFEOS_DATA_DIR: join(root, 'data'), LIFEOS_ASSET_ROOT: join(root, 'assets'), LIFEOS_HOST: '127.0.0.1' }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
    const base = 'http://127.0.0.1:' + (server.address() as {
        port: number;
    }).port;
    const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null }; };
    assert.equal((await call('/api/note-folders')).body.folders.length, 0);
    assert.equal((await call('/api/note-folders', { name: '   ' })).status, 400);
    const parent = (await call('/api/note-folders', { name: '收藏' })).body.folder;
    assert.equal(parent.revision, 1);
    assert.equal((await call('/api/note-folders', { name: '收藏' })).status, 409);
    assert.equal((await call('/api/note-folders', { name: 'x', parentId: 'unknown' })).status, 400);
    const child = (await call('/api/note-folders', { name: '读书', parentId: parent.id })).body.folder;
    assert.equal((await call('/api/note-folders/' + parent.id, { revision: 1, parentId: child.id }, 'PATCH')).status, 400);
    assert.equal((await call('/api/note-folders/' + parent.id + '?revision=1', undefined, 'DELETE')).status, 409);
    assert.equal((await call('/api/note-folders/' + child.id, { revision: 3, name: '其他' }, 'PATCH')).status, 409);
    const moved = (await call('/api/note-folders/' + child.id, { revision: 1, name: '读书摘记' }, 'PATCH')).body.folder;
    assert.equal(moved.revision, 2);
    assert.equal(moved.parentId, parent.id);
    const legacy = (await call('/api/records', { kind: 'note', content: 'legacy quote', note: { format: 'quote', source: '书籍' } })).body;
    assert.deepEqual(legacy.note, { format: 'quote', source: '书籍' });
    assert.equal((await call('/api/records', { kind: 'note', content: 'unknown', note: { format: 'note', folderId: 'unknown' } })).status, 400);
    const created = await call('/api/records', { kind: 'note', content: '正文第一版', note: { format: 'note', title: '我的笔记', source: 'https://example.com', html: '<h2>标题</h2><p><strong>正文第一版</strong></p>', folderId: child.id, starred: true, pinned: true } });
    assert.equal(created.status, 201);
    const note = created.body;
    assert.equal((await call('/api/note-folders/' + child.id + '?revision=2', undefined, 'DELETE')).status, 409);
    assert.equal((await call('/api/records/' + note.id, { revision: note.revision, note: { ...note.note, folderId: 'unknown' } }, 'PATCH')).status, 400);
    const updated = await call('/api/records/' + note.id, { revision: note.revision, content: '正文第二版', note: { ...note.note, html: '<p>正文第二版</p>' } }, 'PATCH');
    assert.equal(updated.status, 200);
    assert.equal(updated.body.body.original, '正文第一版');
    assert.equal(updated.body.body.edited, '正文第二版');
    assert.equal((await call('/api/records/' + note.id, { revision: note.revision, content: 'stale' }, 'PATCH')).status, 409);
    const history = (await call('/api/notes/' + note.id + '/versions')).body.versions;
    assert.equal(history.length, 1);
    assert.equal(history[0].record.note.html, note.note.html);
    const data = app.repository.exportData();
    const bundle = parseExportJson(serializeExportJson(createExportBundle({ exportedAt: { kind: 'instant', value: new Date().toISOString() }, ...data })));
    const target = new SqliteRecordRepository(join(root, 'target.sqlite'));
    try {
        target.importData(bundle);
        assert.equal(target.notes.list().length, 2);
        const read = target.findById(note.id), old = target.findById(legacy.id);
        assert.deepEqual(read?.kind === 'note' && read.note, updated.body.note);
        assert.deepEqual(old?.kind === 'note' && old.note, legacy.note);
    }
    finally {
        target.close();
    }
    const before = app.repository.portableSpace();
    assert.equal(before.note_versions.rows.length, 1);
    const archiveTarget = new SqliteRecordRepository(join(root, 'archive.sqlite'));
    try {
        archiveTarget.restorePortableSpace(before, spaceFingerprint(archiveTarget.portableSpace()));
        assert.equal(archiveTarget.notes.versions(note.id).length, 1);
        assert.equal(archiveTarget.notes.list().length, 2);
        const { note_folders: _folders, note_versions: _versions, ...old } = before;
        // A true pre-folder archive contains legacy note metadata only.
        const rows = old.records.rows.map(row => row.map((cell, index) => index === old.records.columns.indexOf('note_json') && cell ? JSON.stringify({ format: 'fragment' }) : cell));
        archiveTarget.restorePortableSpace({ ...old, records: { ...old.records, rows } } as unknown as typeof before, spaceFingerprint(archiveTarget.portableSpace()));
        assert.equal(archiveTarget.notes.list().length, 0);
        assert.equal(archiveTarget.notes.versions(note.id).length, 0);
    }
    finally {
        archiveTarget.close();
    }
    const unfoldered = { ...updated.body.note };
    delete unfoldered.folderId;
    assert.equal((await call('/api/records/' + note.id, { revision: updated.body.revision, note: unfoldered }, 'PATCH')).status, 200);
    assert.equal((await call('/api/note-folders/' + child.id + '?revision=2', undefined, 'DELETE')).status, 204);
    assert.equal((await call('/api/note-folders/' + parent.id + '?revision=1', undefined, 'DELETE')).status, 204);
});
test('unified notes validate unsafe metadata shapes and export folder cycles atomically', () => {
    assertValidNoteDetails({ format: 'note', title: '随笔', source: '出处', html: '<p>原始富文本</p>', starred: true, pinned: false });
    for (const note of [{ format: 'note', folderId: '' }, { format: 'note', starred: 1 }, { format: 'note', html: 12 }, { format: 'note', html: 'x'.repeat(2000001) }, { format: 'note', unsupported: true }])
        assert.throws(() => assertValidNoteDetails(note));
    const repository = new SqliteRecordRepository(':memory:');
    const now = new Date().toISOString();
    try {
        assert.throws(() => repository.importData({ records: [], entities: [], assets: [], modules: { notes: { folders: [{ id: 'a', name: 'A', parentId: 'b', revision: 1, createdAt: now, updatedAt: now }, { id: 'b', name: 'B', parentId: 'a', revision: 1, createdAt: now, updatedAt: now }] } } }));
        assert.deepEqual(repository.notes.list(), []);
    }
    finally {
        repository.close();
    }
});
test('folders and rich note history stay inside their authenticated account', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'lifeos-notes-accounts-'));
    const { server } = createHttpServer(readConfig({ LIFEOS_HOST: '127.0.0.1', LIFEOS_DATA_DIR: root, LIFEOS_ASSET_ROOT: join(root, 'assets'), LIFEOS_PASSWORD: 'isolated-owner-password', LIFEOS_OWNER_USERNAME: 'owner', LIFEOS_ACCOUNT_MODE: '1', LIFEOS_ALLOWED_ORIGINS: 'https://example.invalid', LIFEOS_COOKIE_SECURE: 'true' }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
    const base = 'http://127.0.0.1:' + (server.address() as {
        port: number;
    }).port;
    const call = async (path: string, body?: unknown, cookie = '', method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]! }; };
    assert.equal((await call('/api/note-folders')).status, 401);
    const owner = await call('/api/auth/login', { username: 'owner', password: 'isolated-owner-password' });
    assert.equal(owner.status, 200);
    assert.equal((await call('/api/admin/accounts', { username: 'member', password: 'isolated-member-password', displayName: 'Member', spaceName: 'Member' }, owner.cookie)).status, 201);
    const member = await call('/api/auth/login', { username: 'member', password: 'isolated-member-password' });
    assert.equal(member.status, 200);
    const folder = (await call('/api/note-folders', { name: 'OWNER_PRIVATE_FOLDER' }, owner.cookie)).body.folder;
    const note = (await call('/api/records', { kind: 'note', content: 'OWNER_PRIVATE_CONTENT', note: { format: 'note', folderId: folder.id, html: '<p>owner HTML</p>' } }, owner.cookie)).body;
    assert.equal((await call('/api/records/' + note.id, { revision: note.revision, content: 'OWNER_CHANGED' }, owner.cookie, 'PATCH')).status, 200);
    assert.deepEqual((await call('/api/note-folders', undefined, member.cookie)).body.folders, []);
    assert.equal((await call('/api/note-folders/' + folder.id, { revision: 1, name: 'attack' }, member.cookie, 'PATCH')).status, 404);
    assert.equal((await call('/api/notes/' + note.id + '/versions', undefined, member.cookie)).status, 404);
    assert.equal((await call('/api/records', { kind: 'note', content: 'member', note: { format: 'note', folderId: folder.id } }, member.cookie)).status, 400);
    const ownerHistory = await call('/api/notes/' + note.id + '/versions', undefined, owner.cookie);
    assert.equal(ownerHistory.body.versions.length, 1);
    const share = await call('/api/notes/' + note.id + '/share', { revision: 2, password: null }, owner.cookie);
    assert.equal(share.status, 200);
    const publicPath = '/api/public/notes/' + owner.body.account.tenantId + '/' + share.body.token;
    assert.equal((await call(publicPath)).status, 200);
    assert.equal((await call('/api/notes/' + note.id + '/share', undefined, member.cookie)).status, 404);
    assert.equal((await call('/api/public/notes/' + member.body.account.tenantId + '/' + share.body.token)).status, 404);
    assert.equal((await call('/api/note-folders')).status, 401, 'public reading never authenticates a visitor');
});
test('note shares enforce passwords, linked-image access, revocation and failed-attempt limits', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'lifeos-note-shares-'));
    const { server, app } = createHttpServer(readConfig({ LIFEOS_DATA_DIR: join(root, 'data'), LIFEOS_ASSET_ROOT: join(root, 'assets'), LIFEOS_HOST: '127.0.0.1', LIFEOS_PASSWORD: 'owner-secret' }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
    const base = 'http://127.0.0.1:' + (server.address() as {
        port: number;
    }).port;
    const call = async (path: string, body?: unknown, cookie = '', method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]!, headers: response.headers }; };
    const owner = (await call('/api/auth/login', { password: 'owner-secret' })).cookie;
    const upload = await fetch(base + '/api/assets/uploads?name=share.png', { method: 'POST', headers: { cookie: owner, 'content-type': 'image/png' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    assert.equal(upload.status, 201);
    const asset = await upload.json() as {
        id: string;
    };
    const note = (await call('/api/records', { kind: 'note', content: 'PRIVATE_SHARED_CONTENT', isPrivate: true, note: { format: 'note', title: '分享标题', html: '<p>分享正文</p><img src="/api/assets/' + asset.id + '/content">' }, assetRefs: [{ assetId: asset.id, role: 'photo' }] }, owner)).body;
    const endpoint = '/api/notes/' + note.id + '/share';
    assert.equal((await call(endpoint)).status, 401);
    assert.equal((await call(endpoint, { revision: 2 }, owner)).status, 409);
    const created = await call(endpoint, { revision: note.revision, password: 'share-password' }, owner);
    assert.equal(created.status, 200);
    assert.equal(created.body.protected, true);
    assert.ok(!JSON.stringify(created.body).includes('secret'));
    assert.ok(!JSON.stringify(created.body).includes('passwordHash'));
    const publicPath = '/api/public/notes/local/' + created.body.token;
    const locked = await call(publicPath);
    assert.equal(locked.status, 401);
    assert.ok(!JSON.stringify(locked.body).includes('PRIVATE_SHARED_CONTENT'));
    assert.equal((await call(publicPath + '/unlock', { password: 'wrong' })).status, 401);
    const unlocked = await call(publicPath + '/unlock', { password: 'share-password' });
    assert.equal(unlocked.status, 200);
    assert.match(unlocked.headers.get('set-cookie')!, /HttpOnly/);
    const visible = await call(publicPath, undefined, unlocked.cookie);
    assert.equal(visible.status, 200);
    assert.equal(visible.body.title, '分享标题');
    assert.ok(!('entityRefs' in visible.body));
    assert.ok(!('recordId' in visible.body));
    const image = await fetch(base + publicPath + '/assets/' + asset.id, { headers: { cookie: unlocked.cookie } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.ok((await image.arrayBuffer()).byteLength > 0);
    assert.equal((await call(publicPath + '/assets/another-asset', undefined, unlocked.cookie)).status, 404);
    assert.equal((await call(publicPath, { content: 'overwrite' }, unlocked.cookie)).status, 405);
    assert.equal((await call(publicPath,{revision:note.revision,title:'guest',html:'<p>guest</p>',content:'guest'},unlocked.cookie,'PUT')).status,403);
    assert.equal((await call(endpoint,{revision:note.revision,canEdit:true},owner)).status,200);
    const edited=await call(publicPath,{revision:note.revision,title:'访客修改',html:'<p>访客修改正文</p>',content:'访客修改正文'},unlocked.cookie,'PUT');assert.equal(edited.status,200);assert.equal(edited.body.canEdit,true);
    assert.equal((await call(publicPath,{revision:note.revision,title:'stale',html:'<p>stale</p>',content:'stale'},unlocked.cookie,'PUT')).status,409);
    note.revision=edited.body.revision;
    assert.equal(app.repository.findById(note.id)?.isPrivate,true);assert.equal(app.repository.notes.versions(note.id).length,1);
    assert.equal((await call(endpoint,{revision:note.revision,canEdit:false},owner)).status,200);
    assert.equal((await call(publicPath,{revision:note.revision,title:'guest',html:'<p>guest</p>',content:'guest'},unlocked.cookie,'PUT')).status,403);
    const changed = await call(endpoint, { revision: note.revision, password: 'new-password' }, owner);
    assert.equal(changed.status, 200);
    assert.equal((await call(publicPath, undefined, unlocked.cookie)).status, 401, 'password rotation invalidates previous reader cookies');
    assert.equal((await call(endpoint, undefined, owner, 'DELETE')).status, 204);
    assert.equal((await call(publicPath, undefined, unlocked.cookie)).status, 404);
    const reopened = await call(endpoint, { revision: note.revision, password: 'new-password' }, owner);
    assert.notEqual(reopened.body.token, created.body.token);
    const second = '/api/public/notes/local/' + reopened.body.token;
    for (let attempt = 0; attempt < 5; attempt++)
        assert.equal((await call(second + '/unlock', { password: 'bad' })).status, 401);
    assert.equal((await call(second + '/unlock', { password: 'bad' })).status, 429);
    const portable = app.repository.portableSpace();
    assert.ok(app.repository.notes.shares.get(note.id));
    app.repository.restorePortableSpace(portable, spaceFingerprint(portable));
    assert.equal(app.repository.notes.shares.get(note.id), null, 'replacing content revokes old access grants');
});
