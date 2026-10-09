import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertValidAsset, VIDEO_LIMITS, type Asset } from "@lifeos/core";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { clearVideoDownloadCache, readVideoMetadata, videoByteRange } from "../src/video-assets.js";

const fixturePath = new URL("../../test/fixtures/video-avc-aac.mp4", import.meta.url);
const fixture = readFileSync(fixturePath);
test("video metadata and byte ranges reject invalid limits instead of trusting client claims", async () => {
  const metadata = await readVideoMetadata(fileURLToPath(fixturePath));
  assert.equal(metadata.videoCodec, "avc"); assert.equal(metadata.audioCodec, "aac"); assert.equal(metadata.width, 64);
  const asset: Asset = { id: "video", kind: "video", mediaType: "video/mp4", sizeBytes: fixture.length, videoMetadata: metadata, storageRefs: [] };
  assertValidAsset(asset);
  for (const bad of [{ width: 3840 }, { height: 2000 }, { durationSeconds: Infinity }, { durationSeconds: 181 }, { frameRate: 60 }, { audioCodec: "opus" }]) assert.throws(() => assertValidAsset({ ...asset, videoMetadata: { ...metadata, ...bad } }));
  assert.throws(() => assertValidAsset({ ...asset, sizeBytes: VIDEO_LIMITS.maxOutputBytes + 1 }));
  assert.throws(() => assertValidAsset({ ...asset, videoMetadata: undefined }));
  assert.deepEqual(videoByteRange("bytes=3-8", 10), { start: 3, end: 8 });
  assert.deepEqual(videoByteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(videoByteRange("bytes=3-", 10), { start: 3, end: 9 });
  assert.deepEqual(videoByteRange("bytes=3-99", 10), { start: 3, end: 9 });
  for (const range of ["bytes=10-", "bytes=4-3", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "bytes=9007199254740992-", "nonsense"]) assert.throws(() => videoByteRange(range, 10));
});

test("isolated video HTTP upload validates bytes, deduplicates and supports authenticated seeking", async t => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-video-http-"));
  const config = readConfig({ LIFEOS_HOST: "127.0.0.1", LIFEOS_DATA_DIR: join(root,"data"), LIFEOS_ASSET_ROOT: join(root,"assets"), LIFEOS_BACKUP_DIR: join(root,"backups") });
  const current = createHttpServer(config); current.server.listen(0,"127.0.0.1"); await once(current.server,"listening");
  const address = current.server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { clearVideoDownloadCache(); current.server.closeAllConnections(); await new Promise<void>(done => current.server.close(()=>done())); assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)); rmSync(root,{recursive:true,force:true}); });
  const upload = (body: Buffer, mediaType = "video/mp4") => fetch(base+"/api/assets/videos?name=test.mp4",{method:"POST",headers:{"content-type":mediaType},body});
  assert.equal((await upload(fixture,"video/webm")).status,415);
  assert.equal((await upload(Buffer.from("not mp4"))).status,415);
  assert.equal((await upload(Buffer.alloc(0))).status,400);
  const oversized = await new Promise<number>((done,reject) => { const req=httpRequest(base+"/api/assets/videos",{method:"POST",headers:{"content-type":"video/mp4","content-length":String(VIDEO_LIMITS.maxOutputBytes+1)}},res=>{res.resume();res.on("end",()=>done(res.statusCode!));});req.on("error",reject);req.end(); });
  assert.equal(oversized,413);
  const first = await upload(fixture); assert.equal(first.status,201); const asset = await first.json() as Asset; assertValidAsset(asset);
  const duplicate = await upload(fixture); assert.equal(duplicate.status,201); assert.equal((await duplicate.json() as Asset).id,asset.id);
  const generic=await fetch(base+"/api/assets",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(asset)}); assert.equal(generic.status,400);
  const patched=await fetch(base+`/api/assets/${asset.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({sizeBytes:1})}); assert.equal(patched.status,409);
  const record=await fetch(base+"/api/records",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"journal",content:"视频契约",assetRefs:[{assetId:asset.id,role:"video"}]})}); assert.equal(record.status,201); assert.equal((await record.json() as {assetRefs:{role:string}[]}).assetRefs[0]!.role,"video");
  const path=base+`/api/assets/${asset.id}/video`;
  const head=await fetch(path,{method:"HEAD"}); assert.equal(head.status,200); assert.equal(head.headers.get("content-length"),String(fixture.length)); assert.equal(head.headers.get("accept-ranges"),"bytes"); assert.match(head.headers.get("cache-control")!,/no-store/);
  const etag=head.headers.get("etag")!;
  for (const [range,start,end] of [["bytes=0-15",0,15],["bytes=-17",fixture.length-17,fixture.length-1],["bytes=20-",20,fixture.length-1],[`bytes=${fixture.length-5}-999999`,fixture.length-5,fixture.length-1]] as const) {
    const result=await fetch(path,{headers:{range}}); assert.equal(result.status,206); assert.equal(result.headers.get("content-range"),`bytes ${start}-${end}/${fixture.length}`); assert.deepEqual(Buffer.from(await result.arrayBuffer()),fixture.subarray(start,end+1));
  }
  assert.equal((await fetch(path,{headers:{range:"bytes=999999-"}})).status,416);
  assert.equal((await fetch(path,{headers:{range:"bytes=0-1,3-4"}})).status,416);
  assert.equal((await fetch(path,{headers:{"if-none-match":etag}})).status,304);
  assert.equal((await fetch(path,{headers:{range:"bytes=0-9","if-range":"different"}})).status,200);
  const full=await fetch(base+`/api/assets/${asset.id}/content`); assert.deepEqual(Buffer.from(await full.arrayBuffer()),fixture);
});

test("pool video upload bypasses historical local-primary mode and charges one coalesced download with tenant isolation", async t => {
  const root=mkdtempSync(join(tmpdir(),"lifeos-video-pool-")), statePath=join(root,"worker.json"),workerPath=join(root,"worker.mjs");
  writeFileSync(statePath,JSON.stringify({objects:{},traffic:0,puts:0,corrupt:false}));
  writeFileSync(workerPath,`
    import {randomUUID} from 'node:crypto'; import {readFileSync,writeFileSync} from 'node:fs';
    const statePath=${JSON.stringify(statePath)},root=${JSON.stringify(root)};
    let raw='';for await(const part of process.stdin)raw+=part;
    const req=JSON.parse(raw),s=JSON.parse(readFileSync(statePath,'utf8'));
    const send=result=>process.stdout.write(JSON.stringify({ok:true,result})+'\\n');
    const fail=code=>process.stdout.write(JSON.stringify({ok:false,error:{code}})+'\\n');
    const save=()=>writeFileSync(statePath,JSON.stringify(s)),used=Object.values(s.objects).reduce((n,x)=>n+x.bytes,0),month=new Date().toISOString().slice(0,7),limit=100000000;
    if(req.op==='usage')send({consumer:'2',storage_used:used,storage_limit:limit,storage_free:limit-used,traffic_month:month,traffic_used:s.traffic,traffic_limit:limit,traffic_free:limit-s.traffic});
    else if(req.op==='put'){const b=readFileSync(req.path),key='pool/2/'+randomUUID(),file=root+'/'+randomUUID()+'.object';writeFileSync(file,b);s.objects[key]={file,bytes:b.length};s.puts++;save();send({key});}
    else if(req.op==='download'){const x=s.objects[req.key];if(!x)fail('download_rejected');else{writeFileSync(req.path,s.corrupt?Buffer.alloc(x.bytes):readFileSync(x.file));s.traffic+=x.bytes;save();send({month,bytes:x.bytes});}}
    else fail('invalid_request');
  `);
  const vars={LIFEOS_STORAGE_POOL_ENABLED:"1",LIFEOS_POOL_LOCAL_PRIMARY:"1",LIFEOS_POOL_CONSUMER:"2",LIFEOS_POOL_PHP_BINARY:process.execPath,LIFEOS_POOL_WORKER_PATH:workerPath,LIFEOS_LOG_DIR:join(root,"logs")};
  const previous=Object.fromEntries(Object.keys(vars).map(key=>[key,process.env[key]]));Object.assign(process.env,vars);
  const config=readConfig({LIFEOS_HOST:"127.0.0.1",LIFEOS_ACCOUNT_MODE:"1",LIFEOS_OWNER_USERNAME:"owner",LIFEOS_PASSWORD:"isolated-video-password",LIFEOS_DATA_DIR:join(root,"data"),LIFEOS_ASSET_ROOT:join(root,"assets"),LIFEOS_BACKUP_DIR:join(root,"backups"),LIFEOS_ALLOWED_ORIGINS:"http://127.0.0.1:3097",LIFEOS_COOKIE_SECURE:"false"});
  const current=createHttpServer(config);current.server.listen(0,"127.0.0.1");await once(current.server,"listening");const address=current.server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{clearVideoDownloadCache();current.server.closeAllConnections();await new Promise<void>(done=>current.server.close(()=>done()));for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
  let cookie="";
  async function json(path:string,method="GET",body?:unknown,auth=cookie){const response=await fetch(base+path,{method,headers:{...(auth?{cookie:auth}:{}),...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,value:await response.json() as any};}
  const login=await json("/api/auth/login","POST",{username:"owner",password:"isolated-video-password"});assert.equal(login.response.status,200);cookie=login.response.headers.get("set-cookie")!.split(";")[0]!;
  const storage=await json("/api/admin/storage-pool"),ownerId=storage.value.users.find((u:any)=>u.role==="owner").accountId;
  assert.equal((await json(`/api/admin/accounts/${ownerId}/pool-quota`,"PUT",{storageLimitBytes:fixture.length*3,trafficLimitBytes:fixture.length*3})).response.status,200);
  const upload=await fetch(base+"/api/assets/videos?name=pool.mp4",{method:"POST",headers:{cookie,"content-type":"video/mp4"},body:fixture});assert.equal(upload.status,201,await upload.clone().text());const asset=await upload.json() as Asset;
  assert.equal(asset.storageRefs[0]!.sourceId,"lifeos-pool");
  const state=()=>JSON.parse(readFileSync(statePath,"utf8"));assert.deepEqual(readFileSync(state().objects[asset.storageRefs[0]!.sourceRef].file),fixture);assert.equal(state().puts,1);
  assert.equal((await fetch(base+`/api/assets/${asset.id}/video`)).status,401);
  const member=await json("/api/admin/accounts","POST",{username:"member",password:"isolated-member-password",displayName:"Member",spaceName:"Member"});assert.equal(member.response.status,201);
  const memberLogin=await json("/api/auth/login","POST",{username:"member",password:"isolated-member-password"},"");const memberCookie=memberLogin.response.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await fetch(base+`/api/assets/${asset.id}/video`,{headers:{cookie:memberCookie}})).status,404);
  const path=base+`/api/assets/${asset.id}/video`;
  assert.equal((await fetch(path,{method:"HEAD",headers:{cookie}})).status,200); assert.equal(state().traffic,0);
  assert.equal((await fetch(path,{headers:{cookie,range:"bytes=999999-"}})).status,416); assert.equal(state().traffic,0);
  // Concurrent suffix/range probes share one upstream transfer and one quota reservation.
  const responses=await Promise.all([fetch(path,{headers:{cookie,range:"bytes=0-15"}}),fetch(path,{headers:{cookie,range:"bytes=-16"}})]);
  assert.equal(responses[0]!.status,206);assert.deepEqual(Buffer.from(await responses[0]!.arrayBuffer()),fixture.subarray(0,16));assert.deepEqual(Buffer.from(await responses[1]!.arrayBuffer()),fixture.subarray(-16));assert.equal(state().traffic,fixture.length);
  const full=await fetch(path,{headers:{cookie}});assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),fixture);assert.equal(state().traffic,fixture.length);
  const duplicate=await fetch(base+"/api/assets/videos",{method:"POST",headers:{cookie,"content-type":"video/mp4"},body:fixture});assert.equal((await duplicate.json() as Asset).id,asset.id);assert.equal(state().puts,1);
  clearVideoDownloadCache();writeFileSync(statePath,JSON.stringify({...state(),corrupt:true}));const corrupt=await fetch(path,{headers:{cookie}});assert.equal(corrupt.status,502);assert.equal(state().traffic,fixture.length*2,"corrupt upstream bytes are still charged");
  writeFileSync(statePath,JSON.stringify({...state(),corrupt:false}));
  assert.equal((await json(`/api/admin/accounts/${ownerId}/pool-quota`,"PUT",{storageLimitBytes:fixture.length*3,trafficLimitBytes:fixture.length*2})).response.status,200);
  const overQuota=await fetch(path,{headers:{cookie}});assert.equal(overQuota.status,409);assert.equal(state().traffic,fixture.length*2);
});
