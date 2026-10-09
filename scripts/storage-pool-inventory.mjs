// Preparation only: no network, database writes, uploads, moves or deletes.
// Node 24. Explicit paths prevent accidentally inventorying the wrong instance.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, openSync, closeSync, fstatSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = value => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
};
const safeRef = value => typeof value === "string" && value.length > 0 && !/[\x00-\x1f:]/.test(value)
  && !value.startsWith("/") && !value.startsWith("\\")
  && value.replaceAll("\\", "/").split("/").every(part => part !== "" && part !== "." && part !== "..");

function readDatabase(path, reader) {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error("Database symlink refused");
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    db.exec("BEGIN");
    return reader(db);
  } finally {
    db.close();
  }
}

function databaseRows(path) {
  return readDatabase(path, db => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has("assets") || !tables.has("records")) throw new Error("Required business tables missing");
    const assets = db.prepare("SELECT id, value_json FROM assets ORDER BY id").all();
    const trash = tables.has("asset_trash")
      ? db.prepare("SELECT asset_id, asset_json, relative_path FROM asset_trash WHERE restored_at IS NULL AND purged_at IS NULL ORDER BY asset_id").all() : [];
    const purgedIds = tables.has("asset_trash") ? db.prepare("SELECT asset_id FROM asset_trash WHERE purged_at IS NOT NULL ORDER BY asset_id").all().map(row => row.asset_id) : [];
    const records = db.prepare("SELECT id, revision, asset_refs_json, deleted_at_json FROM records ORDER BY id").all();
    return { assets, trash, records, purgedIds, fingerprint: digest(JSON.stringify({ assets, trash, records, purgedIds })) };
  });
}

function checkedFile(root, ref) {
  if (!safeRef(ref)) return { status: "unsafe_path" };
  if (!root || !existsSync(root)) return { status: "asset_root_missing" };
  const full = resolve(root, ref.replaceAll("\\", "/"));
  if (!inside(root, full) || full === root) return { status: "unsafe_path" };
  if (!existsSync(full)) return { status: "missing" };
  const realRoot = realpathSync(root);
  const realFile = realpathSync(full);
  if (!inside(realRoot, realFile) || lstatSync(full).isSymbolicLink()) return { status: "unsafe_path" };
  const fd = openSync(full, "r");
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) return { status: "not_regular_file" };
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return { status: "size_unsupported" };
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0, n;
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, n)); bytes += n; }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes) !== before.size
      || realpathSync(full) !== realFile) return { status: "changed_during_read" };
    return { status: "ok", bytes, sha256: hash.digest("hex"), file: full };
  } finally { closeSync(fd); }
}

function walkFiles(root, onFile, issues, maxEntries) {
  if (!root || !existsSync(root)) return;
  if (lstatSync(root).isSymbolicLink()) { issues.push({ code: "asset_root_symlink", path: root }); return; }
  let remaining = maxEntries;
  const walk = (path, depth) => {
    if (depth > 64) { issues.push({ code: "directory_depth_limit", path }); return; }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (--remaining < 0) { issues.push({ code: "file_scan_limit", path }); return; }
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) issues.push({ code: "asset_symlink", path: full });
      else if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) onFile(full);
      else issues.push({ code: "non_regular_entry", path: full });
      if (remaining < 0) return;
    }
  };
  walk(root, 0);
}

