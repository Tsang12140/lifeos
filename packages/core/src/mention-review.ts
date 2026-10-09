import type { Entity, TextEntityDecision } from "./model.js";
import { entitySearchTerms, findEntityMentions, normalizeEntitySearchTerm, type EntityMention } from "./mention.js";

export interface EntityCandidate {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly entities: readonly Entity[];
}

/** Names are matched locally, with source offsets retained; nothing rewrites prose. */
export function findEntityCandidates(text: string, entities: readonly Entity[]): readonly EntityCandidate[] {
  const starts: number[] = [], ends: number[] = [];
  let folded = "", offset = 0;
  for (const char of text) {
    const normalized = /[^\S\r\n]/u.test(char) ? "" : char.normalize("NFKC").toLocaleLowerCase();
    for (let i = 0; i < normalized.length; i++) { starts.push(offset); ends.push(offset + char.length); }
    folded += normalized;
    offset += char.length;
  }
  const vocabulary = new Map<string, Entity[]>();
  for (const entity of entities) {
    if (entity.type !== "person" && entity.type !== "place") continue;
    for (const raw of entitySearchTerms(entity)) {
      const term = normalizeEntitySearchTerm(raw);
      if (!term) continue;
      const options = vocabulary.get(term) ?? [];
      if (!options.some((option) => option.id === entity.id)) options.push(entity);
      vocabulary.set(term, options);
    }
  }
  // Find occurrences per term rather than comparing the entire dictionary at every character.
  const found: EntityCandidate[] = [];
  for (const [term, options] of vocabulary) {
    let at = folded.indexOf(term);
    while (at >= 0) {
      const endAt = at + term.length;
      const leftBlocked = /^[a-z0-9]/i.test(term) && /[a-z0-9]/i.test(text[starts[at]! - 1] ?? "");
      const rightBlocked = /[a-z0-9]$/i.test(term) && /[a-z0-9]/i.test(text[ends[endAt - 1]!] ?? "");
      if (!leftBlocked && !rightBlocked) {
        let start = starts[at]!, end = ends[endAt - 1]!;
        const marker = text[start - 1];
        if ((marker === "@" || marker === "#") && !/[a-z0-9@#]/i.test(text[start - 2] ?? "")) {
          const typed = options.filter((entity) => entity.type === (marker === "@" ? "person" : "place"));
          if (typed.length > 0) { start--; found.push({ start, end, text: text.slice(start, end), entities: typed }); }
          else found.push({ start, end, text: text.slice(start, end), entities: options });
        } else found.push({ start, end, text: text.slice(start, end), entities: options });
      }
      at = folded.indexOf(term, at + Math.max(1, term.length));
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: EntityCandidate[] = [];
  for (const candidate of found) {
    const previous = result[result.length - 1];
    if (previous && candidate.start < previous.end) continue;
    result.push(candidate);
  }
  return result;
}

export function rebaseEntityDecisions(before: string, after: string, decisions: readonly TextEntityDecision[], editRange?: { start: number; end: number }): readonly TextEntityDecision[] {
  if (before === after) return decisions;
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  // An input selection disambiguates inserting identical text next to a repeated name.
  if (editRange && editRange.start >= 0 && editRange.end >= editRange.start && editRange.end <= before.length) {
    const inserted = after.length - before.length + editRange.end - editRange.start;
    if (inserted >= 0 && before.slice(0, editRange.start) === after.slice(0, editRange.start)
      && before.slice(editRange.end) === after.slice(editRange.start + inserted)) {
      prefix = editRange.start; suffix = before.length - editRange.end;
    }
  }
  const delta = after.length - before.length;
  return decisions.flatMap((decision) => {
    const next = decision.end <= prefix ? decision : decision.start >= before.length - suffix ? { ...decision, start: decision.start + delta, end: decision.end + delta } : null;
    return next && after.slice(next.start, next.end) === next.text ? [next] : [];
  });
}

export function resolveTextEntityMentions(text: string, entities: readonly Entity[], decisions: readonly TextEntityDecision[] = []): readonly EntityMention[] {
  const valid = decisions.filter((decision) => text.slice(decision.start, decision.end) === decision.text);
  const legacy = findEntityMentions(text, entities).filter((mention) => !valid.some((decision) => mention.start < decision.end && decision.start < mention.end));
  const explicit = valid.flatMap((decision): EntityMention[] => decision.entityId === null ? [] : [{ entityId: decision.entityId, entityType: decision.entityType, start: decision.start, end: decision.end, matched: decision.text.replace(/^[@#]/u, "") }]);
  return [...legacy, ...explicit].sort((a, b) => a.start - b.start);
}
