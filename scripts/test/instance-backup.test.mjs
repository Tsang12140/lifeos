import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupInstance, restoreInstanceBackup, verifyInstanceBackup } from "../lib/instance-backup.mjs";

const TENANT = "11111111-1111-4111-8111-111111111111";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-instance-backup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(join(source, "tenants", TENANT, "assets"), { recursive: true });
  const owner = new DatabaseSync(join(source, "lifeos.sqlite"));
  owner.exec("CREATE TABLE record_probe (value TEXT); INSERT INTO record_probe VALUES ('owner-data');");
  owner.close();
  const tenant = new DatabaseSync(join(source, "tenants", TENANT, "lifeos.sqlite"));
  tenant.exec("CREATE TABLE record_probe (value TEXT); INSERT INTO record_probe VALUES ('member-data');");
  tenant.close();
  const identity = new DatabaseSync(join(source, "identity.sqlite"));
  identity.exec(`
    CREATE TABLE identity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (tenant_id TEXT, role TEXT);
    INSERT INTO identity_meta VALUES ('config_master_secret', 'isolated-test-master-secret-1234567890');
    INSERT INTO accounts VALUES ('owner', 'owner');
    INSERT INTO accounts VALUES ('${TENANT}', 'member');
  `);
  identity.close();
  writeFileSync(join(source, "tenants", TENANT, "assets", "photo.bin"), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(source, "tenants", TENANT, "ai-config.json"), '{"ciphertext":"isolated"}');
  return { root, source, snapshot: join(root, "snapshot"), restored: join(root, "restored") };
}

test("offline whole-instance backup verifies and restores identity, tenants, assets and config", async (t) => {
  const { source, snapshot, restored } = fixture(t);
  const made = await backupInstance({ source, output: snapshot, accountMode: true, assetRoot: join(source, "tenants", TENANT, "assets"), offlineConfirmed: true });
  assert.equal(made.accountMode, true);
  assert.equal(made.fileCount, 5);
  assert.equal((await verifyInstanceBackup(snapshot)).fileCount, 5);
  assert.equal((await restoreInstanceBackup({ snapshot, target: restored })).fileCount, 5);
  const identity = new DatabaseSync(join(restored, "identity.sqlite"), { readOnly: true });
  assert.equal(identity.prepare("SELECT value FROM identity_meta WHERE key = 'config_master_secret'").get().value, "isolated-test-master-secret-1234567890");
  identity.close();
  const tenant = new DatabaseSync(join(restored, "tenants", TENANT, "lifeos.sqlite"), { readOnly: true });
  assert.equal(tenant.prepare("SELECT value FROM record_probe").get().value, "member-data");
  tenant.close();
  assert.deepEqual(readFileSync(join(restored, "tenants", TENANT, "assets", "photo.bin")), Buffer.from([0, 1, 2, 3, 255]));
  assert.equal(readFileSync(join(restored, "tenants", TENANT, "ai-config.json"), "utf8"), '{"ciphertext":"isolated"}');
  assert.equal(existsSync(join(restored, "lifeos-instance-manifest.json")), false);
  assert.equal((await backupInstance({ source: restored, output: join(dirname(restored), "second-snapshot"), accountMode: true, offlineConfirmed: true })).fileCount, 5);
  await assert.rejects(() => restoreInstanceBackup({ snapshot, target: restored }), /目标已存在/);
});

test("backup refuses live/ambiguous targets and missing tenant data", async (t) => {
  const { root, source, snapshot } = fixture(t);
  await assert.rejects(() => backupInstance({ source, output: snapshot, accountMode: true }), /offline-confirmed/);
  await assert.rejects(() => backupInstance({ source, output: join(source, "nested"), accountMode: true, offlineConfirmed: true }), /不得位于源目录/);
  await assert.rejects(() => backupInstance({ source, output: snapshot, accountMode: true, assetRoot: root, offlineConfirmed: true }), /资产根目录不在数据卷内/);
  rmSync(join(source, "tenants", TENANT, "lifeos.sqlite"));
  await assert.rejects(() => backupInstance({ source, output: snapshot, accountMode: true, offlineConfirmed: true }), /数据库缺失/);
});

test("SQLite online copy includes committed WAL rows without copying transient sidecars", async (t) => {
  const { source, snapshot, restored } = fixture(t);
  const owner = new DatabaseSync(join(source, "lifeos.sqlite"));
  try {
    owner.exec("PRAGMA journal_mode = WAL; INSERT INTO record_probe VALUES ('wal-committed');");
    await backupInstance({ source, output: snapshot, accountMode: true, offlineConfirmed: true });
  } finally { owner.close(); }
  await restoreInstanceBackup({ snapshot, target: restored });
  const restoredOwner = new DatabaseSync(join(restored, "lifeos.sqlite"), { readOnly: true });
  try { assert.deepEqual(restoredOwner.prepare("SELECT value FROM record_probe ORDER BY rowid").all().map((row) => row.value), ["owner-data", "wal-committed"]); }
  finally { restoredOwner.close(); }
  assert.equal(existsSync(join(restored, "lifeos.sqlite-wal")), false);
});

test("verification catches tampering and refuses a restore", async (t) => {
  const { source, snapshot, restored } = fixture(t);
  await backupInstance({ source, output: snapshot, accountMode: true, offlineConfirmed: true });
  writeFileSync(join(snapshot, "tenants", TENANT, "assets", "photo.bin"), "tampered");
  await assert.rejects(() => verifyInstanceBackup(snapshot), /校验失败/);
  await assert.rejects(() => restoreInstanceBackup({ snapshot, target: restored }), /校验失败/);
});
