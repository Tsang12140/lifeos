import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { readableReply } from "../src/assistant-reply-body.js";
import type { TimelineRecord } from "@lifeos/core";
import { listenOnFetchablePort } from "./support/fetchable-port.js";

type ResponseSpec = { text?: string; stream?: boolean; incomplete?: boolean; malformed?: boolean; reasoning?: string };
async function fixture(t: import("node:test").TestContext, answer: (call: number) => ResponseSpec) {
  const root=mkdtempSync(join(tmpdir(),"lifeos-delivery-")); let calls=0;
  const packets: any[] = [];
  const provider=createServer(async(req,res)=>{let requestBody="";for await(const chunk of req)requestBody+=chunk;packets.push(JSON.parse(requestBody));const spec=answer(++calls);
    if(spec.stream){res.writeHead(200,{"content-type":"text/event-stream"});const delta={content:spec.text??"",...(spec.reasoning?{reasoning_content:spec.reasoning}:{})};
      res.write("data: "+JSON.stringify({choices:[{index:0,delta}]})+"\n\n");
      if(spec.malformed){res.end("data: {not-json}\n\n");return;}
      if(!spec.incomplete)res.write("data: "+JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})+"\n\ndata: [DONE]\n\n");res.end();
    }else{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{content:spec.text??"",reasoning_content:spec.reasoning??""},finish_reason:"stop"}]}));}
  });await listenOnFetchablePort(provider);
  const config=readConfig({LIFEOS_DATA_DIR:join(root,"data"),LIFEOS_ASSET_ROOT:join(root,"assets"),LIFEOS_DEEPSEEK_API_KEY:"fake-only",LIFEOS_DEEPSEEK_BASE_URL:"http://127.0.0.1:"+(provider.address() as {port:number}).port});
  const app=createHttpServer(config);await listenOnFetchablePort(app.server);const base="http://127.0.0.1:"+(app.server.address() as {port:number}).port;
  t.after(async()=>{app.server.closeAllConnections();await new Promise<void>(done=>app.server.close(()=>done()));provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));assert(root.startsWith(join(tmpdir(),"lifeos-delivery-")));rmSync(root,{recursive:true,force:true,maxRetries:5});});
  const request=async(path:string,body?:unknown)=>{const r=await fetch(base+path,body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{});return{status:r.status,body:await r.json() as any}};
  const created=await request("/api/ai/assistant/history/new",{});const conversationId=created.body.conversationId;
  const input={conversationId,turnId:"fiction-turn",message:"聊一聊虚构的蓝鹭灯塔",batchId:null,revision:null};
  return{app,request,input,packets,calls:()=>calls,history:async()=> (await request("/api/ai/assistant/history/"+conversationId)).body};
}

test("readable recovery excludes nested protocol, HTML error pages and reasoning but keeps plain citation text",()=>{
  assert.equal(readableReply('{"plan":{"reply":"不展示"}}'),null);
  assert.equal(readableReply('["普通JSON示例"]')?.text,'["普通JSON示例"]');
  assert.equal(readableReply("<html>bad gateway</html>"),null);
  assert.equal(readableReply("【仅思考，未产出正文】思考内容"),null);
  assert.equal(readableReply('[1]。这里是可读正文。')?.text,"[1]。这里是可读正文。");
  assert.deepEqual(readableReply('{"reply":"只有半句'),{text:"只有半句",complete:false,kind:"reply"});
});

test("plain prose is delivered once with no guessed citations or writes and replay is idempotent",async t=>{
  const f=await fixture(t,()=>({text:"这是一段**可读正文**[1]。"}));
  const before=JSON.stringify(f.app.app.repository.exportData());
  const result=await f.request("/api/ai/backfill/chat",f.input);
  assert.equal(result.status,200);assert.equal(result.body.reply,"这是一段**可读正文**[1]。");
  assert.equal(result.body.action,"reply");assert.equal(result.body.delivery.status,"recovered");assert.equal(result.body.ui,undefined);assert.equal(f.calls(),1);
  const replay=await f.request("/api/ai/backfill/chat",f.input);assert.equal(replay.body.reply,result.body.reply);assert.equal(f.calls(),1);
  const detail=await f.history();assert.equal(detail.messages.length,2);assert.equal(detail.messages[1].delivery.status,"recovered");
  assert.equal(JSON.stringify(f.app.app.repository.exportData()),before);assert.equal(f.app.app.repository.assistantBatches().length,0);
  assert.equal(f.app.app.repository.assistantAttempts({limit:10}).length,0,"a delivered reply is not logged as a failed turn");
});

