import type { Asset } from "@lifeos/core";

export type ThumbnailWidth = 400 | 1200 | 2048;
let rotations = new Map<string, number>();
/** Replaced from the current account's asset snapshot before rendering its images. */
export function syncPhotoRotations(assets: readonly Asset[]) {
  rotations = new Map(assets.filter(a => a.displayRotation).map(a => [a.id, a.displayRotation!]));
}
export function assetContentUrl(id: string): string { return `/api/assets/${encodeURIComponent(id)}/content`; }
export function assetThumbUrl(id: string, width: ThumbnailWidth, rotation = rotations.get(id) ?? 0): string {
  // The initial grid and the viewer placeholder share exactly the same cached URL.
  return `/api/assets/${encodeURIComponent(id)}/thumbnail?w=${width}${rotation ? `&r=${rotation}` : "&upright=1"}`;
}
/** Viewer transforms unadjusted pixels itself, preserving the anchor while saving. */
export function viewerThumbUrl(id: string, width: ThumbnailWidth): string {
  return `/api/assets/${encodeURIComponent(id)}/thumbnail?w=${width}&upright=1`;
}
