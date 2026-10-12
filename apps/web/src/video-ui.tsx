import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Asset } from "@lifeos/core";
import type { ApiUploadProgress } from "./api";
import { getOriginal } from "./video/originals";
import "./video.css";

export const VideoScopeContext = createContext("");
export type VideoUpload = (file: File, signal: AbortSignal, progress: (value: ApiUploadProgress) => void) => Promise<Asset>;

const sizeText = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const durationText = (asset: Asset) => `${Math.round(asset.videoMetadata?.durationSeconds ?? 0)}秒`;

/** A video opens with the best source this device has, then falls back quietly. */
export function VideoPlayer({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const scope = useContext(VideoScopeContext);
  const [local, setLocal] = useState<string | null>(null), [ready, setReady] = useState(false), [error, setError] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true, url: string | null = null;
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    void getOriginal(scope, asset.id).then(file => {
      if (!alive) return;
      if (file) { url = URL.createObjectURL(file); setLocal(url); }
    }).catch(() => undefined).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); document.removeEventListener("keydown", escape); previous?.focus(); };
  }, [scope, asset.id, onClose]);
  const source = local ?? `/api/assets/${encodeURIComponent(asset.id)}/video`;
  return createPortal(<div className="video-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="video-dialog" role="dialog" aria-modal="true" aria-label={`播放视频 ${asset.originalName ?? ""}`}>
    <div className="video-dialog-heading"><strong>{asset.originalName ?? "视频"}</strong><button ref={closeButton} className="icon-button" type="button" onClick={onClose} aria-label="关闭视频"><X size={18} /></button></div>
    {ready ? <video key={source} controls playsInline preload="metadata" src={source} onError={() => { if (local) { setLocal(null); setError("本机原片无法播放，已自动使用压缩版"); } else setError("视频暂时无法播放，请重试"); }} /> : <p role="status">正在选择播放版本…</p>}
    <p className="video-hint">{local ? "正在播放本机原片，仅保存在此浏览器" : `正在播放压缩版 ${sizeText(asset.sizeBytes ?? 0)} ${durationText(asset)}`}</p>
    {error ? <p className="video-error" role="alert">{error}</p> : null}
  </section></div>, document.body);
}
