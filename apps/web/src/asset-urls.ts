import type { Asset } from "@lifeos/core";
/**
 * Media URLs carry no unlock token any more: the proof rides in the `lifeos_unlock`
 * cookie, so the same thumbnail URL is reused across page loads and reloads.
 */
export type ThumbnailWidth = 400 | 1200 | 2048;
let rotations = new Map<string, number>();
/** Replaced from the current account's asset snapshot before rendering its images. */
export function syncPhotoRotations(assets: readonly Asset[]) {
  rotations = new Map(assets.filter(a => a.displayRotation).map(a => [a.id, a.displayRotation!]));
}
export function assetContentUrl(id: string, download = false): string { return `/api/assets/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`; }
export function assetThumbUrl(id: string, width: ThumbnailWidth, rotation = rotations.get(id) ?? 0): string {
  // The initial grid and the viewer placeholder share exactly the same cached URL.
  return `/api/assets/${encodeURIComponent(id)}/thumbnail?w=${width}${rotation ? `&r=${rotation}` : "&upright=1"}`;
}
/** Viewer transforms unadjusted pixels itself, preserving the anchor while saving. */
export function viewerThumbUrl(id: string, width: ThumbnailWidth): string {
  return `/api/assets/${encodeURIComponent(id)}/thumbnail?w=${width}&upright=1`;
}
