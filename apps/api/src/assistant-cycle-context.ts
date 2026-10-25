import type { SqliteRecordRepository } from "./repository.js";

/** Cycle facts carry their subject, independently of who owns the space or asks. */
export function assistantCycleContext(repository: SqliteRecordRepository, includeEvents = false) {
  const module = repository.cycleIntimacyModule();
  const people = new Map(repository.listEntities().filter(entity => entity.type === "person").map(entity => [entity.id, entity.name]));
  const describe = (subjectId: string | undefined, cycleLength: number, periodLength: number, anchorStart: string | undefined, events: readonly { date: string; kind: string }[]) => ({
    subject: subjectId ? { personId: subjectId, name: people.get(subjectId) ?? "已移除的联系人" } : { self: true, name: "当前用户本人" },
    cycleLength,
    periodLength,
    ...(includeEvents && anchorStart ? { anchorStart } : {}),
    events: includeEvents ? events.filter(event => event.kind === "period_start" || event.kind === "period_end").map(event => ({ date: event.date, kind: event.kind })) : [],
  });
  const other = Object.entries(module.config.otherSubjects ?? {}).map(([key, value]) => describe(key === "self" ? undefined : key, value.cycleLength, value.periodLength, value.anchorStart, value.events));
  return { selectedSubject: module.config.subjectId ?? "self", cycles: [describe(module.config.subjectId, module.config.cycleLength, module.config.periodLength, module.config.anchorStart, module.events), ...other] };
}
