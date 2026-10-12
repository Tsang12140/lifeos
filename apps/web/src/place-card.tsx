import { useContext, useEffect, useRef, useState } from "react";
import { MapPin, Phone, X } from "lucide-react";
import { PlaceMapButton } from "./place-map";
import { PlaceMiniMap } from "./place-map-preview";
import type { Entity, Place } from "@lifeos/core";
import { apiRequest } from "./api";
import { ContactAvatar, entityPhotoSrc, EntityPhotoScopeContext } from "./contact-avatar";
import { placeRoleLabel } from "./mention";
import "./place-card.css";

export function PlaceRecordCards({ ids, entities, disabled, onOpen }: { ids: readonly string[]; entities: readonly Entity[]; disabled: boolean; onOpen: (entity: Entity) => void }) {
  const scope = useContext(EntityPhotoScopeContext);
  const places = [...new Set(ids)].flatMap(id => { const entity = entities.find(item => item.id === id); return entity?.type === "place" ? [entity] : []; });
  if (!places.length) return null;
  return <div className="record-place-cards" aria-label="记录地点">{places.map(place => <PlaceRecordCard key={place.id} place={place} scope={scope} disabled={disabled} onOpen={onOpen} />)}</div>;
}

function PlaceRecordCard({ place, scope, disabled, onOpen }: { place: Place; scope: string; disabled: boolean; onOpen: (entity: Entity) => void }) {
  const src = entityPhotoSrc(place, scope);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <button className="record-place-card" type="button" disabled={disabled} onClick={() => onOpen(place)} aria-label={`查看地点：${place.name}`}>
    <span className="record-place-photo">{src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <MapPin size={22} aria-hidden="true" />}</span>
    <span className="record-place-copy"><strong>{place.name}</strong><small>{place.address || [place.city, place.district].filter(Boolean).join(" ") || "查看地点详情"}</small></span>
  </button>;
}

export function PlaceCardDialog({ entity, scope, onClose, onEdit, onEditAvatar, onViewRecords, onSaved }: { entity: Place; scope: string; onClose: () => void; onEdit: (entity: Entity) => void; onEditAvatar: (entity: Entity) => void; onViewRecords: (entity: Entity) => void; onSaved: (entity: Entity) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => setNotice(""), [entity.id]);
  const close = () => { if (!lock.current) onClose(); };
  const phone = entity.phone?.split(/[;,，；]/)[0]?.replace(/[^\d+\-]/g, "");
  const savePhoto = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice("");
    try {
      const result = await apiRequest<{ entity: Entity; saved: boolean }>(`/api/entities/${encodeURIComponent(entity.id)}/photo/import`, { method: "POST" });
      onSaved(result.entity);
      setNotice(result.saved ? "地点照片已保存" : "照片暂时未能保存，可以重试或上传自己的照片");
    } catch { setNotice("照片暂时未能保存，可以重试或上传自己的照片"); }
    finally { lock.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="modal-dialog place-card-dialog" aria-labelledby="place-card-title" onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
    <div className="dialog-header"><ContactAvatar entity={entity} scope={scope} onEdit={value => { if (!lock.current) onEditAvatar(value); }} /><div className="place-card-heading"><h2 id="place-card-title">{entity.name}</h2>{entity.role ? <small>{placeRoleLabel(entity.role)}</small> : null}</div><button type="button" className="icon-button compact-icon-button" aria-label="关闭地点详情" disabled={busy} onClick={close}><X size={17} aria-hidden="true" /></button></div>
    <div className={`place-card-body${Number.isFinite(entity.longitude) && Number.isFinite(entity.latitude) ? " has-map" : ""}`}><div className="place-card-details">
      <div className="place-card-field"><small>地址</small><p className="place-detail-copy">{entity.address || "尚未填写地址"}</p>{entity.city || entity.district ? <small>{[entity.province, entity.city, entity.district].filter(Boolean).join(" ")}</small> : null}</div>
      {entity.phone ? <div className="place-card-field"><small>电话</small><p className="place-detail-copy place-detail-phone">{entity.phone}</p></div> : null}
      {entity.description ? <div className="place-card-field"><small>备注</small><p className="place-detail-copy">{entity.description}</p></div> : null}
      {entity.amapId ? <small className="place-card-credit">地点资料来自高德地图</small> : null}
      {entity.amapId && entity.photoUrl && !entity.avatarAssetId ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void savePhoto()}>{busy ? "保存照片中…" : "保存地点照片"}</button> : null}
      {notice ? <p className="place-photo-notice" role="status">{notice}</p> : null}
    </div><PlaceMiniMap key={entity.id} place={entity} /></div>
    <div className="dialog-footer place-card-actions">
      <PlaceMapButton place={entity} disabled={busy} />
      {phone ? <a className="secondary-button" href={`tel:${phone}`}><Phone size={15} aria-hidden="true" /><span>打电话</span></a> : null}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onViewRecords(entity)}>相关日记</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => onEdit(entity)}>编辑地点</button>
    </div>
  </dialog>;
}
