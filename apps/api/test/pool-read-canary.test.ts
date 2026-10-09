import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Asset } from "@lifeos/core";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { PoolConsumerBridge } from "../src/storage-pool.js";

test("HTTP canary authenticates, reads verified copies, reuses previews, charges failures and rolls back offline",async t=>{
  const root=mkdtempSync(join(tmpdir(),"lifeos-read-canary-"));
  const statePath=join(root,"worker.json"),workerPath=join(root,"worker.mjs");
  writeFileSync(statePath,JSON.stringify({objects:{},traffic:0,offline:false,corrupt:false,puts:0}));
  writeFileSync(workerPath,`
    import {randomUUID} from 'node:crypto';
    import {readFileSync,writeFileSync} from 'node:fs';
    const statePath=${JSON.stringify(statePath)},root=${JSON.stringify(root)};
    let raw='';for await(const part of process.stdin)raw+=part;
    const req=JSON.parse(raw),s=JSON.parse(readFileSync(statePath,'utf8'));
    const send=result=>process.stdout.write(JSON.stringify({ok:true,result})+'\\n');
    const fail=code=>process.stdout.write(JSON.stringify({ok:false,error:{code}})+'\\n');
    const save=()=>writeFileSync(statePath,JSON.stringify(s));
    const used=Object.values(s.objects).reduce((n,x)=>n+x.bytes,0),month=new Date().toISOString().slice(0,7),limit=100000000;
    if(s.offline)fail('configuration_missing');
    else if(req.op==='usage')send({consumer:'2',storage_used:used,storage_limit:limit,storage_free:limit-used,traffic_month:month,traffic_used:s.traffic,traffic_limit:limit,traffic_free:limit-s.traffic});
    else if(req.op==='put'){const b=readFileSync(req.path),key='pool/2/'+randomUUID(),file=root+'/'+randomUUID()+'.object';writeFileSync(file,b);s.objects[key]={file,bytes:b.length};s.puts++;save();send({key});}
    else if(req.op==='download'){const x=s.objects[req.key];if(!x)fail('download_rejected');else{writeFileSync(req.path,s.corrupt?Buffer.alloc(x.bytes,0):readFileSync(x.file));s.traffic+=x.bytes;save();send({month,bytes:x.bytes});}}
    else fail('invalid_request');
  `);
  const vars={LIFEOS_STORAGE_POOL_ENABLED:"1",LIFEOS_POOL_LOCAL_PRIMARY:"1",LIFEOS_POOL_CONSUMER:"2",LIFEOS_POOL_PHP_BINARY:process.execPath,LIFEOS_POOL_WORKER_PATH:workerPath,LIFEOS_LOG_DIR:join(root,"logs")};
  const previous=Object.fromEntries(Object.keys(vars).map(key=>[key,process.env[key]]));Object.assign(process.env,vars);
  const config=readConfig({LIFEOS_HOST:"127.0.0.1",LIFEOS_ACCOUNT_MODE:"1",LIFEOS_OWNER_USERNAME:"owner",LIFEOS_PASSWORD:"isolated-canary-password",LIFEOS_DATA_DIR:join(root,"data"),LIFEOS_ASSET_ROOT:join(root,"assets"),LIFEOS_BACKUP_DIR:join(root,"backups"),LIFEOS_ALLOWED_ORIGINS:"https://lifeos.dnbox.cn",LIFEOS_COOKIE_SECURE:"true"});
  let current: ReturnType<typeof createHttpServer> | undefined,base="",cookie="";
  const state=()=>JSON.parse(readFileSync(statePath,"utf8"));
  const change=(value: Record<string,unknown>)=>writeFileSync(statePath,JSON.stringify({...state(),...value}));
  async function stop(){if(current?.server.listening){current.server.closeAllConnections();current.server.close();await once(current.server,"close");}}
  t.after(async()=>{await stop();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
  async function call(path: string,method="GET",body?: unknown,auth=cookie){
    const response=await fetch(base+path,{method,headers:{...(auth?{cookie:auth}:{}),...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value: any=(response.headers.get("content-type")??"").includes("json")?await response.json():Buffer.from(await response.arrayBuffer());
    return {status:response.status,value,headers:response.headers};
  }
  async function boot(){current=createHttpServer(config);current.server.listen(0,"127.0.0.1");await once(current.server,"listening");const address=current.server.address();assert.ok(address&&typeof address!=="string");base=`http://127.0.0.1:${address.port}`;const login=await call("/api/auth/login","POST",{username:"owner",password:"isolated-canary-password"},"");assert.equal(login.status,200);cookie=login.headers.get("set-cookie")!.split(";")[0]!;}
  async function idle(){for(let i=0;i<300;i++){const result=await call("/api/admin/storage-pool/transition");if(!result.value.busy)return result.value;await new Promise(r=>setTimeout(r,20));}throw Error("copy did not settle");}
  await new PoolConsumerBridge().usage();
  await boot();
  const path="/api/admin/storage-pool/read-canary";
  assert.equal((await call(path,"PUT",{assetId:"missing"},"")).status,401);
  const member=await call("/api/admin/accounts","POST",{username:"member",password:"isolated-member-password",displayName:"Member",spaceName:"Member"});assert.equal(member.status,201);
  const memberLogin=await call("/api/auth/login","POST",{username:"member",password:"isolated-member-password"},"");const memberCookie=memberLogin.headers.get("set-cookie")!.split(";")[0]!;
  for(const method of ["GET","PUT","DELETE"])assert.equal((await call(path,method,method==="PUT"?{assetId:"missing"}:undefined,memberCookie)).status,403);
  const poolBefore=await call("/api/admin/storage-pool");assert.equal(poolBefore.status,200,JSON.stringify(poolBefore.value));const ownerId=poolBefore.value.users.find((user: {role: string})=>user.role==="owner").accountId;
  assert.equal((await call(`/api/admin/accounts/${ownerId}/pool-quota`,"PUT",{storageLimitBytes:50000000,trafficLimitBytes:50000000})).status,200);
  const original=await sharp({create:{width:2400,height:1600,channels:3,background:{r:75,g:110,b:140}}}).jpeg().toBuffer();
  async function upload(auth: string){const response=await fetch(base+"/api/assets/uploads?name=canary.jpg",{method:"POST",headers:{cookie:auth,"content-type":"image/jpeg"},body:original});assert.equal(response.status,201);return await response.json() as Asset;}
  const asset=await upload(cookie),memberAsset=await upload(memberCookie);
  assert.equal((await call(path,"PUT",{assetId:memberAsset.id})).status,404,"owner endpoint resolves only its own photo");
  assert.equal((await call(path,"PUT",{assetId:asset.id})).status,409,"unverified photo refused");
  assert.equal((await call("/api/admin/storage-pool/transition","POST",{action:"start",accountIds:[ownerId]})).status,200);
  assert.equal((await idle()).counts.verified,2);
  const puts=state().puts,traffic=state().traffic;
  const started=await call(path,"PUT",{assetId:asset.id});assert.equal(started.status,200);assert.equal(started.value.delivery,"server-proxy");assert.equal(state().traffic,traffic);
  const content=await call(`/api/assets/${asset.id}/content`);assert.equal(content.status,200);assert.deepEqual(content.value,original);assert.equal(content.headers.get("x-lifeos-asset-source"),"pool");assert.equal(content.headers.get("cache-control"),"no-store");assert.equal(state().traffic,traffic+original.length);
  const preview=await call(`/api/assets/${asset.id}/thumbnail?w=2048`);assert.equal(preview.status,200);assert.equal(preview.headers.get("x-lifeos-asset-source"),"pool-derived");
  const dimensions=await sharp(preview.value).metadata();assert.equal(dimensions.width,2048);assert.ok(dimensions.height!>0&&dimensions.height!<=2048);assert.ok(preview.value.length<original.length);
  const afterPreview=state().traffic;
  const cached=await call(`/api/assets/${asset.id}/thumbnail?w=2048`);assert.equal(cached.headers.get("x-lifeos-asset-source"),"derived-cache");assert.equal(state().traffic,afterPreview);
  assert.equal((await call(`/api/assets/${asset.id}/photo-info`)).status,200);
  const other=await call(`/api/assets/${memberAsset.id}/content`,"GET",undefined,memberCookie);assert.equal(other.headers.get("x-lifeos-asset-source"),"local");
  assert.equal((await call(`/api/assets/${asset.id}/content`,"GET",undefined,memberCookie)).status,404);
  const saved=(await call("/api/assets")).value.items.find((item: {id: string})=>item.id===asset.id);assert.deepEqual(saved.storageRefs,asset.storageRefs);
  assert.deepEqual(readFileSync(join(config.assetRoot!,asset.storageRefs[0]!.sourceRef)),original);
  change({corrupt:true});const beforeCorrupt=state().traffic;
  const corrupt=await call(`/api/assets/${asset.id}/content`);assert.equal(corrupt.status,502);assert.equal(corrupt.value.error,"pool_download_hash_mismatch");assert.equal(state().traffic,beforeCorrupt+original.length,"bad bytes were downloaded and remain charged");
  change({corrupt:false});
  const accounting=await call("/api/admin/storage-pool");assert.equal(accounting.value.unassigned.trafficBytes,0);assert.equal(accounting.value.poolDownloadIssues.length,0);assert.equal(accounting.value.project.trafficUsedBytes,state().traffic);
  assert.equal(state().puts,puts,"reads do not reupload copies");
  await stop();await boot();assert.equal((await call(path)).value.assetId,asset.id);
  change({offline:true});assert.equal((await call(`/api/assets/${asset.id}/content`)).status,503,"no silent fallback masks failed pool read");
  const rolled=await call(path,"DELETE");assert.equal(rolled.status,200);assert.equal(rolled.value.enabled,false);
  const local=await call(`/api/assets/${asset.id}/content`);assert.equal(local.status,200);assert.deepEqual(local.value,original);assert.equal(local.headers.get("x-lifeos-asset-source"),"local");
  assert.equal((await call(path,"DELETE")).status,200,"rollback is idempotent");
});
