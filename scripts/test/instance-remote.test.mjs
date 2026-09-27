import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { test } from "node:test";
import { backupInstance, restoreInstanceBackup } from "../lib/instance-backup.mjs";
import { checkInstanceDestination, downloadInstanceSnapshot, uploadInstanceSnapshot } from "../lib/instance-remote.mjs";

const TENANT = "11111111-1111-4111-8111-111111111111";

async function fixture(t, { publicRead = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-instance-remote-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(join(source, "tenants", TENANT, "assets"), { recursive: true });
  const owner = new DatabaseSync(join(source, "lifeos.sqlite"));
  owner.exec("CREATE TABLE record_probe (value TEXT); INSERT INTO record_probe VALUES ('owner-original');");
  owner.close();
  const tenant = new DatabaseSync(join(source, "tenants", TENANT, "lifeos.sqlite"));
  tenant.exec("CREATE TABLE record_probe (value TEXT); INSERT INTO record_probe VALUES ('member-original');");
  tenant.close();
  const identity = new DatabaseSync(join(source, "identity.sqlite"));
  identity.exec("CREATE TABLE identity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE accounts (tenant_id TEXT, role TEXT);");
  identity.prepare("INSERT INTO identity_meta VALUES (?, ?)").run("config_master_secret", "isolated-test-master-secret-1234567890");
  identity.prepare("INSERT INTO accounts VALUES (?, ?)").run("owner", "owner");
  identity.prepare("INSERT INTO accounts VALUES (?, ?)").run(TENANT, "member");
  identity.close();
  writeFileSync(join(source, "tenants", TENANT, "assets", "photo.bin"), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(source, "tenants", TENANT, "ai-config.json"), '{"ciphertext":"isolated"}');
  const snapshot = join(root, "snapshot");
  await backupInstance({ source, output: snapshot, accountMode: true, assetRoot: join(source, "tenants", TENANT, "assets"), offlineConfirmed: true });
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(request.url ?? "");
    if (!publicRead && request.method === "GET" && !request.headers.authorization) {
      response.writeHead(403); response.end(); return;
    }
    if (request.method === "HEAD" || request.method === "GET") {
      const found = objects.get(key);
      if (!found) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-length": found.body.length, "x-amz-meta-sha256": found.hash });
      response.end(request.method === "HEAD" ? undefined : found.body);
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204); response.end(); return;
    }
    if (request.method !== "PUT") { response.writeHead(405); response.end(); return; }
    if (request.headers["if-none-match"] !== "*" || objects.has(key)) { response.writeHead(412); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash !== request.headers["x-amz-content-sha256"] || hash !== request.headers["x-amz-meta-sha256"]) {
      response.writeHead(400); response.end("bad payload hash"); return;
    }
    objects.set(key, { body, hash });
    response.writeHead(200); response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const s3 = {
    enabled: true,
    endpoint: "http://127.0.0.1:" + server.address().port,
    region: "test-region",
    bucket: "isolated-bucket",
    prefix: "product-backup/lifeos",
    forcePathStyle: true,
    accessKeyId: "isolated-access",
    secretAccessKey: "isolated-secret",
  };
  return { root, snapshot, objects, s3 };
}

test("whole-instance offsite copy restores owner, member, identity and photos", async (t) => {
  const { root, snapshot, objects, s3 } = await fixture(t);
  assert.deepEqual(await checkInstanceDestination({ s3, allowInsecureLocal: true }),
    { private: true, bucket: s3.bucket, prefix: s3.prefix });
  assert.equal(objects.size, 0);
  const first = await uploadInstanceSnapshot({ snapshot, s3, allowInsecureLocal: true });
  assert.equal(first.fileCount, 5);
  assert.equal(first.uploaded, 5);
  assert.ok(first.manifestKey.startsWith(s3.prefix + "/instance-v1/manifests/"));
  const second = await uploadInstanceSnapshot({ snapshot, s3, allowInsecureLocal: true });
  assert.equal(second.uploaded, 0);
  assert.equal(second.reused, 5);
  assert.notEqual(second.manifestKey, first.manifestKey);
  assert.equal(objects.size, 7);
  const downloaded = join(root, "downloaded");
  await downloadInstanceSnapshot({ manifestKey: first.manifestKey, target: downloaded, s3, allowInsecureLocal: true });
  const restored = join(root, "restored");
  await restoreInstanceBackup({ snapshot: downloaded, target: restored });
  const identity = new DatabaseSync(join(restored, "identity.sqlite"), { readOnly: true });
  assert.equal(identity.prepare("SELECT value FROM identity_meta WHERE key = 'config_master_secret'").get().value, "isolated-test-master-secret-1234567890");
  identity.close();
  const member = new DatabaseSync(join(restored, "tenants", TENANT, "lifeos.sqlite"), { readOnly: true });
  assert.equal(member.prepare("SELECT value FROM record_probe").get().value, "member-original");
  member.close();
  assert.deepEqual(readFileSync(join(restored, "tenants", TENANT, "assets", "photo.bin")), Buffer.from([0, 1, 2, 3, 255]));
  await assert.rejects(() => downloadInstanceSnapshot({ manifestKey: first.manifestKey, target: downloaded, s3, allowInsecureLocal: true }), /已存在/);
});

test("remote backup refuses insecure transport, foreign keys and tampered data", async (t) => {
  const { root, snapshot, objects, s3 } = await fixture(t);
  await assert.rejects(() => uploadInstanceSnapshot({ snapshot, s3 }), /HTTPS/);
  const uploaded = await uploadInstanceSnapshot({ snapshot, s3, allowInsecureLocal: true });
  await assert.rejects(() => downloadInstanceSnapshot({ manifestKey: "someone-else/instance-v1/manifests/x.json", target: join(root, "foreign"), s3, allowInsecureLocal: true }), /不属于/);
  const objectKey = [...objects.keys()].find((key) => key.includes("/objects/"));
  const entry = objects.get(objectKey);
  objects.set(objectKey, { ...entry, body: Buffer.from("tampered") });
  const partial = join(root, "tampered");
  await assert.rejects(() => downloadInstanceSnapshot({ manifestKey: uploaded.manifestKey, target: partial, s3, allowInsecureLocal: true }), /校验失败/);
  assert.equal(existsSync(join(partial, "lifeos-instance-manifest.json")), false);
});

test("public-readable bucket is rejected before private bytes leave the machine", async (t) => {
  const { snapshot, objects, s3 } = await fixture(t, { publicRead: true });
  await assert.rejects(() => checkInstanceDestination({ s3, allowInsecureLocal: true }), /匿名读取/);
  await assert.rejects(() => uploadInstanceSnapshot({ snapshot, s3, allowInsecureLocal: true }), /匿名读取/);
  assert.equal(objects.size, 0);
});
