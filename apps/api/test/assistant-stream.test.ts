import test from "node:test";
import assert from "node:assert/strict";
import { partialReply, readAssistantStream } from "../src/assistant-stream.js";

test("partial reply never reveals JSON, nested plans or incomplete unicode escapes", () => {
  const source = JSON.stringify({ plan: { reply: "不要显示", content: "资料" }, reply: '先说重点\n咖啡“不错” 😀 \\ 好', action: "reply" });
  const expected = JSON.parse(source).reply as string;
  let last = "";
  for (let length = 1; length <= source.length; length++) {
    const preview = partialReply(source.slice(0, length));
    assert.ok(expected.startsWith(preview), `bad prefix at ${length}: ${preview}`);
    assert.ok(preview.startsWith(last));
    assert.ok(!/[\uD800-\uDBFF]$/.test(preview));
    last = preview;
  }
  assert.equal(last, expected);
  assert.equal(partialReply('```json\n{"reply":"正文'), "正文");
  assert.equal(partialReply('{"plan":{"reply":"隐含内容"},"action":"reply"}'), "");
});

test("provider SSE handles split UTF8, CRLF, reasoning, and final markers", async () => {
  const data = [
    ': keepalive\r\n\r\n',
    'data: '+JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "隐藏推理" } }] })+'\r\n\r\n',
    ...['{"reply":"', '先看咖啡😀', '\\n很好喝', '","action":"reply"}'].map(content => 'data: '+JSON.stringify({ choices: [{ index: 0, delta: { content } }] })+'\r\n\r\n'),
    'data: '+JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })+'\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ].join('');
  const bytes = new TextEncoder().encode(data);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } });
  const previews: string[] = [];
  const result = await readAssistantStream(new Response(stream), text => previews.push(text));
  assert.deepEqual(previews, ['先看咖啡😀', '先看咖啡😀\n很好喝']);
  assert.equal(JSON.parse(result.choices[0]!.message.content).action, "reply");
  assert.equal(result.choices[0]!.finish_reason, "stop");
  // Collected for diagnostics only — see the empty-body case below.
  assert.equal(result.choices[0]!.message.reasoning_content, "隐藏推理");
});

test("a stream that only ever reasons is not mistaken for a silent success", async () => {
  // 2026-10-17 生产现场：模型把预算全花在思考上，正文一个字没写，服务商仍以
  // finish_reason=stop 收尾——与"正常答完"在流里长得一模一样。这里钉住的是：
  // 正文确实是空的，而思考被完整带回，好让失败日志说得出发生了什么。
  const data = [
    'data: '+JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "想了很久" } }] })+'\r\n\r\n',
    'data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })+'\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ].join('');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close(); } });
  const previews: string[] = [];
  const result = await readAssistantStream(new Response(stream), text => previews.push(text));
  assert.equal(result.choices[0]!.message.content, "");
  assert.equal(result.choices[0]!.message.reasoning_content, "想了很久");
  assert.deepEqual(previews, [], "思考不是正文，一个字都不该预览出去");
});

test("truncated provider streams cannot pass as completed replies", async () => {
  for (const suffix of ["", 'data: [DONE]\n\n']) {
    const response = new Response('data: '+JSON.stringify({ choices: [{ delta: { content: '{"reply":"半句话' } }] })+'\n\n'+suffix);
    await assert.rejects(readAssistantStream(response, () => {}), { code: "invalid_ai_reply" });
  }
});

test("plain text streams incrementally while split metadata and reasoning stay hidden", async () => {
  const content=['先给正文。','\n\n第二段。','\n`','``l','ifeos','\n{"action":"commit","plan":{"entries":[]}}','\n```'];
  const data=[...content.map(text=>'data: '+JSON.stringify({choices:[{delta:{content:text,reasoning_content:'SECRET_THINKING'}}]})+'\n\n'),'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'].join('');
  const previews:string[]=[];
  await readAssistantStream(new Response(data),text=>previews.push(text),true);
  assert.equal(previews[0],'先给正文。');assert.equal(previews.at(-1),'先给正文。\n\n第二段。');
  assert(previews.every(text=>!text.includes('lifeos')&&!text.includes('commit')&&!text.includes('SECRET_THINKING')&&!text.includes('`')));
});
