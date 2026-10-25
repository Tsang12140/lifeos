import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_LOCK_IDLE_MS, APP_LOCK_TARGETS, appLockPasswordValid, type AppLockTarget } from '@lifeos/core';
import { HttpError, cookieValue, setJson } from './http-kit.js';
import { readBody, requireJsonContentType } from './http-body.js';
import { jsonObject, hasOnlyKeys, stringField } from './field-validate.js';
import type { AppLockRequest } from './app-lock-context.js';
interface StoredLock { version: 1 | 2; salt: string; hash: string; targets: AppLockTarget[]; }
/**
 * The unlock proof travels in a cookie as well as the header because native media
 * elements cannot send headers. A query grant would work too, but it made every
 * image URL unique per page load, so browsers never reused a thumbnail.
 */
const UNLOCK_COOKIE = 'lifeos_unlock';
const MEDIA_GRANT_PATH = /^\/api\/assets\/[^/]+\/(content|thumbnail|video)/;
export class AppLock {
  readonly file: string;
  readonly #secure: boolean;
  #stored: StoredLock | null = null;
  #sessions = new Map<string, { binding: string; activity: number }>();
  #attempts = new Map<string, { count: number; until: number }>();
  #persist(stored: StoredLock) {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(stored), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file);
    this.#stored = stored;
  }
  constructor(dataDirectory: string, cookieSecure = false) {
    this.file = join(dataDirectory, 'app-lock.json');
    this.#secure = cookieSecure;
    if (existsSync(this.file)) {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as StoredLock;
      if (![1, 2].includes(value.version) || !/^[a-f0-9]{64}$/.test(value.salt) || !/^[a-f0-9]{128}$/.test(value.hash) || !Array.isArray(value.targets) || value.targets.some(t => !APP_LOCK_TARGETS.some(x => x.id === t))) throw new Error('应用锁配置无法读取，请先恢复有效配置');
      this.#stored = value;
    }
  }
  #binding(req: IncomingMessage) { return createHash('sha256').update((req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('lifeos_session=')) ?? 'local').digest('hex'); }
  #mediaGrant(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://local');
    // Native media elements cannot supply headers. Never accept these grants for JSON/write APIs.
    return req.method === 'GET' && MEDIA_GRANT_PATH.test(url.pathname);
  }
  #token(req: IncomingMessage) {
    const v = req.headers['x-lifeos-app-unlock']; if (typeof v === 'string') return v;
    if (!this.#mediaGrant(req)) return '';
    return new URL(req.url ?? '/', 'http://local').searchParams.get('appUnlock') ?? '';
  }
  #unlockCookie(token: string): string {
    return `${UNLOCK_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${this.#secure ? '; Secure' : ''}`;
  }
  #clearUnlockCookie(): string { return this.#unlockCookie('') + '; Max-Age=0'; }
  #sessionValid(token: string, req: IncomingMessage, now: number) {
    if (token === '') return false;
    const session = this.#sessions.get(token);
    if (session === undefined) return false;
    if (session.binding !== this.#binding(req) || now - session.activity >= APP_LOCK_IDLE_MS) { this.#sessions.delete(token); return false; }
    return true;
  }
  /** JSON and write APIs need the in-memory token, which a page reload deliberately forgets. */
  unlocked(req: IncomingMessage, now = Date.now()) { return this.#sessionValid(this.#token(req), req, now); }
  status(req: IncomingMessage) { return { configured: this.#stored !== null, targets: this.#stored?.targets ?? [], idleMs: APP_LOCK_IDLE_MS, unlocked: this.unlocked(req), ...(this.#stored?.version === 1 ? { legacyPassword: true as const } : {}) }; }
  /**
   * Media may also use the HttpOnly cookie: `img` cannot send headers, and the cookie is
   * what lets a thumbnail URL stay byte-identical across reloads. It only ever opens
   * `GET /api/assets/:id/{content,thumbnail,video}`, never JSON or writes.
   */
  policy(req: IncomingMessage): AppLockRequest {
    const now = Date.now();
    const unlocked = this.unlocked(req, now);
    const mediaUnlocked = this.#mediaGrant(req) && this.#sessionValid(cookieValue(req, UNLOCK_COOKIE) ?? '', req, now);
    const proven = unlocked || mediaUnlocked;
    return { protected: (this.#stored?.targets.length ?? 0) > 0, unlocked, mediaUnlocked: proven, ai: (req.url ?? '').startsWith('/api/ai/'), locked: target => this.#stored?.targets.includes(target) === true && !proven };
  }
  #verify(password: string, key: string, now = Date.now()) {
    for (const [id, entry] of this.#attempts) if (entry.until <= now) this.#attempts.delete(id);
    const attempt = this.#attempts.get(key);
    if (attempt && attempt.count >= 5) throw new HttpError(429, 'app_lock_rate_limited', '尝试次数过多，请一分钟后再试');
    if (!this.#stored) return;
    const actual = scryptSync(password, this.#stored.salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(this.#stored.hash, 'hex'))) {
      if (this.#attempts.size >= 512 && !attempt) throw new HttpError(429, 'app_lock_rate_limited', '请稍后再试');
      this.#attempts.set(key, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? now + 60_000 });
      throw new HttpError(403, 'app_lock_password_wrong', '密码不正确');
    }
    this.#attempts.delete(key);
  }
  async handle(req: IncomingMessage, res: ServerResponse, path: string, bodyLimit: number) {
    if (!path.startsWith('/api/app-lock')) return false;
    res.setHeader('cache-control', 'no-store');
    if (path === '/api/app-lock' && req.method === 'GET') { setJson(res, 200, this.status(req)); return true; }
    requireJsonContentType(req);
    const input = jsonObject(await readBody(req, Math.min(bodyLimit, 4096)), 'body');
    const key = req.socket.remoteAddress ?? 'unknown';
    if (path === '/api/app-lock/config' && req.method === 'PUT') {
      hasOnlyKeys(input, ['password', 'newPassword', 'targets']);
      const password = stringField(input.password, 'password');
      // Only the settings migration path accepts an existing legacy password.
      if (this.#stored?.version === 1 ? password.length > 16 : !appLockPasswordValid(password)) throw new HttpError(400, 'invalid_password', '请输入4位数字密码');
      this.#verify(password, key);
      const next = input.newPassword === undefined ? password : stringField(input.newPassword, 'newPassword');
      if (!appLockPasswordValid(next)) throw new HttpError(400, 'invalid_password', '新密码必须是4位数字');
      if (!Array.isArray(input.targets) || input.targets.length > APP_LOCK_TARGETS.length || input.targets.some(t => !APP_LOCK_TARGETS.some(x => x.id === t))) throw new HttpError(400, 'invalid_targets', '保护项目不正确');
      const salt = randomBytes(32).toString('hex');
      const stored: StoredLock = { version: 2, salt, hash: scryptSync(next, salt, 64).toString('hex'), targets: [...new Set(input.targets)] as AppLockTarget[] };
      this.#persist(stored); this.#sessions.clear(); res.setHeader('Set-Cookie', this.#clearUnlockCookie()); setJson(res, 200, this.status(req)); return true;
    }
    if (path === '/api/app-lock/unlock' && req.method === 'POST') {
      hasOnlyKeys(input, ['password']); const password = stringField(input.password, 'password');
      if (!appLockPasswordValid(password)) throw new HttpError(400, 'invalid_password', '请输入4位数字密码');
      this.#verify(password, key);
      if (!this.#stored) throw new HttpError(409, 'app_lock_unconfigured', '请先设置应用锁密码');
      // A successfully verified four-digit legacy password is already a PIN.
      // Upgrade only its format marker; preserve its hash and protection policy.
      if (this.#stored.version === 1) this.#persist({ ...this.#stored, version: 2 });
      const now = Date.now(); for (const [token, s] of this.#sessions) if (now - s.activity >= APP_LOCK_IDLE_MS) this.#sessions.delete(token);
      if (this.#sessions.size >= 256) throw new HttpError(429, 'app_lock_sessions_full', '解锁会话过多，请稍后再试');
      const token = randomBytes(32).toString('base64url'); this.#sessions.set(token, { binding: this.#binding(req), activity: now });
      res.setHeader('Set-Cookie', this.#unlockCookie(token));
      setJson(res, 200, { ...this.status(req), unlocked: true, token }); return true;
    }
    if (path === '/api/app-lock/lock' && req.method === 'POST') {
      hasOnlyKeys(input, []);
      for (const token of [this.#token(req), cookieValue(req, UNLOCK_COOKIE)]) if (token) this.#sessions.delete(token);
      res.setHeader('Set-Cookie', this.#clearUnlockCookie()); setJson(res, 200, this.status(req)); return true;
    }
    if (path === '/api/app-lock/activity' && req.method === 'POST') {
      hasOnlyKeys(input, []);
      if (!this.unlocked(req)) throw new HttpError(423, 'app_locked', '应用已重新上锁');
      this.#sessions.get(this.#token(req))!.activity = Date.now(); setJson(res, 200, this.status(req)); return true;
    }
    throw new HttpError(404, 'not_found', '找不到应用锁操作');
  }
}
