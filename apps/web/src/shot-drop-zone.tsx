import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { AssetPreview, assetContentUrl, type PreviewImage } from "./timeline";
import { Eraser, LoaderCircle, Plus, RotateCw, X } from "lucide-react";
import type { Asset, AssetLink } from "@lifeos/core";
import { apiRequest } from "./api";
import type { ApiUploadProgress } from "./api";
import { ASSET_ROLE_LABEL, assetRoleFor, formatBytes } from "./app-meta";
import { sha256Hex } from "./contentHash";
import { isImageFile, isVideoFile, MEDIA_FILE_ACCEPT } from "./media-files";

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
export const SHOT_REORDER_TYPE = "application/x-lifeos-shot-order";

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
  readonly numbered?: boolean;
  /** Keeps the add-photo control visible beside a horizontally scrolling strip. */
  readonly addOutsideStrip?: boolean;
  readonly disabled?: boolean;
  readonly shots: readonly AssetLink[];
  readonly assets?: readonly Asset[];
  readonly onShotsChange: Dispatch<SetStateAction<readonly AssetLink[]>>;
  readonly onUpload: (file: File, signal: AbortSignal, onProgress: (progress: ApiUploadProgress) => void) => Promise<ShotUpload>;
  readonly onUploadVideo?: (file: File, signal: AbortSignal, onProgress: (progress: ApiUploadProgress) => void) => Promise<ShotUpload>;
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
  readonly mediaKind?: "photo" | "video";
}

interface ShotBatchProgress {
  readonly completed: number;
  readonly total: number;
}

