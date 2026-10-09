import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { Film, X } from "lucide-react";
import { VIDEO_LIMITS, type Asset, type AssetLink } from "@lifeos/core";
import type { ApiUploadProgress } from "./api";
import { getOriginal, removeOriginals, saveOriginal } from "./video/originals";
import "./video.css";

export const VideoScopeContext = createContext("");
export type VideoUpload = (file: File, signal: AbortSignal, progress: (value: ApiUploadProgress) => void) => Promise<Asset>;
type SubmissionState = "active" | "failed" | null;
const sizeText = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const durationText = (asset: Asset) => `${Math.round(asset.videoMetadata?.durationSeconds ?? 0)}秒`;

function VideoPlayer({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const scope = useContext(VideoScopeContext);
  const [local, setLocal] = useState<string | null>(null), [original, setOriginal] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true, url: string | null = null;
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    void getOriginal(scope, asset.id).then(file => {
      if (!alive) return;
      if (file) { url = URL.createObjectURL(file); setLocal(url); setOriginal(true); }
    }).catch(() => { if (alive) setError("无法读取本机原片，可以播放云端压缩版"); }).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); document.removeEventListener("keydown", escape); previous?.focus(); };
  }, [scope, asset.id]);
  return createPortal(<div className="video-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="video-dialog" role="dialog" aria-modal="true" aria-label={`播放视频 ${asset.originalName ?? ""}`}>
    <div className="video-dialog-heading"><strong>{asset.originalName ?? "视频"}</strong><button ref={closeButton} className="icon-button" type="button" onClick={onClose} aria-label="关闭视频"><X size={18} /></button></div>
    {ready ? <video key={original ? "original" : "compressed"} controls playsInline preload="metadata" src={original && local ? local : `/api/assets/${encodeURIComponent(asset.id)}/video`} onError={() => setError(original ? "原片播放失败，可切换压缩版；部分浏览器不支持原片编码" : "视频暂时无法播放，请重试")} /> : <p role="status">正在读取本机原片…</p>}
    <div className="video-actions"><button className="secondary-button" type="button" disabled={!local || original} onClick={() => { setOriginal(true); setError(""); }}>查看本机原片</button><button className="secondary-button" type="button" disabled={!ready || !original} onClick={() => { setOriginal(false); setError(""); }}>查看压缩版</button></div>
    <p className="video-hint">{original ? "正在播放本机原片，仅保存在此浏览器" : `正在播放压缩版 ${sizeText(asset.sizeBytes ?? 0)} ${durationText(asset)}`}{ready && !local ? "；此浏览器没有保存原片" : ""}</p>
    {error ? <p className="video-error" role="alert">{error}</p> : null}
  </section></div>, document.body);
}
export function RecordVideoList({ assets, assetIds, onRemove, disabled = false }: { assets: readonly Asset[]; assetIds: readonly string[]; onRemove?: (id: string) => void; disabled?: boolean }) {
  const scope = useContext(VideoScopeContext), [playing, setPlaying] = useState<Asset | null>(null);
  const videos = assetIds.map(id => assets.find(asset => asset.id === id && asset.kind === "video")).filter((asset): asset is Asset => !!asset);
  if (!videos.length) return null;
  return <div className="record-videos" aria-label="视频附件">{videos.map(asset => <div className="record-video" key={asset.id}><button className="secondary-button video-open" type="button" disabled={disabled} onClick={() => setPlaying(asset)}><Film size={16} aria-hidden="true" /><span>{asset.originalName ?? "视频"}</span><small>{durationText(asset)}</small></button>{onRemove ? <button className="secondary-button" type="button" disabled={disabled} onClick={() => onRemove(asset.id)}>移除</button> : null}</div>)}{playing ? <VideoPlayer key={`${scope}:${playing.id}`} asset={playing} onClose={() => setPlaying(null)} /> : null}</div>;
}

