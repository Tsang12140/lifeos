import type { Asset } from "@lifeos/core";
/**
 * Media URLs carry no unlock token any more: the proof rides in the `lifeos_unlock`
 * cookie, so the same thumbnail URL is reused across page loads and reloads.
 *
 * The `v=` tag is what makes that reuse last: without it the API may only promise
 * five minutes, and every visit after that asks for bytes the browser already has.
 * The tag comes from `/api/assets`; an asset without one (a photo uploaded a moment
 * ago, say) simply keeps the short-lived URL.
 */
export type ThumbnailWidth = 160 | 240 | 400 | 1200 | 2048;
let rotations = new Map<string, number>();
let versions = new Map<string, string>();
let versionSource: Readonly<Record<string, string>> | null = null;
/** Replaced from the current account's asset snapshot before rendering its images. */
export function syncPhotoRotations(assets: readonly Asset[]) {
  rotations = new Map(assets.filter(a => a.displayRotation).map(a => [a.id, a.displayRotation!]));
}
export function syncThumbVersions(thumbVersions: Readonly<Record<string, string>>) {
  // Called on every render: rebuilding a map per photo per keystroke is not free.
  if (versionSource === thumbVersions) return;
  versionSource = thumbVersions;
  versions = new Map(Object.entries(thumbVersions));
}
function versionParam(id: string): string {
  const version = versions.get(id);
  return version === undefined ? "" : `&v=${encodeURIComponent(version)}`;
}
export function assetContentUrl(id: string, download = false): string { return `/api/assets/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`; }
export function assetThumbUrl(id: string, width: ThumbnailWidth, rotation = rotations.get(id) ?? 0): string {
  // The initial grid and the viewer placeholder share exactly the same cached URL.
  return `/api/assets/${encodeURIComponent(id)}/thumbnail?w=${width}${rotation ? `&r=${rotation}` : "&upright=1"}${versionParam(id)}`;
}
/**
 * Density descriptors rather than width ones on purpose: `sizes` is one more thing
 * that can silently fall back to `100vw` (measured — Chrome ignored the media-query
 * form on the gallery page and every tile downloaded the largest file), while a
 * `1x/2x/3x` list always means exactly what it says.
 */
export function assetThumbDensitySet(id: string, widths: readonly ThumbnailWidth[]): string {
  return widths.map((width, index) => `${assetThumbUrl(id, width)} ${index + 1}x`).join(", ");
}
/** Viewer transforms unadjusted pixels itself, preserving the anchor while saving. */
export function viewerThumbUrl(id: string, width: ThumbnailWidth): string {
  return `/api/assets/${encodeURIComponent(id)}/thumbnail?w=${width}&upright=1${versionParam(id)}`;
}
