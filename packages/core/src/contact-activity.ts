import type { EntityRef, LifeTime } from "./model.js";

export const CONTACT_ACTIVITY_HALF_LIFE_DAYS = 60;
export const DEFAULT_CONTACT_ACTIVITY_THRESHOLD = 2;

export interface ContactActivitySource {
  readonly id: string;
  readonly createdAt: LifeTime;
  readonly occurredAt?: LifeTime;
  readonly entityRefs: readonly EntityRef[];
}

export interface ContactActivity {
  readonly entityId: string;
  readonly score: number;
  readonly recordCount: number;
  readonly lastMentionDate: string;
}

const shanghaiDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
function dateOf(time: LifeTime): string {
  return time.kind === "instant" ? shanghaiDate.format(new Date(time.value)) : time.value.slice(0, 10);
}

/** One contribution per linked record, based on when life happened, not when it was edited.
 * Callers exclude deleted/hidden records. Future events contribute only once their day arrives.
 * Return aggregate metadata only; no diary text is needed for the contacts library. */
export function contactActivity(records: readonly ContactActivitySource[], now = new Date()): readonly ContactActivity[] {
  const today = Date.parse(shanghaiDate.format(now));
  const seen = new Set<string>();
  const items = new Map<string, ContactActivity>();
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const date = dateOf(record.occurredAt ?? record.createdAt);
    const age = (today - Date.parse(date)) / 86_400_000;
    if (!Number.isFinite(age) || age < 0) continue;
    const score = 2 ** (-age / CONTACT_ACTIVITY_HALF_LIFE_DAYS);
    for (const entityId of new Set(record.entityRefs.filter(ref => ref.entityType === "person").map(ref => ref.entityId))) {
      const previous = items.get(entityId);
      items.set(entityId, {
        entityId, score: (previous?.score ?? 0) + score,
        recordCount: (previous?.recordCount ?? 0) + 1,
        lastMentionDate: previous && previous.lastMentionDate > date ? previous.lastMentionDate : date,
      });
    }
  }
  return [...items.values()].sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
}