export const VideoInput = forwardRef<{ takeFiles: (files: readonly File[]) => void }, { assets: readonly Asset[]; refs: readonly AssetLink[]; onChange: Dispatch<SetStateAction<readonly AssetLink[]>>; disabled: boolean; onUpload: VideoUpload; onState: (state: SubmissionState) => void; onNotify: (message: string, tone?: "ok" | "warn") => void }>(function VideoInput({ assets, refs, onChange, disabled, onUpload, onState, onNotify }, ref) {
  const scope = useContext(VideoScopeContext), input = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null);
  const alive = useRef(true), retainRef = useRef(true);
  const [retain, setRetain] = useState(true), [job, setJob] = useState<{ file: File; label: string; failed: boolean } | null>(null), [cleaning, setCleaning] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const cancel = () => { controller.current?.abort(); controller.current = null; setJob(null); onState(null); };
  const start = async (files: readonly File[], retry = false) => {
    if (!files.length || disabled) return;
    if (controller.current || (job && !retry)) { onNotify("请先完成、重试或移除正在处理的视频", "warn"); return; }
    if (files.length !== 1) { onNotify("请一次选择一个视频", "warn"); return; }
    const file = files[0]!;
    if (!file.size || file.size > VIDEO_LIMITS.maxInputBytes) { onNotify("请选择200 MB以内的非空视频", "warn"); return; }
    const current = new AbortController(); controller.current = current;
    const keep = retainRef.current;
    const update = (label: string) => { if (alive.current && !current.signal.aborted) setJob({ file, label, failed: false }); };
    update("准备压缩…"); onState("active");
    try {
      const { compressInWorker } = await import("./video/client");
      const compressed = await compressInWorker(file, { signal: current.signal, onProgress: value => update(`本机压缩 ${Math.floor(value * 100)}%`) });
      if (current.signal.aborted) return;
      const body = new File([compressed.bytes], file.name.replace(/\.[^.]+$/, "") + ".mp4", { type: "video/mp4" });
      update(`上传压缩版 ${sizeText(body.size)}`);
      const asset = await onUpload(body, current.signal, value => update(`上传压缩版 ${Math.floor(value.loaded / Math.max(1, value.total) * 100)}%`));
      if (!alive.current || current.signal.aborted) return;
      let localSaved = false, localError = "";
      if (keep) {
        update("保存本机原片…");
        try { await saveOriginal(scope, asset.id, file); localSaved = true; }
        catch (error) { localError = error instanceof Error ? error.message : "本机原片未能保存，请自行保留源文件"; }
      }
      if (!alive.current || current.signal.aborted) return;
      onChange(previous => previous.some(item => item.assetId === asset.id) ? previous : [...previous, { assetId: asset.id, role: "video" }]);
      setJob(null); onState(null);
      onNotify(`视频已上传压缩版 ${sizeText(file.size)} → ${sizeText(body.size)}${localSaved ? "，原片已留在本机" : ""}${localError ? `；${localError}` : ""}`, localError ? "warn" : "ok");
    } catch (error) {
      if (!alive.current || current.signal.aborted) return;
      setJob({ file, label: error instanceof Error ? error.message : "视频处理失败，请重试", failed: true }); onState("failed");
    } finally { if (controller.current === current) controller.current = null; }
  };
  useImperativeHandle(ref, () => ({ takeFiles: files => { void start(files); } }));
  const clear = async () => {
    if (!window.confirm("清理此账号保存在当前浏览器的全部视频原片副本？云端压缩版和设备相册中的源文件都会保留。")) return;
    setCleaning(true);
    try { await removeOriginals(scope); onNotify("已清理此账号在当前浏览器的视频原片副本"); }
    catch (error) { onNotify(error instanceof Error ? error.message : "清理失败", "warn"); }
    finally { if (alive.current) setCleaning(false); }
  };
  return <div className="video-input">
    <div className="video-actions"><button className="secondary-button" type="button" disabled={disabled || !!job || cleaning} onClick={() => input.current?.click()}><Film size={15} aria-hidden="true" />添加视频</button><button className="secondary-button" type="button" disabled={disabled || !!job || cleaning} onClick={() => void clear()}>{cleaning ? "正在清理…" : "清理本机副本"}</button></div>
    <label className="video-retain"><input type="checkbox" checked={retain} disabled={disabled || !!job} onChange={event => { retainRef.current = event.target.checked; setRetain(event.target.checked); }} />保留本机原片</label>
    <p className="video-hint">原片最多200 MB、3分钟；云端只存压缩版，最多50 MB。此账号本机原片合计最多1 GB，清理浏览器数据会丢失副本，请保留相册源文件。</p>
    <input ref={input} className="visually-hidden" type="file" accept="video/*,.mp4,.mov,.webm,.m4v" aria-label="选择视频" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void start([file]); }} />
    {job ? <div className="video-job" role={job.failed ? "alert" : "status"}><span className={job.failed ? "video-error" : ""}>{job.file.name}：{job.label}</span><div className="video-actions">{job.failed ? <button className="secondary-button" type="button" disabled={disabled} onClick={() => void start([job.file], true)}>重试</button> : null}<button className="secondary-button" type="button" disabled={disabled} onClick={cancel}>{job.failed ? "移除" : "取消处理"}</button></div></div> : null}
    <RecordVideoList assets={assets} assetIds={refs.filter(item => item.role === "video").map(item => item.assetId)} disabled={disabled} onRemove={id => onChange(previous => previous.filter(item => item.assetId !== id))} />
  </div>;
});
