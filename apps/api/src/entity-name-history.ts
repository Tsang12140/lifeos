import { findEntityCandidates, findEntityMentions, normalizeEntitySearchTerm, type Entity, type EntityCandidate, type TextEntityDecision, type TimelineRecord } from "@lifeos/core";

/** Persist the spelling and identity together; exclusions always win. */
export function snapshotMentions(record: TimelineRecord, entities: readonly Entity[]): TimelineRecord {
  const text = record.body.edited ?? record.body.original;
  const decisions = [...(record.body.entityMentions ?? [])];
  for (const mention of findEntityMentions(text, entities)) {
    if (decisions.some(d => d.start < mention.end && mention.start < d.end)) continue;
    decisions.push({ start: mention.start, end: mention.end, text: text.slice(mention.start, mention.end), entityId: mention.entityId, entityType: mention.entityType as "person" | "place" });
  }
  decisions.sort((a, b) => a.start - b.start);
  return decisions.length === 0 && record.body.entityMentions === undefined ? record : { ...record, body: { ...record.body, entityMentions: decisions } };
}

export function nameVocabulary(entity: Entity): string {
  return JSON.stringify([entity.type, ...[entity.name, ...(entity.aliases ?? [])].map(normalizeEntitySearchTerm).sort()]);
}

function markedCandidates(text: string, entities: readonly Entity[]): readonly EntityCandidate[] {
  return findEntityCandidates(text, entities).flatMap(candidate => {
    const marker = text[candidate.start];
    if (marker !== "@" && marker !== "#") return [];
    const options = candidate.entities.filter(e => e.type === (marker === "@" ? "person" : "place"));
    return options.length ? [{ ...candidate, entities: options }] : [];
  });
}

/** Freeze legacy interpretations before a vocabulary change, including newly
 * matching text as an exclusion so adding an alias cannot rewrite old meaning. */
export function planNameHistory(record: TimelineRecord, before: readonly Entity[], after: readonly Entity[], deleted = false) {
  const text = record.body.edited ?? record.body.original;
  const frozen = snapshotMentions(record, before);
  const decisions = [...(frozen.body.entityMentions ?? [])];
  const conflicts: EntityCandidate[] = [];
  const oldCandidates = markedCandidates(text, before);
  const newCandidates = markedCandidates(text, after);
  const overlaps = (c: EntityCandidate) => decisions.some(d => d.start < c.end && c.start < d.end);
  for (const candidate of oldCandidates) {
    if (overlaps(candidate) || candidate.entities.length < 2) continue;
    const next = newCandidates.find(c => c.start === candidate.start && c.end === candidate.end);
    if (next && candidate.entities.map(e => e.id).sort().join() === next.entities.map(e => e.id).sort().join()) continue;
    const removingCandidate = candidate.entities.some(entity => !next?.entities.some(e => e.id === entity.id));
    // A record-level relation cannot prove who this particular occurrence
    // means. Only a saved per-occurrence decision establishes that identity.
    if (removingCandidate && !deleted) { conflicts.push(candidate); continue; }
    decisions.push({ start: candidate.start, end: candidate.end, text: candidate.text, entityId: null, entityType: candidate.entities[0]!.type as "person" | "place" });
  }
  for (const candidate of newCandidates) {
    if (overlaps(candidate) || oldCandidates.some(c => c.start < candidate.end && candidate.start < c.end)) continue;
    decisions.push({ start: candidate.start, end: candidate.end, text: candidate.text, entityId: null, entityType: candidate.entities[0]!.type as "person" | "place" });
  }
  decisions.sort((a, b) => a.start - b.start);
  const body = decisions.length || record.body.entityMentions !== undefined ? { ...record.body, entityMentions: decisions } : record.body;
  return { body, refs: record.entityRefs, conflicts };
}
