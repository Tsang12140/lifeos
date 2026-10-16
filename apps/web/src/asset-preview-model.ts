import type { Asset } from "@lifeos/core";
import type { RecordView } from "./api";

export type PhotoPreviewHandler = (ids: readonly string[], index: number, record?: RecordView, records?: readonly RecordView[]) => void;
export interface PhotoPreviewSession {
  readonly assetIds: readonly string[];
  readonly index: number;
  /** One owner per occurrence: shared assets must retain each diary's own text. */
  readonly owners?: readonly RecordView[];
}
export function photoPreviewSession(ids: readonly string[], index: number, assets: readonly Asset[], records: readonly RecordView[], record?: RecordView): PhotoPreviewSession {
  if (!record) return { assetIds: ids, index };
  const anchor = ids[index];
  const source = record.kind === "journal" ? records.filter(r => r.kind === "journal") : [record];
  const candidates = source.some(r => r.id === record.id) ? source : [record];
  const known = new Map(assets.map(a => [a.id, a]));
  const entries = candidates.flatMap(owner => owner.assetRefs.filter(ref => {
    const asset = known.get(ref.assetId);
    return (ref.role === "photo" || ref.role === "video") && asset !== undefined
      && (asset.kind === "photo" || asset.kind === "video") && asset.storageRefs.some(s => s.sourceId === "local" || s.sourceId === "lifeos-pool");
  }).map(ref => ({ id: ref.assetId, owner })));
  const start = entries.findIndex(e => e.owner.id === record.id && e.id === anchor);
  return start < 0 ? { assetIds: ids, index } : { assetIds: entries.map(e => e.id), owners: entries.map(e => e.owner), index: start };
}

export interface PhotoTransform { zoom: number; x: number; y: number }
export const fitTransform = (): PhotoTransform => ({ zoom: 1, x: 0, y: 0 });
export function zoomPhoto(view: PhotoTransform, zoom: number, point: { x: number; y: number }, maxZoom = 16): PhotoTransform {
  const next = Math.max(1, Math.min(maxZoom, zoom)), ratio = next / view.zoom;
  return { zoom: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
export function fitPhoto(width: number, height: number, stageWidth: number, stageHeight: number, rotation: number): number {
  const swapped = rotation % 180 !== 0;
  return Math.min(1, stageWidth / (swapped ? height : width), stageHeight / (swapped ? width : height));
}
export function boundPhoto(view: PhotoTransform, width: number, height: number, stageWidth: number, stageHeight: number, rotation: number): PhotoTransform {
  const fit = fitPhoto(width, height, stageWidth, stageHeight, rotation);
  const swapped = rotation % 180 !== 0;
  const maxX = Math.max(0, ((swapped ? height : width) * fit * view.zoom - stageWidth) / 2);
  const maxY = Math.max(0, ((swapped ? width : height) * fit * view.zoom - stageHeight) / 2);
  return { zoom: view.zoom, x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, view.x)), y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, view.y)) };
}
