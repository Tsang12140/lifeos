import { attemptDetailOf, withAttemptDetail } from "./assistant-attempt-log.js";
import { HttpError } from "./http-kit.js";

export type ReplyPreview = (text: string) => void;

import { readReplyString, readableReply } from "./assistant-reply-body.js";

export function partialReply(source: string): string { return readReplyString(source)?.text ?? ""; }

/** Read OpenAI-compatible SSE. Transport EOF without a finish marker is failure. */
export async function readAssistantStream(response: Response, onPreview: ReplyPreview, preserveReply = false): Promise<{ choices: { message: { content: string; reasoning_content: string }; finish_reason: string }[] }> {
  if (!response.body) throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "AI 回复中断，请重试"), { stage: "connection", errorCode: "ai_stream_interrupted", errorDetail: "响应没有可读取的正文流", receivedChars: 0, rawText: "" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", content = "", reasoning = "", preview = "", finish = "", doneMarker = false;
  const frame = (data: string) => {
    if (data === "[DONE]") { doneMarker = true; return; }
    const packet = JSON.parse(data) as { error?: unknown; choices?: { index?: number; delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string | null }[] };
    if (packet.error) throw withAttemptDetail(new HttpError(502, "ai_service_unavailable", "AI 服务暂时未能完成回复，请稍后重试"), { stage: "service", errorCode: "ai_service_unavailable", errorDetail: `流式响应内嵌服务端错误：${JSON.stringify(packet.error).slice(0, 300)}`, receivedChars: content.length, rawText: content });
    const choice = packet.choices?.find(item => item.index === 0 || item.index === undefined);
    if (typeof choice?.delta?.content === "string") {
      content += choice.delta.content;
      if (content.length > 512_000) throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "AI 回复过长，请重试"), { stage: "format", errorCode: "ai_reply_too_long", errorDetail: `累计正文超过 512000 字`, receivedChars: content.length, rawText: content });
      const next = (preserveReply ? readableReply(content, true)?.text ?? "" : partialReply(content)).slice(0, 12000);
      if (next !== preview) { preview = next; onPreview(next); }
    }
    /**
     * Thinking modes stream the whole train of thought through
     * `reasoning_content` before the first `content` chunk. It must never reach
     * the preview — the owner sees a reply, not the model's scratch pad. It is
     * collected anyway because it is the only evidence left when a turn comes
     * back with no body at all (see `assistant.ts`): the failure log would
     * otherwise say "the provider returned nothing" while the model had, in
     * fact, thought for thousands of tokens and simply never written an answer.
     * Capped rather than thrown on: oversized reasoning is not the owner's problem.
     */
    if (typeof choice?.delta?.reasoning_content === "string" && reasoning.length < 512_000) reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason) finish = choice.finish_reason;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) frame(data);
      }
      if (buffer.length > 512_000) throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "AI 回复格式不完整，请重试"), { stage: "format", errorCode: "ai_stream_frame_too_long", errorDetail: "未闭合的 SSE 分片超过 512000 字", receivedChars: content.length, rawText: content });
      if (chunk.done) break;
    }
    if (!finish || !doneMarker) {
      console.warn(`[ai-stream] stage=transport finish_marker=${Boolean(finish)} done_marker=${doneMarker} chars=${content.length}`);
      throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "AI 回复中断，请重试"), { stage: "connection", errorCode: "ai_stream_interrupted", errorDetail: `流结束但缺少完成标记（finish=${finish || "无"} done=${doneMarker}）`, receivedChars: content.length, rawText: content });
    }
    return { choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finish }] };
  } catch (error) {
    if (attemptDetailOf(error)) throw error;
    throw withAttemptDetail(error instanceof Error ? error : new Error(String(error)), { stage: "connection", errorCode: "ai_stream_interrupted", errorDetail: "读取正文流时连接中断", receivedChars: content.length, rawText: content });
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
