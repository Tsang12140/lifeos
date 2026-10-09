import test from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PoolTransition, decryptTransitionSnapshot } from "../src/pool-transition.js";
import { StoragePoolStore } from "../src/storage-pool-store.js";
import { StoragePoolError, type PoolConsumerBridge } from "../src/storage-pool.js";
import { SqliteRecordRepository } from "../src/repository.js";
import { spaceFingerprint } from "../src/portable-space.js";
import { AssetGcScheduler } from "../src/asset-gc-scheduler.js";
import { readConfig } from "../src/config.js";

class FakePool {
  objects = new Map<string,Buffer>(); puts = 0; traffic = 0; corrupt = false; uncertain = false;
  async usage() { const used = [...this.objects.values()].reduce((n,b)=>n+b.length,0); return { consumer:"2",storage_used:used,storage_limit:100000000,storage_free:100000000-used,traffic_month:new Date().toISOString().slice(0,7),traffic_used:this.traffic,traffic_limit:100000000,traffic_free:100000000-this.traffic }; }
  async putFile(path: string) { const key = `object-${++this.puts}`; this.objects.set(key,readFileSync(path)); if(this.uncertain) throw new StoragePoolError("timeout","uncertain",503,key,true); return { key }; }
  async downloadToFile(key: string,path: string) { const body = this.objects.get(key)!; writeFileSync(path,this.corrupt ? Buffer.alloc(body.length,0) : body); this.traffic += body.length; return { bytes:body.length,month:new Date().toISOString().slice(0,7) }; }
}
async function idle(service: PoolTransition) { for(let i=0;i<300;i++){if(!service.snapshot().busy)return;await new Promise(r=>setTimeout(r,10));}throw Error("transition did not settle"); }
function fixture(localPrimaryAtBoot = false, oldSettings = false) {
  const root = mkdtempSync(join(tmpdir(),"lifeos-transition-test-")); const assets = join(root,"assets"); mkdirSync(assets);
  if(oldSettings){
    mkdirSync(join(root,"pool-transition"));const old=new DatabaseSync(join(root,"pool-transition","jobs.sqlite"));
    old.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL,local_primary INTEGER NOT NULL); INSERT INTO settings VALUES(1,0,1)");old.close();
  }
  const repository = new SqliteRecordRepository(join(root,"lifeos.sqlite"));
  const ledger = new StoragePoolStore(join(root,"ledger.sqlite")); const pool = new FakePool();
  const bytes = Buffer.from("original fixture photo bytes"); writeFileSync(join(assets,"old.jpg"),bytes);
  repository.insertAsset({ id:"old",kind:"photo",mediaType:"image/jpeg",sizeBytes:bytes.length,storageRefs:[{sourceId:"local",sourceRef:"old.jpg",contentHash:{algorithm:"sha256",value:createHash("sha256").update(bytes).digest("hex")}}] });
  ledger.saveQuota("owner",{storageLimitBytes:50000000,trafficLimitBytes:50000000},100000000,100000000);
  const spaces = [{accountId:"owner",databasePath:join(root,"lifeos.sqlite"),assetRoot:assets}];
  const make = () => new PoolTransition(root,pool as unknown as PoolConsumerBridge,ledger,()=>spaces,"stable-test-master-secret",localPrimaryAtBoot);
  const extras: SqliteRecordRepository[] = [];
  let service = make();
  return {root,assets,repository,ledger,pool,bytes,spaces,extras,get service(){return service;},restart:async()=>{await idle(service);service.close();service=make();},
    stop:async()=>{await idle(service);service.close();ledger.close();repository.close();for(const extra of extras)extra.close();if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error("unsafe cleanup");rmSync(root,{recursive:true,force:true});} };
}

test("deployment protection keeps local primary before the pool can be contacted",async t=>{
  const f=fixture(true);t.after(f.stop);
  ok(f.service.localPrimary);equal(f.service.enabled,false);equal(f.pool.puts,0);
  f.service.setEnabled(false);await f.restart();ok(f.service.localPrimary);equal(f.pool.puts,0);
});