export const ShotDropZone = forwardRef<ShotDropZoneHandle, ShotDropZoneProps>(function ShotDropZone({ scopeKey, numbered = false, addOutsideStrip = false, disabled = false, shots, assets = [], onShotsChange, onUpload, onUploadVideo, onNotify, onCleared, onBusyChange, onSubmissionState }, ref) {
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
  const stripRef = useRef<HTMLUListElement>(null);
  const draggingShotRef = useRef<string | null>(null);
  const [draggingShot, setDraggingShot] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null);
  const dropTargetRef = useRef<{ key: string; after: boolean } | null>(null);
  const [insertMarker, setInsertMarker] = useState<{ left: number; top: number; height: number } | null>(null);
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);
  const scrollFrameRef = useRef(0);
  const suppressPreviewUntilRef = useRef(0);
  const [preview, setPreview] = useState<{ images: readonly PreviewImage[]; ownedUrls: readonly string[]; index: number } | null>(null);
  const [previewAssets, setPreviewAssets] = useState<readonly Asset[]>([]);
  const closePreview = useCallback(() => setPreview(null), []);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { if (!preview) return; const urls = preview.ownedUrls; return () => { for (const url of urls) URL.revokeObjectURL(url); }; }, [preview?.ownedUrls]);
  const previewAssetId = preview?.images[preview.index]?.id;
  useEffect(() => {
    if (!previewAssetId || previewAssetId.startsWith("pending:")) return;
    const controller = new AbortController();
    void apiRequest<Asset>(`/api/assets/${encodeURIComponent(previewAssetId)}`, { signal: controller.signal }).then(asset => { if (!controller.signal.aborted) setPreviewAssets(current => [...current.filter(a => a.id !== asset.id), asset]); }).catch(() => { /* Original preview remains usable without metadata. */ });
    return () => controller.abort();
  }, [previewAssetId]);

  const orderedKeys = () => [
    ...shotsRef.current.map((shot) => ({ key: `asset:${shot.assetId}`, order: orderForAsset(shot.assetId) })),
    ...pendingRef.current.map((shot) => ({ key: `pending:${shot.id}`, order: shot.order })),
  ].sort((a, b) => a.order - b.order).map((item) => item.key);
  const moveShot = (from: string, target: string, after: boolean) => {
    if (disabled || from === target) return;
    const keys = orderedKeys();
    if (!keys.includes(from) || !keys.includes(target)) return;
    const next = keys.filter((key) => key !== from);
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, from);
    const ranks = new Map(next.map((key, index) => [key, index + 1]));
    for (const shot of shotsRef.current) orderByAssetRef.current.set(shot.assetId, ranks.get(`asset:${shot.assetId}`)!);
    nextOrderRef.current = next.length;
    publishPending(pendingRef.current.map((shot) => ({ ...shot, order: ranks.get(`pending:${shot.id}`)! })));
    setShotsTracked([...shotsRef.current].sort((a, b) => orderForAsset(a.assetId) - orderForAsset(b.assetId)));
  };
  const stopDragging = () => {
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    touchTimerRef.current = null;
    cancelAnimationFrame(scrollFrameRef.current);
    dragPointRef.current = null;
    draggingShotRef.current = null; setDraggingShot(null); dropTargetRef.current = null; setDropTarget(null); setInsertMarker(null);
  };
  const targetAt = (x: number, y: number) => {
    const strip = stripRef.current;
    if (!strip) return null;
    const bounds = strip.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    const tiles = [...strip.querySelectorAll<HTMLElement>("[data-shot-key]")].map(tile => ({ key: tile.dataset.shotKey!, rect: tile.getBoundingClientRect() }));
    if (!tiles.length) return null;
    const distance = (rect: DOMRect) => Math.max(rect.top - y, y - rect.bottom, 0);
    // Use row geometry so gaps and the leading/trailing slots are drop targets too.
    const nearest = tiles.reduce((a, b) => distance(b.rect) < distance(a.rect) ? b : a);
    const row = tiles.filter(tile => Math.abs(tile.rect.top - nearest.rect.top) < 2);
    const before = row.find(tile => x < tile.rect.left + tile.rect.width / 2);
    return before ? { key: before.key, after: false } : { key: row[row.length - 1]!.key, after: true };
  };
  const showTarget = (target: { key: string; after: boolean } | null) => {
    dropTargetRef.current = target; setDropTarget(target);
    const strip = stripRef.current, tile = strip && target ? [...strip.querySelectorAll<HTMLElement>("[data-shot-key]")].find(tile => tile.dataset.shotKey === target.key) : null;
    if (!strip || !tile || !target) { setInsertMarker(null); return; }
    const bounds = strip.getBoundingClientRect(), rect = tile.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 6;
    const edge = target.after ? rect.right + gap / 2 : rect.left - gap / 2;
    setInsertMarker({ left: Math.max(2, Math.min(strip.scrollWidth - 2, edge - bounds.left + strip.scrollLeft)), top: rect.top - bounds.top + strip.scrollTop, height: rect.height });
  };
  const updateDragPoint = (x: number, y: number) => { dragPointRef.current = { x, y }; showTarget(targetAt(x, y)); };
  const beginDragging = (key: string) => {
    draggingShotRef.current = key; setDraggingShot(key); suppressPreviewUntilRef.current = Date.now() + 500;
    const autoScroll = () => {
      const strip = stripRef.current, point = dragPointRef.current;
      if (!draggingShotRef.current || !strip) return;
      if (point && strip.scrollWidth > strip.clientWidth) {
        const bounds = strip.getBoundingClientRect();
        if (point.y >= bounds.top && point.y <= bounds.bottom && point.x >= bounds.left && point.x <= bounds.right) {
          const direction = point.x < bounds.left + 20 ? -1 : point.x > bounds.right - 20 ? 1 : 0;
          if (direction) { strip.scrollLeft += direction * 4; showTarget(targetAt(point.x, point.y)); }
        }
      }
      scrollFrameRef.current = requestAnimationFrame(autoScroll);
    };
    cancelAnimationFrame(scrollFrameRef.current); scrollFrameRef.current = requestAnimationFrame(autoScroll);
  };
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let startX = 0, startY = 0;
    const start = (event: TouchEvent) => {
      // Chrome may adjust a finger's target to the nearby remove button on a
      // small tile. A short tap still clicks it; a held gesture belongs to sorting.
      if (disabled || event.touches.length !== 1) return;
      const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-shot-key]");
      if (!tile) return;
      startX = event.touches[0]!.clientX; startY = event.touches[0]!.clientY;
      const key = tile.dataset.shotKey!;
      touchTimerRef.current = setTimeout(() => { touchTimerRef.current = null; beginDragging(key); navigator.vibrate?.(15); }, 350);
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0]; if (!touch) return;
      if (touchTimerRef.current && Math.hypot(touch.clientX - startX, touch.clientY - startY) > 8) { clearTimeout(touchTimerRef.current); touchTimerRef.current = null; }
      if (draggingShotRef.current) { event.preventDefault(); updateDragPoint(touch.clientX, touch.clientY); }
    };
    const end = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      const target = touch ? targetAt(touch.clientX, touch.clientY) : null;
      if (draggingShotRef.current) { event.preventDefault(); if (target) moveShot(draggingShotRef.current, target.key, target.after); }
      if (draggingShotRef.current) suppressPreviewUntilRef.current = Date.now() + 500;
      stopDragging();
    };
    const cancel = () => { if (draggingShotRef.current) suppressPreviewUntilRef.current = Date.now() + 500; stopDragging(); };
    strip.addEventListener("touchstart", start, { passive: true });
    strip.addEventListener("touchmove", move, { passive: false });
    strip.addEventListener("touchend", end, { passive: false });
    strip.addEventListener("touchcancel", cancel);
    return () => { strip.removeEventListener("touchstart", start); strip.removeEventListener("touchmove", move); strip.removeEventListener("touchend", end); strip.removeEventListener("touchcancel", cancel); stopDragging(); };
  }, [scopeKey, disabled]);
  const dropShot = (event: import("react").DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(SHOT_REORDER_TYPE)) return;
    event.preventDefault(); event.stopPropagation();
    const target = targetAt(event.clientX, event.clientY) ?? (event.clientX === 0 && event.clientY === 0 ? dropTargetRef.current : null);
    if (!disabled && event.dataTransfer.getData(SHOT_REORDER_TYPE) === scopeKey && draggingShotRef.current && target) moveShot(draggingShotRef.current, target.key, target.after);
    suppressPreviewUntilRef.current = Date.now() + 500;
    stopDragging();
  };
  const reorderHandlers = (key: string) => ({
    draggable: !disabled,
    tabIndex: 0,
    "data-shot-key": key,
    "aria-label": "照片，拖动调整顺序，或按 Alt 加方向键移动",
    onKeyDown: (event: import("react").KeyboardEvent<HTMLLIElement>) => {
      if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); const keys = orderedKeys(), index = keys.indexOf(key), forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const target = keys[index + (forward ? 1 : -1)]; if (target) moveShot(key, target, forward);
    },
    onDragStart: (event: import("react").DragEvent<HTMLLIElement>) => {
      if (disabled) { event.preventDefault(); return; }
      event.stopPropagation(); event.dataTransfer.setData(SHOT_REORDER_TYPE, scopeKey); event.dataTransfer.effectAllowed = "move"; beginDragging(key);
    },
    onDragOver: (event: import("react").DragEvent<HTMLLIElement>) => {
      if (!draggingShotRef.current || disabled || !Array.from(event.dataTransfer.types).includes(SHOT_REORDER_TYPE)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
      updateDragPoint(event.clientX, event.clientY);
    },
    onDrop: dropShot,
    onDragEnd: () => { suppressPreviewUntilRef.current = Date.now() + 500; stopDragging(); },
    onContextMenu: (event: import("react").MouseEvent<HTMLLIElement>) => { if (draggingShotRef.current) event.preventDefault(); },
  });
  const reorderClass = (key: string) => draggingShot === key ? " is-reordering" : "";

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
    closePreview(); setPreviewAssets([]);
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
          const upload = job.mediaKind === "video" ? onUploadVideo : onUpload;
          if (!upload) throw new Error("当前入口不支持视频");
          const uploaded = await upload(job.file, controller.signal, ({ loaded, total }) => {
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
          setPreview(current => current ? { ...current, images: current.images.map(image => image.id === `pending:${job.id}` ? { ...image, id: uploaded.asset.id } : image) } : current);
          if (!alreadyAttached) {
            orderByAssetRef.current.set(uploaded.asset.id, pendingRef.current.find((shot) => shot.id === job.id)?.order ?? job.order);
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
          updatePendingShot(job.id, (shot) => ({ ...shot, state: "failed", progress: 0, error: error instanceof Error ? error.message : "媒体上传失败" }));
          onNotify("媒体上传失败，可重试或移除", "warn");
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
    const media = files.filter((file) => isImageFile(file) || (onUploadVideo && isVideoFile(file)));
    if (media.length === 0) {
      onNotify(onUploadVideo ? "请选择图片或常见视频" : "请选择图片", "warn");
      return;
    }
    if (media.length < files.length) onNotify(onUploadVideo ? "已跳过不支持的文件，请选择图片或常见视频" : "已跳过非图片文件", "warn");
    const room = SHOT_LIMIT - shotsRef.current.length - pendingRef.current.length;
    if (room <= 0) {
      onNotify(`最多添加 ${SHOT_LIMIT} 项，先移除一项再添加`, "warn");
      return;
    }
    const batch = media.slice(0, room);
    if (media.length > room) onNotify(`一次最多 ${SHOT_LIMIT} 项，只收下了前 ${room} 项`, "warn");
    const added: PendingShot[] = [];
    for (const file of batch) {
      try {
        idCounterRef.current += 1;
        added.push({ id: `${scopeGenerationRef.current}-${idCounterRef.current}`, order: ++nextOrderRef.current, file, previewUrl: URL.createObjectURL(file), state: "queued", progress: 0, mediaKind: isVideoFile(file) ? "video" : "photo" });
      } catch {
        onNotify("无法预览这个媒体文件，请重新选择", "warn");
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
  const openPreview = (key: string) => {
    if (draggingShotRef.current || Date.now() < suppressPreviewUntilRef.current) return;
    const ownedUrls: string[] = [];
    try {
      const images = strip.map((entry): PreviewImage => {
        if (entry.type === "complete") return { id: entry.shot.assetId, url: assetContentUrl(entry.shot.assetId), ...(entry.shot.label ? { name: entry.shot.label } : {}) };
        // Upload completion releases the thumbnail URL; an open viewer owns its own.
        const url = URL.createObjectURL(entry.shot.file); ownedUrls.push(url);
        return { id: `pending:${entry.shot.id}`, url, name: entry.shot.file.name, localInfo: { originalName: entry.shot.file.name, mediaType: entry.shot.file.type, sizeBytes: entry.shot.file.size } };
      });
      const id = key.startsWith("asset:") ? key.slice(6) : key;
      const index = images.findIndex(image => image.id === id);
      if (index < 0) { for (const url of ownedUrls) URL.revokeObjectURL(url); return; }
      setPreview({ images, ownedUrls, index });
    } catch { for (const url of ownedUrls) URL.revokeObjectURL(url); onNotify("无法预览这张照片，请重新选择", "warn"); }
  };

  // The parent composer accepts dropped files across the whole input frame;
  // this strip owns uploads, thumbnails and the file-picker button.
  const zoneClass = `composer-shots ${empty ? "is-empty" : "has-shots"}`;

  const fileInput = <input ref={inputRef} className="shot-file-input" type="file" accept={onUploadVideo ? MEDIA_FILE_ACCEPT : "image/*"} multiple tabIndex={-1} aria-hidden="true" disabled={disabled} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; takeFiles(files); }} />;
  const openPicker = () => { if (!disabled && remaining > 0) inputRef.current?.click(); };

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
      <ul ref={stripRef} className="shot-strip" data-count={shots.length + pending.length} aria-busy={busy ? "true" : undefined} onDragOver={(event) => { if (draggingShotRef.current && !disabled && Array.from(event.dataTransfer.types).includes(SHOT_REORDER_TYPE)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; updateDragPoint(event.clientX, event.clientY); } }} onDragLeave={event => { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) updateDragPoint(event.clientX, event.clientY); }} onDrop={dropShot}>
        {strip.map((entry, index) => entry.type === "complete" ? <li className={`shot-tile${reorderClass(`asset:${entry.shot.assetId}`)}`} {...reorderHandlers(`asset:${entry.shot.assetId}`)} key={entry.shot.assetId} data-shot-state="complete" data-asset-id={entry.shot.assetId}>
          {numbered ? <span className="shot-number">{index + 1}</span> : null}
          <button type="button" draggable={!disabled} className="shot-preview-button" aria-label={`放大查看 ${entry.shot.label ?? "媒体"}`} onClick={() => openPreview(`asset:${entry.shot.assetId}`)}>{assets.find(asset => asset.id === entry.shot.assetId)?.kind === "video" ? <video muted playsInline preload="metadata" src={assetContentUrl(entry.shot.assetId)} aria-label={entry.shot.label ?? "视频"} /> : <img draggable={!disabled} src={assetThumbUrl(entry.shot.assetId, 400)} alt={entry.shot.label ?? "已添加的媒体"} loading="lazy" decoding="async" onLoad={() => releaseCommittedPreview(entry.shot.assetId)} />}
          {committedPreviews.get(entry.shot.assetId) && entry.shot.role !== "video" ? <img draggable={!disabled} className="shot-tile-local-preview" src={committedPreviews.get(entry.shot.assetId)} alt="" aria-hidden="true" /> : null}</button>
          <button className="shot-tile-remove" type="button" disabled={disabled} onClick={() => removeAsset(entry.shot.assetId)} aria-label={`移除 ${entry.shot.label ?? "这张照片"}`}><X size={12} strokeWidth={2.4} aria-hidden="true" /></button>
        </li> : <li className={`shot-tile shot-tile-pending${reorderClass(`pending:${entry.shot.id}`)}`} {...reorderHandlers(`pending:${entry.shot.id}`)} key={entry.shot.id} data-shot-state={entry.shot.state} data-upload-id={entry.shot.id} data-file-name={entry.shot.file.name} title={entry.shot.error}>
          {numbered ? <span className="shot-number">{index + 1}</span> : null}
          <button type="button" draggable={!disabled} className="shot-preview-button" aria-label={`放大查看 ${entry.shot.file.name || "媒体"}`} onClick={() => openPreview(`pending:${entry.shot.id}`)}>{entry.shot.mediaKind === "video" ? <video muted playsInline preload="metadata" src={entry.shot.previewUrl} aria-label={entry.shot.file.name || "视频"} /> : <img draggable={!disabled} src={entry.shot.previewUrl} alt={entry.shot.file.name || "照片"} loading="eager" decoding="async" />}</button>
          {entry.shot.state === "uploading" || entry.shot.state === "processing" ? <div className="shot-upload-progress" role="progressbar" aria-label={`照片上传进度 ${entry.shot.progress}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={entry.shot.progress}><span style={{ width: `${entry.shot.progress}%` }} /></div> : null}
          <span className="shot-upload-state" role="status">{entry.shot.state === "queued" ? "等待" : entry.shot.state === "preparing" ? "准备中" : entry.shot.state === "uploading" ? `${entry.shot.progress}%` : entry.shot.state === "processing" ? "处理中" : "失败"}</span>
          {entry.shot.state === "failed" ? <button className="shot-tile-retry" type="button" disabled={disabled} onClick={() => retry(entry.shot.id)} aria-label={`重试上传 ${entry.shot.file.name || "照片"}`} title="重试上传"><RotateCw size={12} aria-hidden="true" /></button> : null}
          <button className="shot-tile-remove" type="button" disabled={disabled} onClick={() => removePending(entry.shot.id)} aria-label={`移除 ${entry.shot.file.name || "待处理照片"}`} title="移除照片"><X size={12} strokeWidth={2.4} aria-hidden="true" /></button>
        </li>)}
        {insertMarker && dropTarget ? <li className="shot-insert-marker" aria-hidden="true" data-insert-key={dropTarget.key} data-insert-after={dropTarget.after} style={{ left: insertMarker.left, top: insertMarker.top, height: insertMarker.height }} /> : null}
        {/* The same dashed square is the only photo slot when empty and stays
            at the end of the row after photos are added. */}
        {!addOutsideStrip ? <li className="shot-tile shot-tile-add">
          <button type="button" onClick={openPicker} disabled={disabled || remaining === 0} aria-label="添加照片或视频">
            <Plus size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </li> : null}
      </ul>
      {addOutsideStrip ? <div className="shot-tile shot-tile-add shot-tile-add-outside">
        <button type="button" onClick={openPicker} disabled={disabled || remaining === 0} aria-label="添加照片或视频">
          <Plus size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div> : null}
      {/* The two things that are about the strip rather than in it. They ride
          the end of the same row, so they cost no height of their own: on a
          line underneath they would add a full caption line of blank below
          the last row of photos, which is exactly the stretch of nothing the
          owner kept seeing. The tally and the broom are both simply there — the
          broom does not wait for a hover, because a control people cannot see is
          a control half of them never use. */}
      {!empty || batchProgress !== null
        ? <div className="shot-strip-meta">
            {!empty ? <span className="shot-strip-tally">{shots.length + pending.length}/{SHOT_LIMIT}</span> : null}
            {shots.length > 0 ? <button className="shot-clear" type="button" disabled={disabled} onClick={clearAll} aria-label="清空全部媒体"><Eraser size={13} strokeWidth={2} aria-hidden="true" /><span>清空</span></button> : null}
            {batchProgress !== null ? <span className="shot-progress-summary" role="status">已完成{batchProgress.completed}/{batchProgress.total}项</span> : null}
            {busy ? <span className="shot-busy" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span> : null}
          </div> : null}
    </div>
    {fileInput}
    {preview ? createPortal(<AssetPreview assetIds={preview.images.map(image => image.id)} images={preview.images} index={preview.index} assets={previewAssets} onClose={closePreview} onIndexChange={index => setPreview(current => current ? { ...current, index } : null)} />, document.body) : null}
  </div>;
});
