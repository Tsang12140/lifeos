import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { Asset } from "@lifeos/core";
import { ChevronLeft, ChevronRight, Download, Info, LoaderCircle, Maximize, Minus, Plus, RotateCcw, RotateCw, X } from "lucide-react";
import { apiRequest, type RecordView } from "./api";
import { assetContentUrl, viewerThumbUrl } from "./asset-urls";
import { boundPhoto, fitPhoto, fitTransform, zoomPhoto, type PhotoTransform } from "./asset-preview-model";
import { PhotoInformation, photoSummary, usePhotoInfo, type PhotoInfo } from "./photo-info";
import { lockDialogScroll } from "./dialog-scroll-lock";
import { recordText } from "./app-meta";
import { lifeTimeDate, lifeTimeTime } from "./time";
import { usePhotoPresentation } from "./photo-presentation";
import "./asset-preview.css";

export interface PreviewImage { readonly id: string; readonly url: string; readonly name?: string; readonly localInfo?: PhotoInfo }
interface Props {
  assetIds: readonly string[]; index: number; assets: readonly Asset[]; images?: readonly PreviewImage[];
  owners?: readonly RecordView[]; onClose: () => void; onIndexChange: (index: number) => void;
  onAssetChange?: (asset: Asset) => void;
}
interface EntryState { transform: PhotoTransform; rotation: number; original: boolean }
type Point = { x: number; y: number };

