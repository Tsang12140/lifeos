import { assistantCitationRanges, type AssistantCitationRange, type UiOffer } from "@lifeos/core";

export const isJournalSourceOffer = (offer: UiOffer): boolean => offer.command.type === "record.focus" && /^来源 [1-6] \d{4}-\d{2}-\d{2}$/.test(offer.label);
export function sourceNumber(offer: UiOffer): number { return Number(/^来源 (\d+)/.exec(offer.label)?.[1] ?? 0); }
/** Only complete markers backed by server-verified offers become interactive. */
export function citationParts(text: string, offers: readonly UiOffer[] = [], ranges: readonly AssistantCitationRange[] = assistantCitationRanges(text)): readonly { text: string; source?: UiOffer }[] {
  const byNumber = new Map(offers.filter(isJournalSourceOffer).map(offer => [sourceNumber(offer), offer]));
  const parts: { text: string; source?: UiOffer }[] = [];
  let at = 0;
  for (const range of ranges) {
    const source = byNumber.get(range.number);
    if (range.start > at) parts.push({ text: text.slice(at, range.start) });
    if (source) parts.push({ text: text.slice(range.start, range.end), source });
    at = range.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
