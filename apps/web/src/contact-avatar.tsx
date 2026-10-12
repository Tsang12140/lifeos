import { useEffect, useRef, useState } from "react";
import { ContactRound, Edit3, LoaderCircle, X } from "lucide-react";
import type { Asset, Entity } from "@lifeos/core";
import { apiRequest, apiUploadRequest } from "./api";
import { avatarCrop } from "./contact-avatar-crop";
import "./contact-avatar.css";

export function ContactAvatar({ entity, scope, small = false, onEdit }: { entity: Entity; scope: string; small?: boolean; onEdit: (entity: Entity) => void }) {
  const id = entity.type === "person" ? entity.avatarAssetId : undefined;
  const src = id ? `/api/assets/${encodeURIComponent(id)}/thumbnail?w=160&scope=${encodeURIComponent(scope)}` : undefined;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <button type="button" className={`contact-avatar ${small ? "is-small" : ""}`} onClick={() => onEdit(entity)} aria-label={`${id ? "更换" : "添加"}${entity.name}的头像`} title={id ? "更换头像" : "添加头像"}>
    {src && !failed ? <img src={src} alt="" decoding="async" onError={() => setFailed(true)} /> : <ContactRound size={small ? 20 : 25} strokeWidth={1.7} aria-hidden="true" />}
    <span className="contact-avatar-edit"><Edit3 size={small ? 10 : 12} strokeWidth={1.8} aria-hidden="true" /></span>
  </button>;
}

