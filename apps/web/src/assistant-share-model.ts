import { assistantCitationRanges, type AssistantReplyDelivery, type UiOffer, type UiTurnPlan } from "@lifeos/core";
import { isJournalSourceOffer, sourceNumber } from "./assistant-citations-model.ts";
import { replyParagraphs } from "./assistant-reply-format.ts";

export interface ShareMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at?: string;
  readonly seq?: number;
  readonly attachments?: readonly { readonly assetId: string; readonly name: string }[];
  readonly ui?: UiTurnPlan;
  readonly delivery?: AssistantReplyDelivery;
}

export interface ShareMessagePart {
  /** Text represented by this run in the selection editor. Citation markers stay as [n]. */
  readonly text: string;
  /** UTF-16 offsets in shareMessageDisplayText, shared with preview selection leaves. */
  readonly start: number;
  readonly end: number;
  readonly strong: boolean;
  readonly kind: "text" | "citation";
  readonly number?: number;
  readonly offer?: UiOffer;
}

export interface ShareRedaction {
  readonly id: string;
  readonly messageId: string;
  readonly start: number;
  readonly end: number;
  readonly mode: "blur" | "block";
  /** Gaussian blur radius in logical image pixels. */
  readonly strength: number;
}

/**
 * The image and the text-selection editor share one display string. Assistant
 * markdown emphasis is interpreted here, and citation controls are only
 * considered verified when the server supplied the corresponding offer.
 */
export function shareMessageParts(message: ShareMessage): readonly ShareMessagePart[] {
  const paragraphs = message.role === "assistant"
    ? replyParagraphs(message.text)
    : [[{ text: message.text.replace(/\r\n?/g, "\n"), strong: false }]];
  const offers = new Map((message.ui?.offers ?? []).filter(isJournalSourceOffer).map(offer => [sourceNumber(offer), offer]));
  const parts: ShareMessagePart[] = [];
  const ranges = message.role === "assistant" ? assistantCitationRanges(paragraphs.map(runs => runs.map(run => run.text).join("")).join("\n\n")) : [];
  let sourceOffset = 0;
  let offset = 0;
  const push = (text: string, strong: boolean, kind: ShareMessagePart["kind"], number?: number, offer?: UiOffer) => {
    if (!text) return;
    parts.push({ text, start: offset, end: offset + text.length, strong, kind, ...(number === undefined ? {} : { number }), ...(offer === undefined ? {} : { offer }) });
    offset += text.length;
  };
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (paragraphIndex > 0) { push("\n\n", false, "text"); sourceOffset += 2; }
    for (const run of paragraph) {
      let at = 0;
      for (const range of ranges.filter(range => range.start >= sourceOffset && range.end <= sourceOffset + run.text.length)) {
        const start = range.start - sourceOffset, end = range.end - sourceOffset;
        if (start > at) push(run.text.slice(at, start), run.strong, "text");
        const offer = offers.get(range.number);
        if (offer) push(run.text.slice(start, end), false, "citation", range.number, offer);
        at = end;
      }
      if (at < run.text.length) push(run.text.slice(at), run.strong, "text");
      sourceOffset += run.text.length;
    }
  });
  return parts;
}

export function shareMessageDisplayText(message: ShareMessage): string {
  return shareMessageParts(message).map(part => part.text).join("");
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