export function inventoryStoragePool({ dataDirectory, assetRoot, databasePath, maxEntries = 100000 }) {
  if (!dataDirectory || !assetRoot) throw new Error("Explicit dataDirectory and owner assetRoot required");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Invalid maxEntries");
  const data = resolve(dataDirectory), ownerRoot = resolve(assetRoot), ownerDb = resolve(databasePath ?? join(data, "lifeos.sqlite"));
  if (!existsSync(data) || lstatSync(data).isSymbolicLink()) throw new Error("Data directory missing or symlinked");
  const startedAt = new Date().toISOString();
  const issues = [], notices = [], spaces = [], files = [], knownDatabases = new Set();
  let accounts = [];
  const identityPath = join(data, "identity.sqlite");
  try {
    accounts = readDatabase(identityPath, db => db.prepare("SELECT id, tenant_id, role, disabled_at FROM accounts ORDER BY id").all()) ?? [];
  } catch { issues.push({ code: "identity_unreadable", path: identityPath }); }
  const owner = accounts.filter(account => account.role === "owner");
  if (owner.length !== 1) issues.push({ code: "owner_identity_unresolved", count: owner.length });
  const candidates = [{ accountId: owner.length === 1 ? owner[0].id : null, tenantId: owner.length === 1 ? owner[0].tenant_id : null,
    role: "owner", databasePath: ownerDb, assetRoot: ownerRoot }];
  for (const account of accounts.filter(account => account.role !== "owner")) {
    if (account.role !== "member" || !UUID.test(String(account.tenant_id))) { issues.push({ code: "invalid_tenant_identity", accountId: account.id }); continue; }
    const directory = join(data, "tenants", account.tenant_id.toLowerCase());
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !inside(realpathSync(data), realpathSync(directory)))) {
      issues.push({ code: "unsafe_tenant_directory", accountId: account.id }); continue;
    }
    candidates.push({ accountId: account.id, tenantId: account.tenant_id, role: "member", disabled: account.disabled_at !== null,
      databasePath: join(directory, "lifeos.sqlite"), assetRoot: join(directory, "assets") });
  }
  const tenantsRoot = join(data, "tenants");
  if (existsSync(tenantsRoot)) {
    if (lstatSync(tenantsRoot).isSymbolicLink()) throw new Error("Tenants directory symlink refused");
    for (const entry of readdirSync(tenantsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || candidates.some(candidate => candidate.role === "member" && candidate.tenantId.toLowerCase() === entry.name.toLowerCase())) continue;
      issues.push({ code: "unassigned_tenant_directory", path: join(tenantsRoot, entry.name) });
      candidates.push({ accountId: null, tenantId: entry.name, role: "unassigned", databasePath: join(tenantsRoot, entry.name, "lifeos.sqlite"), assetRoot: join(tenantsRoot, entry.name, "assets") });
    }
  }
  for (const candidate of candidates) {
    const space = { ...candidate, records: 0, deletedRecords: 0, assets: 0, recoverableTrashAssets: 0, databaseFingerprint: null, status: "not_initialized" };
    spaces.push(space);
    if (knownDatabases.has(candidate.databasePath)) { issues.push({ code: "duplicate_space_database", path: candidate.databasePath }); continue; }
    knownDatabases.add(candidate.databasePath);
    let rows;
    try { rows = databaseRows(candidate.databasePath); }
    catch { issues.push({ code: "business_database_unreadable", path: candidate.databasePath }); continue; }
    const referenced = new Set(), fileCache = new Map();
    if (rows) {
      space.status = "inventoried";
      space.records = rows.records.length;
      space.deletedRecords = rows.records.filter(row => row.deleted_at_json !== null).length;
      space.assets = rows.assets.length;
      space.recoverableTrashAssets = rows.trash.length;
      space.databaseFingerprint = rows.fingerprint;
      const entries = [...rows.assets.map(row => ({ id: row.id, json: row.value_json, trash: false })),
        ...rows.trash.map(row => ({ id: row.asset_id, json: row.asset_json, trash: true, relativePath: row.relative_path }))];
      const assetIds = new Set([...rows.assets.map(row => row.id), ...rows.trash.map(row => row.asset_id)]);
      for (const record of rows.records) {
        try {
          const refs = JSON.parse(record.asset_refs_json);
          if (!Array.isArray(refs)) throw new Error();
          for (const ref of refs) if (!assetIds.has(ref.assetId ?? ref)) {
            const assetId = ref.assetId ?? ref;
            if (record.deleted_at_json !== null && rows.purgedIds.includes(assetId)) notices.push({ code: "deleted_record_purged_asset", recordId: record.id, assetId });
            else issues.push({ code: "record_asset_missing", accountId: candidate.accountId, recordId: record.id, assetId });
          }
        } catch { issues.push({ code: "record_references_invalid", recordId: record.id }); }
      }
      for (const entry of entries) {
        let asset;
        try { asset = JSON.parse(entry.json); if (asset.id !== entry.id || !Array.isArray(asset.storageRefs)) throw new Error(); }
        catch { issues.push({ code: "asset_metadata_invalid", assetId: entry.id }); continue; }
        if (asset.storageRefs.length === 0) issues.push({ code: "asset_has_no_references", assetId: entry.id });
        for (const ref of asset.storageRefs) {
          const item = { accountId: candidate.accountId, tenantId: candidate.tenantId, assetId: entry.id, trash: entry.trash,
            sourceId: ref.sourceId, sourceRef: ref.sourceRef, databasePath: candidate.databasePath };
          if (ref.sourceId !== "local") {
            files.push({ ...item, status: ref.sourceId === "lifeos-pool" ? "pool_not_verified" : "external_not_verified" });
            issues.push({ code: "remote_reference_needs_verification", assetId: entry.id, sourceId: ref.sourceId });
            continue;
          }
          let path = ref.sourceRef;
          if (entry.trash) {
            const original = String(ref.sourceRef).replaceAll("\\", "/");
            path = safeRef(original) && original.startsWith("uploads/") && !original.startsWith("uploads/_orphan-trash/")
              ? `uploads/_orphan-trash/${original.slice("uploads/".length)}` : "";
          }
          let checked;
          try {
            checked = fileCache.get(path) ?? checkedFile(candidate.assetRoot, path);
            fileCache.set(path, checked);
          } catch { checked = { status: "unreadable" }; }
          if (safeRef(path)) referenced.add(resolve(candidate.assetRoot, path.replaceAll("\\", "/")));
          const expectedHash = ref.contentHash?.algorithm === "sha256" ? ref.contentHash.value : undefined;
          const mismatch = checked.status === "ok" && ((expectedHash && expectedHash.toLowerCase() !== checked.sha256)
            || (asset.sizeBytes !== undefined && asset.sizeBytes !== checked.bytes));
          const status = mismatch ? "metadata_mismatch" : checked.status;
          files.push({ ...item, relativePath: path, ...checked, status });
          if (status !== "ok") issues.push({ code: status, assetId: entry.id, sourceRef: ref.sourceRef });
        }
      }
    }
    try {
      walkFiles(candidate.assetRoot, path => {
        if (!referenced.has(path)) { files.push({ accountId: candidate.accountId, tenantId: candidate.tenantId, file: path, status: "unreferenced" }); issues.push({ code: "unreferenced_file", path }); }
      }, issues, maxEntries);
    } catch { issues.push({ code: "asset_directory_unreadable", path: candidate.assetRoot }); }
    if (rows) {
      try { if (databaseRows(candidate.databasePath)?.fingerprint !== rows.fingerprint) issues.push({ code: "database_changed_during_inventory", path: candidate.databasePath }); }
      catch { issues.push({ code: "database_recheck_failed", path: candidate.databasePath }); }
    }
  }
  const physical = new Map();
  for (const file of files.filter(file => file.status === "ok")) physical.set(file.file, file.bytes);
  return { format: "lifeos-pool-inventory-v1", startedAt, finishedAt: new Date().toISOString(),
    scope: { dataDirectory: data, ownerDatabasePath: ownerDb, ownerAssetRoot: ownerRoot },
    preparationOnly: true, migrationReady: false,
    summary: { spaces: spaces.length, assets: spaces.reduce((sum, space) => sum + space.assets, 0),
      recoverableTrashAssets: spaces.reduce((sum, space) => sum + space.recoverableTrashAssets, 0),
      localFilesVerified: physical.size, localBytesVerified: [...physical.values()].reduce((a, b) => a + b, 0),
      issues: issues.length, historicalPurgedReferences: notices.length, inventoryComplete: issues.length === 0 }, spaces, files, issues, notices };
}