test("existing transition settings upgrade without losing paused local protection",async t=>{
  const f=fixture(false,true);t.after(f.stop);
  equal(f.service.enabled,false);ok(f.service.localPrimary);equal(f.service.accountIds,null);equal(f.pool.puts,0);
  f.service.setEnabled(true,["owner"]);await idle(f.service);equal(f.service.snapshot().counts.verified,2);
  f.service.setEnabled(false);await f.restart();ok(f.service.localPrimary);deepEqual(f.service.accountIds,["owner"]);equal(f.pool.puts,2);
});

test("account-scoped copying and retry preserve other users and survive pause/restart",async t=>{
  const f=fixture();t.after(f.stop);
  const memberRoot=join(f.root,"member");mkdirSync(join(memberRoot,"assets"),{recursive:true});
  const member=new SqliteRecordRepository(join(memberRoot,"lifeos.sqlite"));f.extras.push(member);
  writeFileSync(join(memberRoot,"assets","member.jpg"),f.bytes);member.insertAsset({id:"member-photo",kind:"photo",storageRefs:[{sourceId:"local",sourceRef:"member.jpg"}]});
  f.spaces.push({accountId:"member",databasePath:join(memberRoot,"lifeos.sqlite"),assetRoot:join(memberRoot,"assets")});
  f.ledger.saveQuota("member",{storageLimitBytes:50000000,trafficLimitBytes:50000000},100000000,100000000);
  f.service.setEnabled(true,["member"]);await idle(f.service);
  equal(f.pool.puts,2);equal(f.service.snapshot().counts.verified,2);deepEqual(f.service.snapshot().accountIds,["member"]);
  equal(f.ledger.usage("owner",new Date().toISOString().slice(0,7)).storageUsedBytes,0);
  f.service.setEnabled(false);await f.restart();deepEqual(f.service.accountIds,["member"]);
  f.service.setEnabled(true);await idle(f.service);equal(f.pool.puts,2,"resume never broadens the account scope");
  await rejects(async()=>f.service.setEnabled(true,["unknown"]));deepEqual(f.service.accountIds,["member"]);
  f.ledger.saveQuota("owner",{storageLimitBytes:0,trafficLimitBytes:0},100000000,100000000);
  f.service.setEnabled(true,null);await idle(f.service);equal(f.service.snapshot().counts.failed,2);
  f.service.setEnabled(true,["member"]);await idle(f.service);f.service.retry();await idle(f.service);
  equal(f.service.snapshot().counts.failed,0,"status is scoped to the selected test account");
  f.service.setEnabled(false,null);equal(f.service.snapshot().counts.failed,2,"retry did not requeue another account's failures");
  deepEqual(readFileSync(join(f.assets,"old.jpg")),f.bytes);
});

