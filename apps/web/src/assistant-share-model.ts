export interface ShareMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at?: string;
  readonly seq?: number;
  readonly attachments?: readonly { readonly assetId: string; readonly name: string }[];
}
export const SHARE_WINDOW_MS = 30 * 60_000;
export function initialShareSelection(messages: readonly ShareMessage[], index: number): Set<string> {
  const selected = new Set<string>();
  if (!messages[index]) return selected;
  const end = Date.parse(messages[index].at ?? "");
  if (Number.isFinite(end)) for (const message of messages.slice(0, index + 1)) {
    const at = Date.parse(message.at ?? "");
    if (at >= end - SHARE_WINDOW_MS && at <= end) selected.add(message.id);
  }
  selected.add(messages[index].id);
  // Keep the question belonging to each selected answer, even at the window edge.
  let question: string | null = null;
  for (const message of messages.slice(0, index + 1)) {
    if (message.role === "user") question = message.id;
    else if (selected.has(message.id) && question) selected.add(question);
  }
  return selected;
}
export function needsEarlierShareWindow(messages: readonly ShareMessage[], anchorId: string): boolean {
  const index = messages.findIndex(message => message.id === anchorId);
  if (index < 0) return false;
  const selected = initialShareSelection(messages, index);
  let questionSeen = false;
  for (const message of messages.slice(0, index + 1)) {
    if (message.role === "user") questionSeen = true;
    else if (selected.has(message.id) && !questionSeen) return true;
  }
  const end = Date.parse(messages[index]!.at ?? "");
  if (!Number.isFinite(end)) return false;
  const oldest = Date.parse(messages[0]?.at ?? "");
  return !Number.isFinite(oldest) || oldest >= end - SHARE_WINDOW_MS;
}
export function mergeShareMessages(older: readonly ShareMessage[], current: readonly ShareMessage[]): ShareMessage[] {
  return [...new Map([...older, ...current].map(message => [message.id, message])).values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}
/** Grapheme wrapping avoids splitting emoji; explicit blank lines remain blank. */
export function wrapShareText(text: string, width: number, measure: (text: string) => number): string[] {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
  return text.replace(/\r\n?/g, "\n").split("\n").flatMap(paragraph => {
    const rows: string[] = []; let line = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      if (line && measure(line + segment) > width) { rows.push(line); line = ""; }
      line += segment;
    }
    rows.push(line); return rows;
  });
}
