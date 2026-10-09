import type { CycleIntimacyEventKind, CycleIntimacyModuleData, Entity, Movie, RecordKind, TimelineRecord } from "./model.js";

export interface BackfillMaterial {
  readonly name: string;
  readonly text: string;
  readonly assetId?: string;
  readonly imageData?: string;
}
export interface BackfillEntry {
  readonly key: string;
  readonly selected: boolean;
  readonly kind: RecordKind;
  readonly content: string;
  readonly date: string;
  /** Shanghai wall-clock time. Empty means an explicitly date-only record. */
  readonly time?: string;
  readonly questionKind?: "missing" | "confirmation";
  readonly isBackfill?: boolean;
  readonly evidence: string;
  readonly questions: string;
  readonly entityKeys: readonly string[];
  readonly assetIds: readonly string[];
  readonly targetId?: string;
  readonly targetRevision?: number;
  readonly duplicateIds?: readonly string[];
  readonly targetCandidates?: readonly { readonly id: string; readonly revision: number; readonly label: string }[];
}
export function backfillEntryTime(entry: BackfillEntry, generatedAt: string): string {
  if (entry.time !== undefined) return entry.time;
  const instant = new Date(generatedAt);
  if (!Number.isFinite(instant.getTime()) || entry.isBackfill === true) return "";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(instant);
  return entry.date === day ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant) : "";
}
export function backfillEntryReady(entry: BackfillEntry): boolean {
  const acceptanceOnly = entry.questionKind === "confirmation" || (entry.questionKind === undefined && /^是否只保留[“「].+[”」][，,]\s*不写.+相关内容[？?]$/.test(entry.questions.trim()));
  return entry.selected && Boolean(entry.content.trim()) && (entry.kind === "note" || Boolean(entry.date)) && (!entry.questions.trim() || acceptanceOnly);
}
export interface BackfillObject {
  readonly key: string;
  readonly selected: boolean;
  readonly type: "person" | "place" | "movie";
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly address: string;
  readonly evidence: string;
  readonly questions: string;
  readonly existingId?: string;
  readonly existingSnapshot?: Entity;
  readonly movie?: Partial<Movie>;
  readonly candidates?: readonly Movie[];
}
export interface BackfillPlan {
  readonly entries: readonly BackfillEntry[];
  readonly objects: readonly BackfillObject[];
  readonly explanation: string;
  readonly actions?: readonly BackfillAction[];
}
export interface BackfillAction {
  readonly key: string;
  readonly type: "cycle" | "habit";
  readonly date: string;
  readonly selected: boolean;
  readonly marked: boolean;
  readonly evidence: string;
  readonly questions: string;
  readonly cycleKind?: CycleIntimacyEventKind;
  readonly habitId?: string;
  readonly name?: string;
  readonly icon?: string;
}
export interface BackfillBatch {
  readonly id: string;
  readonly revision: number;
  readonly status: "draft" | "committed" | "undone";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly materials: readonly BackfillMaterial[];
  readonly plan: BackfillPlan;
  readonly mode: "ai" | "rules";
  readonly conversation?: readonly BackfillChatMessage[];
  readonly recordIds?: readonly string[];
  readonly entityIds?: readonly string[];
  readonly beforeRecords?: readonly TimelineRecord[];
  readonly afterRecords?: readonly (TimelineRecord & { readonly revision: number })[];
  readonly beforeEntities?: readonly Entity[];
  readonly afterEntities?: readonly Entity[];
  readonly committedKeys?: readonly string[];
  readonly deferredKeys?: readonly string[];
  readonly committedObjectKeys?: readonly string[];
  readonly moduleSnapshot?: CycleIntimacyModuleData;
  readonly beforeModule?: CycleIntimacyModuleData;
  readonly afterModule?: CycleIntimacyModuleData;
  readonly undoBlocked?: boolean;
}
export interface BackfillChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}
export interface BackfillChatAnswer {
  readonly reply: string;
  readonly action: "reply" | "draft" | "commit" | "undo";
  readonly mode: "ai" | "rules";
  readonly batch?: BackfillBatch;
}
export function isAiBackfill(record: Pick<TimelineRecord, "aiDerived" | "isBackfill">): boolean {
  // Compatibility for callers that used this name to identify AI provenance.
  return isAiAssisted(record);
}
export function isAiAssisted(record: Pick<TimelineRecord, "aiDerived">): boolean {
  return record.aiDerived.some(item => item.provider === "lifeos-assistant" && item.kind === "classification" && typeof item.value === "object" && item.value !== null && !Array.isArray(item.value) && "type" in item.value && (item.value.type === "ai-backfill" || item.value.type === "ai-assisted"));
}
export function isBackfilled(record: Pick<TimelineRecord, "aiDerived" | "isBackfill">): boolean {
  return record.isBackfill === true || (record.isBackfill === undefined && record.aiDerived.some(item => item.provider === "lifeos-assistant" && item.kind === "classification" && typeof item.value === "object" && item.value !== null && !Array.isArray(item.value) && "type" in item.value && item.value.type === "ai-backfill"));
}
export function backfillItemState(batch: BackfillBatch, key: string): "pending" | "deferred" | "committed" {
  return batch.committedKeys?.includes(key) || (batch.status === "committed" && !batch.committedKeys) ? "committed" : batch.deferredKeys?.includes(key) ? "deferred" : "pending";
}