export function saveInventory(path, report) {
  const target = resolve(path), parent = realpathSync(dirname(target));
  for (const root of [report.scope.dataDirectory, report.scope.ownerAssetRoot, ...report.spaces.map(space => space.assetRoot)]) {
    if (inside(resolve(root), target) || (existsSync(root) && inside(realpathSync(root), join(parent, relative(dirname(target), target)))))
      throw new Error("Inventory output must be outside source data and asset directories");
  }
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const help = "Node 24: node scripts/storage-pool-inventory.mjs --data-dir <existing-dir> --asset-root <owner-originals> [--db-path <owner-db>] [--out <new-private-json>]\nRead-only. No --apply, upload, delete, configuration or schema changes. Output parents must already exist; existing output files are never overwritten.";
  try {
    const flags = new Map();
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") { console.log(help); }
    else {
      for (let i = 0; i < args.length; i += 2) {
        if (!["--data-dir", "--asset-root", "--db-path", "--out"].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error(help);
        flags.set(args[i], args[i + 1]);
      }
      const report = inventoryStoragePool({ dataDirectory: flags.get("--data-dir"), assetRoot: flags.get("--asset-root"), databasePath: flags.get("--db-path") });
      if (flags.has("--out")) saveInventory(flags.get("--out"), report);
      console.log(JSON.stringify(report.summary, null, 2));
      console.log(`INVENTORY: ${report.summary.inventoryComplete ? "COMPLETE" : "INCOMPLETE"}; MIGRATION: NOT RUN`);
      if (!report.summary.inventoryComplete) process.exitCode = 2;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
