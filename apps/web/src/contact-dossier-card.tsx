import type { Entity } from "@lifeos/core";
import type { RecordView } from "./api";
import type { ToggleContactStar } from "./contact-star";
import { ContactStar } from "./contact-star";
import { ContactAvatar } from "./contact-avatar";
import { recordText } from "./app-meta";
import { lifeTimeDate, shortDate } from "./time";
import { contactJournalExcerpt } from "./contact-dossier-model";
import "./contact-dossier-card.css";

export function ContactDossierCard({ entity, journal, scope, relation, onOpen, onEditAvatar, onToggleStar, onViewRecord }: {
  entity: Entity; journal?: RecordView; scope: string; relation?: string;
  onOpen: (entity: Entity) => void; onEditAvatar: (entity: Entity) => void;
  onToggleStar: ToggleContactStar; onViewRecord: (id: string) => void;
}) {
  const text = journal ? contactJournalExcerpt(recordText(journal)) : "";
  return <article className="entity-library-card entity-library-card--person contact-dossier" data-entity-card={entity.id}>
    <div className="contact-dossier-head">
      <ContactAvatar entity={entity} scope={scope} dossier onEdit={onEditAvatar} />
      <div className="contact-dossier-identity">
        <div className="contact-dossier-name"><h2><button type="button" onClick={() => onOpen(entity)} aria-label={`查看联系人：${entity.name}`}>{entity.name}</button></h2><ContactStar entity={entity} onToggle={onToggleStar} /></div>
        {entity.aliases?.length ? <p className="contact-dossier-aliases">{entity.aliases.join("、")}</p> : null}
      </div>
    </div>
    {entity.description?.trim() ? <p className="contact-dossier-description">{entity.description}</p> : null}
    {journal && (text || journal.assetRefs.some(ref => ref.role === "photo")) ? <button type="button" className="contact-dossier-journal" aria-label={`预览与${entity.name}关联的日记`} data-record-id={journal.id} onClick={() => {
      if (window.getSelection()?.isCollapsed !== false) onViewRecord(journal.id);
    }}><time>{shortDate(lifeTimeDate(journal.occurredAt ?? journal.createdAt) ?? "")}</time><span className="contact-dossier-excerpt">{text || (journal.assetRefs.some(ref => ref.role === "photo") ? "照片日记" : "")}</span></button> : null}
    {relation ? <div className="contact-dossier-footer"><span>{relation}</span></div> : null}
  </article>;
}
