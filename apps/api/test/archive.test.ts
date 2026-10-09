import test from "node:test";
import { equal, ok, deepEqual, rejects } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { ArchiveService } from "../src/archive-service.js";
import { StoragePoolStore } from "../src/storage-pool-store.js";
import { POOL_SOURCE_ID } from "../src/storage-pool.js";
import type { RouteContext } from "../src/route-context.js";
import { trashPathFor } from "../src/asset-gc.js";
import { readConfig, type ApiConfig } from "../src/config.js";
import { spaceFingerprint } from "../src/portable-space.js";
import { encryptArchive, decryptArchive } from "../src/encrypted-archive.js";

process.env.LIFEOS_LOG_DIR ??= join(tmpdir(), "lifeos-archive-test-logs");
const { createHttpServer } = await import("../src/server.js");

async function harness(overrides: Partial<ApiConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lifeos-archive-test-")); mkdirSync(join(dir, "assets"));
  const config = { ...readConfig({ LIFEOS_DATA_DIR: join(dir, "data"), LIFEOS_ASSET_ROOT: join(dir, "assets"), LIFEOS_PORT: "3099" }), ...overrides };
  const { app, server } = createHttpServer(config); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("no test port");
  return { dir, app, config, base: `http://127.0.0.1:${address.port}`, stop: async () => { await new Promise<void>(r => server.close(() => r())); app.close(); const full = resolve(dir); if (!full.startsWith(resolve(tmpdir()) + requireSeparator())) throw Error("unsafe test cleanup"); rmSync(full, { recursive: true, force: true }); } };
}
function requireSeparator() { return process.platform === "win32" ? "\\" : "/"; }
async function json(base: string, path: string, body?: unknown) { const response = await fetch(base + path, { ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }); const value = await response.json() as any; return { response, value }; }
async function ready(base: string, id: string) { for (let i = 0; i < 200; i++) { const { value } = await json(base, `/api/archive/jobs/${id}`); if (value.phase !== "working") return value; await new Promise(r => setTimeout(r, 30)); } throw Error("job timeout"); }
async function upload(base: string, bytes: Buffer, password: string) { const response = await fetch(base + "/api/archive/uploads", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes }); equal(response.status, 201); const uploaded = await response.json() as any; const { response: start } = await json(base, "/api/archive/import", { id: uploaded.id, password }); equal(start.status, 202); return await ready(base, uploaded.id); }

test("backup month range survives more than 100 recent runs and honors Shanghai midnight", async (t) => {
  const h = await harness(); t.after(h.stop);
  h.app.repository.recordBackupRun({ provider: "local", kind: "manual", status: "success", startedAt: "2026-08-31T16:00:00.000Z" });
  h.app.repository.recordBackupRun({ provider: "local", kind: "manual", status: "success", startedAt: "2026-09-30T16:00:00.000Z" });
  for (let i = 0; i < 150; i++) h.app.repository.recordBackupRun({ provider: "local", kind: "test", status: "success", startedAt: "2026-10-06T01:00:00.000Z" });
  const { response, value } = await json(h.base, "/api/backup/runs?from=2026-09-01&to=2026-09-30"); equal(response.status, 200); equal(value.items.length, 1); equal(value.items[0].startedAt, "2026-08-31T16:00:00.000Z");
});

