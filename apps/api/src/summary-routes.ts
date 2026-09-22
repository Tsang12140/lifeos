import { dateForTime } from "./timeline-query.js";
import type { DaySummary, Entity } from "@lifeos/core";
import type { RecordView, SqliteRecordRepository } from "./repository.js";

export function summaryPayload(items: readonly DaySummary[], provider: { readonly providerId: string; readonly model?: string; readonly kind: "ai" | "rule" }): Record<string, unknown> {
  return {
    items,
    provider: provider.providerId,
    ...(provider.model === undefined ? {} : { model: provider.model }),
    ai: provider.kind === "ai",
  };
}

/**
 * Every record a day summary may read, bucketed by the caller's calendar day.
 *
 * Notes are included rather than filtered out, because a day that has nothing
 * else still deserves a cell: the summariser treats them as filler and is told
 * not to describe them as events. Private records stay out either way — a
 * summary is shown on the grid.
 */
export function collectSummarisableRecords(repository: SqliteRecordRepository, timeZone: string): Map<string, RecordView[]> {
  const byDate = new Map<string, RecordView[]>();
  for (const record of repository.list({})) {
    if (record.isPrivate === true) continue;
    const date = dateForTime(record.occurredAt ?? record.createdAt, timeZone);
    const bucket = byDate.get(date);
    if (bucket === undefined) byDate.set(date, [record]);
    else bucket.push(record);
  }
  return byDate;
}