test("transition copies owner/member/trash and encrypted business data without replacing originals",async t=>{
  const f=fixture();t.after(f.stop);
  f.repository.insert({id:"private",kind:"journal",body:{original:"私密日记保留全文"},createdAt:{kind:"instant",value:"2026-10-07T00:00:00.000Z"},entityRefs:[],relatedRecordIds:[],assetRefs:[{assetId:"old",role:"photo"}],aiDerived:[],isPrivate:true});
  mkdirSync(join(f.assets,"uploads","_orphan-trash"),{recursive:true});writeFileSync(join(f.assets,"uploads","_orphan-trash","deleted.jpg"),f.bytes);
  f.repository.insertAssetTrash({asset:{id:"trashed",kind:"photo",storageRefs:[{sourceId:"local",sourceRef:"uploads/deleted.jpg"}]},origin:"asset-delete",relativePath:"uploads/deleted.jpg",trashedAt:"2026-10-07T00:00:00.000Z"});
  const memberRoot=join(f.root,"member");mkdirSync(join(memberRoot,"assets"),{recursive:true});const member=new SqliteRecordRepository(join(memberRoot,"lifeos.sqlite"));f.extras.push(member);
  writeFileSync(join(memberRoot,"assets","member.jpg"),f.bytes);member.insertAsset({id:"member-photo",kind:"photo",storageRefs:[{sourceId:"local",sourceRef:"member.jpg"}]});
  f.spaces.push({accountId:"member",databasePath:join(memberRoot,"lifeos.sqlite"),assetRoot:join(memberRoot,"assets")});
  f.ledger.saveQuota("member",{storageLimitBytes:50000000,trafficLimitBytes:50000000},100000000,100000000);
  const before=spaceFingerprint(f.repository.portableSpace());const memberBefore=spaceFingerprint(member.portableSpace());
  f.service.setEnabled(true);await idle(f.service);equal(f.service.snapshot().counts.verified,5);equal(f.service.snapshot().counts.failed,0);
  equal(spaceFingerprint(f.repository.portableSpace()),before);equal(spaceFingerprint(member.portableSpace()),memberBefore);
  deepEqual(readFileSync(join(f.assets,"old.jpg")),f.bytes);ok(existsSync(join(f.assets,"uploads","_orphan-trash","deleted.jpg")));
  const encrypted=[...f.pool.objects.values()].find(body=>body.subarray(0,18).toString().startsWith("LIFEOS-POOL-SPACE"))!;ok(encrypted);ok(!encrypted.includes(Buffer.from("私密日记")));
  const restored=decryptTransitionSnapshot(encrypted,"owner","stable-test-master-secret");equal(spaceFingerprint(restored),before);
  await rejects(async()=>decryptTransitionSnapshot(encrypted,"member","stable-test-master-secret"));
  const broken=Buffer.from(encrypted);broken[broken.length-1]=broken[broken.length-1]!^1;await rejects(async()=>decryptTransitionSnapshot(broken,"owner","stable-test-master-secret"));
  const puts=f.pool.puts;f.service.wake();await idle(f.service);equal(f.pool.puts,puts,"rescan is idempotent");
  f.service.setEnabled(false);ok(f.service.localPrimary,"pause retains local writes");await f.restart();ok(f.service.localPrimary);equal(f.service.enabled,false);
});

test("failed verification retries the same object and charges actual downloads",async t=>{
  const f=fixture();t.after(f.stop);f.pool.corrupt=true;f.service.setEnabled(true);await idle(f.service);
  equal(f.service.snapshot().counts.failed,2);const puts=f.pool.puts;const traffic=f.pool.traffic;
  f.pool.corrupt=false;f.service.retry();await idle(f.service);equal(f.service.snapshot().counts.verified,2);equal(f.pool.puts,puts);ok(f.pool.traffic>traffic);
  equal(f.ledger.usage("owner",new Date().toISOString().slice(0,7)).trafficUsedBytes,f.pool.traffic);
  deepEqual(readFileSync(join(f.assets,"old.jpg")),f.bytes);
});

test("ambiguous upload remains pending across retry/restart without duplicate upload",async t=>{
  const f=fixture();t.after(f.stop);f.pool.uncertain=true;f.service.setEnabled(true);await idle(f.service);
  equal(f.service.snapshot().counts.pending,2);const puts=f.pool.puts;
  f.pool.uncertain=false;f.service.retry();await idle(f.service);equal(f.pool.puts,puts);await f.restart();f.service.wake();await idle(f.service);equal(f.pool.puts,puts);
  ok(f.ledger.usage("owner",new Date().toISOString().slice(0,7)).storageReservedBytes>0);deepEqual(readFileSync(join(f.assets,"old.jpg")),f.bytes);
});

