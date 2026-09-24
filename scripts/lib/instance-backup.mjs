import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const MANIFEST = "lifeos-instance-manifest.json";
const VERSION = 1;

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelative(value) {
  return typeof value === "string" && value !== "" && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0"));
}

async function absent(path) {
  try { await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`目标已存在，拒绝覆盖：${path}`);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function filesUnder(root) {
  const found = [];
  async function visit(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`备份源含符号链接，拒绝越界：${join(directory, entry.name)}`);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (!safeRelative(name)) throw new Error(`备份源文件名不安全：${name}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else if (entry.isFile()) found.push(name);
      else throw new Error(`备份源含非普通文件：${join(directory, entry.name)}`);
    }
  }
  await visit(root, "");
  return found.sort((a, b) => a.localeCompare(b));
}

function activeDatabase(name) {
  return name === "identity.sqlite" || name === "lifeos.sqlite"
    || /^tenants\/[0-9a-f-]+\/lifeos\.sqlite$/i.test(name);
}

function transientSqliteFile(name) {
  return activeDatabase(name.replace(/-(?:wal|shm)$/, "")) && /-(?:wal|shm)$/.test(name);
}

function checkSqlite(path, identity = false) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA quick_check").get();
    if (result?.quick_check !== "ok") throw new Error(`SQLite 完整性校验失败：${path}`);
    if (identity) {
      const master = db.prepare("SELECT value FROM identity_meta WHERE key = 'config_master_secret'").get();
      const owners = db.prepare("SELECT count(*) AS count FROM accounts WHERE role = 'owner'").get();
      if (typeof master?.value !== "string" || master.value.length < 32 || Number(owners?.count) !== 1) {
        throw new Error("身份库缺少唯一 owner 或租户配置主密钥");
      }
    }
  } finally { db.close(); }
}

async function validateAccountFiles(root, names, accountMode) {
  const present = new Set(names);
  if (!present.has("lifeos.sqlite")) throw new Error("备份源缺少 owner 的 lifeos.sqlite");
  if (!accountMode && !present.has("identity.sqlite")) return;
  if (!present.has("identity.sqlite")) throw new Error("账户模式备份源缺少 identity.sqlite");
  checkSqlite(join(root, "identity.sqlite"), true);
  const db = new DatabaseSync(join(root, "identity.sqlite"), { readOnly: true });
  try {
    for (const row of db.prepare("SELECT tenant_id FROM accounts WHERE role = 'member'").all()) {
      const tenantId = String(row.tenant_id);
      if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !present.has(`tenants/${tenantId}/lifeos.sqlite`)) {
        throw new Error(`成员 ${tenantId} 的数据库缺失，拒绝声称可恢复`);
      }
    }
  } finally { db.close(); }
}

async function canonicalNewPath(path) {
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
}

/** Copy a stopped instance's entire /data tree to a NEW directory outside it. */
export async function backupInstance({ source, output, accountMode = false, assetRoot, offlineConfirmed = false }) {
  if (!offlineConfirmed) throw new Error("先停止 LifeOS 写入，再明确传 --offline-confirmed；跨库与照片不能在线保证同一恢复点");
  if (!source || !output) throw new Error("必须明确指定 --source 和 --output");
  const sourceRoot = await realpath(resolve(source));
  if (!(await lstat(sourceRoot)).isDirectory()) throw new Error("备份源不是目录");
  const outputRoot = await canonicalNewPath(output);
  if (within(sourceRoot, outputRoot) || within(outputRoot, sourceRoot)) throw new Error("备份目标不得位于源目录之内，也不得覆盖源目录的父目录");
  await absent(outputRoot);
  if (assetRoot) {
    const assetPath = await realpath(resolve(assetRoot)).catch((error) => {
      if (error?.code === "ENOENT") return resolve(assetRoot);
      throw error;
    });
    if (!within(sourceRoot, assetPath)) throw new Error("资产根目录不在数据卷内；请先将它迁入同一持久卷，或另行制定联合恢复方案");
  }
  const names = (await filesUnder(sourceRoot)).filter((name) => !transientSqliteFile(name));
  if (names.includes(MANIFEST)) throw new Error(`源目录使用了保留文件名 ${MANIFEST}`);
  await validateAccountFiles(sourceRoot, names, accountMode);
  await mkdir(outputRoot, { mode: 0o700 });
  const files = [];
  for (const name of names) {
    const from = join(sourceRoot, ...name.split("/"));
    const to = join(outputRoot, ...name.split("/"));
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    if (activeDatabase(name)) {
      const db = new DatabaseSync(from, { readOnly: true });
      try { await backup(db, to); } finally { db.close(); }
      // A source in WAL mode can make a read-only verification open create
      // -wal/-shm siblings in the snapshot. The restored database is offline;
      // store it in single-file DELETE mode before hashing the artifact.
      const snapshotDb = new DatabaseSync(to);
      try { snapshotDb.exec("PRAGMA journal_mode = DELETE"); } finally { snapshotDb.close(); }
      checkSqlite(to, name === "identity.sqlite");
    } else {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    }
    await chmod(to, 0o600);
    files.push({ path: name, ...await hashFile(to) });
  }
  const manifest = { version: VERSION, createdAt: new Date().toISOString(), accountMode: accountMode || names.includes("identity.sqlite"), files };
  await writeFile(join(outputRoot, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await verifyInstanceBackup(outputRoot);
  return { output: outputRoot, fileCount: files.length, bytes: files.reduce((total, file) => total + file.sizeBytes, 0), accountMode: manifest.accountMode };
}

/** Hash every listed file and reject missing, extra, linked, or corrupt files. */
export async function verifyInstanceBackup(snapshot) {
  const root = await realpath(resolve(snapshot));
  const manifest = JSON.parse(await readFile(join(root, MANIFEST), "utf8"));
  if (manifest.version !== VERSION || !Array.isArray(manifest.files)) throw new Error("备份清单版本无效");
  const actual = await filesUnder(root);
  const listed = manifest.files.map((file) => file.path);
  if (new Set(listed).size !== listed.length || listed.some((name) => !safeRelative(name))) throw new Error("备份清单含重复或越界路径");
  if (JSON.stringify(actual) !== JSON.stringify([...listed, MANIFEST].sort((a, b) => a.localeCompare(b)))) {
    throw new Error("备份目录的文件与清单不一致");
  }
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split("/"));
    const actualHash = await hashFile(path);
    if (actualHash.sizeBytes !== file.sizeBytes || actualHash.sha256 !== file.sha256) throw new Error(`备份文件校验失败：${file.path}`);
    if (activeDatabase(file.path)) checkSqlite(path, file.path === "identity.sqlite");
  }
  await validateAccountFiles(root, listed, manifest.accountMode === true);
  return { snapshot: root, fileCount: listed.length, bytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0), accountMode: manifest.accountMode === true };
}

/** Restore only into a NEW directory; never replace a running/old data volume. */
export async function restoreInstanceBackup({ snapshot, target }) {
  if (!target) throw new Error("必须明确指定 --target");
  const verified = await verifyInstanceBackup(snapshot);
  const targetRoot = await canonicalNewPath(target);
  if (within(verified.snapshot, targetRoot) || within(targetRoot, verified.snapshot)) throw new Error("恢复目标不能包含备份目录或位于备份目录内部");
  await absent(targetRoot);
  const staging = `${targetRoot}.restoring-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  const manifest = JSON.parse(await readFile(join(verified.snapshot, MANIFEST), "utf8"));
  for (const file of manifest.files) {
    const to = join(staging, ...file.path.split("/"));
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(join(verified.snapshot, ...file.path.split("/")), to, constants.COPYFILE_EXCL);
    await chmod(to, 0o600);
  }
  await copyFile(join(verified.snapshot, MANIFEST), join(staging, MANIFEST), constants.COPYFILE_EXCL);
  await verifyInstanceBackup(staging);
  // The manifest authenticates the transport artifact, not the application's
  // live data tree. Leaving it in /data would make the next backup ambiguous.
  await unlink(join(staging, MANIFEST));
  await absent(targetRoot);
  await rename(staging, targetRoot);
  return { target: targetRoot, fileCount: verified.fileCount, bytes: verified.bytes, accountMode: verified.accountMode };
}