export function AssetPreview({ assetIds, index, assets, images, owners, onClose, onIndexChange, onAssetChange }: Props) {
  const id = assetIds[index] ?? assetIds[0] ?? "";
  const asset = assets.find(a => a.id === id), image = images?.find(a => a.id === id), owner = owners?.[index];
  const key = `${owner?.id ?? ""}:${id}`;
  const video = asset?.kind === "video" || image?.localInfo?.mediaType?.startsWith("video/") === true;
  const session = useRef(new Map<string, EntryState>());
  const savedRotations = useRef(new Map<string, number>());
  const initial = (): EntryState => session.current.get(key) ?? { transform: fitTransform(), rotation: savedRotations.current.get(id) ?? asset?.displayRotation ?? 0, original: false };
  const [state, setState] = useState(() => ({ key, ...initial() }));
  if (state.key !== key) setState({ key, ...initial() });
  const entry = state.key === key ? state : { key, ...initial() };
  const current = useRef(entry); current.current = entry;
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 760px)").matches);
  const [sheet, setSheet] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false), mounted = useRef(true);
  const derived = !video && !image;
  const url = image?.url ?? (derived && !entry.original ? viewerThumbUrl(id, 2048) : assetContentUrl(id));
  const placeholder = image?.url ?? (derived ? viewerThumbUrl(id, 400) : url);
  const [load, setLoad] = useState<{ url: string; status: "loading" | "loaded" | "error"; width?: number; height?: number }>({ url, status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const presentation = usePhotoPresentation(url, attempt, !video, () => {
    if (current.current.key !== key) return;
    if (derived && !current.current.original) update({ original: true });
  });
  const status = video ? (load.url === url ? load.status : "loading") : presentation.status;
  const info = usePhotoInfo({ asset, assetId: video ? undefined : id, localInfo: image?.localInfo });
  const metadata = info.value?.photoMetadata;
  const dimensions = { width: metadata?.width ?? (presentation.photo?.url === url ? presentation.photo.width : undefined) ?? 1, height: metadata?.height ?? (presentation.photo?.url === url ? presentation.photo.height : undefined) ?? 1 };
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null), full = useRef<HTMLImageElement>(null), reading = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const geometry = useRef({ ...dimensions, ...{ stageWidth: size.width, stageHeight: size.height }, rotation: entry.rotation });
  geometry.current = { ...dimensions, stageWidth: size.width, stageHeight: size.height, rotation: entry.rotation };
  const fit = fitPhoto(dimensions.width, dimensions.height, size.width, size.height, entry.rotation);
  const maxZoom = Math.max(16, 1 / fit);
  const view = boundPhoto(entry.transform, dimensions.width, dimensions.height, size.width, size.height, entry.rotation);
  const update = useCallback((patch: Partial<EntryState>) => {
    const next = { ...current.current, ...patch };
    current.current = next; session.current.set(next.key, next); setState(next);
  }, []);
  const changeView = useCallback((transform: PhotoTransform) => {
    const g = geometry.current;
    update({ transform: boundPhoto(transform, g.width, g.height, g.stageWidth, g.stageHeight, g.rotation) });
  }, [update]);
  const zoomView = useCallback((transform: PhotoTransform, zoom: number, anchor: Point) => {
    const g = geometry.current;
    return zoomPhoto(transform, zoom, anchor, Math.max(16, 1 / fitPhoto(g.width, g.height, g.stageWidth, g.stageHeight, g.rotation)));
  }, []);
  useLayoutEffect(() => {
    if (Math.abs(view.x - current.current.transform.x) > .01 || Math.abs(view.y - current.current.transform.y) > .01) update({ transform: view });
  }, [size.width, size.height, dimensions.width, dimensions.height, entry.rotation]);
  const point = (x: number, y: number): Point => {
    const r = stage.current!.getBoundingClientRect(); return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };
  const navigate = useCallback((delta: number) => {
    if (savingRef.current) return;
    const next = Math.max(0, Math.min(assetIds.length - 1, index + delta));
    if (next !== index) onIndexChange(next);
  }, [assetIds.length, index, onIndexChange]);
  const latest = useRef({ navigate, onClose, mobile, sheet, video }); latest.current = { navigate, onClose, mobile, sheet, video };
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; last: Point; transform: PhotoTransform; moved: boolean; pinch: boolean; distance: number; center: Point; type: string } | null>(null);
  const suppressClick = useRef(false);
  const imagePress = useRef(false);
  const blankPress = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    const trigger = document.activeElement, element = dialog.current;
    element?.showModal(); const unlock = lockDialogScroll(); document.documentElement.classList.add("has-asset-preview");
    return () => {
      mounted.current = false; element?.close(); unlock(); document.documentElement.classList.remove("has-asset-preview");
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const element = stage.current; if (!element) return;
    const measure = () => { const r = element.getBoundingClientRect(); setSize({ width: Math.max(1, r.width), height: Math.max(1, r.height) }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const query = matchMedia("(max-width: 760px)"); const change = () => setMobile(query.matches);
    query.addEventListener("change", change); return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    setSheet(false); setSaveError(""); pointers.current.clear(); gesture.current = null;
  }, [key]);
  useEffect(() => { if (reading.current) reading.current.scrollTop = 0; }, [owner?.id]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true],video")) return;
      if (event.key === "Escape" && latest.current.mobile && latest.current.sheet) {
        event.preventDefault(); event.stopPropagation(); setSheet(false); return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (event.target instanceof Element && event.target.closest(".photo-reading-body")) return;
        event.preventDefault(); latest.current.navigate(event.key === "ArrowLeft" ? -1 : 1);
      }
      if ((event.key === "+" || event.key === "=" || event.key === "-") && !latest.current.video) {
        event.preventDefault(); changeView(zoomView(current.current.transform, current.current.transform.zoom * (event.key === "-" ? 1 / 1.25 : 1.25), { x: 0, y: 0 }));
      }
      if (event.key === "0" && !latest.current.video) changeView(fitTransform());
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [changeView]);
  useEffect(() => {
    const element = stage.current; if (!element || video) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); suppressClick.current = true;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      changeView(zoomView(current.current.transform, current.current.transform.zoom * Math.exp(-event.deltaY * unit * .002), point(event.clientX, event.clientY)));
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, [video, changeView]);
  const rotate = async (delta: number) => {
    if (savingRef.current || video) return;
    const before = current.current, rotation = (before.rotation + delta + 360) % 360;
    const nextFit = fitPhoto(dimensions.width, dimensions.height, size.width, size.height, rotation);
    const radians = delta * Math.PI / 180;
    const transform = before.transform.zoom <= 1.001 ? fitTransform() : {
      zoom: Math.max(1, Math.min(Math.max(16, 1 / nextFit), fit * before.transform.zoom / nextFit)),
      x: Math.cos(radians) * view.x - Math.sin(radians) * view.y,
      y: Math.sin(radians) * view.x + Math.cos(radians) * view.y,
    };
    update({ rotation, transform }); setSaveError("");
    if (!asset || id.startsWith("pending:")) return; // Unsaved upload previews have no server asset yet.
    savingRef.current = true; setSaving(true);
    try {
      const updated = await apiRequest<Asset>(`/api/assets/${encodeURIComponent(id)}/rotation`, { method: "PATCH", body: JSON.stringify({ rotation, expectedRotation: before.rotation }) });
      savedRotations.current.set(id, rotation);
      // Shared assets can occur in several diaries; keep each view's independent pan.
      for (const [entryKey, cached] of session.current) if (entryKey.endsWith(`:${id}`)) session.current.set(entryKey, { ...cached, rotation });
      onAssetChange?.(updated);
    } catch (error) {
      session.current.set(before.key, before);
      if (mounted.current && current.current.key === before.key) { update(before); setSaveError(error instanceof Error ? error.message : "方向保存失败，请重试"); }
    } finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (video || event.button !== 0 || event.target instanceof Element && event.target.closest("button,video,.asset-preview-status")) return;
    imagePress.current = event.target instanceof Element && Boolean(event.target.closest("img"));
    const p = point(event.clientX, event.clientY); pointers.current.set(event.pointerId, p);
    event.currentTarget.setPointerCapture(event.pointerId); suppressClick.current = false;
    if (pointers.current.size === 1) gesture.current = { start: p, last: p, transform: current.current.transform, moved: false, pinch: false, distance: 0, center: p, type: event.pointerType };
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { start: p, last: p, transform: current.current.transform, moved: true, pinch: true, distance: Math.max(1, Math.hypot(a.x-b.x,a.y-b.y)), center: { x: (a.x+b.x)/2, y: (a.y+b.y)/2 }, type: event.pointerType };
    }
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    const p = point(event.clientX, event.clientY), g = gesture.current; pointers.current.set(event.pointerId, p); g.last = p;
    if (Math.hypot(p.x-g.start.x,p.y-g.start.y)>5) g.moved = true;
    if (pointers.current.size >= 2 && g.pinch) {
      const [a,b] = [...pointers.current.values()], center = { x:(a.x+b.x)/2,y:(a.y+b.y)/2 };
      const next = zoomView(g.transform,g.transform.zoom*Math.hypot(a.x-b.x,a.y-b.y)/g.distance,g.center);
      changeView({ ...next, x:next.x+center.x-g.center.x,y:next.y+center.y-g.center.y });
    } else if (g.transform.zoom>1.001) changeView({ ...g.transform,x:g.transform.x+p.x-g.start.x,y:g.transform.y+p.y-g.start.y });
  };
  const up = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const g = gesture.current; pointers.current.delete(event.pointerId);
    if (!g) return;
    suppressClick.current = g.moved || g.pinch || cancelled;
    if (pointers.current.size) {
      if (pointers.current.size === 1 && g.pinch) { const remaining = [...pointers.current.values()][0]; g.start = remaining; g.last = remaining; g.transform = current.current.transform; }
      return;
    }
    gesture.current = null;
    if (!cancelled && !g.pinch && g.type === "touch" && g.transform.zoom<=1.001) {
      const dx=g.last.x-g.start.x,dy=g.last.y-g.start.y;
      if (Math.abs(dx)>=48 && Math.abs(dx)>Math.abs(dy)*1.5) navigate(dx<0?1:-1);
    }
  };
  const previousDiary = owner ? owners?.reduce((last,o,i) => i<index && o.id!==owner.id ? i : last, -1) ?? -1 : -1;
  const nextDiary = owner ? owners?.findIndex((o,i) => i>index && o.id!==owner.id) ?? -1 : -1;
  const ownerIndices = owner ? owners?.flatMap((o,i)=>o.id===owner.id?[i]:[]) ?? [] : [];
  const photoIndex = owner ? ownerIndices.indexOf(index)+1 : index+1, photoCount = owner ? ownerIndices.length : assetIds.length;
  const summary = video ? [] : photoSummary(info.value);
  const scale = fit * view.zoom;
  const imageStyle: CSSProperties = { width: dimensions.width * scale, height: dimensions.height * scale, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${entry.rotation}deg)` };
  const painted = useRef<{ style: CSSProperties; name: string }>({ style: imageStyle, name: "照片" });
  if (!video && status === "loaded") painted.current = { style: imageStyle, name: image?.name ?? asset?.originalName ?? "照片" };
  const backgroundUrl = video ? undefined : presentation.photo?.url;
  const zoom = (factor:number) => changeView(zoomView(view,view.zoom*factor,{x:0,y:0}));
  const button = (label:string, icon:ReactNode, action:()=>void, disabled=false) => <button type="button" className="photo-tool" aria-label={label} title={label} onClick={action} disabled={disabled}>{icon}</button>;
  return <dialog ref={dialog} className={`asset-preview photo-reader${mobile && sheet ? " has-reading-sheet" : ""}`} aria-label="照片预览" aria-modal="true" onCancel={event=>{event.preventDefault();event.stopPropagation();if(mobile&&sheet)setSheet(false);else onClose();}}
    onPointerDown={event=>{blankPress.current=event.target===event.currentTarget&&event.isPrimary&&event.button===0?{x:event.clientX,y:event.clientY,moved:false}:null;}}
    onPointerMove={event=>{const press=blankPress.current;if(press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>6)press.moved=true;}}
    onPointerCancel={()=>{blankPress.current=null;}}
    onClick={event=>{const press=blankPress.current;blankPress.current=null;if(event.target===event.currentTarget&&press&&!press.moved){if(mobile&&sheet)setSheet(false);else onClose();}}}>
    <span className="asset-preview-backdrop" aria-hidden="true" style={{"--preview-photo":backgroundUrl?`url(${JSON.stringify(backgroundUrl)})`:"none"} as CSSProperties}/>
    <div className="asset-preview-top-actions"><button type="button" className="asset-preview-close" aria-label="关闭预览" onClick={onClose}><X size={20}/></button></div>
    <section className="photo-reader-main" aria-label="照片查看区">
      <figure className="asset-preview-figure" data-load-state={status}>
        <div ref={stage} className="asset-preview-image-stage" data-zoom={view.zoom} data-rotation={entry.rotation} data-x={view.x} data-y={view.y} style={{cursor:video?"default":view.zoom>1?"grab":"default"}} onPointerDown={down} onPointerMove={move} onPointerUp={event=>up(event)} onPointerCancel={event=>up(event,true)} onDoubleClick={event=>{if(!video)changeView(view.zoom>1.001?fitTransform():zoomView(view,1/fit,point(event.clientX,event.clientY)));}} onClick={event=>{
          if(event.target===event.currentTarget&&!suppressClick.current){if(mobile&&sheet)setSheet(false);else if(!imagePress.current)onClose();}
        }}>
          {video?<video className="asset-preview-full asset-preview-video" key={id} src={url} controls playsInline preload="metadata" onLoadedData={()=>setLoad({url,status:"loaded"})} onError={()=>setLoad({url,status:"error"})}/>:<>
            {!presentation.photo?<img className="asset-preview-placeholder" src={placeholder} alt="" aria-hidden="true" draggable={false} style={imageStyle} onError={event=>{event.currentTarget.style.visibility="hidden";}}/>:null}
            <img ref={full} className="asset-preview-full" src={presentation.photo?.url} alt={presentation.photo ? painted.current.name : ""} aria-hidden={!presentation.photo} draggable={false} style={{ ...painted.current.style, visibility: presentation.photo ? "visible" : "hidden" }} />
          </>}
          {status==="loading"?<span className="asset-preview-loading" role="status" aria-label="正在加载照片"><LoaderCircle className="spin" size={18}/></span>:null}
          {status==="error"?<div className="asset-preview-status" role="status"><span>照片未能加载，请重试</span><button className="photo-tool" onClick={()=>{setLoad({url,status:"loading"});setAttempt(v=>v+1);}}>重试</button></div>:null}
        </div>
        <figcaption aria-live="polite">{owner?"本篇 ":""}{photoIndex} / {photoCount}</figcaption>
      </figure>
      <div className="photo-toolbar" role="group" aria-label="图片工具">
        {!video?<>
          {button("向左旋转",<RotateCcw size={18}/>,()=>void rotate(-90),saving)}
          {button("向右旋转",<RotateCw size={18}/>,()=>void rotate(90),saving)}
          {button("缩小",<Minus size={18}/>,()=>zoom(1/1.25),view.zoom<=1.001)}
          <button type="button" className="photo-tool photo-zoom-value" aria-label="按实际像素查看" title="按实际像素查看" onClick={()=>changeView(zoomView(view,1/fit,{x:0,y:0}))}>{Math.round(scale*100)}%</button>
          {button("放大",<Plus size={18}/>,()=>zoom(1.25),view.zoom>=maxZoom)}
          {button("适应窗口",<Maximize size={18}/>,()=>changeView(fitTransform()))}
          {derived?<button type="button" className="photo-tool photo-original" aria-label={entry.original?"返回预览":"查看原图"} aria-pressed={entry.original} onClick={()=>update({original:!entry.original})}>{entry.original?"预览":"原图"}</button>:null}
        </>:null}
        <a className="photo-tool" href={image?.url??`${assetContentUrl(id)}?download=1`} download={image?.name??asset?.originalName??"photo"} aria-label="下载原文件" title="下载原文件"><Download size={18}/></a>
      </div>
      {saving?<span className="photo-save-state" role="status">正在保存方向…</span>:saveError?<span className="photo-save-state" role="alert">{saveError}</span>:null}
    </section>
    {index>0?<button type="button" className="asset-preview-nav asset-preview-nav-prev" disabled={saving} aria-label="上一张" title="上一张（←）" onClick={()=>navigate(-1)}><ChevronLeft size={22}/></button>:null}
    {index<assetIds.length-1?<button type="button" className="asset-preview-nav asset-preview-nav-next" disabled={saving} aria-label="下一张" title="下一张（→）" onClick={()=>navigate(1)}><ChevronRight size={22}/></button>:null}
    <aside className="photo-reader-sidebar" id="photo-reader-details" hidden={mobile&&!sheet} aria-label="日记与照片信息">
      {owner?<div className="photo-diary-navigation" role="group" aria-label="切换日记"><button type="button" className="photo-tool" disabled={saving||previousDiary<0} onClick={()=>{const prev=owners![previousDiary];onIndexChange(owners!.findIndex(o=>o.id===prev.id));}}><ChevronLeft size={15}/>上一篇日记</button><button type="button" className="photo-tool" disabled={saving||nextDiary<0} onClick={()=>onIndexChange(nextDiary)}>下一篇日记<ChevronRight size={15}/></button></div>:null}
      <div className="photo-reader-scroll" ref={reading}>
        {owner?<article className="photo-reading" key={owner.id} data-record-id={owner.id}><header><span>日记</span><time>{lifeTimeDate(owner.occurredAt??owner.createdAt)}{lifeTimeTime(owner.occurredAt??owner.createdAt)?` ${lifeTimeTime(owner.occurredAt??owner.createdAt)}`:""}</time></header>{recordText(owner)?<p className="photo-reading-body">{recordText(owner)}</p>:null}</article>:null}
        {!video?<div className="photo-information-host"><PhotoInformation key={id} info={info} mobile={mobile}/></div>:null}
      </div>
    </aside>
    {mobile?<button className="photo-reading-toggle" type="button" aria-label={sheet?"收起阅读面板":"查看日记与照片信息"} aria-expanded={sheet} aria-controls="photo-reader-details" onClick={()=>setSheet(v=>!v)}><span>{owner?lifeTimeDate(owner.occurredAt??owner.createdAt):summary.find(s=>s.kind==="time")?.text??"照片信息"}</span>{owner?<span>日记与照片信息</span>:null}<Info size={17}/></button>:null}
  </dialog>;
}
