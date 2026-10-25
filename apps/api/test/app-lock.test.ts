import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { APP_LOCK_IDLE_MS, APP_LOCK_TARGETS, appLockPasswordValid, type TimelineRecord } from '@lifeos/core';
import { createHttpServer } from '../src/server.js';
import { readConfig } from '../src/config.js';
import { AppLock } from '../src/app-lock.js';
import type { IncomingMessage } from 'node:http';
import { appLockRepository } from '../src/app-lock-context.js';
import { retrieveJournals } from '../src/journal-retrieval.js';
import { listenOnFetchablePort } from './support/fetchable-port.js';
const record = (id: string, extra: Partial<TimelineRecord> = {}): TimelineRecord => ({ id, kind: 'journal', body: { original: id + '蓝鹭灯塔' }, createdAt: { kind: 'instant', value: '2026-10-01T00:00:00Z' }, entityRefs: [], relatedRecordIds: [], assetRefs: [], aiDerived: [], ...extra } as TimelineRecord);
async function fixture(t: import('node:test').TestContext, legacyPassword?: string) {
  const root = mkdtempSync(join(tmpdir(), 'lifeos-app-lock-'));
  const config = readConfig({ LIFEOS_DATA_DIR: join(root, 'data'), LIFEOS_ASSET_ROOT: join(root, 'assets') });
  if (legacyPassword) {
    mkdirSync(config.dataDirectory, { recursive: true });
    const salt = randomBytes(32).toString('hex');
    writeFileSync(join(config.dataDirectory, 'app-lock.json'), JSON.stringify({ version: 1, salt, hash: scryptSync(legacyPassword, salt, 64).toString('hex'), targets: ['notes'] }));
  }
  const running = createHttpServer(config); await listenOnFetchablePort(running.server);
  t.after(async () => { running.server.closeAllConnections(); await new Promise<void>(resolve => running.server.close(() => resolve())); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const base = 'http://127.0.0.1:' + (running.server.address() as { port: number }).port;
  const get = (path: string, token?: string) => fetch(base + path, { headers: token ? { 'X-LifeOS-App-Unlock': token } : {} });
  const send = (path: string, body: unknown, token?: string, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-LifeOS-App-Unlock': token } : {}) }, body: JSON.stringify(body) });
  const setup = (targets: string[], password = '1234') => send('/api/app-lock/config', { password, targets }, undefined, 'PUT');
  const unlock = async (password = '1234') => { const r = await send('/api/app-lock/unlock', { password }); assert.equal(r.status, 200); return (await r.json() as { token: string }).token; };
  return { ...running, root, config, base, repository: running.app.repository, get, send, setup, unlock };
}
test('app lock password and fixed exclusions', () => {
  for (const value of ['1234', '0000', '0123', '9999']) assert(appLockPasswordValid(value));
  for (const value of ['', '123', '12345', 'aB!2', '1234\n', '123\n', ' 1234', '1234 ', '１２３４', '中文密码', 'abc😀']) assert(!appLockPasswordValid(value));
  assert(!APP_LOCK_TARGETS.some(t => (t.id as string) === 'today' || (t.id as string) === 'settings'));
  assert.equal(APP_LOCK_IDLE_MS, 600000);
});
test('no password/config side effects by default; set stores hash only and rejects forbidden targets', async t => {
  const f = await fixture(t); const s = await (await f.get('/api/app-lock')).json();
  assert.deepEqual(s, { configured: false, targets: [], idleMs: 600000, unlocked: false }); assert(!existsSync(join(f.config.dataDirectory, 'app-lock.json')));
  for (const targets of [['today'], ['settings'], ['unknown']]) assert.equal((await f.setup(targets)).status, 400);
  assert.equal((await f.setup(['notes'], 'abc')).status, 400);
  assert.equal((await f.setup(['notes'])).status, 200);
  const stored = readFileSync(join(f.config.dataDirectory, 'app-lock.json'), 'utf8'); assert(!stored.includes('1234')); assert.equal(JSON.parse(stored).hash.length, 128);
});
test('one shared proof unlocks adjacent modules and both switches, wrong password and edit bypass denied', async t => {
  const f = await fixture(t); await f.setup(APP_LOCK_TARGETS.map(t => t.id));
  assert.equal((await f.get('/api/note-folders')).status, 423);
  assert.equal((await f.send('/api/app-lock/unlock', { password: '0000' })).status, 403);
  const token = await f.unlock();
  for (const path of ['/api/note-folders', '/api/calendar/days?from=2026-10-01&to=2026-10-01', '/api/ai/assistant/history', '/api/modules/cycle-intimacy']) assert.equal((await f.get(path, token)).status, 200, path);
  assert.equal((await f.send('/api/app-lock/config', { password: '0000', targets: [] }, token, 'PUT')).status, 403);
  assert.equal((await f.send('/api/app-lock/config', { password: '1234', newPassword: 'abCD!2', targets: ['notes'] }, token, 'PUT')).status, 400);
  assert.equal((await f.send('/api/app-lock/config', { password: '1234', newPassword: '0123', targets: ['notes'] }, token, 'PUT')).status, 200);
  assert.equal((await f.get('/api/note-folders', token)).status, 423);
  assert.equal((await f.send('/api/app-lock/unlock', { password: '1234' })).status, 403);
  await f.unlock('0123');
});
test('PIN API rejects every non-four-digit shape without truncation and preserves leading zeroes', async t => {
  const f = await fixture(t);
  const invalid = ['123', '12345', 'abcd', '1a23', '1234\n', '１２３４', ' 1234', '1234 '];
  for (const password of invalid) assert.equal((await f.setup(['notes'], password)).status, 400, password);
  await f.setup(['notes'], '0001');
  for (const password of invalid) assert.equal((await f.send('/api/app-lock/unlock', { password })).status, 400, password);
  assert.equal((await f.send('/api/app-lock/unlock', { password: '0000' })).status, 403);
  await f.unlock('0001');
  assert.equal(JSON.parse(readFileSync(join(f.config.dataDirectory, 'app-lock.json'), 'utf8')).version, 2);
});
test('legacy non-PIN hashes migrate only through verified settings; malformed or wrong credentials never rewrite them', async t => {
  const f = await fixture(t, 'Abcd!2');
  const file = join(f.config.dataDirectory, 'app-lock.json'), before = readFileSync(file, 'utf8');
  assert.equal((await (await f.get('/api/app-lock')).json() as { legacyPassword?: true }).legacyPassword, true);
  assert.equal((await f.send('/api/app-lock/unlock', { password: 'Abcd!2' })).status, 400);
  assert.equal((await f.send('/api/app-lock/config', { password: 'wrong', newPassword: '0123', targets: [] }, undefined, 'PUT')).status, 403);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal((await f.send('/api/app-lock/config', { password: 'Abcd!2', newPassword: '12345', targets: [] }, undefined, 'PUT')).status, 400);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal((await f.send('/api/app-lock/config', { password: 'Abcd!2', newPassword: '0123', targets: ['notes'] }, undefined, 'PUT')).status, 200);
  assert.equal((await (await f.get('/api/app-lock')).json() as { legacyPassword?: true }).legacyPassword, undefined);
  assert.equal((await f.get('/api/note-folders')).status, 423);
  await f.unlock('0123');
  const restored = new AppLock(f.config.dataDirectory);
  assert.equal(restored.status({ headers: {}, url: '/api/app-lock' } as IncomingMessage).legacyPassword, undefined);
});
test('existing four-digit legacy passwords upgrade their format only after successful verification', async t => {
  const f = await fixture(t, '0042'), file = join(f.config.dataDirectory, 'app-lock.json');
  const before = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal((await f.send('/api/app-lock/unlock', { password: '0043' })).status, 403);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before);
  const token = await f.unlock('0042');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after, { ...before, version: 2 });
  assert.equal((await (await f.get('/api/app-lock')).json() as { legacyPassword?: true }).legacyPassword, undefined);
  assert.equal((await f.get('/api/note-folders', token)).status, 200);
});
test('search/direct reads/mutations/AI sources cannot bypass locked record modules; diary remains usable', async t => {
  const f = await fixture(t);
  f.repository.insert(record('diary')); f.repository.insert(record('note', { kind: 'note', note: { format: 'note', title: '蓝鹭灯塔笔记' } }));
  f.repository.insert(record('dream', { body: { original: '蓝鹭灯塔梦境', nature: 'dream' } }));
  f.repository.insert(record('task', { kind: 'task', task: { status: 'todo' } }));
  await f.setup(['notes', 'tasks', 'dreams']);
  const result = await (await f.get('/api/records?q=' + encodeURIComponent('蓝鹭灯塔'))).json() as { items: { id: string }[] };
  assert.deepEqual(result.items.map(r => r.id), ['diary']);
  for (const id of ['note', 'task', 'dream']) {
    assert.equal((await f.get('/api/records/' + id)).status, 404);
    assert.equal((await f.get('/api/ai/assistant/sources/' + id)).status, 404);
    assert.equal((await f.send('/api/records/' + id, { content: 'overwrite', revision: 1 }, undefined, 'PATCH')).status, 404);
  }
  assert.equal((await f.get('/api/records/diary')).status, 200);
  assert.equal((await f.get('/api/export?format=json')).status, 423);
  const token = await f.unlock(); assert.equal((await f.get('/api/records/note', token)).status, 200);
  await f.send('/api/app-lock/lock', {}, token); assert.equal((await f.get('/api/records/note', token)).status, 404);
  assert.equal(f.repository.findById('note')?.body.original, 'note蓝鹭灯塔');
});
test('AI repository filtering and merged request challenge happen before provider or durable turn', async t => {
  const f = await fixture(t); f.repository.insert(record('diary')); f.repository.insert(record('note', { kind: 'note', note: { format: 'note' } })); f.repository.insert(record('secret', { isPrivate: true }));
  await f.setup(['notes', 'privacy-ai']);
  const lock = new AppLock(f.config.dataDirectory), req = { url: '/api/ai/backfill/chat', headers: {} } as IncomingMessage;
  const scoped = appLockRepository(f.repository, lock.policy(req));
  const retrieval = await retrieveJournals(f.config, scoped, '找找蓝鹭灯塔笔记', '2026-10-21', undefined, false, true);
  assert.deepEqual(retrieval.candidates, []); assert.equal(scoped.findById('secret'), null);
  const r = await f.send('/api/ai/backfill/chat', { message: '找找私密笔记', conversationId: 'missing', turnId: 'missing' });
  assert.equal(r.status, 423); assert.deepEqual((await r.json() as { details: { targets: string[] } }).details.targets, ['notes', 'privacy-ai']);
  assert.equal(f.repository.assistantCurrentConversation(), null);
  const token = await f.unlock(); const s = await f.get('/api/ai/assistant/sources/secret', token); assert.equal(s.status, 404, 'password proof does not automatically grant private AI permission');
});
test('10 minutes enforced by server, polling never renews, tokens are per page and bound to login', async t => {
  const f = await fixture(t); await f.setup(['notes']);
  const lock = new AppLock(f.config.dataDirectory);
  // Exercise endpoint issuance on the same service using a minimal response sink.
  let result: { token: string } | undefined;
  const { Readable } = await import('node:stream');
  const request = Readable.from([JSON.stringify({ password: '1234' })]) as IncomingMessage;
  Object.assign(request, { headers: { 'content-type': 'application/json', cookie: 'lifeos_session=one' }, socket: { remoteAddress: 'test' }, method: 'POST', url: '/api/app-lock/unlock' });
  const response = { setHeader() {}, writeHead() {}, end(body: string) { result = JSON.parse(body); } } as unknown as import('node:http').ServerResponse;
  await lock.handle(request, response, '/api/app-lock/unlock', 4096);
  const req = { headers: { cookie: 'lifeos_session=one; lifeos_weather_device=other', 'x-lifeos-app-unlock': result!.token }, url: '/api/records' } as unknown as IncomingMessage;
  const now = Date.now(); assert(lock.unlocked(req, now)); assert(lock.unlocked(req, now + 599000)); assert(!lock.unlocked(req, now + 600001));
  assert(!lock.unlocked({ headers: {}, url: '/api/records' } as IncomingMessage));
  const token = await f.unlock(); assert.equal((await f.get('/api/note-folders?appUnlock=' + token)).status, 423, 'JSON does not accept media query grants');
});
test('password brute force is throttled and configuration survives app restart with sessions revoked', async t => {
  const f = await fixture(t); await f.setup(['notes']);
  for (let i = 0; i < 5; i++) assert.equal((await f.send('/api/app-lock/unlock', { password: '0000' })).status, 403);
  assert.equal((await f.send('/api/app-lock/unlock', { password: '1234' })).status, 429);
  const restored = new AppLock(f.config.dataDirectory); const req = { headers: {}, url: '/api/app-lock' } as IncomingMessage;
  assert.deepEqual(restored.status(req).targets, ['notes']); assert(!restored.status(req).unlocked);
});
test('protected image originals and thumbnails require the same page proof; unlocked sessions cache privately and revalidate', async t => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1UAAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(f.base + '/api/assets/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(upload.status, 201); const asset = await upload.json() as { id: string };
  f.repository.insert(record('photo-note', { kind: 'note', note: { format: 'note' }, assetRefs: [{ assetId: asset.id, role: 'photo' }] }));
  await f.setup(['notes']);
  assert.equal((await f.get(`/api/assets/${asset.id}/content`)).status, 404);
  // Native media elements cannot send headers, so the unlock proof must also ride a cookie.
  const unlocked = await f.send('/api/app-lock/unlock', { password: '1234' });
  assert.equal(unlocked.status, 200);
  const token = (await unlocked.json() as { token: string }).token;
  const grant = unlocked.headers.get('set-cookie')!.split(';')[0]!;
  assert.match(grant, /^lifeos_unlock=/);
  const content = await fetch(f.base + `/api/assets/${asset.id}/content`, { headers: { cookie: grant } });
  assert.equal(content.status, 200); assert.equal(content.headers.get('cache-control'), 'private, no-cache');
  const contentTag = content.headers.get('etag')!;
  assert.equal((await fetch(f.base + `/api/assets/${asset.id}/content`, { headers: { cookie: grant, 'if-none-match': contentTag } })).status, 304);
  const thumb = await fetch(f.base + `/api/assets/${asset.id}/thumbnail?w=400`, { headers: { cookie: grant } });
  // A 400 tile of a screenshot re-encodes to WebP instead of shipping the PNG bytes.
  assert.equal(thumb.status, 200); assert.equal(thumb.headers.get('cache-control'), 'private, no-cache'); assert.equal(thumb.headers.get('x-lifeos-asset-source'), 'local-derived');
  const thumbTag = thumb.headers.get('etag')!;
  assert.equal((await fetch(f.base + `/api/assets/${asset.id}/thumbnail?w=400`, { headers: { cookie: grant, 'if-none-match': thumbTag } })).status, 304);
  await f.send('/api/app-lock/lock', {}, token);
  assert.equal((await fetch(f.base + `/api/assets/${asset.id}/content`, { headers: { cookie: grant } })).status, 404);
});
