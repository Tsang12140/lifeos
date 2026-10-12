import { useEffect, useId, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { mapPlatform, placeMapLinks, type MapPlace } from "./place-map-links";
import "./place-card.css";

export function PlaceMapButton({ place, className = "secondary-button", disabled = false }: { place: MapPlace; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const platform = mapPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const links = placeMapLinks(place, platform);
  const close = () => { dialog.current?.close(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  return <><button ref={trigger} className={className} type="button" disabled={disabled} onClick={() => setOpen(true)} aria-label={`在地图中查看${place.name}`}><MapPin size={15} aria-hidden="true" /><span>地图</span></button>{open ? <dialog ref={dialog} className="modal-dialog place-map-dialog" data-platform={platform} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onClose={event => { event.stopPropagation(); setOpen(false); }}>
    <div className="dialog-header"><h2 id={titleId}>选择地图</h2><button className="icon-button compact-icon-button" type="button" aria-label="关闭地图选择" onClick={close}><X size={17} aria-hidden="true" /></button></div>
    <div className="place-map-body"><p className="place-map-name">{place.name}</p>{links.map(item => <div className="place-map-row" key={item.id}><a className="secondary-button place-map-provider" data-map-provider={item.id} href={item.href} target={platform === "desktop" || item.id === "amap" ? "_blank" : undefined} rel="noopener noreferrer">{item.name}</a>{platform !== "desktop" ? <a className="secondary-button" data-map-web={item.id} href={item.web} target="_blank" rel="noopener noreferrer" aria-label={`${item.name}网页版`}>网页版</a> : null}</div>)}{platform !== "desktop" ? <small>未安装或无法唤起时，可以打开网页版。</small> : null}</div>
  </dialog> : null}</>;
}
