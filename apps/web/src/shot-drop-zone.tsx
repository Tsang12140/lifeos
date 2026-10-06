import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Eraser, LoaderCircle, Plus, RotateCw, X } from "lucide-react";
import type { Asset, AssetLink } from "@lifeos/core";
import { apiRequest } from "./api";
import type { ApiUploadProgress } from "./api";
import { ASSET_ROLE_LABEL, assetRoleFor, formatBytes } from "./app-meta";
import { sha256Hex } from "./contentHash";

function assetThumbUrl(assetId: string, width: number): string {
  return `/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=${width}`;
}

/**
 * The photo strip inside the entry box. This is the only place in LifeOS
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
export async function resolveKnownShot(hash: string, signal?: AbortSignal): Promise<Asset | null> {
  try {
    const payload = await apiRequest<AssetResolveResponse>("/api/assets/resolve", { method: "POST", body: JSON.stringify({ algorithm: "sha256", value: hash }), signal });
    return payload.matched ? payload.asset ?? null : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

interface ShotDropZoneProps {
  readonly scopeKey: string;
  readonly disabled?: boolean;
  readonly shots: readonly AssetLink[];
  readonly onShotsChange: Dispatch<SetStateAction<readonly AssetLink[]>>;
  readonly onUpload: (file: File, signal: AbortSignal, onProgress: (progress: ApiUploadProgress) => void) => Promise<ShotUpload>;
  /** Says things the drop zone itself no longer says. The zone keeps no message
   *  line of its own: a paragraph of status text under a hand of cards reads as
   *  a defect in the panel. Anything that has to be said is said as a toast. */
  readonly onNotify: (message: string, tone?: "ok" | "warn") => void;
  /** Clearing the hand is one tap on a phone and one hover away on a desktop, so
   *  it has to be undoable. The zone hands the undo back to whoever owns the
   *  toast: it can put the photos back, but only the shell can offer the button. */
  readonly onCleared: (cleared: readonly AssetLink[], restore: () => boolean, cancelledPending: number) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onSubmissionState: (scopeKey: string, state: ShotSubmissionState) => void;
}

export interface ShotDropZoneHandle { takeFiles: (files: readonly File[]) => void; }

type PendingShotState = "queued" | "preparing" | "uploading" | "processing" | "failed";
type ShotSubmissionState = "active" | "failed" | null;

interface PendingShot {
  readonly id: string;
  readonly order: number;
  readonly file: File;
  readonly previewUrl: string;
  readonly state: PendingShotState;
  readonly progress: number;
  readonly error?: string;
}

interface ShotBatchProgress {
  readonly completed: number;
  readonly total: number;
}

