import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

async function fixture(t: TestContext, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-entity-details-"));
  const instance = createHttpServer(readConfig({ LIFEOS_HOST: "127.0.0.1", LIFEOS_DATA_DIR: join(root, "data"), LIFEOS_ASSET_ROOT: join(root, "assets"), LIFEOS_BACKUP_DIR: join(root, "backup"), ...extra }));
  await listenOnFetchablePort(instance.server);
  const address = instance.server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { instance.server.closeAllConnections(); await new Promise<void>(done => instance.server.close(() => done())); rmSync(root, { recursive: true, force: true }); });
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { ...instance, call };
}

test("person contact details round-trip through create, edits, export/import and explicit clearing without changing historical records", async t => {
  const source = await fixture(t), target = await fixture(t);
  const result = await source.call("/api/entities", { type: "person", name: "人物选填资料", phone: "13800000000", wechat: "test_wechat", residence: "虚构住址一号", aliases: ["旧称呼"] });
  assert.equal(result.status, 201); const person = result.body;
  const record = (await source.call("/api/records", { kind: "journal", content: "和旧称呼一起散步", entityRefs: [{ entityType: "person", entityId: person.id, label: "旧称呼" }] })).body;
  const bundle = (await source.call("/api/export?format=json")).body;
  assert.equal((await target.call("/api/import", { bundle })).status, 201);
  const imported = (await target.call(`/api/entities/${person.id}`)).body;
  for (const field of ["phone", "wechat", "residence"]) assert.equal(imported[field], person[field]);
  const edited = await source.call(`/api/entities/${person.id}`, { phone: "13900000000", wechat: "updated", residence: "新住址" }, "PATCH");
  assert.equal(edited.status, 200); assert.equal(edited.body.wechat, "updated");
  const cleared = await source.call(`/api/entities/${person.id}`, { phone: null, wechat: null, residence: null }, "PATCH");
  assert.equal(cleared.status, 200); for (const field of ["phone", "wechat", "residence"]) assert.equal(cleared.body[field], undefined);
  const after = (await source.call(`/api/records/${record.id}`)).body;
  assert.deepEqual(after.body, record.body); assert.deepEqual(after.entityRefs, record.entityRefs);
});

test("person-only fields reject wrong kinds, malformed and overlong values while old place fields remain valid", async t => {
  const h = await fixture(t);
  for (const data of [{ type: "place", wechat: "bad" }, { type: "project", phone: "bad" }, { type: "person", residence: {} }, { type: "person", residence: "字".repeat(501) }, { type: "person", phone: "1".repeat(201) }, { type: "person", role: "home" }]) {
    assert.equal((await h.call("/api/entities", { name: "不合法的资料", ...data })).status, 400);
  }
  assert.equal((await h.call("/api/entities", { type: "person", name: "没有选填字段" })).status, 201);
  const place = await h.call("/api/entities", { type: "place", name: "原有地点", phone: "075712345678", address: "原地址", period: { from: "2020-01" } });
  assert.equal(place.status, 201); assert.equal(place.body.period.from, "2020-01");
});

test("role recommendations prefer category, degrade without keys, isolate AI input and reject personal-context or malformed suggestions", async t => {
  let output = '{"role":"展览馆"}', calls = 0; const payloads: any[] = [];
  const fake = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); payloads.push(JSON.parse(Buffer.concat(chunks).toString())); calls++;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
  });
  await listenOnFetchablePort(fake); const address = fake.address(); assert(address && typeof address !== "string");
  t.after(async () => { fake.closeAllConnections(); await new Promise<void>(done => fake.close(() => done())); });
  const h = await fixture(t, { LIFEOS_DEEPSEEK_API_KEY: "fake-only-key", LIFEOS_DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}` });
  const route = "/api/places/role-suggestion";
  const mapped = await h.call(route, { name: "隔离咖啡店", address: "测试街道", category: "餐饮服务;咖啡厅" });
  assert.equal(mapped.status, 200); assert.equal(mapped.body.role, "咖啡馆"); assert.equal(calls, 0);
  const ai = await h.call(route, { name: "无分类场馆", address: "虚构街一号" });
  assert.equal(ai.body.role, "展览馆"); assert.equal(ai.body.source, "ai"); assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(payloads[0].messages[1].content), { name: "无分类场馆", address: "虚构街一号", category: "" });
  await h.call(route, { name: "无分类场馆", address: "虚构街一号" }); assert.equal(calls, 1, "same inputs reuse the suggestion");
  output = '{"role":"工作地点"}'; assert.equal((await h.call(route, { name: "其他地方", address: "虚构街二号" })).body.role, null);
  output = 'not json'; assert.equal((await h.call(route, { name: "其他地方", address: "虚构街三号" })).body.role, null);
  assert.equal((await h.call(route, { name: "测试", address: "地址", phone: "private" })).status, 400);
  const noKey = await fixture(t);
  assert.equal((await noKey.call(route, { name: "未知场所", address: "测试街道" })).body.role, null);
  assert.equal((await noKey.call(route, { name: "未知场所", address: "医院路一号" })).body.role, null, "street names do not imply venue type");
});