test("full encrypted archive round trip includes originals, deleted/private records, manual summaries and safe replacement", async (t) => {
  const source = await harness(); const target = await harness(); t.after(source.stop); t.after(target.stop);
  const bytes = Buffer.from("fixture original bytes with no shared server path");
  writeFileSync(join(source.dir, "assets", "photo.jpg"), bytes);
  source.app.repository.insertAsset({ id: "photo", kind: "photo", mediaType: "image/jpeg", sizeBytes: bytes.length, storageRefs: [{ sourceId: "local", sourceRef: "photo.jpg", contentHash: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") } }] });
  const trashRef = "uploads/discarded.jpg", trashFile = join(source.dir, "assets", trashPathFor(trashRef)!);
  mkdirSync(join(trashFile, ".."), { recursive: true }); writeFileSync(trashFile, bytes);
  source.app.repository.insertAssetTrash({ asset: { id: "discarded", kind: "photo", mediaType: "image/jpeg", storageRefs: [{ sourceId: "local", sourceRef: trashRef }] }, origin: "asset-delete", relativePath: trashRef, trashedAt: "2026-10-07T00:00:00.000Z" });
  for (const [id, extension, kind] of [["legacy-jpeg", ".jpeg", "photo"], ["legacy-aac", ".aac", "audio"]] as const) {
    writeFileSync(join(source.dir, "assets", id + extension), bytes);
    source.app.repository.insertAsset({ id, kind, storageRefs: [{ sourceId: "local", sourceRef: id + extension }] });
  }
  const { value: privateRecord } = await json(source.base, "/api/records", { kind: "journal", content: "非常私密的完整包原文", isPrivate: true, assetRefs: [{ assetId: "photo", role: "photo" }] });
  const { value: deleted } = await json(source.base, "/api/records", { kind: "journal", content: "回收站内容", occurredAt: { kind: "date", value: "2026-10-07" } });
  equal((await json(source.base, "/api/summaries/manual", { entries: [{ date: "2026-10-07", text: "手写小结" }] })).response.status, 200);
  await fetch(source.base + `/api/records/${deleted.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: deleted.revision }) });
  const estimate = await json(source.base, "/api/archive/estimate"); equal(estimate.value.originalBytes, bytes.length * 4); equal(estimate.value.cloudReadBytes, 0); equal(estimate.value.counts.records, 2);
  const { value: started } = await json(source.base, "/api/archive/export", { password: "archive-test-password" }); const exported = await ready(source.base, started.id); equal(exported.phase, "ready", exported.error);
  const download = await fetch(source.base + `/api/archive/jobs/${started.id}/download`); const encrypted = Buffer.from(await download.arrayBuffer()); equal(Number(download.headers.get("content-length")), encrypted.length); equal(exported.bytes, encrypted.length); ok(!encrypted.includes(Buffer.from("非常私密"))); ok(!encrypted.includes(bytes));
  equal((await fetch(target.base + `/api/archive/jobs/${started.id}/download`)).status, 404, "job belongs only to source space");
  await json(target.base, "/api/records", { kind: "journal", content: "目标当前内容" });
  const before = spaceFingerprint(target.app.repository.portableSpace());
  const wrong = await upload(target.base, encrypted, "wrong-test-password"); equal(wrong.phase, "failed"); equal(spaceFingerprint(target.app.repository.portableSpace()), before); await fetch(target.base + `/api/archive/jobs/${wrong.id}`, { method: "DELETE" });
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  const corrupt = await upload(target.base, tampered, "archive-test-password"); equal(corrupt.phase, "failed"); equal(spaceFingerprint(target.app.repository.portableSpace()), before); await fetch(target.base + `/api/archive/jobs/${corrupt.id}`, { method: "DELETE" });
  const prepared = await upload(target.base, encrypted, "archive-test-password"); equal(prepared.phase, "ready", prepared.error); equal(prepared.counts.deletedRecords, 1); equal(prepared.counts.summaries, 1);
  equal((await json(target.base, "/api/archive/commit", { id: prepared.id })).response.status, 400, "replacement needs explicit confirmation");
  const committed = await json(target.base, "/api/archive/commit", { id: prepared.id, replaceConfirmed: true }); equal(committed.response.status, 200, JSON.stringify(committed.value));
  const data = target.app.repository.exportData(); equal(data.records.length, 1); equal(data.records[0]!.id, privateRecord.id); equal(data.records[0]!.isPrivate, true);
  equal(target.app.repository.portableSpace().records.rows.length, 2); equal(target.app.repository.portableSpace().day_summaries.rows.length, 1);
  const asset = target.app.repository.findAssetById("photo")!; ok(asset.storageRefs[0]!.sourceRef.startsWith("uploads/archive-")); deepEqual(readFileSync(join(target.dir, "assets", asset.storageRefs[0]!.sourceRef)), bytes);
  const trash = target.app.repository.findAssetTrash("discarded")!; equal(trash.restoredAt, undefined); deepEqual(readFileSync(join(target.dir, "assets", trashPathFor(trash.relativePath)!)), bytes);
  ok(target.app.repository.findAssetById("legacy-jpeg")!.storageRefs[0]!.sourceRef.endsWith(".jpg"));
  ok(target.app.repository.findAssetById("legacy-aac")!.storageRefs[0]!.sourceRef.endsWith(".aac"));
  ok(existsSync(join(target.dir, "data", "backups", committed.value.backup))); equal((await fetch(target.base + `/api/archive/jobs/${prepared.id}`)).status, 404);
});

test("import refuses stale preview and missing originals fail before generating an incomplete package", async (t) => {
  const source = await harness(); const target = await harness(); t.after(source.stop); t.after(target.stop);
  await json(source.base, "/api/records", { kind: "journal", content: "source" });
  const started = await json(source.base, "/api/archive/export", { password: "archive-test-password" }); equal((await ready(source.base, started.value.id)).phase, "ready");
  const bytes = Buffer.from(await (await fetch(source.base + `/api/archive/jobs/${started.value.id}/download`)).arrayBuffer());
  const preview = await upload(target.base, bytes, "archive-test-password"); equal(preview.phase, "ready"); await json(target.base, "/api/records", { kind: "journal", content: "new edit since preview" });
  const before = spaceFingerprint(target.app.repository.portableSpace()); equal((await json(target.base, "/api/archive/commit", { id: preview.id, replaceConfirmed: true })).response.status, 409); equal(spaceFingerprint(target.app.repository.portableSpace()), before);
  source.app.repository.insertAsset({ id: "gone", kind: "photo", storageRefs: [{ sourceId: "local", sourceRef: "missing.jpg" }] }); equal((await json(source.base, "/api/archive/estimate")).response.status, 409);
});

test("encrypted framing rejects tampered headers and truncated bytes and never releases plaintext on failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lifeos-archive-crypto-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "archive"); const bytes = Buffer.from("private content"); await encryptArchive((async function* () { yield bytes; })(), source, "long-test-password");
  const encrypted = readFileSync(source); writeFileSync(join(dir, "short"), encrypted.subarray(0, 20));
  await rejects(decryptArchive(join(dir, "short"), join(dir, "short-output"), "long-test-password")); ok(!existsSync(join(dir, "short-output")));
  const modified = Buffer.from(encrypted); modified[10] = modified[10]! ^ 1; writeFileSync(join(dir, "tamper"), modified);
  await rejects(decryptArchive(join(dir, "tamper"), join(dir, "bad-output"), "long-test-password")); ok(!existsSync(join(dir, "bad-output")));
});

test("account archive exports require the current password and are isolated between tenants", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lifeos-archive-account-test-"));
  const h = await harness({ ...readConfig({ LIFEOS_ACCOUNT_MODE: "1", LIFEOS_COOKIE_SECURE: "true", LIFEOS_ALLOWED_ORIGINS: "https://lifeos.dnbox.cn", LIFEOS_PASSWORD: "owner-test-password", LIFEOS_OWNER_USERNAME: "owner", LIFEOS_DATA_DIR: join(dir, "data"), LIFEOS_ASSET_ROOT: join(dir, "assets") }) });
  t.after(async () => { await h.stop(); rmSync(dir, { recursive: true, force: true }); });
  const login = await json(h.base, "/api/auth/login", { username: "owner", password: "owner-test-password" }); equal(login.response.status, 200); const cookie = login.response.headers.get("set-cookie")!.split(";")[0]!;
  const response = await fetch(h.base + "/api/archive/export", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ password: "wrong-test-password" }) }); equal(response.status, 403);
  const yes = await fetch(h.base + "/api/archive/export", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ password: "owner-test-password" }) }); equal(yes.status, 202); const job = await yes.json() as any;
  for (let i = 0; i < 200; i++) { const v = await (await fetch(h.base + `/api/archive/jobs/${job.id}`, { headers: { cookie } })).json() as any; if (v.phase !== "working") { equal(v.phase, "ready", v.error); break; } await new Promise(r => setTimeout(r, 30)); }
  equal((await fetch(h.base + `/api/archive/jobs/${job.id}/download`)).status, 401);
  const created = await fetch(h.base + "/api/admin/accounts", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ username: "member", password: "member-test-password", displayName: "成员", spaceName: "成员空间" }) }); equal(created.status, 201);
  const member = await json(h.base, "/api/auth/login", { username: "member", password: "member-test-password" }); equal(member.response.status, 200); const memberCookie = member.response.headers.get("set-cookie")!.split(";")[0]!;
  equal((await fetch(h.base + `/api/archive/jobs/${job.id}/download`, { headers: { cookie: memberCookie } })).status, 404);
  equal((await fetch(h.base + `/api/archive/jobs/${job.id}`, { headers: { cookie: memberCookie } })).status, 404);
});

test("cloud originals are included without another stored archive, download quota is charged and rollback preserves the target", async (t) => {
  const source = await harness(); const target = await harness();
  const store = new StoragePoolStore(join(source.dir, "pool.sqlite"));
  const account = "archive-owner", bytes = Buffer.from("remote original"), month = new Date().toISOString().slice(0, 7);
  store.saveQuota(account, { storageLimitBytes: 4096, trafficLimitBytes: 4096 }, 4096, 4096);
  const attempt = store.reserveUpload(account, "remote", bytes.length, 4096); store.completeUpload(attempt, "pool/source-original");
  source.app.repository.insertAsset({ id: "remote", kind: "photo", mediaType: "image/jpeg", sizeBytes: bytes.length, storageRefs: [{ sourceId: POOL_SOURCE_ID, sourceRef: "pool/source-original" }] });
  let puts = 0, downloads = 0; const deleted: string[] = [];
  const bridge = { enabled: true, downloadToFile: async (_key: string, file: string) => { downloads++; writeFileSync(file, bytes); return { month, bytes: bytes.length }; }, putFile: async () => { puts++; await json(target.base, "/api/records", { kind: "journal", content: "concurrent edit during cloud upload" }); return { key: "pool/import-original" }; }, delete: async (key: string) => { deleted.push(key); } };
  const preflight = async () => ({ storageFreeBytes: 4096, trafficFreeBytes: 4096, month });
  const sourceCtx = { config: source.config, repository: source.app.repository, poolStore: store, poolBridge: bridge, poolAccountId: account, poolPreflight: preflight } as unknown as RouteContext;
  const service = new ArchiveService(); t.after(async () => { service.close(); store.close(); await source.stop(); await target.stop(); });
  equal((await service.estimate(sourceCtx)).cloudReadBytes, bytes.length);
  const id = await service.export(sourceCtx, "remote-test-password");
  for (let i = 0; i < 200 && service.view(id).phase === "working"; i++) await new Promise(r => setTimeout(r, 30));
  equal(service.view(id).phase, "ready", service.view(id).error); equal(puts, 0); equal(downloads, 1); equal(store.usage(account, month).trafficUsedBytes, bytes.length);
  const encrypted = readFileSync(join(service.get(id).directory, "archive.lifeos")); await service.remove(id);
  // Import is exercised with the real quota ledger and a bridge that creates a concurrent edit.
  // It must compensate only its new object and preserve that concurrent edit.
  const targetCtx = { ...sourceCtx, config: target.config, repository: target.app.repository } as RouteContext;
  const request = Readable.from([encrypted]) as unknown as IncomingMessage; request.headers = { "content-length": String(encrypted.length) };
  const localId = await service.upload(request);
  await service.prepareImport(targetCtx, localId, "remote-test-password");
  for (let i = 0; i < 200 && service.view(localId).phase === "working"; i++) await new Promise(r => setTimeout(r, 30));
  equal(service.view(localId).phase, "ready", service.view(localId).error);
  await rejects(service.commitImport(targetCtx, localId), /当前空间已发生变化/);
  equal(target.app.repository.exportData().records.length, 1); equal(target.app.repository.exportData().assets.length, 0);
  deepEqual(deleted, ["pool/import-original"]); equal(store.poolObject(account, "remote", "pool/import-original"), null); ok(store.poolObject(account, "remote", "pool/source-original"));
  await service.remove(localId);
  store.saveQuota(account, { storageLimitBytes: 4096, trafficLimitBytes: 0 }, 4096, 4096);
  await rejects(service.estimate(sourceCtx), /流量超过剩余额度/);
});
