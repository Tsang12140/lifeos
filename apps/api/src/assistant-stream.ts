import { HttpError } from "./http-kit.js";

export type ReplyPreview = (text: string) => void;

/** Decode only a top-level reply string, never plans, reasoning or JSON syntax. */
export function partialReply(source: string): string {
  const text = source.replace(/^\s*```(?:json)?\s*/i, "");
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      const token = readString(text, i);
      if (!token.complete) return "";
      let next = token.end;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (depth === 1 && token.value === "reply" && text[next] === ":") {
        next++;
        while (/\s/.test(text[next] ?? "") && next < text.length) next++;
        return text[next] === '"' ? readString(text, next).value : "";
      }
      i = token.end - 1;
    }
  }
  return "";
}

function readString(text: string, start: number): { value: string; end: number; complete: boolean } {
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return { value, end: i + 1, complete: true };
    if (c !== "\\") { value += c; continue; }
    const escape = text[++i];
    if (escape === undefined) break;
    if (escape === "u") {
      const hex = text.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else {
      const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (!(escape in escapes)) break;
      value += escapes[escape];
    }
  }
  // A unicode escape or a provider chunk can split an emoji in half.
  return { value: value.replace(/[\uD800-\uDBFF]$/, ""), end: text.length, complete: false };
}

/** Read OpenAI-compatible SSE. Transport EOF without a finish marker is failure. */
export async function readAssistantStream(response: Response, onPreview: ReplyPreview): Promise<{ choices: { message: { content: string }; finish_reason: string }[] }> {
  if (!response.body) throw new HttpError(502, "invalid_ai_reply", "AI 回复中断，请重试");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", content = "", preview = "", finish = "", doneMarker = false;
  const frame = (data: string) => {
    if (data === "[DONE]") { doneMarker = true; return; }
    const packet = JSON.parse(data) as { error?: unknown; choices?: { index?: number; delta?: { content?: unknown }; finish_reason?: string | null }[] };
    if (packet.error) throw new HttpError(502, "ai_service_unavailable", "AI 服务暂时未能完成回复，请稍后重试");
    const choice = packet.choices?.find(item => item.index === 0 || item.index === undefined);
    if (typeof choice?.delta?.content === "string") {
      content += choice.delta.content;
      if (content.length > 512_000) throw new HttpError(502, "invalid_ai_reply", "AI 回复过长，请重试");
      const next = partialReply(content).slice(0, 12000);
      if (next !== preview) { preview = next; onPreview(next); }
    }
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
      if (buffer.length > 512_000) throw new HttpError(502, "invalid_ai_reply", "AI 回复格式不完整，请重试");
      if (chunk.done) break;
    }
    if (!finish || !doneMarker) {
      console.warn(`[ai-stream] stage=transport finish_marker=${Boolean(finish)} done_marker=${doneMarker} chars=${content.length}`);
      throw new HttpError(502, "invalid_ai_reply", "AI 回复中断，请重试");
    }
    return { choices: [{ message: { content }, finish_reason: finish }] };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