export function ContactAvatarDialog({ entity, onClose, onSaved }: { entity: Entity | null; onClose: () => void; onSaved: (entity: Entity) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const lock = useRef(false);
  const selection = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    selection.current++;
    dragDepth.current = 0; setDragging(false);
    setImage(null); setZoom(1); setOffset({ x: 0, y: 0 }); setError(null);
    if (entity && !dialog.current?.open) dialog.current?.showModal();
    if (!entity && dialog.current?.open) dialog.current.close();
  }, [entity?.id]);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.src); }, [image]);
  const crop = image ? avatarCrop(image.naturalWidth, image.naturalHeight, zoom, offset.x, offset.y) : null;
  const close = () => { if (!lock.current) onClose(); };
  const choose = async (file: File) => {
    if (lock.current || !dialog.current?.open) return;
    const token = ++selection.current;
    setError(null);
    if (file.size > 20 * 1024 * 1024) { setError("请选择小于 20 MB 的图片"); return; }
    const url = URL.createObjectURL(file);
    const next = new Image(); next.src = url;
    try {
      await next.decode();
      if (!next.naturalWidth || next.naturalWidth * next.naturalHeight > 40_000_000) throw Error("请选择不超过 4000 万像素的图片");
      if (token !== selection.current) { URL.revokeObjectURL(url); return; }
      setImage(next); setZoom(1); setOffset({ x: 0, y: 0 });
    } catch (e) { URL.revokeObjectURL(url); if (token === selection.current) setError(e instanceof Error && e.message.startsWith("请选择") ? e.message : "无法读取这张图片，请换一张图片"); }
  };
  const receiveFiles = (files: FileList) => {
    if (lock.current) return;
    const file = Array.from(files).find(item => /^image\/(jpeg|png|webp|gif|avif)$/i.test(item.type) || (!item.type && /\.(jpe?g|png|webp|gif|avif)$/i.test(item.name)));
    if (file) void choose(file);
    else if (files.length) setError("请粘贴或拖入 JPEG、PNG、WebP、GIF 或 AVIF 图片");
  };
  const save = async (remove = false) => {
    if (!entity || lock.current || (!remove && (!image || !crop))) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      let avatarAssetId: string | null = null;
      if (!remove && image && crop) {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 160;
        const context = canvas.getContext("2d"); if (!context) throw Error("无法处理图片，请重试");
        context.drawImage(image, crop.sx, crop.sy, crop.size, crop.size, 0, 0, 160, 160);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error("无法处理图片，请重试")), "image/webp", .9));
        const asset = await apiUploadRequest<Asset>("/api/assets/uploads?purpose=avatar", blob, { contentType: blob.type });
        avatarAssetId = asset.id;
      }
      const updated = await apiRequest<Entity>(`/api/entities/${encodeURIComponent(entity.id)}`, { method: "PATCH", body: JSON.stringify({ avatarAssetId }) });
      onSaved(updated); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "头像未能保存，请重试"); }
    finally { lock.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className={`modal-dialog contact-avatar-dialog${dragging ? " is-dragging" : ""}`} aria-labelledby="contact-avatar-title" onCancel={e => { e.preventDefault(); close(); }} onClose={close}
    onPaste={e => { if (!dialog.current?.open || !e.clipboardData.files.length) return; e.preventDefault(); e.stopPropagation(); receiveFiles(e.clipboardData.files); }}
    onDragEnter={e => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); e.stopPropagation(); dragDepth.current++; if (!lock.current) setDragging(true); }}
    onDragOver={e => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = lock.current ? "none" : "copy"; }}
    onDragLeave={e => { e.stopPropagation(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={e => { e.preventDefault(); e.stopPropagation(); dragDepth.current = 0; setDragging(false); receiveFiles(e.dataTransfer.files); }}>
    <div className="dialog-header"><h2 id="contact-avatar-title">设置头像</h2><button type="button" className="icon-button compact-icon-button" aria-label="关闭头像设置" disabled={busy} onClick={close}><X size={17} /></button></div>
    <div className="contact-avatar-body">
      <div className="contact-avatar-crop" role="img" aria-label="头像裁切预览，可拖动或使用方向键移动图片" tabIndex={image ? 0 : -1}
        onPointerDown={e => { if (!crop || busy) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: crop.x, oy: crop.y }; }}
        onPointerMove={e => { if (!image || !drag.current || busy) return; const side = e.currentTarget.getBoundingClientRect().width; const next = avatarCrop(image.naturalWidth, image.naturalHeight, zoom, drag.current.ox + (e.clientX - drag.current.x) / side, drag.current.oy + (e.clientY - drag.current.y) / side); setOffset({ x: next.x, y: next.y }); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={e => { if (!image || !crop || busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return; e.preventDefault(); const next = avatarCrop(image.naturalWidth, image.naturalHeight, zoom, crop.x + (e.key === "ArrowRight" ? .03 : e.key === "ArrowLeft" ? -.03 : 0), crop.y + (e.key === "ArrowDown" ? .03 : e.key === "ArrowUp" ? -.03 : 0)); setOffset({ x: next.x, y: next.y }); }}>
        {image && crop ? <img src={image.src} alt="" draggable={false} style={{ width: `${crop.width * 100}%`, height: `${crop.height * 100}%`, left: `${50 + crop.x * 100}%`, top: `${50 + crop.y * 100}%` }} /> : <ContactRound size={52} strokeWidth={1.3} aria-hidden="true" />}
      </div>
      {image ? <label className="contact-avatar-zoom">缩放<input type="range" min="1" max="3" step=".01" value={zoom} disabled={busy} onChange={e => { const value = Number(e.target.value); const next = avatarCrop(image.naturalWidth, image.naturalHeight, value, offset.x, offset.y); setZoom(value); setOffset({ x: next.x, y: next.y }); }} /></label> : null}
      <p className="contact-avatar-hint">选择、粘贴或拖入图片，再拖动和缩放调整头像。</p>
      <div className="contact-avatar-options"><button type="button" className="secondary-button" disabled={busy} onClick={() => input.current?.click()}>选择图片</button>{entity?.type === "person" && entity.avatarAssetId ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(true)}>移除头像</button> : null}</div>
      <input ref={input} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" aria-label="选择头像图片" disabled={busy} onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void choose(file); e.currentTarget.value = ""; }} />
      {error ? <p className="dialog-error" role="alert">{error}</p> : null}
    </div>
    <div className="dialog-footer"><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button><button type="button" className="primary-button" disabled={busy || !image} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}<span>{busy ? "保存中" : "保存头像"}</span></button></div>
  </dialog>;
}
