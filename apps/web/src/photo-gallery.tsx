import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@lifeos/core";
import { GALLERY_COLUMNS_STORAGE_KEY } from "./app-meta";
import { assetContentUrl, assetThumbDensitySet, assetThumbUrl } from "./asset-urls";
import { ArchiveColumnsIcon } from "./icon-archive";
import { formatMediaDuration } from "./media-duration";
import type { DiaryPhotoOccurrence } from "./photo-gallery-model";
import "./photo-gallery.css";

const PAGE_SIZE = 24;
/** `auto` keeps the responsive auto-fill; 2–4 are the archive icons the control offers. */
type GalleryColumns = "auto" | 2 | 3 | 4;
const GALLERY_COLUMN_CHOICES = [2, 3, 4] as const;
const COLUMN_HINTS: Record<(typeof GALLERY_COLUMN_CHOICES)[number], string> = { 2: "双列", 3: "三列", 4: "四列" };

function storedGalleryColumns(): GalleryColumns {
  const stored = window.localStorage.getItem(GALLERY_COLUMNS_STORAGE_KEY);
  return stored === "2" ? 2 : stored === "3" ? 3 : stored === "4" ? 4 : "auto";
}
/**
 * Tiles are square (see `.diary-photo-tile`), so one file per screen density is exact:
 * the phone grid measures 97–114px and the desktop column around 210px. Handing both
 * sets to the browser is what stops a 114px square from downloading the 400px file.
 */
const PHONE_THUMBS = [160, 240, 400] as const;
const DESKTOP_THUMBS = [240, 400] as const;

function monthTitle(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  return `${year}年${Number(month)}月`;
}

