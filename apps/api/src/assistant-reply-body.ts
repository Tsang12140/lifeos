export interface ReadableReply { readonly text: string; readonly complete: boolean; readonly kind: "reply" | "plain" }
function readString(text: string, start: number): { text: string; end: number; complete: boolean } {
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return { text: value, end: i + 1, complete: true };
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
  return { text: value.replace(/[\uD800-\uDBFF]$/, ""), end: text.length, complete: false };
}
/** Read only a top-level reply string. Never promote nested plans or reasoning. */
export function readReplyString(source: string): ReadableReply | null {
  const text = source.replace(/^\s*```(?:json)?\s*/i, "");
  if (!text.trimStart().startsWith("{")) return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      const token = readString(text, i);
      if (!token.complete) return null;
      let next = token.end;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (depth === 1 && token.text === "reply" && text[next] === ":") {
        next++;
        while (next < text.length && /\s/.test(text[next]!)) next++;
        if (text[next] !== '"') return null;
        const body = readString(text, next);
        return { text: body.text, complete: body.complete, kind: "reply" };
      }
      i = token.end - 1;
    }
  }
  return null;
}
/** Only this explicitly named footer is metadata; ordinary code blocks remain body. */
export function splitChatMetadata(source: string): { body: string; metadata?: string } {
  const marker = /(?:^|\n)```lifeos[ \t]*(?:\r?\n|$)/i.exec(source);
  if (!marker) return { body: source };
  const tail = source.slice(marker.index + marker[0].length);
  const close = /(?:^|\n)```[ \t]*(?:\r?\n|$)/.exec(tail);
  return { body: source.slice(0, marker.index), metadata: close ? tail.slice(0, close.index) : tail };
}

function withoutThinking(source: string): string {
  // Some compatible providers put a separate think block before body-channel text.
  // Never interpret quoted/code examples elsewhere in an answer as a channel.
  return source.replace(/^\s*<think>[\s\S]*?(?:<\/think>|$)\s*/i, "");
}

export function isReplyEnvelope(source: string): boolean {
  const text = source.trim().replace(/^```(?:json)?\s*/i, "");
  return text.startsWith("{") && /"(?:reply|action|plan|sourceIds|ui)"\s*:/.test(text);
}

/** Display body, including Markdown/code/JSON examples, without exposing protocol or thinking. */
export function readableReply(source: string, streaming = false): ReadableReply | null {
  const visible = splitChatMetadata(withoutThinking(source)).body;
  const reply = readReplyString(visible);
  if (reply?.text.trim()) return { ...reply, text: reply.text.slice(0, 12000), complete: reply.complete && reply.text.length <= 12000 };
  let text = visible.trim();
  if (!text || /^(?:<(?:!doctype|html|head|body|script)\b|【(?:仅思考|空白正文))/i.test(text) || isReplyEnvelope(text)) return null;
  if (streaming && text.startsWith("{")) { try { JSON.parse(text); } catch { return null; } }
  // During streaming, keep a possible footer delimiter out of the visible answer.
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  if (streaming && ["`", "``", "```", "```l", "```li", "```lif", "```life", "```lifeo", "```lifeos"].includes(lastLine.toLowerCase())) text = text.slice(0, text.length - lastLine.length).trimEnd();
  if (!text) return null;
  return { text: text.slice(0, 12000), complete: text.length <= 12000, kind: "plain" };
}

export interface ChatOutput { readonly value: unknown; readonly issue?: "metadata" | "legacy"; readonly limited?: boolean }

/** Normal prose needs no schema. Only explicit metadata and legacy envelopes are parsed. */
export function decodeChatOutput(source: string): ChatOutput | null {
  const split = splitChatMetadata(withoutThinking(source));
  const body = readableReply(source);
  if (!body) return null;
  if ((readReplyString(split.body)?.text.length ?? split.body.trim().length) > 12000) return { value: { action: "reply", reply: body.text }, limited: true };
  if (split.metadata !== undefined) {
    try {
      const metadata: unknown = JSON.parse(split.metadata.trim());
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid metadata");
      return { value: { action: "reply", ...metadata, reply: body.text } };
    } catch { return { value: { action: "reply", reply: body.text }, issue: "metadata" }; }
  }
  if (isReplyEnvelope(source)) {
    const text = withoutThinking(source).trim().replace(/^\uFEFF/, "").replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
    try { return { value: JSON.parse(text) }; }
    catch { return { value: { action: "reply", reply: body.text }, issue: "legacy" }; }
  }
  return { value: { action: "reply", reply: body.text } };
}

