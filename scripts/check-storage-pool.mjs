// Server connection preparation. Default is read-only; --usage calls the real existing IPC worker.
// No upload/delete/account creation, credentials in output, shadow config or shadow ledger.
import { spawn } from 'node:child_process';
import { constants, accessSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative, resolve } from 'node:path';
const args=process.argv.slice(2),flags=new Map();let usageRequested=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--usage'){usageRequested=true;continue;}
  if(!['--go-root','--private-root'].includes(args[i])||!args[i+1]||flags.has(args[i]))throw Error('Usage: node --env-file-if-exists=.env scripts/check-storage-pool.mjs [--usage] [--go-root path --private-root path]');
  flags.set(args[i],args[++i]);
}
if(usageRequested&&flags.size)throw Error('--usage only supports the production fixed shared-ledger paths');
const goRoot=resolve(flags.get('--go-root')??'/www/wwwroot/g.dnbox.cn'),privateRoot=resolve(flags.get('--private-root')??'/www/server/gdnbox-secrets');
const consumer=process.env.LIFEOS_POOL_CONSUMER?.trim()||'2',php=process.env.LIFEOS_POOL_PHP_BINARY?.trim()||'php';
const checks=[],notices=[];const check=(name,ok)=>checks.push({name,ok:Boolean(ok)});
const can=(path,mode)=>{try{accessSync(path,mode);return true;}catch{return false;}};
const outside=(root,path)=>{const r=relative(root,path);return r==='..'||r.startsWith('../')||r.startsWith('..\\')||isAbsolute(r);};
const input={consumer,goRoot,privateRoot};
const metadata=await new Promise(done=>{
  let output='',finished=false;
  const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);done(value);};
  const env=Object.fromEntries(['PATH','SYSTEMROOT','TMP','TEMP','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const p=spawn(php,[resolve(import.meta.dirname,'../apps/api/php/pool-preflight.php')],{env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  const timer=setTimeout(()=>{p.kill();finish({ok:false,error:'metadata_probe_timeout'});},30000);
  p.on('error',()=>finish({ok:false,error:'php_cli_unavailable'}));
  p.stdout.on('data',b=>{output+=b;if(output.length>65536){p.kill();finish({ok:false,error:'metadata_response_invalid'});}});
  p.on('close',code=>{try{const value=JSON.parse(output);finish(code===0?value:{ok:false,error:value.error??'metadata_probe_failed'});}catch{finish({ok:false,error:'metadata_response_invalid'});}});
  p.stdin.on('error',()=>finish({ok:false,error:'metadata_probe_failed'}));p.stdin.end(JSON.stringify(input));
});
check('actual_pool_configuration_readable',metadata.ok);
if(metadata.ok){
  check('project_registered_with_positive_limits',metadata.registered&&metadata.project.storage_limit>0&&metadata.project.traffic_limit>0);
  check('numeric_consumer_compatible',metadata.numericConsumerProtocol);
  check('download_returns_actual_charged_month',metadata.chargedMonthProtocol);
  check('php_curl_and_pdo_sqlite',metadata.cliExtensions.curl&&metadata.cliExtensions.pdo_sqlite);
  check('project_reservations_fit_pool',metadata.reservedStorageBytes<=metadata.backends.reduce((n,b)=>n+b.storageLimitBytes,0)&&metadata.reservedTrafficBytes<=metadata.backends.reduce((n,b)=>n+b.trafficLimitBytes,0));
  check('historical_default_prefix_preserved',metadata.backends.length>0&&metadata.backends[0].prefix==='');
  check('backend_credentials_configured',metadata.backends.length>0&&metadata.backends.every(b=>b.credentialsConfigured));
  if(metadata.backends.some(b=>!b.usageApiConfigured))notices.push('Physical bucket usage falls back to local ledgers where provider usage APIs are not configured.');
}
const ledger=join(privateRoot,'consumer-ledger.sqlite');let ledgerState=null;
check('private_directory_outside_go_webroot',existsSync(privateRoot)&&existsSync(goRoot)&&outside(realpathSync(goRoot),realpathSync(privateRoot)));
check('private_directory_accessible_for_current_user',can(privateRoot,constants.R_OK|constants.W_OK|(process.platform==='win32'?0:constants.X_OK)));
check('shared_ledger_exists_and_is_not_symlink',existsSync(ledger)&&!lstatSync(ledger).isSymbolicLink());
if(existsSync(ledger)){
  check('shared_ledger_current_user_read_write',can(ledger,constants.R_OK|constants.W_OK));
  try{
    const db=new DatabaseSync(ledger,{readOnly:true,timeout:5000});
    try{
      const month=new Date().toISOString().slice(0,7);
      ledgerState={utcMonth:month,objects:db.prepare("SELECT state,count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM pool_objects WHERE consumer_id=? GROUP BY state").all(consumer),trafficBytes:Number(db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM pool_traffic WHERE consumer_id=? AND month=?').get(consumer,month).bytes)};
      check('existing_shared_ledger_schema_readable',true);
    }finally{db.close();}
  }catch{check('existing_shared_ledger_schema_readable',false);}
}else notices.push('Shared ledger missing: bootstrap must be performed on this server, never with a separate local copy.');
let actualUsage=null;
if(usageRequested){
  if(checks.every(c=>c.ok)){
    try{
      const {PoolConsumerBridge}=await import('../apps/api/dist/src/storage-pool.js');
      actualUsage=await new PoolConsumerBridge({...process.env,LIFEOS_STORAGE_POOL_ENABLED:'1'}).usage();
      check('real_project_usage_via_shared_ipc',actualUsage.consumer===consumer);
    }catch{check('real_project_usage_via_shared_ipc',false);}
  }else notices.push('Usage call skipped because prerequisites failed; no ledger was created.');
}
notices.push('This checks the current CLI user and environment. PM2 runtime, both service users, bucket access policy and complete restore still require verification.');
const passed=checks.every(c=>c.ok);
console.log(JSON.stringify({format:'lifeos-pool-preflight-v1',consumer,goRoot,privateRoot,metadata,ledgerState,actualUsage,checks,notices,uploadsPerformed:false},null,2));
console.log(`RESULT: ${passed?'PASS':'FAIL'}`);if(!passed)process.exitCode=2;
