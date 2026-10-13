import type { Asset, AssetLink, RecordKind } from "@lifeos/core";

/** Upload queues are guarded separately; only stored local photos count here. */
export function hasSavableRecordContent(kind: RecordKind, text: string, refs: readonly AssetLink[], assets: readonly Asset[]): boolean {
  if (text.trim()) return true;
  return kind === "journal" && refs.some(ref => ref.role === "photo" && assets.some(asset => asset.id === ref.assetId && asset.kind === "photo" && asset.storageRefs.some(storage => storage.sourceId === "local")));
}