test("missing originals and insufficient quota remain visible, GC is held during transition",async t=>{
  const f=fixture();t.after(f.stop);f.repository.insertAsset({id:"missing",kind:"photo",storageRefs:[{sourceId:"local",sourceRef:"missing.jpg"}]});
  f.ledger.saveQuota("owner",{storageLimitBytes:0,trafficLimitBytes:0},100000000,100000000);f.service.setEnabled(true);await idle(f.service);
  equal(f.service.snapshot().counts.failed,3);equal(f.pool.puts,0);ok(f.service.snapshot().issues.some(row=>row.error==="local_source_unavailable"));
  const scheduler=new AssetGcScheduler({repository:f.repository,config:readConfig({LIFEOS_DATA_DIR:f.root,LIFEOS_ASSET_ROOT:f.assets}),canRun:()=>!f.service.localPrimary});
  equal(scheduler.runOnce(new Date(Date.now()+400*86400000)),null);ok(existsSync(join(f.assets,"old.jpg")));
});

test("single-photo read canary preserves references, copy accounting and local writes across restart",async t=>{
  const f=fixture();t.after(f.stop);
  const asset=f.repository.findAssetById("old")!;
  await rejects(f.service.startReadCanary("owner",asset),/副本未验证/);
  f.service.setEnabled(true,["owner"]);await idle(f.service);
  const before=spaceFingerprint(f.repository.portableSpace()),traffic=f.pool.traffic,puts=f.pool.puts;
  await f.service.startReadCanary("owner",asset);
  const selected=f.service.selectedRead("owner",asset)!;
  ok(selected.ledgerAssetId.startsWith("transition:"));
  equal(f.ledger.poolObject("owner",asset.id,selected.reference.sourceRef),null,"the original business ID is not the copy's ledger ID");
  equal(f.ledger.poolObject("owner",selected.ledgerAssetId,selected.reference.sourceRef)?.state,"ready");
  equal(f.service.selectedRead("member",asset),null,"equal asset IDs cannot cross accounts");
  equal(f.service.selectedRead("owner",{...asset,id:"different"}),null);
  equal(f.service.snapshot().stage,"read_canary");
  await f.service.startReadCanary("owner",asset);equal(f.pool.puts,puts);equal(f.pool.traffic,traffic);
  equal(spaceFingerprint(f.repository.portableSpace()),before);deepEqual(readFileSync(join(f.assets,"old.jpg")),f.bytes);
  const other={...asset,id:"other"};f.repository.insertAsset(other);
  f.service.wake();await idle(f.service);
  await rejects(f.service.startReadCanary("owner",other),/已有一张照片/);
  f.repository.deleteAsset("other");
  f.service.setEnabled(false);await f.restart();ok(f.service.selectedRead("owner",asset));ok(f.service.localPrimary);
  f.service.stopReadCanary();f.service.stopReadCanary();await f.restart();equal(f.service.selectedRead("owner",asset),null);
  equal(f.service.snapshot().stage,"copy_only");equal(spaceFingerprint(f.repository.portableSpace()),before);
});

test("read canary refuses changed references, original bytes and unowned copy rows",async t=>{
  const f=fixture();t.after(f.stop);
  f.service.setEnabled(true,["owner"]);await idle(f.service);
  const asset=f.repository.findAssetById("old")!;
  await rejects(f.service.startReadCanary("member",asset),/复制范围/);
  await rejects(f.service.startReadCanary("owner",{...asset,kind:"file"}),/本地照片/);
  await f.service.startReadCanary("owner",asset);
  await rejects(async()=>f.service.selectedRead("owner",{...asset,storageRefs:[{sourceId:"local",sourceRef:"different.jpg"}]}),/原件已变化/);
  const db=new DatabaseSync(join(f.root,"ledger.sqlite"));
  db.prepare("UPDATE storage_pool_objects SET account_id='member' WHERE asset_id LIKE 'transition:%'").run();
  await rejects(async()=>f.service.selectedRead("owner",asset),/对象账目不符/);
  db.prepare("UPDATE storage_pool_objects SET account_id='owner' WHERE asset_id LIKE 'transition:%'").run();db.close();
  writeFileSync(join(f.assets,"old.jpg"),Buffer.alloc(f.bytes.length,1));
  await rejects(async()=>f.service.selectedRead("owner",asset),/原件已变化/);
  f.service.stopReadCanary();equal(f.service.selectedRead("owner",asset),null,"rollback never requires a healthy source or provider");
});