export const ShotDropZone = forwardRef<ShotDropZoneHandle, ShotDropZoneProps>(function ShotDropZone({ scopeKey, disabled = false, shots, onShotsChange, onUpload, onNotify, onCleared, onBusyChange, onSubmissionState }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<readonly PendingShot[]>([]);
  const pendingRef = useRef<readonly PendingShot[]>([]);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const [batchProgress, setBatchProgress] = useState<ShotBatchProgress | null>(null);
  const batchProgressRef = useRef<ShotBatchProgress | null>(null);
  const [committedPreviews, setCommittedPreviews] = useState<ReadonlyMap<string, string>>(() => new Map());
  const committedPreviewsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const orderByAssetRef = useRef(new Map<string, number>());
  const nextOrderRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const workerTokenRef = useRef<{ readonly scope: string; readonly generation: number } | null>(null);
  const scopeGenerationRef = useRef(0);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const idCounterRef = useRef(0);

  const publishPending = (next: readonly PendingShot[], publishScope = scopeKey) => {
    pendingRef.current = next;
    setPending(next);
    const active = next.some((shot) => shot.state === "preparing" || shot.state === "uploading" || shot.state === "processing");
    const submissionState: ShotSubmissionState = next.some((shot) => shot.state === "failed") ? "failed" : next.length > 0 ? "active" : null;
    onBusyChange?.(active);
    onSubmissionState(publishScope, submissionState);
  };

  const publishBatchProgress = (next: ShotBatchProgress | null) => {
    batchProgressRef.current = next;
    setBatchProgress(next);
  };

  const setShotsTracked = (update: SetStateAction<readonly AssetLink[]>) => {
    const next = typeof update === "function" ? update(shotsRef.current) : update;
    shotsRef.current = next;
    onShotsChange(next);
  };

  const setCommittedPreviewsTracked = (update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>) => {
    const next = update(committedPreviewsRef.current);
    committedPreviewsRef.current = next;
    setCommittedPreviews(next);
  };

  const releaseCommittedPreview = (assetId: string) => {
    const url = committedPreviewsRef.current.get(assetId);
    if (url === undefined) return;
    revokePreview(url);
    setCommittedPreviewsTracked((current) => { const next = new Map(current); next.delete(assetId); return next; });
  };

  const orderForAsset = (assetId: string) => {
    const existing = orderByAssetRef.current.get(assetId);
    if (existing !== undefined) return existing;
    nextOrderRef.current += 1;
    orderByAssetRef.current.set(assetId, nextOrderRef.current);
    return nextOrderRef.current;
  };

  const revokePreview = (url: string) => {
    try { URL.revokeObjectURL(url); } catch { /* An already-revoked URL is harmless. */ }
  };

  useLayoutEffect(() => {
    const thisScope = scopeKey;
    scopeGenerationRef.current += 1;
    orderByAssetRef.current.clear();
    nextOrderRef.current = 0;
    for (const shot of shotsRef.current) orderForAsset(shot.assetId);
    pendingRef.current = [];
    setPending([]);
    publishBatchProgress(null);
    for (const url of committedPreviewsRef.current.values()) revokePreview(url);
    committedPreviewsRef.current = new Map();
    setCommittedPreviews(committedPreviewsRef.current);
    onBusyChange?.(false);
    onSubmissionState(thisScope, null);
    return () => {
      scopeGenerationRef.current += 1;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
      for (const shot of pendingRef.current) revokePreview(shot.previewUrl);
      for (const url of committedPreviewsRef.current.values()) revokePreview(url);
      committedPreviewsRef.current = new Map();
      pendingRef.current = [];
      onBusyChange?.(false);
      onSubmissionState(thisScope, null);
    };
  }, [scopeKey]);

  useEffect(() => {
    if (shots.length === 0 && pending.length === 0) publishBatchProgress(null);
  }, [shots.length, pending.length]);

  useEffect(() => {
    const live = new Set(shotsRef.current.map((shot) => shot.assetId));
    const orphaned = [...committedPreviewsRef.current].filter(([assetId]) => !live.has(assetId));
    if (orphaned.length === 0) return;
    for (const [, url] of orphaned) revokePreview(url);
    setCommittedPreviewsTracked((current) => {
      const next = new Map(current);
      for (const [assetId] of orphaned) next.delete(assetId);
      return next;
    });
  }, [shots]);

  const updatePendingShot = (id: string, update: (shot: PendingShot) => PendingShot) => {
    const next = pendingRef.current.map((shot) => shot.id === id ? update(shot) : shot);
    if (next.some((shot, index) => shot !== pendingRef.current[index])) publishPending(next);
  };

  const runQueue = async (runScope: string) => {
    const generation = scopeGenerationRef.current;
    if (workerTokenRef.current?.scope === runScope && workerTokenRef.current.generation === generation) return;
    const token = { scope: runScope, generation };
    workerTokenRef.current = token;
    const isCurrent = () => scopeRef.current === runScope && scopeGenerationRef.current === generation;
    try {
      while (isCurrent()) {
        const jobs = pendingRef.current;
        const job = jobs.find((shot) => shot.state === "queued");
        if (job === undefined) break;
        const controller = new AbortController();
        controllersRef.current.set(job.id, controller);
        updatePendingShot(job.id, (shot) => ({ ...shot, state: "preparing", progress: 0, error: undefined }));
        try {
          const uploaded = await onUpload(job.file, controller.signal, ({ loaded, total }) => {
            if (!isCurrent() || !pendingRef.current.some((shot) => shot.id === job.id)) return;
            const safeTotal = Math.max(0, total);
            const safeLoaded = Math.max(0, Math.min(loaded, safeTotal));
            const percent = safeTotal <= 0 ? 0 : safeLoaded >= safeTotal ? 100 : Math.min(99, Math.floor((safeLoaded / safeTotal) * 100));
            updatePendingShot(job.id, (shot) => shot.progress === percent && shot.state === (percent >= 100 ? "processing" : "uploading")
              ? shot
              : { ...shot, state: percent >= 100 ? "processing" : "uploading", progress: percent, error: undefined });
          });
          if (!isCurrent() || !pendingRef.current.some((shot) => shot.id === job.id)) continue;
          const assetLink: AssetLink = {
            assetId: uploaded.asset.id,
            role: assetRoleFor(uploaded.asset.kind),
            ...(uploaded.asset.originalName === undefined ? {} : { label: uploaded.asset.originalName }),
          };
          const alreadyAttached = shotsRef.current.some((shot) => shot.assetId === uploaded.asset.id);
          if (!alreadyAttached) {
            orderByAssetRef.current.set(uploaded.asset.id, job.order);
            setShotsTracked((current) => [...current, assetLink].sort((left, right) => orderForAsset(left.assetId) - orderForAsset(right.assetId)));
            setCommittedPreviewsTracked((current) => new Map(current).set(uploaded.asset.id, job.previewUrl));
          } else {
            revokePreview(job.previewUrl);
          }
          const progress = batchProgressRef.current;
          if (progress !== null) publishBatchProgress({ completed: Math.min(progress.total, progress.completed + 1), total: progress.total });
          publishPending(pendingRef.current.filter((shot) => shot.id !== job.id));
        } catch (error) {
          if (!isCurrent() || !pendingRef.current.some((shot) => shot.id === job.id)) continue;
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) continue;
          updatePendingShot(job.id, (shot) => ({ ...shot, state: "failed", progress: 0, error: error instanceof Error ? error.message : "照片上传失败" }));
          onNotify("照片上传失败，可重试或移除", "warn");
          // Continue serially so each photo gets its own result. The failed
          // tile remains in place and still blocks saving until resolved.
        } finally {
          controllersRef.current.delete(job.id);
        }
      }
    } finally {
      if (workerTokenRef.current === token) workerTokenRef.current = null;
    }
  };

  const takeFiles = (files: readonly File[]) => {
    if (disabled) return;
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      onNotify("只接受图片文件", "warn");
      return;
    }
    const room = SHOT_LIMIT - shotsRef.current.length - pendingRef.current.length;
    if (room <= 0) {
      onNotify(`已经 ${SHOT_LIMIT} 张了，时间轴一屏放不下，先删一张再加`, "warn");
      return;
    }
    const batch = images.slice(0, room);
    if (images.length > room) onNotify(`一次最多 ${SHOT_LIMIT} 张，只收下了前 ${room} 张`, "warn");
    const added: PendingShot[] = [];
    for (const file of batch) {
      try {
        idCounterRef.current += 1;
        added.push({ id: `${scopeGenerationRef.current}-${idCounterRef.current}`, order: ++nextOrderRef.current, file, previewUrl: URL.createObjectURL(file), state: "queued", progress: 0 });
      } catch {
        onNotify("无法预览这张照片，请重新选择", "warn");
      }
    }
    if (added.length === 0) return;
    const prior = pendingRef.current;
    const currentProgress = prior.length > 0 ? batchProgressRef.current : null;
    publishBatchProgress({ completed: currentProgress?.completed ?? 0, total: (currentProgress?.total ?? 0) + added.length });
    publishPending([...prior, ...added]);
    void runQueue(scopeRef.current);
  };
  useImperativeHandle(ref, () => ({ takeFiles: (files) => { void takeFiles(files); } }));

  const removeAsset = (assetId: string) => {
    if (disabled) return;
    orderByAssetRef.current.delete(assetId);
    const preview = committedPreviewsRef.current.get(assetId);
    if (preview !== undefined) {
      revokePreview(preview);
      setCommittedPreviewsTracked((current) => { const next = new Map(current); next.delete(assetId); return next; });
    }
    setShotsTracked((current) => current.filter((shot) => shot.assetId !== assetId));
  };

  const removePending = (id: string) => {
    if (disabled) return;
    const removed = pendingRef.current.find((shot) => shot.id === id);
    if (removed === undefined) return;
    controllersRef.current.get(id)?.abort();
    publishPending(pendingRef.current.filter((shot) => shot.id !== id));
    revokePreview(removed.previewUrl);
    const progress = batchProgressRef.current;
    if (progress !== null) {
      const total = Math.max(0, progress.total - 1);
      publishBatchProgress(total === 0 ? null : { completed: Math.min(progress.completed, total), total });
    }
    if (pendingRef.current.some((shot) => shot.state === "queued")) void runQueue(scopeRef.current);
  };

  const retry = (id: string) => {
    if (disabled) return;
    const failed = pendingRef.current.find((shot) => shot.id === id && shot.state === "failed");
    if (failed === undefined) return;
    updatePendingShot(id, (shot) => ({ ...shot, state: "queued", progress: 0, error: undefined }));
    void runQueue(scopeRef.current);
  };

  const clearAll = () => {
    if (disabled) return;
    const cleared = [...shotsRef.current];
    const cancelledPending = pendingRef.current.length;
    const clearScope = scopeRef.current;
    const clearGeneration = scopeGenerationRef.current;
    const clearedOrder = new Map(cleared.map((shot) => [shot.assetId, orderForAsset(shot.assetId)]));
    if (cleared.length === 0 && cancelledPending === 0) return;
    for (const shot of pendingRef.current) {
      controllersRef.current.get(shot.id)?.abort();
      revokePreview(shot.previewUrl);
    }
    for (const shot of cleared) orderByAssetRef.current.delete(shot.assetId);
    publishPending([]);
    publishBatchProgress(null);
    setShotsTracked([]);
    if (cleared.length > 0) onCleared(cleared, () => {
      if (scopeRef.current !== clearScope || scopeGenerationRef.current !== clearGeneration) return false;
      setShotsTracked((current) => {
        const known = new Set(current.map((shot) => shot.assetId));
        const missing = cleared.filter((shot) => !known.has(shot.assetId));
        for (const shot of missing) {
          const order = clearedOrder.get(shot.assetId);
          if (order !== undefined) orderByAssetRef.current.set(shot.assetId, order);
        }
        return [...missing, ...current].sort((left, right) => orderForAsset(left.assetId) - orderForAsset(right.assetId));
      });
      return true;
    }, cancelledPending);
    else if (cancelledPending > 0) onNotify(`已取消 ${cancelledPending} 张待处理照片`, "ok");
  };

  const busy = pending.some((shot) => shot.state === "preparing" || shot.state === "uploading" || shot.state === "processing");
  const empty = shots.length === 0 && pending.length === 0;
  const remaining = Math.max(0, SHOT_LIMIT - shots.length - pending.length);

  // Reading order is the order they were added in. There is no rank, no arc and
  // no stacking: the strip is a set of pictures, and the only thing it has to
  // say is which ones are in it.
  const strip = [
    ...shots.map((shot) => ({ type: "complete" as const, shot, order: orderForAsset(shot.assetId) })),
    ...pending.map((shot) => ({ type: "pending" as const, shot, order: shot.order })),
  ].sort((left, right) => left.order - right.order);

  // The parent composer accepts dropped files across the whole input frame;
  // this strip owns uploads, thumbnails and the file-picker button.
  const zoneClass = `composer-shots ${empty ? "is-empty" : "has-shots"}`;

  const fileInput = <input ref={inputRef} className="shot-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple tabIndex={-1} aria-hidden="true" disabled={disabled} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; takeFiles(files); }} />;

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
  return <div className={zoneClass}>
    <div className="shot-row">
      <ul className="shot-strip" data-count={shots.length + pending.length} aria-busy={busy ? "true" : undefined}>
        {strip.map((entry) => entry.type === "complete" ? <li className="shot-tile" key={entry.shot.assetId} data-shot-state="complete" data-asset-id={entry.shot.assetId}>
          <img src={assetThumbUrl(entry.shot.assetId, 400)} alt={entry.shot.label ?? "已添加的照片"} loading="lazy" decoding="async" onLoad={() => releaseCommittedPreview(entry.shot.assetId)} />
          {committedPreviews.get(entry.shot.assetId) ? <img className="shot-tile-local-preview" src={committedPreviews.get(entry.shot.assetId)} alt="" aria-hidden="true" /> : null}
          <button className="shot-tile-remove" type="button" disabled={disabled} onClick={() => removeAsset(entry.shot.assetId)} aria-label={`移除 ${entry.shot.label ?? "这张照片"}`}><X size={12} strokeWidth={2.4} aria-hidden="true" /></button>
        </li> : <li className="shot-tile shot-tile-pending" key={entry.shot.id} data-shot-state={entry.shot.state} data-upload-id={entry.shot.id} data-file-name={entry.shot.file.name} title={entry.shot.error}>
          <img src={entry.shot.previewUrl} alt={entry.shot.file.name || "正在添加的照片"} loading="eager" decoding="async" />
          {entry.shot.state === "uploading" || entry.shot.state === "processing" ? <div className="shot-upload-progress" role="progressbar" aria-label={`照片上传进度 ${entry.shot.progress}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={entry.shot.progress}><span style={{ width: `${entry.shot.progress}%` }} /></div> : null}
          <span className="shot-upload-state" role="status">{entry.shot.state === "queued" ? "等待" : entry.shot.state === "preparing" ? "准备中" : entry.shot.state === "uploading" ? `${entry.shot.progress}%` : entry.shot.state === "processing" ? "处理中" : "失败"}</span>
          {entry.shot.state === "failed" ? <button className="shot-tile-retry" type="button" disabled={disabled} onClick={() => retry(entry.shot.id)} aria-label={`重试上传 ${entry.shot.file.name || "照片"}`} title="重试上传"><RotateCw size={12} aria-hidden="true" /></button> : null}
          <button className="shot-tile-remove" type="button" disabled={disabled} onClick={() => removePending(entry.shot.id)} aria-label={`移除 ${entry.shot.file.name || "待处理照片"}`} title="移除照片"><X size={12} strokeWidth={2.4} aria-hidden="true" /></button>
        </li>)}
        {/* The same dashed square is the only photo slot when empty and stays
            at the end of the row after photos are added. */}
        <li className="shot-tile shot-tile-add">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled || remaining === 0} aria-label="添加照片">
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
      {!empty || batchProgress !== null
        ? <div className="shot-strip-meta">
            {!empty ? <span className="shot-strip-tally">{shots.length}/{SHOT_LIMIT}</span> : null}
            {shots.length > 0 ? <button className="shot-clear" type="button" disabled={disabled} onClick={clearAll} aria-label="清空全部照片"><Eraser size={13} strokeWidth={2} aria-hidden="true" /><span>清空</span></button> : null}
            {batchProgress !== null ? <span className="shot-progress-summary" role="status">已完成{batchProgress.completed}/{batchProgress.total}张</span> : null}
            {busy ? <span className="shot-busy" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span> : null}
          </div> : null}
    </div>
    {fileInput}
  </div>;
});
