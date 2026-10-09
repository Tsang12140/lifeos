import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, createReadStream } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { assertValidAsset, type Asset } from "@lifeos/core";
import { readSpaceTables, spaceFingerprint, type SpaceTables } from "./portable-space.js";
import { resolveLocalAsset, ASSET_MEDIA_TYPES } from "./asset-static.js";
import { trashPathFor } from "./asset-gc.js";
import { StoragePoolError, type PoolConsumerBridge } from "./storage-pool.js";
import type { StoragePoolStore } from "./storage-pool-store.js";

export interface TransitionSpace { readonly accountId: string; readonly databasePath: string; readonly assetRoot?: string }
type State = "queued" | "uploading" | "verifying" | "verified" | "failed" | "pending";
type Job = { id: string; account_id: string; asset_id: string; kind: "asset" | "database"; source_path: string; source_fingerprint: string;
  bytes: number; sha256: string | null; object_key: string | null; attempt_id: string | null; state: State; error: string | null; media_type: string };
const within = (root: string, path: string) => { const r = relative(root, path); return r !== "" && !isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\"); };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}
function fileStamp(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("source_invalid");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export function decryptTransitionSnapshot(body: Buffer, accountId: string, stableMasterSecret: string): SpaceTables {
  const header = Buffer.from("LIFEOS-POOL-SPACE-1\n");
  if (body.length < header.length + 28 || !body.subarray(0,header.length).equals(header)) throw new Error("Invalid pool snapshot");
  const key = createHmac("sha256", stableMasterSecret).update(`lifeos:pool-snapshot:v1:${accountId}`).digest();
  const decipher = createDecipheriv("aes-256-gcm",key,body.subarray(header.length,header.length+12));
  decipher.setAAD(header); decipher.setAuthTag(body.subarray(-16));
  const value = JSON.parse(Buffer.concat([decipher.update(body.subarray(header.length+12,-16)),decipher.final()]).toString("utf8"));
  if (value.format !== "lifeos-pool-space-v1" || value.accountId !== accountId) throw new Error("Invalid pool snapshot identity");
  return value.tables as SpaceTables;
}

/** First migration stage. Old references/read paths are never replaced; no old or remote objects are deleted. */
export class PoolTransition {
  readonly #db: DatabaseSync;
  readonly #privateRoot: string;
  readonly #bridge: PoolConsumerBridge;
  readonly #store: StoragePoolStore;
  readonly #spaces: () => readonly TransitionSpace[];
  readonly #secret: string;
  readonly #timer: ReturnType<typeof setInterval>;
  #busy = false;
  #closed = false;
  #scanError: string | null = null;

  public constructor(dataDirectory: string, bridge: PoolConsumerBridge, store: StoragePoolStore,
    spaces: () => readonly TransitionSpace[], stableMasterSecret: string, localPrimaryAtBoot = false) {
    this.#privateRoot = resolve(dataDirectory, "pool-transition");
    if (existsSync(this.#privateRoot) && lstatSync(this.#privateRoot).isSymbolicLink()) throw new Error("Transition directory must not be symlinked");
    mkdirSync(this.#privateRoot, { recursive: true, mode: 0o700 });
    if (!within(realpathSync(dataDirectory), realpathSync(this.#privateRoot))) throw new Error("Unsafe transition directory");
    const path = join(this.#privateRoot, "jobs.sqlite");
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Transition ledger must not be symlinked");
    this.#db = new DatabaseSync(path, { timeout: 10000 });
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, local_primary INTEGER NOT NULL DEFAULT 0, account_ids_json TEXT);
      INSERT OR IGNORE INTO settings(id,enabled) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, asset_id TEXT NOT NULL,
        kind TEXT NOT NULL, source_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL,
        sha256 TEXT, object_key TEXT, attempt_id TEXT, state TEXT NOT NULL, error TEXT, media_type TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      UPDATE jobs SET state='pending', error='interrupted_upload' WHERE state='uploading';
      UPDATE jobs SET state='failed', error='interrupted_verification' WHERE state='verifying';`);
    if (!this.#db.prepare("PRAGMA table_info(settings)").all().some(column => column.name === "account_ids_json")) {
      this.#db.exec("ALTER TABLE settings ADD COLUMN account_ids_json TEXT");
    }
    // Deployment can protect local writes before connectivity/quotas are configured.
    // Removing the flag or pausing must never undo this persisted protection.
    if (localPrimaryAtBoot) this.#db.exec("UPDATE settings SET local_primary=1 WHERE id=1");
    this.#bridge = bridge; this.#store = store; this.#spaces = spaces; this.#secret = stableMasterSecret;
    this.#timer = setInterval(() => this.wake(), 60000); this.#timer.unref();
  }

  public get enabled(): boolean { return !this.#closed && Number(this.#db.prepare("SELECT enabled FROM settings WHERE id=1").get()!.enabled) === 1; }
  public get localPrimary(): boolean { return !this.#closed && Number(this.#db.prepare("SELECT local_primary FROM settings WHERE id=1").get()!.local_primary) === 1; }
  public get accountIds(): readonly string[] | null {
    const value = this.#db.prepare("SELECT account_ids_json FROM settings WHERE id=1").get()!.account_ids_json;
    if (value === null) return null;
    const ids: unknown = JSON.parse(String(value));
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string")) throw new Error("Invalid transition account scope");
    return ids as string[];
  }
  #jobScope(): { sql: string; ids: readonly string[] } {
    const ids = this.accountIds;
    return ids === null ? { sql: "", ids: [] } : { sql: ` AND account_id IN (${ids.map(() => "?").join(",")})`, ids };
  }
  #activeSpaces(): readonly TransitionSpace[] {
    const ids = this.accountIds;
    return this.#spaces().filter(space => ids === null || ids.includes(space.accountId));
  }
  public setEnabled(enabled: boolean, accountIds?: readonly string[] | null): void {
    if (accountIds !== undefined && accountIds !== null) {
      const known = new Set(this.#spaces().map(space => space.accountId));
      if (accountIds.length === 0 || accountIds.length > 1000 || new Set(accountIds).size !== accountIds.length || accountIds.some(id => !known.has(id))) throw new Error("Invalid transition account scope");
    }
    // Scope selection and activation are one persisted operation; resume without a scope preserves it.
    const serialized = accountIds === null ? null : accountIds === undefined ? undefined : JSON.stringify([...accountIds].sort());
    if (serialized === undefined) {
      this.#db.prepare("UPDATE settings SET enabled=?,local_primary=max(local_primary,?) WHERE id=1").run(enabled ? 1 : 0, enabled ? 1 : 0);
    } else {
      this.#db.prepare("UPDATE settings SET enabled=?,local_primary=max(local_primary,?),account_ids_json=? WHERE id=1").run(enabled ? 1 : 0, enabled ? 1 : 0,serialized);
    }
    if (enabled) this.wake();
  }
  public snapshot() {
    const scope = this.#jobScope();
    const counts = Object.fromEntries(["queued", "uploading", "verifying", "verified", "failed", "pending"].map(state => [state, Number(this.#db.prepare("SELECT count(*) AS n FROM jobs WHERE state=?"+scope.sql).get(state,...scope.ids)!.n)]));
    const totals = this.#db.prepare("SELECT count(*) AS total, coalesce(sum(CASE WHEN state='verified' THEN bytes ELSE 0 END),0) AS verified_bytes FROM jobs WHERE 1"+scope.sql).get(...scope.ids)!;
    return { enabled: this.enabled, localPrimary: this.localPrimary, accountIds: this.accountIds, busy: this.#busy, stage: "copy_only" as const, counts, total: Number(totals.total), verifiedBytes: Number(totals.verified_bytes),
      scanError: this.#scanError, databaseEncryption: "server-master-key" as const,
      issues: this.#db.prepare("SELECT account_id AS accountId, asset_id AS assetId, kind, state, error FROM jobs WHERE state IN ('failed','pending')"+scope.sql+" ORDER BY updated_at DESC LIMIT 100").all(...scope.ids) };
  }
  public retry(): void {
    // A possibly committed upload must never be blindly uploaded again.
    const scope = this.#jobScope();
    this.#db.prepare("UPDATE jobs SET state='queued',error=NULL WHERE state='failed'"+scope.sql).run(...scope.ids);
    this.wake();
  }
  public wake(): void {
    if (this.#closed || this.#busy || !this.enabled) return;
    this.#busy = true;
    void this.#run().catch(() => { if (!this.#closed) this.#scanError = "scan_failed"; }).finally(() => {
      this.#busy = false;
      if (this.#closed) this.#db.close();
    });
  }
  public close(): void {
    if (this.#closed) return;
    this.#closed = true; clearInterval(this.#timer);
    if (!this.#busy) this.#db.close();
  }

  #add(job: Omit<Job, "sha256" | "object_key" | "attempt_id" | "state" | "error">, error?: string): void {
    this.#db.prepare(`INSERT OR IGNORE INTO jobs(id,account_id,asset_id,kind,source_path,source_fingerprint,bytes,state,error,media_type,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id,job.account_id,job.asset_id,job.kind,job.source_path,job.source_fingerprint,job.bytes,error ? "failed" : "queued",error ?? null,job.media_type,Date.now(),Date.now());
  }
  #scan(): void {
    this.#scanError = null;
    for (const space of this.#activeSpaces()) {
      if (!existsSync(space.databasePath)) continue;
      if (lstatSync(space.databasePath).isSymbolicLink()) { this.#scanError = "database_symlink"; continue; }
      const db = new DatabaseSync(space.databasePath, { readOnly: true, timeout: 5000 });
      try {
        const data = readSpaceTables(db);
        const fingerprint = spaceFingerprint(data);
        const id = hash(`${space.accountId}:database:${fingerprint}`);
        // At most one automatic business snapshot per space per 24h. Files are still scanned each pass.
        const recent = this.#db.prepare("SELECT id FROM jobs WHERE account_id=? AND kind='database' AND created_at>? LIMIT 1").get(space.accountId,Date.now()-86400000);
        if (!recent && !this.#db.prepare("SELECT id FROM jobs WHERE id=?").get(id)) {
          // Only business tables, including private/deleted content. No credentials, identity or ledgers.
          const plain = Buffer.from(JSON.stringify({ format: "lifeos-pool-space-v1", accountId: space.accountId, tables: data }));
          const key = createHmac("sha256", this.#secret).update(`lifeos:pool-snapshot:v1:${space.accountId}`).digest();
          const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
          const header = Buffer.from("LIFEOS-POOL-SPACE-1\n"); cipher.setAAD(header);
          const body = Buffer.concat([header, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
          const path = join(this.#privateRoot, id + ".space.enc");
          if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Snapshot symlink refused");
          if (!existsSync(path)) writeFileSync(path, body, { flag: "wx", mode: 0o600 });
          if (spaceFingerprint(decryptTransitionSnapshot(readFileSync(path),space.accountId,this.#secret)) !== fingerprint) throw new Error("Snapshot staging mismatch");
          this.#add({ id, account_id: space.accountId, asset_id: `database:${fingerprint}`, kind: "database", source_path: path,
            source_fingerprint: fileStamp(path), bytes: statSync(path).size, media_type: "application/octet-stream" });
        }
        const assetEntries = [
          ...data.assets.rows.map(row => ({ json: row[data.assets.columns.indexOf("value_json")], trash: false })),
          ...data.asset_trash.rows.filter(row => row[data.asset_trash.columns.indexOf("restored_at")] === null && row[data.asset_trash.columns.indexOf("purged_at")] === null)
            .map(row => ({ json: row[data.asset_trash.columns.indexOf("asset_json")], trash: true })),
        ];
        for (const entry of assetEntries) {
          const asset = JSON.parse(String(entry.json)) as Asset; assertValidAsset(asset);
          for (const ref of asset.storageRefs) {
            if (ref.sourceId === "lifeos-pool") continue;
            let path = "", stamp = "unresolved", bytes = 0, error: string | undefined;
            try {
              if (ref.sourceId !== "local") throw new Error("external_source_not_migrated");
              if (!space.assetRoot) throw new Error("asset_root_missing");
              const source = entry.trash ? trashPathFor(ref.sourceRef) : ref.sourceRef;
              if (!source) throw new Error("invalid_trash_reference");
              path = resolveLocalAsset(space.assetRoot, source).file;
              if (lstatSync(path).isSymbolicLink()) throw new Error("source_symlink");
              stamp = fileStamp(path); bytes = statSync(path).size;
              if (asset.sizeBytes !== undefined && asset.sizeBytes !== bytes) throw new Error("source_size_mismatch");
            } catch { error = ref.sourceId === "local" ? "local_source_unavailable" : "external_source_not_migrated"; }
            const sourceFingerprint = JSON.stringify({ stamp, reference: ref, trash: entry.trash });
            const jobId = hash(`${space.accountId}:${asset.id}:${sourceFingerprint}`);
            this.#add({ id: jobId, account_id: space.accountId, asset_id: asset.id, kind: "asset", source_path: path,
              source_fingerprint: sourceFingerprint, bytes, media_type: asset.mediaType ?? ref.mediaType ?? ASSET_MEDIA_TYPES[path.split(".").pop() ? "." + path.split(".").pop() : ""] ?? "application/octet-stream" },error);
          }
        }
      } catch { this.#scanError = "space_scan_failed"; }
      finally { db.close(); }
    }
  }
  #state(id: string, state: State, error: string | null = null): void {
    this.#db.prepare("UPDATE jobs SET state=?,error=?,updated_at=? WHERE id=?").run(state,error,Date.now(),id);
  }
  async #run(): Promise<void> {
    this.#scan();
    // Sequential and bounded. Remaining work continues on the next wake/restart.
    const scope = this.#jobScope();
    const jobs = this.#db.prepare("SELECT * FROM jobs WHERE state='queued'"+scope.sql+" ORDER BY created_at,id LIMIT 20").all(...scope.ids) as unknown as Job[];
    for (const job of jobs) {
      if (this.#closed || !this.enabled) return;
      if (this.accountIds !== null && !this.accountIds.includes(job.account_id)) continue;
      let dir: string | undefined, uploadAttempt: string | undefined, downloadId: string | undefined;
      try {
        const current = this.#spaces().find(space => space.accountId === job.account_id);
        if (!current) throw new Error("account_no_longer_exists");
        const root = job.kind === "database" ? this.#privateRoot : current.assetRoot;
        if (!root || !within(realpathSync(root), realpathSync(job.source_path))) throw new Error("unsafe_source_path");
        const expected = job.kind === "asset" ? JSON.parse(job.source_fingerprint).stamp as string : job.source_fingerprint;
        if (fileStamp(job.source_path) !== expected) throw new Error("source_changed");
        dir = mkdtempSync(join(tmpdir(), "lifeos-pool-copy-"));
        const staged = join(dir,"source.bin"), downloaded = join(dir,"readback.bin");
        copyFileSync(job.source_path,staged);
        if (fileStamp(job.source_path) !== expected || statSync(staged).size !== job.bytes) throw new Error("source_changed");
        const sha256 = await fileHash(staged);
        if (this.#closed) return;
        if (job.kind === "asset") {
          const expectedHash = JSON.parse(job.source_fingerprint).reference.contentHash;
          if (expectedHash?.algorithm === "sha256" && expectedHash.value !== sha256) throw new Error("source_hash_mismatch");
        }
        this.#db.prepare("UPDATE jobs SET sha256=? WHERE id=?").run(sha256,job.id);
        let key = job.object_key;
        const ledgerAsset = `transition:${job.id}`;
        if (!key) {
          const usage = await this.#bridge.usage(); if (this.#closed) return;
          uploadAttempt = this.#store.reserveUpload(job.account_id,ledgerAsset,job.bytes,usage.storage_free);
          this.#db.prepare("UPDATE jobs SET state='uploading',attempt_id=? WHERE id=?").run(uploadAttempt,job.id);
          const uploaded = await this.#bridge.putFile(staged,job.kind === "database" ? "space.enc" : "original",job.media_type);
          if (this.#closed) return;
          key = uploaded.key;
          this.#db.prepare("UPDATE jobs SET object_key=? WHERE id=?").run(key,job.id);
          this.#store.keepPendingUpload(uploadAttempt,key);
          this.#store.completeUpload(uploadAttempt,key);
        }
        this.#state(job.id,"verifying");
        const usage = await this.#bridge.usage(); if (this.#closed) return;
        const reservation = this.#store.reserveDownload(job.account_id,ledgerAsset,key,usage.traffic_month,usage.traffic_free);
        downloadId = reservation.id;
        const result = await this.#bridge.downloadToFile(key,downloaded);
        if (this.#closed) return;
        this.#store.finishDownload(downloadId,result.month,result.bytes); downloadId = undefined;
        if (result.bytes !== job.bytes || await fileHash(downloaded) !== sha256) throw new Error("readback_mismatch");
        if (this.#closed) return;
        if (fileStamp(job.source_path) !== expected) throw new Error("source_changed_after_upload");
        this.#state(job.id,"verified");
      } catch (error) {
        if (this.#closed) return;
        if (downloadId) {
          if (error instanceof StoragePoolError && !error.uncertain) this.#store.refundDownload(downloadId);
          else this.#store.markDownloadUncertain(downloadId);
        }
        const updated = this.#db.prepare("SELECT object_key FROM jobs WHERE id=?").get(job.id);
        const knownKey = updated?.object_key;
        if (typeof knownKey === "string" && this.#store.poolObject(job.account_id,`transition:${job.id}`,knownKey)?.state !== "ready") {
          this.#state(job.id,"pending","upload_needs_reconciliation"); continue;
        }
        if (uploadAttempt && !knownKey) {
          if (error instanceof StoragePoolError && !error.uncertain) this.#store.releaseUploadReservation(uploadAttempt);
          else {
            this.#store.keepPendingUpload(uploadAttempt,error instanceof StoragePoolError ? error.pendingKey : undefined);
            this.#state(job.id,"pending","upload_needs_reconciliation"); continue;
          }
        }
        const reason = error instanceof StoragePoolError ? error.code : error instanceof Error && error.message.includes("额度不足") ? "quota_exceeded"
          : error instanceof Error && ["source_changed","source_changed_after_upload","source_hash_mismatch","unsafe_source_path","account_no_longer_exists","readback_mismatch"].includes(error.message) ? error.message : "copy_failed";
        this.#state(job.id,"failed",reason);
      } finally { if (dir) rmSync(dir,{ recursive: true,force: true }); }
    }
  }
}
