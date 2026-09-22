import { useRef, useState, type DragEvent as ReactDragEvent, type Dispatch, type SetStateAction } from "react";
import { CloudUpload, Eraser, LoaderCircle, Plus, X } from "lucide-react";
import type { Asset, AssetLink } from "@lifeos/core";
import { apiRequest } from "./api";
import { ASSET_ROLE_LABEL, assetRoleFor, formatBytes } from "./app-meta";
import { sha256Hex } from "./contentHash";

function assetThumbUrl(assetId: string, width: number): string {
  return `/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=${width}`;
}

/**
 * The photo drop zone beside the entry box. This is the only place in LifeOS
 * that writes a file: everywhere else an asset is a reference to an original
 * that stays where it lives. A dropped photo uploads immediately, so the
 * thumbnail on screen is the very asset the record will point at — saving the
 * entry only links it.
 *
 * Nine is the timeline's own number, not an arbitrary cap: a record's grid
 * shows nine squares and folds the rest behind a +N badge. Keeping the two
 * equal means every photo the owner can attach is a photo the timeline can
 * show, so the badge never becomes a surprise.
 */
export const SHOT_LIMIT = 9;

/**
 * Uploading a photo ends either in newly stored bytes or in a reuse of bytes
 * the library already holds. The drop zone reports which, so the owner can
 * see that nothing was uploaded twice.
 */
export interface ShotUpload { readonly asset: Asset; readonly reused: boolean; }

export interface AssetResolveResponse { readonly matched: boolean; readonly asset?: Asset; }

/**
 * The library's answer to "do you already hold these exact bytes?". Failing to
 * ask must never stop an upload, so any error degrades to "no".
 */
export async function resolveKnownShot(hash: string): Promise<Asset | null> {
  try {
    const payload = await apiRequest<AssetResolveResponse>("/api/assets/resolve", { method: "POST", body: JSON.stringify({ algorithm: "sha256", value: hash }) });
    return payload.matched ? payload.asset ?? null : null;
  } catch {
    return null;
  }
}

interface ShotDropZoneProps {
  readonly shots: readonly AssetLink[];
  readonly onShotsChange: Dispatch<SetStateAction<readonly AssetLink[]>>;
  readonly onUpload: (file: File) => Promise<ShotUpload | null>;
  /** Says things the drop zone itself no longer says. The zone keeps no message
   *  line of its own: a paragraph of status text under a hand of cards reads as
   *  a defect in the panel. Anything that has to be said is said as a toast. */
  readonly onNotify: (message: string, tone?: "ok" | "warn") => void;
  /** Clearing the hand is one tap on a phone and one hover away on a desktop, so
   *  it has to be undoable. The zone hands the undo back to whoever owns the
   *  toast: it can put the photos back, but only the shell can offer the button. */
  readonly onCleared: (cleared: readonly AssetLink[], restore: () => void) => void;
}

