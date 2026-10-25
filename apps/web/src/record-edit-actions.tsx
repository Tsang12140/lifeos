import { createContext, useContext, type ReactNode } from "react";
import { Edit3, Trash2 } from "lucide-react";
import "./record-edit-actions.css";

const EditingRecordContext = createContext<string | null>(null);

/** Save and cancel belong to the editor; hide the source card's duplicate actions. */
export function RecordEditActionsProvider({ recordId, children }: { recordId: string | null; children: ReactNode }) {
  return <EditingRecordContext.Provider value={recordId}>{children}</EditingRecordContext.Provider>;
}

export function RecordEditActions({ recordId, disabled, onEdit, onDelete }: { recordId: string; disabled: boolean; onEdit: () => void; onDelete: () => void }) {
  const editingRecordId = useContext(EditingRecordContext);
  if (editingRecordId === recordId) return null;
  return <>
    <button className="record-action record-action-icon record-edit-control" type="button" onClick={onEdit} disabled={disabled} aria-label="编辑记录" title="编辑记录">
      <Edit3 size={14} aria-hidden="true" />
    </button>
    <button className="record-action record-action-icon record-edit-control record-action-danger" type="button" onClick={onDelete} disabled={disabled} aria-label="删除记录" title="删除记录">
      <Trash2 size={14} aria-hidden="true" />
    </button>
  </>;
}