test("orphan citations retain an incomplete reply without automatic regeneration or draft writes",async t=>{
  for(const text of ['[1]。只有评价，没交代事情。','先有普通正文。\n\n[1]。\n\n后续段落。','[1]。缺少事件说明。\n```lifeos\n{"action":"new_draft","plan":{"entries":[]}}\n```']){
    const f=await fixture(t,()=>({text}));
    const result=await f.request('/api/ai/backfill/chat',f.input);
    assert.equal(result.status,502);assert.equal(f.calls(),1);
    const detail=await f.history();assert.equal(detail.messages[1].delivery.status,'incomplete');
    assert.equal(detail.messages[0].turnStatus,'failed');assert.equal(detail.messages[0].retryable,true);
    assert(detail.messages[1].text.startsWith(text.split('\n```lifeos')[0]!));
    assert.equal(f.app.app.repository.assistantBatches().length,0);assert.equal(f.app.app.repository.list().length,0);
    assert.equal(f.app.app.repository.assistantAttempts({limit:10})[0]?.errorCode,'ai_reply_orphan_citation');
  }
});

test("manual retry replaces an orphan reply and generation asks for independently readable body",async t=>{
  const f=await fixture(t,call=>({text:call===1?'[1]。只剩一句评价。':'昨天在虚构灯塔整理旧书，发现了以前的留言。这件小事有意思，是因为留言连起了两次阅读。'}));
  assert.equal((await f.request('/api/ai/backfill/chat',f.input)).status,502);assert.equal(f.calls(),1);
  assert.match(f.packets[0].messages[0].content,/去掉所有引用编号后仍应完整/);
  assert.equal((await f.request('/api/ai/backfill/chat',f.input)).status,200);assert.equal(f.calls(),2);
  const h=await f.history();assert.equal(h.messages.length,2);assert.equal(h.messages[1].delivery,undefined);
});

test("invalid operation and missing plan retain body while creating no draft or records",async t=>{
  const f=await fixture(t,()=>({text:JSON.stringify({action:"new_draft",reply:"拟写说明已经生成。",plan:{entries:"broken"}})}));
  const result=await f.request("/api/ai/backfill/chat",f.input);
  assert.equal(result.status,200);assert.equal(result.body.reply,"拟写说明已经生成。");assert.equal(result.body.action,"reply");
  assert.equal(result.body.delivery.issue,"operation");assert.equal(f.app.app.repository.assistantBatches().length,0);assert.equal(f.app.app.repository.list().length,0);assert.equal(f.calls(),1);
});

test("model commit actions are not executed while their readable reply remains visible",async t=>{
  const f=await fixture(t,()=>({text:JSON.stringify({action:"commit",reply:"这句话不能授权写入。",ui:{commands:[{type:"record.focus",params:{recordId:"missing"}}]}})}));
  const result=await f.request("/api/ai/backfill/chat",f.input);assert.equal(result.status,200);assert.equal(result.body.action,"reply");assert.equal(result.body.delivery.issue,"operation");assert.equal(result.body.ui,undefined);assert.equal(f.app.app.repository.list().length,0);
});

test("bad citation mapping drops controls without discarding the answer or guessing candidate order",async t=>{
  const f=await fixture(t,()=>({text:JSON.stringify({action:"reply",reply:"普通事实[1]。",sourceIds:["missing-record"]})}));
  const result=await f.request("/api/ai/backfill/chat",f.input);assert.equal(result.status,200);assert.equal(result.body.reply,"普通事实[1]。");assert.equal(result.body.delivery.issue,"references");assert.equal(result.body.ui?.offers,undefined);assert.equal(f.calls(),1);
});

test("closed reply string is recovered from broken metadata without leaking JSON or regenerating prose",async t=>{
  const f=await fixture(t,()=>({text:'{"reply":"正文已经完整。","sourceIds":['}));
  const result=await f.request("/api/ai/backfill/chat",f.input);assert.equal(result.status,200);assert.equal(result.body.reply,"正文已经完整。");assert.equal(result.body.action,"reply");assert.equal(f.calls(),1);
});

