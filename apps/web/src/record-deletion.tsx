import { createContext, useContext, useEffect, useRef, useState } from "react";
import { assertValidTimelineRecord } from "@lifeos/core";
import { apiRequest, type ApiError, type RecordView } from "./api";
import "./record-deletion.css";

interface Receipt { revision: number; undoUntil: string; remainingMs: number }
export interface PendingRecordDeletion { record: RecordView; query: string; index: number; phase: "deleting" | "undoable" | "restoring"; receipt?: Receipt; deadline?: number }
const EMPTY: readonly PendingRecordDeletion[] = [];
const prefix = "lifeos.record-delete.v1.";
export const RecordDeletionContext = createContext<{ entries: readonly PendingRecordDeletion[]; undo: (id: string) => void }>({ entries: EMPTY, undo: () => {} });
export const useRecordDeletion = (id: string) => useContext(RecordDeletionContext).entries.find(entry => entry.record.id === id);

function readPending(scope: string): readonly PendingRecordDeletion[] {
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(prefix + scope) ?? "[]");
    if (!Array.isArray(entries) || entries.length > 100) return EMPTY;
    return entries.flatMap((entry: PendingRecordDeletion) => {
      assertValidTimelineRecord(entry.record);
      return entry.receipt && Number.isSafeInteger(entry.receipt.revision) && Number.isFinite(entry.deadline) && entry.deadline! > Date.now() && typeof entry.query === "string" && Number.isSafeInteger(entry.index)
        ? [{ ...entry, phase: "undoable" as const }] : [];
    });
  } catch { return EMPTY; }
}

/** Keep a short-lived source snapshot so refreshes do not remove the undo target. */
export function useRecordDeletions(scope: string | null, callbacks: { onFinished: (record: RecordView) => void; onRestored: (record: RecordView, entry: PendingRecordDeletion) => void; onError: (message: string) => void }) {
  const [state, setState] = useState<{ scope: string | null; entries: readonly PendingRecordDeletion[] }>({ scope: null, entries: EMPTY });
  const stateRef = useRef(state), scopeRef = useRef(scope), callbacksRef = useRef(callbacks);
  scopeRef.current = scope; callbacksRef.current = callbacks;
  useEffect(() => { scopeRef.current = scope; return () => { scopeRef.current = null; }; }, [scope]);
  const entries = state.scope === scope ? state.entries : EMPTY;
  const publish = (owner: string, next: readonly PendingRecordDeletion[]) => {
    if (scopeRef.current !== owner) return;
    stateRef.current = { scope: owner, entries: next }; setState(stateRef.current);
    try {
      const durable = next.filter(entry => entry.receipt);
      if (durable.length) sessionStorage.setItem(prefix + owner, JSON.stringify(durable));
      else sessionStorage.removeItem(prefix + owner);
    } catch { /* In-memory undo still works if session storage is unavailable. */ }
  };
  useEffect(() => { if (scope) publish(scope, readPending(scope)); else { stateRef.current = { scope: null, entries: EMPTY }; setState(stateRef.current); } }, [scope]);
  useEffect(() => {
    if (!scope) return;
    const waiting = entries.filter(entry => entry.phase === "undoable");
    if (!waiting.length) return;
    const timer = window.setTimeout(() => {
      const current = stateRef.current.entries;
      const expired = current.filter(entry => entry.phase === "undoable" && entry.deadline! <= Date.now());
      if (!expired.length) return;
      publish(scope, current.filter(entry => !expired.includes(entry)));
      for (const entry of expired) callbacksRef.current.onFinished(entry.record);
    }, Math.max(0, Math.min(...waiting.map(entry => entry.deadline!)) - Date.now()) + 5);
    return () => clearTimeout(timer);
  }, [entries, scope]);
  const requestWithRetry = async <T,>(owner: string, path: string, init: RequestInit): Promise<T> => {
    try { return await apiRequest<T>(path, init); }
    catch (error) {
      if (scopeRef.current !== owner || ((error as ApiError).status !== undefined && (error as ApiError).status! < 500)) throw error;
      return apiRequest<T>(path, init);
    }
  };
  const start = async (record: RecordView, query: string, index: number): Promise<boolean> => {
    const owner = scopeRef.current;
    if (!owner || stateRef.current.entries.some(entry => entry.record.id === record.id)) return false;
    const entry: PendingRecordDeletion = { record, query, index, phase: "deleting" };
    publish(owner, [...stateRef.current.entries, entry]);
    try {
      const receipt = await requestWithRetry<Receipt>(owner, `/api/records/${encodeURIComponent(record.id)}`, { method: "DELETE", body: JSON.stringify({ revision: record.revision, undoable: true }) });
      if (scopeRef.current !== owner) return true;
      const deadline = Date.now() + Math.max(0, Math.min(5000, receipt.remainingMs));
      publish(owner, stateRef.current.entries.map(item => item === entry ? { ...entry, receipt, deadline, phase: "undoable" } : item));
      return true;
    } catch (error) {
      if (scopeRef.current === owner) publish(owner, stateRef.current.entries.filter(item => item !== entry));
      throw error;
    }
  };
  const undo = async (id: string) => {
    const owner = scopeRef.current, entry = stateRef.current.entries.find(item => item.record.id === id);
    if (!owner || !entry?.receipt || entry.phase !== "undoable" || entry.deadline! <= Date.now()) return;
    publish(owner, stateRef.current.entries.map(item => item === entry ? { ...entry, phase: "restoring" } : item));
    try {
      const restored = await requestWithRetry<RecordView>(owner, `/api/records/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ revision: entry.receipt.revision }) });
      if (scopeRef.current !== owner) return;
      callbacksRef.current.onRestored(restored, entry);
      publish(owner, stateRef.current.entries.filter(item => item.record.id !== id));
    } catch (error) {
      if (scopeRef.current !== owner) return;
      publish(owner, stateRef.current.entries.map(item => item.record.id === id ? { ...entry, phase: "undoable" } : item));
      callbacksRef.current.onError((error as Error).message || "撤销失败，请重试");
    }
  };
  const retain = (records: readonly RecordView[] | null, query: string): readonly RecordView[] | null => {
    if (!records) return records;
    const next = [...records];
    for (const entry of [...entries].sort((a, b) => a.index - b.index)) if (entry.query === query && !next.some(record => record.id === entry.record.id)) next.splice(Math.max(0, Math.min(entry.index, next.length)), 0, entry.record);
    return next;
  };
  return { entries, start, undo, retain };
}

export function RecordDeleteUndo({ id }: { id: string }) {
  const { entries, undo } = useContext(RecordDeletionContext), entry = entries.find(item => item.record.id === id);
  const [seconds, setSeconds] = useState(5);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (entry?.phase !== "undoable") return;
    const frame = requestAnimationFrame(() => { if (!document.querySelector("dialog:modal")) button.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [entry?.phase]);
  useEffect(() => {
    if (!entry?.receipt) return;
    const update = () => setSeconds(Math.max(0, Math.ceil((entry.deadline! - Date.now()) / 1000)));
    update(); const timer = window.setInterval(update, 150); return () => clearInterval(timer);
  }, [entry?.deadline]);
  if (!entry) return null;
  return <div className="record-delete-undo" role="status"><span>{entry.phase === "deleting" ? "删除中…" : entry.phase === "restoring" ? "撤销中…" : `${seconds} 秒后收起`}</span><button ref={button} type="button" className="secondary-button" disabled={entry.phase !== "undoable" || seconds === 0} onClick={() => undo(id)}>撤销</button></div>;
}