export function DiaryPhotoGallery({
  items,
  assets,
  loading,
  refreshing = false,
  recordsError,
  assetsError,
  interactionDisabled,
  retryDisabled = false,
  focusIndex = null,
  onRetry,
  onPreview,
  onFocusHandled,
}: {
  items: readonly DiaryPhotoOccurrence[];
  assets: readonly Asset[];
  loading: boolean;
  refreshing?: boolean;
  recordsError?: string | null;
  assetsError?: string | null;
  interactionDisabled: boolean;
  retryDisabled?: boolean;
  focusIndex?: number | null;
  onRetry: () => void;
  onPreview: (index: number) => void;
  onFocusHandled?: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [columns, setColumns] = useState<GalleryColumns>(storedGalleryColumns);
  const [hasScrolled, setHasScrolled] = useState(() => typeof window !== "undefined" && window.scrollY > 0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const visibleItems = items.slice(0, visibleCount);
  const groups = useMemo(() => {
    const result: Array<{ monthKey: string; items: Array<{ item: DiaryPhotoOccurrence; index: number }> }> = [];
    for (let index = 0; index < visibleItems.length; index += 1) {
      const item = visibleItems[index];
      let group = result[result.length - 1];
      if (!group || group.monthKey !== item.monthKey) {
        group = { monthKey: item.monthKey, items: [] };
        result.push(group);
      }
      group.items.push({ item, index });
    }
    return result;
  }, [visibleItems]);

  useEffect(() => {
    if (hasScrolled) return;
    const markScrolled = () => setHasScrolled(true);
    window.addEventListener("scroll", markScrolled, { once: true, passive: true });
    return () => window.removeEventListener("scroll", markScrolled);
  }, [hasScrolled]);

  useEffect(() => {
    if (!hasScrolled || visibleCount >= items.length || typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((count) => Math.min(items.length, count + PAGE_SIZE));
      }
    }, { rootMargin: "360px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasScrolled, items.length, visibleCount]);

  useEffect(() => {
    if (focusIndex === null || focusIndex < visibleCount) return;
    setVisibleCount(Math.min(items.length, Math.ceil((focusIndex + 1) / PAGE_SIZE) * PAGE_SIZE));
  }, [focusIndex, items.length, visibleCount]);

  useEffect(() => {
    if (focusIndex === null || focusIndex >= visibleCount) return;
    const tile = document.querySelector<HTMLButtonElement>(`.diary-photo-tile[data-photo-index="${focusIndex}"]`);
    if (!tile || tile.disabled) return;
    tile.scrollIntoView({ block: "center" });
    tile.focus({ preventScroll: true });
    onFocusHandled?.();
  }, [focusIndex, interactionDisabled, onFocusHandled, visibleCount]);

  const requestError = recordsError || assetsError;
  const isLoading = loading || items.length === 0 && !requestError && refreshing;
  const showColumnChoices = items.length > 0 && !requestError && !isLoading;
  const chooseColumns = (next: GalleryColumns) => {
    setColumns(next);
    window.localStorage.setItem(GALLERY_COLUMNS_STORAGE_KEY, String(next));
  };
  return <section className="diary-photo-gallery" aria-label="图库" aria-busy={isLoading || refreshing}>
    <div className="diary-photo-header">
      <h1 className="diary-photo-title">图库</h1>
      {refreshing || showColumnChoices ? <div className="diary-photo-tools">
        {refreshing ? <div className="diary-photo-refresh" role="status">正在更新</div> : null}
        {showColumnChoices ? <div className="diary-photo-columns" role="group" aria-label="图库每行列数">
          <button className={`diary-photo-column-option diary-photo-column-auto ${columns === "auto" ? "is-active" : ""}`} type="button" aria-pressed={columns === "auto"} title="自动：跟随窗口宽度" onClick={() => chooseColumns("auto")}>自动</button>
          {GALLERY_COLUMN_CHOICES.map((count) => <button key={count} className={`diary-photo-column-option ${columns === count ? "is-active" : ""}`} type="button" aria-pressed={columns === count} aria-label={COLUMN_HINTS[count]} title={`每行${COLUMN_HINTS[count]}照片`} onClick={() => chooseColumns(count)}><ArchiveColumnsIcon count={count} /></button>)}
        </div> : null}
      </div> : null}
    </div>
    {isLoading ? <div className="diary-photo-message" role="status">正在读取照片</div> : requestError ? <div className="diary-photo-message" role="alert"><span>{requestError}</span><button type="button" onClick={onRetry} disabled={retryDisabled}>重试</button></div> : items.length === 0 ? <div className="diary-photo-message" role="status">还没有照片日记</div> : <>
      <div className="diary-photo-months">
        {groups.map((group) => <section className="diary-photo-month" key={group.monthKey} aria-label={monthTitle(group.monthKey)}>
          <h2>{monthTitle(group.monthKey)}</h2>
          <div className="diary-photo-grid" data-columns={columns === "auto" ? undefined : columns}>
            {group.items.map(({ item, index }) => {
              const asset = assetById.get(item.assetId);
              if (!asset) return null;
              const originalName = asset.originalName?.trim();
              /* A clip has no derived thumbnail — the API only rasterises stills — so
                 the tile is the video element itself at `preload="metadata"`: the
                 browser fetches the header and paints the first frame, not the file.
                 Its label is the length, bottom right, and nothing else. */
              const duration = item.kind === "video" ? formatMediaDuration(asset.videoMetadata?.durationSeconds) : null;
              return <button
                className="diary-photo-tile"
                type="button"
                key={item.key}
                data-photo-index={index}
                data-media-kind={item.kind}
                aria-label={`${item.dateKey} 日记${item.kind === "video" ? "视频" : "照片"}${originalName ? `：${originalName}` : ""}${duration === null ? "" : `，时长 ${duration}`}`}
                disabled={interactionDisabled}
                onClick={() => onPreview(index)}
              >{item.kind === "video" ? <>
                <video src={assetContentUrl(item.assetId)} muted playsInline preload="metadata" />
                {duration === null ? null : <span className="diary-photo-duration">{duration}</span>}
              </> : <picture>
                <source media="(max-width: 560px)" srcSet={assetThumbDensitySet(item.assetId, PHONE_THUMBS)} />
                <img
                  src={assetThumbUrl(item.assetId, 400)}
                  srcSet={assetThumbDensitySet(item.assetId, DESKTOP_THUMBS)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              </picture>}</button>;
            })}
          </div>
        </section>)}
      </div>
      {visibleCount < items.length ? <>
        <div className="diary-photo-sentinel" ref={sentinelRef} aria-hidden="true" />
        {typeof IntersectionObserver === "undefined" ? <button className="diary-photo-load-more" type="button" onClick={() => setVisibleCount((count) => Math.min(items.length, count + PAGE_SIZE))}>加载更多</button> : null}
      </> : null}
    </>}
  </section>;
}
