import { isDreamRecord, type Asset } from "@lifeos/core";
import type { RecordView } from "./api";
import { dateKeyForRecord } from "./time.ts";

export interface DiaryPhotoOccurrence {
  readonly key: string;
  readonly assetId: string;
  /** Photos and clips share the grid; only the tile body and the badge differ. */
  readonly kind: "photo" | "video";
  readonly record: RecordView;
  readonly dateKey: string;
  readonly monthKey: string;
}

/**
 * Build the diary's photo view from the already-scoped records and asset snapshot.
 * Occurrences deliberately stay separate even when two records reference one asset.
 *
 * Clips belong here as well as photographs. A video the owner filed in a diary is
 * a thing they may well go looking for later, and leaving it out meant the gallery
 * quietly denied it existed — the one place built to answer "what did I put in this
 * month" was the one place that could not answer for half the media. A clip still
 * says nothing but its length; the badge is the whole of its label.
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
      const asset = assetById.get(ref.assetId);
      if (!asset || asset.purpose === "avatar") return;
      const video = asset.kind === "video";
      if (!video && (ref.role !== "photo" || asset.kind !== "photo")) return;
      if (!asset.storageRefs.some((storage) => storage.sourceId === "local" || storage.sourceId === "lifeos-pool")) return;
      occurrences.push({
        key: `${record.id}:${attachmentIndex}:${ref.assetId}`,
        assetId: ref.assetId,
        kind: video ? "video" : "photo",
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
