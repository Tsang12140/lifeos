import type { EntityCandidate } from "@lifeos/core";

export interface MentionContextGroup {
  readonly candidates: readonly EntityCandidate[];
  readonly paragraphStart: number;
  readonly paragraphEnd: number;
  readonly start: number;
  readonly end: number;
  readonly wordClipped?: boolean;
}

/** Share nearby context, but keep individual source offsets and bound chained matches. */
export function groupMentionContexts(text: string, candidates: readonly EntityCandidate[]): readonly MentionContextGroup[] {
  const groups: EntityCandidate[][] = [];
  for (const candidate of [...candidates].sort((a, b) => a.start - b.start)) {
    const group = groups[groups.length - 1], previous = group?.[group.length - 1];
    if (group && previous && candidate.start - previous.end <= 64
      && candidate.end - group[0]!.start <= 96
      && !/[。！？!?\r\n]/u.test(text.slice(previous.end, candidate.start))) {
      group.push(candidate);
    } else groups.push([candidate]);
  }
  return groups.map((items) => {
    const first = items[0]!, last = items[items.length - 1]!;
    const paragraphStart = text.lastIndexOf("\n", first.start - 1) + 1;
    const nextBreak = text.indexOf("\n", last.end);
    const paragraphEnd = nextBreak < 0 ? text.length : nextBreak;
    return { candidates: items, paragraphStart, paragraphEnd, start: Math.max(paragraphStart, first.start - 32), end: Math.min(paragraphEnd, last.end + 32) };
  });
}
