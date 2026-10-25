import { Fragment } from "react";
import { assistantCitationRanges, splitHistoryMatches, type UiOffer, type AssistantReplyDelivery } from "@lifeos/core";
import { citationParts } from "./assistant-citations-model";
import { SourceNumber } from "./assistant-source-reader";
import { replyParagraphs } from "./assistant-reply-format";
import "./assistant-journal-sources.css";

export { isJournalSourceOffer } from "./assistant-citations-model";

export function AssistantDeliveryNote({ delivery }: { readonly delivery?: AssistantReplyDelivery | undefined }) {
  if (!delivery || (delivery.status === "recovered" && delivery.issue !== "operation")) return null;
  const text = delivery.status === "incomplete" ? "回复未完成，已保留收到的内容。" : delivery.issue === "references" ? "引用暂不可用，正文已保留。" : delivery.issue === "format" ? "正文已保留，回复格式不完整，引用或附加内容可能不可用。" : delivery.issue === "operation" ? "正文已保留，操作方案未完成，本次未执行操作。" : "正文已保留，本次未执行附加操作。";
  return <small className="assistant-delivery-note" role="status">{text}</small>;
}

/** Uses the existing read-only record command; the server owns IDs and labels. */
export function AssistantCitedText({ text, offers = [], disabled = false, query = "", className }: {
  readonly text: string;
  readonly offers?: readonly UiOffer[] | undefined;
  readonly disabled?: boolean;
  readonly query?: string;
  readonly className?: string;
}) {
  const rawParagraphs = replyParagraphs(text);
  const ranges = assistantCitationRanges(rawParagraphs.map(runs => runs.map(run => run.text).join("")).join("\n\n"));
  let offset = 0;
  const paragraphs = rawParagraphs.map((runs, index) => {
    if (index) offset += 2;
    return runs.map(run => {
      const at = offset; offset += run.text.length;
      const local = ranges.filter(range => range.start >= at && range.end <= offset).map(range => ({ ...range, start: range.start - at, end: range.end - at }));
      return { ...run, parts: citationParts(run.text, offers, local) };
    });
  });
  return <>{paragraphs.map((runs, paragraphIndex) => <p className={[className, "assistant-reply-paragraph"].filter(Boolean).join(" ")} key={paragraphIndex}>{runs.map((run, runIndex) => {
    const content = run.parts.map((part, index) => part.source ? <SourceNumber key={index} offer={part.source} disabled={disabled} /> : <Fragment key={index}>{splitHistoryMatches(part.text, query).map((segment, i) => segment.match ? <mark key={i}>{segment.text}</mark> : <Fragment key={i}>{segment.text}</Fragment>)}</Fragment>);
    return run.strong ? <strong key={runIndex}>{content}</strong> : <Fragment key={runIndex}>{content}</Fragment>;
  })}</p>)}</>;
}
