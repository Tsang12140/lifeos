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
});

test("truncated provider streams cannot pass as completed replies", async () => {
  for (const suffix of ["", 'data: [DONE]\n\n']) {
    const response = new Response('data: '+JSON.stringify({ choices: [{ delta: { content: '{"reply":"半句话' } }] })+'\n\n'+suffix);
    await assert.rejects(readAssistantStream(response, () => {}), { code: "invalid_ai_reply" });
  }
});
