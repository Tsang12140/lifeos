import { isDreamRecord } from "@lifeos/core";
import type { RecordView } from "./api";

/** Bound preview DOM before CSS clamping; never materialize an entire code-point array. */
export function contactJournalExcerpt(text: string): string {
  const characters: string[] = [];
  for (const character of text.trim()) {
    if (characters.length === 180) return `${characters.join("")}…`;
    characters.push(character);
  }
  return characters.join("");
}

/** One actual journal per person; input order and later backfills do not change life-time order. */
export function contactJournalPreviews(records: readonly RecordView[], includePrivate: boolean, hideDemo: boolean): ReadonlyMap<string, RecordView> {
  const latest = new Map<string, { record: RecordView; at: number }>();
  for (const record of records) {
    if (record.kind !== "journal" || isDreamRecord(record) || (!includePrivate && record.isPrivate) || (hideDemo && record.isDemo)) continue;
    const time = record.occurredAt ?? record.createdAt;
    // Calendar dates and unresolved wall times follow the app's Shanghai display clock.
    const at = Date.parse(time.kind === "instant" ? time.value : `${time.value}${time.kind === "date" ? "T00:00:00" : ""}+08:00`);
    for (const ref of record.entityRefs) {
      if (ref.entityType !== "person") continue;
      const previous = latest.get(ref.entityId);
      if (!previous || previous.at < at || (previous.at === at && `${previous.record.createdAt.value}|${previous.record.id}` < `${record.createdAt.value}|${record.id}`)) latest.set(ref.entityId, { record, at });
    }
  }
  return new Map([...latest].map(([id, item]) => [id, item.record]));
}
