import type { EntityCandidate } from "@lifeos/core";
import { groupMentionContexts, type MentionContextGroup } from "./entity-mention-groups";

/** Measure the same inline controls as the review, including icons and bold names. */
export function layoutMentionContexts(text: string, candidates: readonly EntityCandidate[], body: HTMLElement): readonly MentionContextGroup[] {
  const copy = body.querySelector<HTMLElement>(".mention-review-copy");
  if (!copy || copy.clientWidth === 0) return groupMentionContexts(text, candidates);
  const ordered = [...candidates].sort((a, b) => a.start - b.start);
  const positions = new Map(ordered.map((candidate, index) => [candidate.start, index]));
  const nextStart = (candidate: EntityCandidate) => ordered[positions.get(candidate.start)! + 1]?.start ?? Infinity;
  const words = new Map(Array.from(body.querySelectorAll<HTMLElement>(".mention-review-word"), word => [Number(word.dataset.occurrenceStart), word]));
  const probe = document.createElement("div");
  probe.className = "mention-review-context";
  probe.setAttribute("aria-hidden", "true");
  probe.inert = true;
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:${copy.clientWidth}px;`;
  body.append(probe);
  try {
    const style = getComputedStyle(probe), lineHeight = parseFloat(style.lineHeight);
    const canvas = document.createElement("canvas").getContext("2d");
    if (canvas) canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const templates = new Map<number, HTMLElement>();
    for (const [offset, word] of words) {
      const clone = word.cloneNode(true) as HTMLElement;
      clone.querySelector("input")?.remove();
      // Selection changes must not reflow the groups. Reserve the selected width.
      clone.querySelector<HTMLElement>("strong")!.style.fontWeight = "600";
      templates.set(offset, clone);
    }
    const prefixStart = (group: MentionContextGroup, first: EntityCandidate) => {
      const previousEnd = ordered[positions.get(first.start)! - 1]?.end ?? 0;
      const before = Array.from(text.slice(Math.max(group.paragraphStart, previousEnd), first.start));
      let count = Math.min(before.length, copy.clientWidth >= 320 ? 10 : 6, Math.floor(copy.clientWidth / 3 / parseFloat(style.fontSize)));
      probe.replaceChildren(templates.get(first.start)!.cloneNode(true));
      const wordWidth = probe.firstElementChild!.getBoundingClientRect().width;
      while (count > 0) {
        const prefix = (before.length > count ? "…" : "") + before.slice(-count).join("");
        if ((canvas?.measureText(prefix).width ?? prefix.length * parseFloat(style.fontSize)) + wordWidth <= copy.clientWidth - 1) break;
        count--;
      }
      return first.start - before.slice(before.length - count).join("").length;
    };
    const fits = (group: MentionContextGroup) => {
      const nodes: Node[] = [];
      let cursor = group.start;
      if (cursor > group.paragraphStart && cursor < group.candidates[0]!.start) nodes.push(document.createTextNode("…"));
      for (const candidate of group.candidates) {
        nodes.push(document.createTextNode(text.slice(cursor, candidate.start)), templates.get(candidate.start)!.cloneNode(true));
        cursor = candidate.end;
      }
      nodes.push(document.createTextNode(text.slice(cursor, group.end) + (group.end < group.paragraphEnd ? "…" : "")));
      probe.replaceChildren(...nodes);
      return probe.getBoundingClientRect().height <= lineHeight * 2 + .5;
    };
    const result: MentionContextGroup[] = [];
    for (const base of groupMentionContexts(text, candidates)) {
      let index = 0;
      while (index < base.candidates.length) {
        const first = base.candidates[index]!, start = prefixStart(base, first);
        let stop = index + 1;
        // Greedily share two lines, leaving some readable context after the last name.
        while (stop < base.candidates.length) {
          const last = base.candidates[stop]!;
          const end = Math.min(base.paragraphEnd, nextStart(last), last.end + 6);
          if (!fits({ ...base, start, end, candidates: base.candidates.slice(index, stop + 1) })) break;
          stop++;
        }
        const items = base.candidates.slice(index, stop), last = items.at(-1)!;
        const tail = Array.from(text.slice(last.end, Math.min(base.paragraphEnd, nextStart(last)))).slice(0, 32);
        let end = last.end;
        // Keep as much following context as the remaining second line allows.
        for (const character of tail) {
          const nextEnd = end + character.length;
          if (!fits({ ...base, start, end: nextEnd, candidates: items })) break;
          end = nextEnd;
        }
        let fittedStart = start;
        // A single unusually wide name gets priority over the preceding context.
        while (fittedStart < first.start && !fits({ ...base, start: fittedStart, end, candidates: items })) {
          fittedStart += text.codePointAt(fittedStart)! > 0xffff ? 2 : 1;
        }
        const fitted = { ...base, candidates: items, start: fittedStart, end };
        fits(fitted);
        const wordClipped = Array.from(probe.querySelectorAll("strong")).some(word => word.scrollHeight > word.clientHeight + 1);
        result.push({ ...fitted, wordClipped });
        index = stop;
      }
    }
    return result;
  } finally {
    probe.remove();
  }
}
