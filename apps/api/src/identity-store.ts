import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HASH_BYTES = 64;
const MAX_MEMBER_ACCOUNTS = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type AccountRole = "owner" | "member";

export interface AccountIdentity {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly spaceName: string;
  readonly tenantId: string;
  readonly role: AccountRole;
  readonly disabled: boolean;
}

export interface PublicAccount extends Omit<AccountIdentity, "disabled"> {
  readonly disabled: boolean;
  readonly createdAt: string;
}

export interface IdentitySession {
  readonly tokenHash: string;
  readonly account: AccountIdentity;
  readonly expiresAt: number;
}

function scryptKey(value: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(value, salt, HASH_BYTES, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashAccountPassword(value: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await scryptKey(value, salt)).toString("hex")}`;
}

export async function verifyAccountPassword(value: string, stored: string): Promise<boolean> {
  const [algorithm, salt, hash, extra] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !hash || extra !== undefined || !/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(hash)) return false;
  try {
    const actual = await scryptKey(value, salt);
    const expected = Buffer.from(hash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function normalizeAccountUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function assertAccountUsername(value: string): string {
  const username = normalizeAccountUsername(value);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error("账号需为 3–32 位字母、数字、点、下划线或短横线");
  return username;
}

function accountRow(row: Record<string, unknown>): AccountIdentity {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    spaceName: String(row.space_name),
    tenantId: String(row.tenant_id),
    role: row.role === "owner" ? "owner" : "member",
    disabled: row.disabled_at !== null,
  };
}

export class IdentityStore {
  readonly #db: DatabaseSync;
  readonly #dummyPasswordHash: string;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS identity_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY NOT NULL,
        space_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY NOT NULL,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        disabled_at INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS identity_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS identity_sessions_expiry_idx ON identity_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS identity_sessions_account_idx ON identity_sessions(account_id);
    `);
    const master = this.#db.prepare("SELECT value FROM identity_meta WHERE key = 'config_master_secret'").get() as { value?: unknown } | undefined;
    const masterSecret = typeof master?.value === "string" ? master.value : randomBytes(32).toString("base64url");
    if (typeof master?.value !== "string") {
      this.#db.prepare("INSERT OR REPLACE INTO identity_meta (key, value) VALUES ('config_master_secret', ?)").run(masterSecret);
    }
    this.configMasterSecret = masterSecret;
    const dummySalt = randomBytes(16).toString("hex");
    this.#dummyPasswordHash = `scrypt:${dummySalt}:${scryptSync(randomBytes(32), dummySalt, HASH_BYTES, SCRYPT_OPTIONS).toString("hex")}`;
  }

  public readonly configMasterSecret: string;

  public ensureOwner(usernameValue: string, password: string): AccountIdentity {
    const username = assertAccountUsername(usernameValue);
    if (password.length < 10 || password.length > 1024) throw new Error("密码长度需为 10–1024 个字符");
    const existing = this.#db.prepare("SELECT a.id, a.username, a.display_name, t.space_name, a.tenant_id, a.role, a.disabled_at FROM accounts a JOIN tenants t ON t.id = a.tenant_id WHERE a.role = 'owner' LIMIT 1").get() as Record<string, unknown> | undefined;
    if (existing !== undefined) return accountRow(existing);
    const count = this.#db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
    if (count.count !== 0) throw new Error("账户库没有 owner 账号，拒绝继续启动");
    const now = Date.now();
    const tenantId = randomUUID();
    const accountId = randomUUID();
    const salt = randomBytes(16).toString("hex");
    const ownerPasswordHash = `scrypt:${salt}:${scryptSync(password, salt, HASH_BYTES, SCRYPT_OPTIONS).toString("hex")}`;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO tenants (id, space_name, role, created_at) VALUES (?, ?, 'owner', ?)").run(tenantId, "LifeOS 主空间", now);
      this.#db.prepare("INSERT INTO accounts (id, username, display_name, password_hash, tenant_id, role, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(accountId, username, "空间所有者", ownerPasswordHash, tenantId, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { id: accountId, username, displayName: "空间所有者", spaceName: "LifeOS 主空间", tenantId, role: "owner", disabled: false };
  }

  public async authenticate(usernameValue: string, password: string): Promise<AccountIdentity | null> {
    const username = normalizeAccountUsername(usernameValue);
    const validSyntax = /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username);
    const row = validSyntax
      ? this.#db.prepare("SELECT a.id, a.username, a.display_name, a.password_hash, a.tenant_id, a.role, a.disabled_at, t.space_name FROM accounts a JOIN tenants t ON t.id = a.tenant_id WHERE a.username = ? COLLATE NOCASE LIMIT 1").get(username) as Record<string, unknown> | undefined
      : undefined;
    const storedHash = typeof row?.password_hash === "string" ? row.password_hash : this.#dummyPasswordHash;
    const passwordValid = await verifyAccountPassword(password, storedHash);
    if (!passwordValid || row === undefined || row.disabled_at !== null) return null;
    return accountRow(row);
  }

  public createSession(accountId: string, tokenHash: string, expiresAt: number): void {
    const now = Date.now();
    this.#db.prepare("DELETE FROM identity_sessions WHERE expires_at <= ?").run(now);
    const result = this.#db.prepare("INSERT INTO identity_sessions (token_hash, account_id, expires_at, created_at) SELECT ?, id, ?, ? FROM accounts WHERE id = ? AND disabled_at IS NULL").run(tokenHash, expiresAt, now, accountId);
    if (result.changes !== 1) throw new Error("账号已停用");
  }

  public session(tokenHash: string, now = Date.now()): IdentitySession | null {
    const row = this.#db.prepare(`
      SELECT s.token_hash, s.expires_at, a.id, a.username, a.display_name, a.tenant_id,
             a.role, a.disabled_at, t.space_name
      FROM identity_sessions s
      JOIN accounts a ON a.id = s.account_id
      JOIN tenants t ON t.id = a.tenant_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled_at IS NULL
      LIMIT 1
    `).get(tokenHash, now) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return { tokenHash: String(row.token_hash), expiresAt: Number(row.expires_at), account: accountRow(row) };
  }

  public deleteSession(tokenHash: string): void {
    this.#db.prepare("DELETE FROM identity_sessions WHERE token_hash = ?").run(tokenHash);
  }

  public listAccounts(): PublicAccount[] {
    const rows = this.#db.prepare(`
      SELECT a.id, a.username, a.display_name, a.tenant_id, a.role, a.disabled_at,
             a.created_at, t.space_name
      FROM accounts a JOIN tenants t ON t.id = a.tenant_id
      ORDER BY a.role = 'owner' DESC, a.created_at ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({ ...accountRow(row), createdAt: new Date(Number(row.created_at)).toISOString() }));
  }

  public async createAccount(input: { username: string; password: string; displayName: string; spaceName: string }): Promise<PublicAccount> {
    const username = assertAccountUsername(input.username);
    const displayName = input.displayName.trim();
    const spaceName = input.spaceName.trim();
    if (input.password.length < 10 || input.password.length > 1024) throw new Error("密码长度需为 10–1024 个字符");
    if (!displayName || displayName.length > 80) throw new Error("显示名称需为 1–80 个字符");
    if (!spaceName || spaceName.length > 80) throw new Error("空间名称需为 1–80 个字符");
    const id = randomUUID();
    const tenantId = randomUUID();
    const createdAt = Date.now();
    const passwordHash = await hashAccountPassword(input.password);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const count = this.#db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE role = 'member'").get() as { count: number };
      if (count.count >= MAX_MEMBER_ACCOUNTS) throw new Error(`最多可创建 ${MAX_MEMBER_ACCOUNTS} 个独立账号`);
      this.#db.prepare("INSERT INTO tenants (id, space_name, role, created_at) VALUES (?, ?, 'member', ?)").run(tenantId, spaceName, createdAt);
      this.#db.prepare("INSERT INTO accounts (id, username, display_name, password_hash, tenant_id, role, created_at) VALUES (?, ?, ?, ?, ?, 'member', ?)").run(id, username, displayName, passwordHash, tenantId, createdAt);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      if (error instanceof Error && /UNIQUE constraint failed: accounts.username/i.test(error.message)) throw new Error("账号已存在");
      throw error;
    }
    return { id, username, displayName, spaceName, tenantId, role: "member", disabled: false, createdAt: new Date(createdAt).toISOString() };
  }

  public disableAccount(accountId: string): void {
    const account = this.#db.prepare("SELECT role FROM accounts WHERE id = ?").get(accountId) as { role?: unknown } | undefined;
    if (account === undefined) throw new Error("账号不存在");
    if (account.role === "owner") throw new Error("不能停用 owner 账号");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE accounts SET disabled_at = ? WHERE id = ?").run(Date.now(), accountId);
      this.#db.prepare("DELETE FROM identity_sessions WHERE account_id = ?").run(accountId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public async resetAccountPassword(accountId: string, password: string): Promise<void> {
    if (password.length < 10 || password.length > 1024) throw new Error("密码长度需为 10–1024 个字符");
    const account = this.#db.prepare("SELECT role FROM accounts WHERE id = ?").get(accountId) as { role?: unknown } | undefined;
    if (account === undefined) throw new Error("账号不存在");
    if (account.role === "owner") throw new Error("不能从此处重置 owner 密码");
    const passwordHash = await hashAccountPassword(password);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ? AND role <> 'owner'").run(passwordHash, accountId);
      this.#db.prepare("DELETE FROM identity_sessions WHERE account_id = ?").run(accountId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public tokenHash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  public close(): void {
    this.#db.close();
  }
}