test("partial provider body survives history reload and same-turn retry replaces it without duplicates",async t=>{
  const f=await fixture(t,call=>call===1?{stream:true,incomplete:true,text:'{"reply":"只收到前半句'}:{text:JSON.stringify({action:"reply",reply:"现在是完整回答。"})});
  const failed=await f.request("/api/ai/backfill/chat",f.input);assert.equal(failed.status,502);assert.equal(f.calls(),1,"do not silently regenerate a partial response");
  const detail=await f.history();assert.equal(detail.messages.length,2);assert.equal(detail.messages[1].text,"只收到前半句");assert.equal(detail.messages[1].delivery.status,"incomplete");assert.equal(detail.messages[0].turnStatus,"failed");assert.equal(detail.messages[0].retryable,true);
  const result=await f.request("/api/ai/backfill/chat",f.input);assert.equal(result.status,200);assert.equal(result.body.reply,"现在是完整回答。");
  const after=await f.history();assert.equal(after.messages.length,2);assert.equal(after.messages[1].text,"现在是完整回答。");assert.equal(after.messages[1].delivery,undefined);assert.equal(f.calls(),2);
});

test("malformed stream frame retains preceding body as incomplete without a silent retry",async t=>{
  const f=await fixture(t,()=>({stream:true,malformed:true,text:'{"reply":"分片损坏前收到的正文。"}'}));
  const result=await f.request("/api/ai/backfill/chat",f.input);assert.equal(result.status,502);assert.equal(f.calls(),1);
  const detail=await f.history();assert.equal(detail.messages.length,2);assert.equal(detail.messages[1].text,"分片损坏前收到的正文。");assert.equal(detail.messages[1].delivery.status,"incomplete");
});

test("normal finish delivers an unclosed legacy reply string, while thinking-only output stays undisplayed",async t=>{
  const f=await fixture(t,()=>({text:'{"reply":"未闭合的正文'}));
  const recovered=await f.request("/api/ai/backfill/chat",f.input);
  assert.equal(recovered.status,200);assert.equal(recovered.body.reply,"未闭合的正文");
  assert.equal((await f.history()).messages[1].delivery,undefined);assert.equal(f.calls(),1);
  const other=await fixture(t,()=>({text:"",reasoning:"PRIVATE_REASONING_DO_NOT_DISPLAY"}));
  const failed=await other.request("/api/ai/backfill/chat",other.input);assert.equal(failed.status,502);assert.equal(other.calls(),2);assert.equal((await other.history()).messages.length,1);
});

test("ordinary replies accept Markdown, code, JSON examples, quotes, emoji and citations without schema warnings",async t=>{
  for(const text of ["# 标题\n\n- 第一项\n- 第二项",'```js\nconst n = 1;\n```','```json\n{"name":"灯塔"}\n```','{"name":"灯塔"}','["灯塔","海风"]','"一句话"','👍','42','正常正文[1]。']){
    const f=await fixture(t,()=>({text}));
    const result=await f.request("/api/ai/backfill/chat",f.input);
    assert.equal(result.status,200);assert.equal(result.body.reply,text);assert.equal(result.body.delivery?.issue==="format",false);
    assert.equal(f.calls(),1);assert.equal(f.packets[0].response_format,undefined,"ordinary chat never forces json_object");
    assert.equal((await f.history()).messages[1].text,text);
  }
});

test("plain body streams before optional metadata and valid read-only commands still compile",async t=>{
  const f=await fixture(t,()=>({stream:true,text:'正文先给你。\n```lifeos\n{"action":"reply","ui":{"commands":[{"type":"view.goto","params":{"view":"tasks"}}]}}\n```'}));
  const result=await f.request("/api/ai/backfill/chat",f.input);
  assert.equal(result.status,200);assert.equal(result.body.reply,"正文先给你。");assert.equal(result.body.ui.commands[0].params.view,"tasks");
  assert.equal(f.calls(),1);assert.equal(f.app.app.repository.list().length,0);
});

