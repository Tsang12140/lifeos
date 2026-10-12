import { useEffect, useId, useRef, useState } from "react";
import { MapPin, Minus, Plus, X } from "lucide-react";
import type { Place } from "@lifeos/core";
import { PlaceMapButton } from "./place-map";
import { shiftMapCenter, type MapCenter } from "./place-map-geometry";
import "./place-card.css";

function MapImage({ place, large = false }: { place: Place; large?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 160, height: 160 });
  const [center, setCenter] = useState<MapCenter>({ longitude: place.longitude!, latitude: place.latitude! });
  const [zoom, setZoom] = useState(16), [retry, setRetry] = useState(0);
  const [source, setSource] = useState(""), [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => { setCenter({ longitude: place.longitude!, latitude: place.latitude! }); setZoom(16); }, [place.longitude, place.latitude]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(() => { const r = element.getBoundingClientRect(); if (r.width && r.height) setSize(current => { const next = { width: Math.max(100, Math.min(1024, Math.round(r.width))), height: Math.max(100, Math.min(1024, Math.round(r.height))) }; return current.width === next.width && current.height === next.height ? current : next; }); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(size).map(([key, value]) => [key, String(value)])), zoom: String(zoom), longitude: center.longitude.toFixed(6), latitude: center.latitude.toFixed(6) });
      // Retrying uses reload on the browser request while leaving server-side deduplication intact.
      if (retry) query.set("retry", String(retry));
      setState("loading"); setSource(`/api/places/${encodeURIComponent(place.id)}/map?${query}`);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [place.id, size, center, zoom, retry]);
  const pan = (dx: number, dy: number) => setCenter(current => shiftMapCenter(current, zoom, dx, dy));
  return <div className={large ? "place-map-interactive" : "place-mini-image"}>
    <div ref={host} className="place-map-canvas" data-map-state={state} tabIndex={large ? 0 : undefined} role={large ? "region" : undefined} aria-label={large ? "地点地图，可拖动或用方向键移动" : undefined}
      onPointerDown={event => { if (!large || state !== "ready" || (event.pointerType === "mouse" && event.button !== 0)) return; drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerUp={event => { const start = drag.current; drag.current = null; if (start?.id === event.pointerId) { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) pan(event.clientX - start.x, event.clientY - start.y); } }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => { if (!large) return; const offsets: Record<string, [number, number]> = { ArrowLeft: [80,0], ArrowRight: [-80,0], ArrowUp: [0,80], ArrowDown: [0,-80] }; const offset = offsets[event.key]; if (offset) { event.preventDefault(); event.stopPropagation(); pan(...offset); } }}>
      {source ? <img key={source} src={source} alt={`${place.name}周边地图`} draggable={false} onLoad={() => setState("ready")} onError={() => setState("error")} /> : null}
      {state !== "ready" ? <span className="place-map-status" role="status"><MapPin size={19} aria-hidden="true" />{state === "error" ? "地图暂不可用" : "地图加载中"}</span> : null}
    </div>
    {large ? <div className="place-map-tools"><button type="button" className="secondary-button" aria-label="缩小地图" disabled={zoom <= 3} onClick={() => setZoom(value => Math.max(3, value - 1))}><Minus size={15} /></button><button type="button" className="secondary-button" aria-label="放大地图" disabled={zoom >= 17} onClick={() => setZoom(value => Math.min(17, value + 1))}><Plus size={15} /></button><button type="button" className="secondary-button" onClick={() => { setCenter({ longitude: place.longitude!, latitude: place.latitude! }); setZoom(16); }}>回到店铺</button>{state === "error" ? <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>重试</button> : null}</div> : null}
  </div>;
}

export function PlaceMiniMap({ place }: { place: Place }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null), title = useId();
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  if (!Number.isFinite(place.longitude) || !Number.isFinite(place.latitude)) return null;
  const close = () => { dialog.current?.close(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  return <><button ref={trigger} type="button" className="place-mini-map" aria-label={`放大${place.name}的地图`} onClick={() => setOpen(true)}><MapImage place={place} /><span className="place-mini-caption">查看地图</span></button>{open ? <dialog ref={dialog} className="modal-dialog place-map-view-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onClose={event => { event.stopPropagation(); setOpen(false); }}>
    <div className="dialog-header"><h2 id={title}>{place.name}</h2><button className="icon-button compact-icon-button" type="button" aria-label="关闭地图预览" onClick={close}><X size={17} /></button></div>
    <div className="place-map-view-body"><MapImage place={place} large /><small className="place-card-credit">地图 © 高德地图</small></div>
    <div className="dialog-footer place-card-actions"><PlaceMapButton place={place} /><button className="secondary-button" type="button" onClick={close}>返回地点</button></div>
  </dialog> : null}</>;
}
