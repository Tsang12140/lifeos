import { isDreamRecord, type Asset } from "@lifeos/core";
import type { RecordView } from "./api";
import { dateKeyForRecord } from "./time.ts";

export interface DiaryPhotoOccurrence {
  readonly key: string;
  readonly assetId: string;
  readonly record: RecordView;
  readonly dateKey: string;
  readonly monthKey: string;
}

/**
 * Build the diary's photo view from the already-scoped records and asset snapshot.
 * Occurrences deliberately stay separate even when two records reference one asset.
 */
export function diaryPhotoOccurrences(
  records: readonly RecordView[],
  assets: readonly Asset[],
  deletedRecordIds: ReadonlySet<string> = new Set(),
): DiaryPhotoOccurrence[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const occurrences: Array<DiaryPhotoOccurrence & { recordIndex: number; attachmentIndex: number }> = [];

  records.forEach((record, recordIndex) => {
    if (record.kind !== "journal" || isDreamRecord(record) || deletedRecordIds.has(record.id)) return;
    const dateKey = dateKeyForRecord(record.occurredAt, record.createdAt);
    if (!dateKey) return;

    record.assetRefs.forEach((ref, attachmentIndex) => {
      if (ref.role !== "photo") return;
      const asset = assetById.get(ref.assetId);
      if (!asset || asset.kind !== "photo" || asset.purpose === "avatar") return;
      if (!asset.storageRefs.some((storage) => storage.sourceId === "local" || storage.sourceId === "lifeos-pool")) return;
      occurrences.push({
        key: `${record.id}:${attachmentIndex}:${ref.assetId}`,
        assetId: ref.assetId,
        record,
        dateKey,
        monthKey: dateKey.slice(0, 7),
        recordIndex,
        attachmentIndex,
      });
    });
  });

  occurrences.sort((left, right) => right.dateKey.localeCompare(left.dateKey)
    || left.recordIndex - right.recordIndex
    || left.attachmentIndex - right.attachmentIndex);
  return occurrences.map(({ recordIndex: _recordIndex, attachmentIndex: _attachmentIndex, ...occurrence }) => occurrence);
}