test("optional draft metadata retains mandatory review before any record is written",async t=>{
  const plan={entries:[{key:"r1",selected:true,kind:"journal",content:"虚构的海边散步。",date:"2026-10-01",evidence:"虚构的海边散步。",questions:"",entityKeys:[],assetIds:[],isBackfill:true}],objects:[],actions:[],explanation:"待确认"};
  const f=await fixture(t,()=>({text:'整理好了，请核对。\n```lifeos\n'+JSON.stringify({action:"new_draft",plan})+'\n```'}));
  const result=await f.request("/api/ai/backfill/chat",{...f.input,message:"帮我记2026-10-01虚构的海边散步"});
  assert.equal(result.status,200);assert.equal(result.body.action,"draft");assert.equal(result.body.batch.plan.entries[0].content,"虚构的海边散步。");
  assert.equal(f.app.app.repository.list().length,0,"a parsed plan never confirms writes");
});

test("malformed footer and truncated footer transport preserve complete body without replay or guessed actions",async t=>{
  for(const incomplete of [false,true]){
    const f=await fixture(t,()=>({stream:true,incomplete,text:'完整的普通回答。\n```lifeos\n{"action":"new_draft","plan":'}));
    const result=await f.request("/api/ai/backfill/chat",f.input);
    assert.equal(result.status,200);assert.equal(result.body.reply,"完整的普通回答。");assert.equal(result.body.action,"reply");
    assert.equal(f.calls(),1);assert.equal(f.app.app.repository.assistantBatches().length,0);assert.equal(f.app.app.repository.list().length,0);
  }
});

test("blank retry drops thinking and JSON constraints even when direct was already selected",async t=>{
  const f=await fixture(t,call=>({text:call===1?' \n \t':'这次直接回答。'}));
  const result=await f.request("/api/ai/backfill/chat",{...f.input,effort:"direct"});
  assert.equal(result.status,200);assert.equal(result.body.reply,"这次直接回答。");assert.equal(f.calls(),2);
  assert.equal(f.packets[1].response_format,undefined);assert.deepEqual(f.packets[1].thinking,{type:"disabled"});
  assert.match(f.packets[1].messages[0].content,/不要JSON外壳/);
});

test("diagnostic text and inline thinking never become user replies",()=>{
  assert.equal(readableReply('【空白正文 3 字符】\n"   "'),null);
  assert.equal(readableReply('<think>隐藏思考'),null);
  assert.equal(readableReply('<think>隐藏思考</think>正常回答。')?.text,"正常回答。");
  assert.equal(readableReply('```lifeos\n{"action":"commit"}\n```'),null);
});

test("each source is verified independently without renumbering valid citations",async t=>{
  const f=await fixture(t,()=>({text:'有效原文[2]，另一个有效原文[4]。\n```lifeos\n{"sourceIds":["invented","source-a","private-source","source-b"]}\n```'}));
  for(const id of ["source-a","private-source","source-b"])f.app.app.repository.insert({id,kind:"journal",body:{original:"虚构的蓝鹭灯塔原文"},createdAt:{kind:"instant",value:"2026-10-01T00:00:00Z"},occurredAt:{kind:"date",value:"2026-10-01"},entityRefs:[],relatedRecordIds:[],assetRefs:[],aiDerived:[],...(id==="private-source"?{isPrivate:true}:{})} as TimelineRecord);
  const result=await f.request("/api/ai/backfill/chat",{...f.input,message:"找找蓝鹭灯塔的日记"});
  assert.equal(result.status,200);assert.equal(result.body.reply,"有效原文[2]，另一个有效原文[4]。");
  const offers=result.body.ui.offers;
  assert.deepEqual(offers.map((o:any)=>o.command.params.recordId),["source-a","source-b"]);
  assert.match(offers[0].label,/^来源 2 /);assert.match(offers[1].label,/^来源 4 /);
  assert.equal(f.calls(),1);assert.equal((await f.history()).messages[1].ui.offers.length,2);
});

test("existing reply length limit never silently marks a shortened answer complete",async t=>{
  const f=await fixture(t,()=>({text:'字'.repeat(12001)+'\n```lifeos\n{}\n```'}));
  const result=await f.request("/api/ai/backfill/chat",f.input);
  assert.equal(result.status,502);assert.equal(f.calls(),1);
  const message=(await f.history()).messages[1];assert.equal(message.text.length,12000);assert.equal(message.delivery.status,"incomplete");
});