export function ShotDropZone({ shots, onShotsChange, onUpload, onNotify, onCleared }: ShotDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  // dragenter/dragleave fire again for every child element, so only a depth
  // counter can tell whether the pointer really left the zone.
  const dragDepth = useRef(0);

  const takeFiles = async (files: readonly File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      onNotify("只接受图片文件", "warn");
      return;
    }
    const room = SHOT_LIMIT - shots.length;
    if (room <= 0) {
      onNotify(`已经 ${SHOT_LIMIT} 张了，时间轴一屏放不下，先删一张再加`, "warn");
      return;
    }
    const batch = images.slice(0, room);
    if (images.length > room) onNotify(`一次最多 ${SHOT_LIMIT} 张，只收下了前 ${room} 张`, "warn");
    setUploading((count) => count + batch.length);
    const added: AssetLink[] = [];
    let failedCount = 0;
    // Identical bytes resolve to the same asset, so dropping one photo twice
    // would put two identical assetIds in this list: the React keys would
    // collide and one ✕ would remove both thumbnails. Keep one per asset.
    const seen = new Set(shots.map((shot) => shot.assetId));
    for (const file of batch) {
      const upload = await onUpload(file);
      if (upload === null) { failedCount += 1; continue; }
      if (seen.has(upload.asset.id)) continue;
      seen.add(upload.asset.id);
      added.push({ assetId: upload.asset.id, role: assetRoleFor(upload.asset.kind), ...(upload.asset.originalName === undefined ? {} : { label: upload.asset.originalName }) });
    }
    setUploading((count) => count - batch.length);
    if (added.length > 0) onShotsChange((current) => [...current, ...added]);
    // Reuse and duplicates are both silent on purpose: whether the bytes were
    // already in the library is the library's business, not the owner's. A photo
    // landing in the hand is the whole confirmation.
    if (failedCount > 0) onNotify(`${failedCount} 张没能传上去，可以重试`, "warn");
  };

  const remove = (assetId: string) => onShotsChange((current) => current.filter((shot) => shot.assetId !== assetId));

  const clearAll = () => {
    if (shots.length === 0) return;
    const cleared = [...shots];
    onShotsChange([]);
    onCleared(cleared, () => onShotsChange((current) => [...cleared, ...current]));
  };

  const busy = uploading > 0;
  const empty = shots.length === 0;

  // Reading order is the order they were added in. There is no rank, no arc and
  // no stacking: the strip is a set of pictures, and the only thing it has to
  // say is which ones are in it.
  const strip = shots;

  // One state, one component. The add control is a dashed square like the slot
  // it stands for, in every state — it is never a different thing. A labelled
  // button for the empty case was what made this area read as a control bolted
  // under the field rather than as the place photos go, so it is gone.
  const zoneClass = `composer-shots ${dragging ? "is-dragging" : ""} ${empty ? "is-empty" : "has-shots"}`;
  const zoneHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => { event.preventDefault(); dragDepth.current += 1; setDragging(true); },
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy" as const; },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); },
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void takeFiles(Array.from(event.dataTransfer.files)); },
  };

  const fileInput = <input ref={inputRef} className="shot-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void takeFiles(files); }} />;

  /**
   * One strip, one component. Every photo is the same square and they run in the
   * order they were added, with the add square as the last tile in the row —
   * which is where 微信, 微博 and 小红书 all put it, and therefore where nobody
   * has to look for it. On an empty composer that square is simply the only tile
   * there: the row does not change shape, it only has one member.
   *
   * A desk gets one row of nine. A phone cannot fit nine across, so the same row
   * is allowed to wrap into 朋友圈's grid; the tiles never change size or shape,
   * only the number that fits per line. That is the whole responsive story — no
   * second rendering, no second set of rules, and nothing that has to be kept in
   * sync with the other one.
   */
  return <div className={zoneClass} {...zoneHandlers}>
    <div className="shot-row">
      <ul className="shot-strip" data-count={shots.length}>
        {strip.map((shot) => <li className="shot-tile" key={shot.assetId}>
          <img src={assetThumbUrl(shot.assetId, 400)} alt={shot.label ?? "已添加的照片"} loading="lazy" decoding="async" />
          <button className="shot-tile-remove" type="button" onClick={() => remove(shot.assetId)} aria-label={`移除 ${shot.label ?? "这张照片"}`}><X size={12} strokeWidth={2.4} aria-hidden="true" /></button>
        </li>)}
        {/* The slot for the next photo, and the same dashed square whether or
            not there are any yet. A dashed box with a plus is the one add
            affordance nobody has to be taught; an empty composer just happens to
            be showing only this one. */}
        <li className="shot-tile shot-tile-add">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} aria-label="添加照片">
            <Plus size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </li>
      </ul>
      {/* The two things that are about the strip rather than in it. They ride
          the end of the same row, so they cost no height of their own: on a
          line underneath they would add a full caption line of blank below
          the last row of photos, which is exactly the stretch of nothing the
          owner kept seeing. The tally and the broom are both simply there — the
          broom does not wait for a hover, because a control people cannot see is
          a control half of them never use. */}
      {empty
        ? null
        : <div className="shot-strip-meta">
            <span className="shot-strip-tally">{shots.length}/{SHOT_LIMIT}</span>
            <button className="shot-clear" type="button" onClick={clearAll} aria-label="清空全部照片"><Eraser size={13} strokeWidth={2} aria-hidden="true" /><span>清空</span></button>
            {busy ? <span className="shot-busy" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" /></span> : null}
          </div>}
    </div>
    {fileInput}
  </div>;
}
