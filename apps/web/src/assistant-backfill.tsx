import { backfillItemState, backfillEntryTime, backfillEntryReady, calendarToday } from "@lifeos/core";
import type { AssetLink } from "@lifeos/core";
import type { ComposerProps } from "./composer";
import { ShotDropZone, type ShotDropZoneHandle } from "./shot-drop-zone";
import { usePhotoInput } from "./photo-input";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { Eraser, Film, History, LoaderCircle, MessageSquarePlus, Plus, Settings2 } from "lucide-react";
import type { Asset, BackfillBatch, BackfillChatMessage, BackfillEntry, BackfillMaterial, BackfillObject, Entity, UiClarify, UiCommand, UiTurnPlan } from "@lifeos/core";
import { apiRequest, type ApiError } from "./api";
import {
  clearAssistantConversation,
  loadAssistantConversation,
  loadCurrentConversation,
  sendAssistantChatTurn,
  startAssistantConversation,
  type AssistantArchiveMessage,
  type AssistantHistoryAttachment,
} from "./assistant-history-api";
import { assistantMessageLengthError, clearPendingAssistantTurn, pendingTurnRecoveryStatus, readPendingAssistantTurn, writePendingAssistantTurn, type PendingAssistantMaterial, type PendingAssistantTurn } from "./assistant-pending-turn";
import { AssistantHistoryDialog } from "./assistant-history-dialog";
import { AssistantMessageActions } from "./assistant-message-actions";
import { clampFixedMenuPosition } from "./menu-position";
import { AssetPreview, assetContentUrl } from "./timeline";
import "./assistant-backfill.css";

const TYPE_LABEL = { person: "人物", place: "地点", movie: "电影" };
/**
 * Two people can share a nickname, so the assistant asks instead of picking. The
 * buttons carry the answer back as a sentence — "「姐姐」是王琳" — which the same
 * pipeline then resolves to an id. That way the choice is remembered for the rest
 * of the conversation without inventing a permanent mapping nobody asked for.
 */
function UiClarifyPrompt({ clarify, onPick }: { readonly clarify: UiClarify; readonly onPick: (text: string) => void }) {
  return <div className="backfill-ui-clarify">
    <p>{clarify.question}</p>
    <div className="backfill-operation-group">{clarify.candidates.map((candidate) => <button className="secondary-button" type="button" key={candidate.entityId} onClick={() => onPick(`「${clarify.term}」是${candidate.name}`)}><span>{candidate.name}</span>{candidate.hint === undefined ? null : <small className="backfill-ui-hint">{candidate.hint}</small>}</button>)}</div>
  </div>;
}
/** Where a right-click landed: the panel itself, or one message inside it. */
interface MenuState {
  readonly x: number;
  readonly y: number;
}
interface BackfillChatViewMessage extends BackfillChatMessage {
  readonly id?: string;
  /** Compiled interface commands that came with this reply. */
  readonly ui?: UiTurnPlan;
  readonly at?: string;
  readonly turnId?: string;
  readonly turnStatus?: AssistantArchiveMessage["turnStatus"];
  readonly retryable?: boolean;
  readonly attachments?: readonly AssistantHistoryAttachment[];
}
function DraftDateTime({ entry, generatedAt, editable, onChange }: { entry: BackfillEntry; generatedAt: string; editable: boolean; onChange: (patch: Partial<BackfillEntry>) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [clock, setClock] = useState("");
  const time = backfillEntryTime(entry, generatedAt);
  const apply = () => {
    if (!editing) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && (!clock || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock))) onChange({ date: value, time: clock });
    setEditing(false);
  };
  if (!editable) return <strong>{entry.date || "日期未定"}{time ? " " + time : ""}</strong>;
  return editing ? <div className="backfill-datetime-fields" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) apply(); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }}><input aria-label="发生日期" type="date" max={entry.kind === "journal" ? calendarToday() : undefined} value={value} autoFocus onChange={e => setValue(e.target.value)} /><input aria-label="发生时间（可留空）" type="time" value={clock} onChange={e => setClock(e.target.value)} /></div> : <button type="button" className="backfill-datetime" aria-label="修改发生日期时间" onClick={() => { setValue(entry.date); setClock(time); setEditing(true); }}>{entry.date || "日期未定"}{time ? " " + time : ""}</button>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试"; }
async function imageData(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try { const canvas = document.createElement("canvas"), scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height)); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale); canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); return canvas.toDataURL("image/jpeg", 0.82); }
  finally { bitmap.close(); }
}
/** Actions the assistant header and its right-click menu can ask this panel to run. */
export interface AssistantBackfillHandle {
  readonly openMenu: (x: number, y: number) => void;
  readonly openHistory: () => void;
  readonly clearScreen: () => void;
  readonly startNewConversation: () => void;
}

interface AssistantBackfillProps {
  readonly photoInput: Pick<ComposerProps, "onUploadShot" | "onNotify" | "onShotsCleared">;
  readonly scope: string;
  readonly configured: boolean;
  readonly onChanged: () => void;
  readonly onViewRecords: (ids: readonly string[]) => void;
  readonly onOpenEntity: (entity: Entity) => void;
  readonly onUiPlan: (plan: UiTurnPlan) => void;
  readonly onUiCommand: (command: UiCommand) => void;
  readonly privacyRequest: { readonly reason: string } | null;
  readonly onPrivacyDecision: (decision: "once" | "session" | "never") => void;
  /** Whether private records are on screen right now — see `AssistantChatTurnRequest`. */
  readonly privacyVisible?: boolean;
  readonly onOpenSettings: () => void;
  readonly ref?: Ref<AssistantBackfillHandle>;
}

export function AssistantBackfill({ photoInput, scope, configured, onChanged, onViewRecords, onOpenEntity, onOpenSettings, onUiPlan, onUiCommand, privacyRequest, onPrivacyDecision, privacyVisible = false, ref }: AssistantBackfillProps) {
  const [batch, setBatch] = useState<BackfillBatch | null>(null);
  const [batches, setBatches] = useState<readonly BackfillBatch[]>([]);
  const [shots, setShots] = useState<readonly AssetLink[]>(() => { try { return JSON.parse(sessionStorage.getItem('lifeos.assistant.photos:'+scope) ?? '[]'); } catch { return []; } });
  const [photoState, setPhotoState] = useState<"active" | "failed" | null>(null);
  const shotRef = useRef<ShotDropZoneHandle>(null);
  const busyRef = useRef(false);
  const [input, setInput] = useState(() => { try { return sessionStorage.getItem(`lifeos.backfill.input:${scope}`) ?? ""; } catch { return ""; } });
  const [chat, setChat] = useState<readonly BackfillChatViewMessage[]>([]);
  // The conversation this panel is appending to. Null until the first save
  // creates one, so the archive stays empty for someone who never chats.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [entities, setEntities] = useState<readonly Entity[]>([]);
  const [busy, setBusy] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<PendingAssistantTurn | null>(() => {
    try { return readPendingAssistantTurn(scope, window.sessionStorage); } catch { return null; }
  });
  const conversationBatchRef = useRef<string | null>(pendingTurn?.batchId ?? null);
  const [pendingError, setPendingError] = useState("");
  const [assetPreview, setAssetPreview] = useState<{ readonly id: string; readonly asset: Asset } | null>(null);
  const [loadRetry, setLoadRetry] = useState(0);
  const storageKey = `lifeos.backfill.edit:${scope}`;
  const active = useRef(true);
  const loadGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The archive id, kept in a ref as well so two quick sends cannot each open
  // their own conversation before the first id has landed in state.
  const conversationRef = useRef<string | null>(pendingTurn?.conversationId ?? null);
  const pendingRef = useRef<PendingAssistantTurn | null>(pendingTurn);
  const bindConversationBatch = (id: string | null) => { conversationBatchRef.current = id; };
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const toChatMessage = (item: AssistantArchiveMessage): BackfillChatViewMessage => ({
    role: item.role, text: item.text, id: item.id, at: item.at,
    // The archive stores the compiled plan with the reply, so reloading a
    // conversation redraws its clarify/offer buttons instead of dropping them.
    ...(item.ui === undefined ? {} : { ui: item.ui }),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.turnStatus ? { turnStatus: item.turnStatus } : {}),
    ...(item.retryable !== undefined ? { retryable: item.retryable } : {}),
    ...(item.attachments?.length ? { attachments: item.attachments } : {}),
  });
  const updatePending = (next: PendingAssistantTurn | null) => {
    pendingRef.current = next;
    setPendingTurn(next);
    setPendingError("");
  };
  const execute = async (label: string, run: () => Promise<void>) => {
    if (busyRef.current || initializing) return;
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try { await run(); }
    catch (e) { if (active.current) setError(message(e)); }
    finally { busyRef.current = false; if (active.current) setBusy(""); }
  };
  const openMenu = (x: number, y: number) => setMenu({ x, y });
  const clearScreen = () => {
    setMenu(null);
    void execute("正在清屏", async () => {
      if (pendingRef.current !== null) throw new Error("有一条消息尚未确认，请先重试发送后再清屏");
      // Keep the bound batch for subsequent turns, but hide its old cards too.
      // Save edits before hiding them so continuing from history recovers them.
      if (dirty) await save();
      let id = conversationRef.current;
      if (id === null) {
        const created = await startAssistantConversation(batch?.status === "draft" ? batch.id : null);
        id = created.conversationId;
        conversationRef.current = id; setConversationId(id);
        bindConversationBatch(batch?.status === "draft" ? batch.id : null);
        // Legacy batch transcripts did not yet have an archive conversation.
        for (let offset = 0; offset < chat.length; offset += 20) {
          await apiRequest("/api/ai/assistant/history", { method: "POST", body: JSON.stringify({ conversationId: id, messages: chat.slice(offset, offset + 20).map(({ role, text, attachments }) => ({ role, text, ...(attachments ? { attachments } : {}) })) }) });
        }
      }
      const cleared = await clearAssistantConversation(id);
      if (!active.current) return;
      loadGeneration.current++; detailGeneration.current++;
      setClearedAt(cleared.clearedAt); setReviewOpen(false);
      setChat([]); setError(""); setNotice("屏幕已清空，历史记录仍保留");
    });
  };
  const startNewConversation = () => {
    setMenu(null);
    void execute("正在新建对话", async () => {
      if (pendingRef.current !== null) throw new Error("有一条消息尚未确认，请先重试发送后再新建对话");
      const created = await startAssistantConversation();
      if (!active.current) return;
      loadGeneration.current++; detailGeneration.current++;
      conversationRef.current = created.conversationId;
      bindConversationBatch(null);
      setConversationId(created.conversationId); setClearedAt(null); setChat([]); setBatch(null); setDirty(false);
      clearPendingAssistantTurn(scope, window.sessionStorage); updatePending(null);
      setReviewOpen(false);
    });
  };
  useImperativeHandle(ref, () => ({ openMenu, openHistory: () => setHistoryOpen(true), clearScreen, startNewConversation }));
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null || menu === null) return;
    const rect = element.getBoundingClientRect();
    const next = clampFixedMenuPosition(menu.x, menu.y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    if (next.x !== menu.x || next.y !== menu.y) setMenu({ ...menu, ...next });
  }, [menu]);
  useEffect(() => {
    if (menu === null) return;
    // Pointerdown anywhere but the menu itself dismisses it. Two deliberate
    // choices here:
    //  · **bubble**, not capture — the menu's own `onPointerDown` stops the event
    //    before it reaches `window`, so clicking an item still fires its `click`.
    //    With capture the window ran first and unmounted the menu mid-gesture,
    //    leaving every item unclickable. Same contract as `.calendar-summary-menu`.
    //  · the `contains` guard is what actually protects the portaled menu: it
    //    lives under `document.body`, outside the React root, so relying on the
    //    synthetic `stopPropagation` alone would be a coin flip.
    const close = (event: Event) => {
      const target = event.target;
      if (menuRef.current !== null && target instanceof Node && menuRef.current.contains(target)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    const onDismiss = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [menu]);
  useEffect(() => {
    active.current = true;
    setInitializing(true);
    const generation = ++loadGeneration.current;
    const pending = readPendingAssistantTurn(scope, window.sessionStorage);
    pendingRef.current = pending; setPendingTurn(pending); setPendingError("");
    void Promise.all([
      apiRequest<{ items: BackfillBatch[] }>("/api/ai/backfill"),
      apiRequest<{ items: Entity[] }>("/api/entities"),
      loadCurrentConversation(),
    ]).then(async ([history, objects, current]) => {
      let archived = current.conversation;
      if (pending && pending.conversationId !== current.conversation?.id) {
        try { archived = await loadAssistantConversation(pending.conversationId); }
        catch { archived = null; }
      }
      if (!active.current || generation !== loadGeneration.current) return;
      setBatches(history.items); setEntities(objects.items);
      let chosen = history.items.find((b) => b.status === "draft") ?? history.items[0] ?? null;
      let recoveredDraft = false;
      try {
        const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as BackfillBatch | null;
        const server = history.items.find((b) => b.id === local?.id);
        if (local && server?.status === "draft" && local.revision === server.revision) { chosen = local; recoveredDraft = true; }
      } catch { /* optional local edit recovery */ }
      if (archived !== null) {
        conversationRef.current = archived.id; setConversationId(archived.id);
        setClearedAt(archived.clearedAt);
        bindConversationBatch(archived.batchId);
        setChat(archived.messages.map(toChatMessage));
        const serverBoundBatch = archived.batchId === null ? null : history.items.find((item) => item.id === archived.batchId) ?? null;
        const boundBatch = serverBoundBatch !== null && recoveredDraft && chosen?.id === serverBoundBatch.id ? chosen : serverBoundBatch;
        setBatch(boundBatch); setDirty(boundBatch?.id === chosen?.id && recoveredDraft);
        if (pending !== null) {
          const recovery = pendingTurnRecoveryStatus(pending, archived.messages);
          if (recovery === "completed") { clearPendingAssistantTurn(scope, window.sessionStorage); updatePending(null); }
          else if (recovery === "blocked") {
            const blocked = { ...pending, retryBlocked: true };
            try { writePendingAssistantTurn(scope, blocked, window.sessionStorage); } catch { /* keep the existing pending marker */ }
            updatePending(blocked);
            const stored = archived.messages.some((item) => item.role === "user" && item.turnId === pending.turnId);
            setPendingError(stored
              ? "服务器标记这条操作不可安全重放；原消息和附件仍在聊天记录中。可以保留记录并新建对话。"
              : "这条请求未能保存在服务器；原文仍保留在当前浏览器。请保留后新建对话，检查原文再手动发送。");
          }
        }
      } else if (pending !== null) {
        setClearedAt(null);
        conversationRef.current = pending.conversationId; setConversationId(pending.conversationId);
        bindConversationBatch(pending.batchId);
        setChat([]); setBatch(null); setDirty(false);
        setPendingError(pending.retryBlocked
          ? "这条请求已停止自动重试；原文仍保存在当前浏览器。请保留后新建对话，再检查原文。"
          : "未能读取这条待确认消息所在的对话；可以继续用同一编号重试发送。");
      } else {
        setClearedAt(null);
        conversationRef.current = null; setConversationId(null);
        bindConversationBatch(null);
        setBatch(chosen); setDirty(recoveredDraft);
        // Only an absent archive permits migration from the legacy batch transcript.
        setChat(current.conversation === null && chosen?.conversation ? chosen.conversation : []);
      }
      setInitializing(false);
    }).catch((e) => { if (active.current && generation === loadGeneration.current) setError(message(e)); });
    return () => {
      active.current = false;
      if (generation === loadGeneration.current) loadGeneration.current++;
      detailGeneration.current++;
    };
  }, [scope, storageKey, loadRetry]);
  useEffect(() => { if (batch && dirty) { try { sessionStorage.setItem(storageKey, JSON.stringify(batch)); } catch { /* explicit save remains available */ } } }, [batch, dirty, storageKey]);
  useEffect(() => { try { sessionStorage.setItem(`lifeos.backfill.input:${scope}`, input); } catch { /* optional */ } }, [input, scope]);
  useEffect(() => { const field = composerRef.current; if (field) { field.style.height = "32px"; field.style.height = `${Math.min(80, Math.max(32, field.scrollHeight))}px`; } }, [input]);
  useEffect(() => { if (!reviewOpen && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [chat, busy, reviewOpen]);
  useEffect(() => { try { sessionStorage.setItem("lifeos.assistant.photos:"+scope, JSON.stringify(shots)); } catch { /* optional */ } }, [shots, scope]);
  const { draggingFiles, handlers: photoHandlers } = usePhotoInput(shotRef, Boolean(busy) || initializing || pendingTurn !== null);
  const remember = (next: BackfillBatch) => { if (!active.current) return; setBatch(next); setBatches((current) => [next, ...current.filter((item) => item.id !== next.id)]); setDirty(false); if (next.entityIds?.length) void apiRequest<{ items: Entity[] }>("/api/entities").then((result) => { if (active.current) setEntities(result.items); }).catch(() => { /* exact object links remain readable */ }); try { sessionStorage.removeItem(storageKey); } catch { /* optional */ } };
  const save = async (): Promise<BackfillBatch> => {
    if (!batch) throw new Error("请先整理草稿");
    if (!dirty) return batch;
    const next = await apiRequest<BackfillBatch>(`/api/ai/backfill/${batch.id}`, { method: "PATCH", body: JSON.stringify({ revision: batch.revision, plan: batch.plan }) }); remember(next); return next;
  };
  const withImages = async (source: readonly BackfillMaterial[]) => Promise.all(source.map(async (m) => {
    if (!m.assetId || m.imageData) return m;
    const asset = await apiRequest<Asset>(`/api/assets/${encodeURIComponent(m.assetId)}`);
    if (asset.kind !== "photo") return m;
    const response = await fetch(`/api/assets/${encodeURIComponent(m.assetId)}/content`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("材料照片无法读取，请重新选入");
    return { ...m, imageData: await imageData(await response.blob()) };
  }));
  const openAttachment = async (assetId: string) => {
    try {
      const asset = await apiRequest<Asset>(`/api/assets/${encodeURIComponent(assetId)}`);
      if (asset.kind === "photo" || asset.kind === "video") setAssetPreview({ id: assetId, asset });
      else window.open(assetContentUrl(assetId), "_blank", "noopener,noreferrer");
    } catch (e) { if (active.current) setError(message(e)); }
  };
  const userMessageFromPending = (turn: PendingAssistantTurn): BackfillChatViewMessage => ({
    role: "user", text: turn.message, id: turn.turnId, turnId: turn.turnId, at: turn.startedAt,
    attachments: turn.materials.filter((item) => item.assetId).map((item) => ({ assetId: item.assetId!, name: item.name })),
  });
  const submitPendingTurn = async (turn: PendingAssistantTurn) => {
    setPendingError("");
    try {
      const materials: BackfillMaterial[] = turn.materials.map((item) => ({ ...item }));
      const result = await sendAssistantChatTurn({
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        batchId: turn.batchId,
        revision: turn.revision,
        message: turn.message,
        materials: await withImages(materials),
        privacyVisible,
      });
      if (!active.current) return;
      if (result.conversationId !== turn.conversationId || result.turnId !== turn.turnId) throw new Error("服务器返回的消息编号不匹配，本条仍保留待确认");
      const userMessage = userMessageFromPending(turn);
      const assistantMessage: BackfillChatViewMessage = { role: "assistant", text: result.reply, id: `${turn.turnId}:assistant`, at: new Date().toISOString(), ...(result.ui === undefined ? {} : { ui: result.ui }) };
      setChat((current) => [...current.filter((item) => item.turnId !== turn.turnId), userMessage, assistantMessage]);
      // The server already compiled and validated these; run them now. Offers stay
      // on the message and wait for a click.
      if (result.ui !== undefined) onUiPlan(result.ui);
      if (result.action === "draft") setShots([]);
      if (result.batch) {
        if (result.batch.id !== batch?.id) setReviewOpen(false);
        remember(result.batch);
        bindConversationBatch(result.batch.id);
      }
      if (result.action === "commit" || result.action === "undo") onChanged();
      if (input.trim() === turn.message) setInput("");
      conversationRef.current = turn.conversationId; setConversationId(turn.conversationId);
      clearPendingAssistantTurn(scope, window.sessionStorage); updatePending(null);
      // Hydrate stable server ids, sequence numbers and attachment metadata. A
      // read failure cannot turn a confirmed send into an apparent send failure.
      loadGeneration.current++;
      const generation = ++detailGeneration.current;
      void loadCurrentConversation().then((current) => {
        const detail = current.conversation;
        if (detail !== null && active.current && generation === detailGeneration.current && conversationRef.current === detail.id && detail.id === turn.conversationId) {
          setChat(detail.messages.map(toChatMessage));
          bindConversationBatch(detail.batchId);
        }
      }).catch(() => { /* local confirmed messages remain visible */ });
    } catch (e) {
      if (!active.current) throw e;
      const status = (e as ApiError).status;
      if (status === 409 || status === 400 || status === 404 || status === 413) {
        const blocked = { ...turn, retryBlocked: true };
        try { writePendingAssistantTurn(scope, blocked, window.sessionStorage); } catch { /* keep current marker in memory */ }
        updatePending(blocked);
        setPendingError(status === 409
          ? `${message(e)}。服务器拒绝了同编号重放；本条已保留。为避免重复写入，请保留记录并新建对话。`
          : `${message(e)}。这条请求未被接受，不能用相同内容自动重试；请保留记录并新建对话后检查原文。`);
      } else {
        setPendingError(`${message(e)}。发送结果尚未确认，重试会沿用同一消息编号。`);
      }
      throw e;
    }
  };
  const retryPendingTurn = () => {
    const pending = pendingRef.current;
    if (pending === null || pending.retryBlocked) return;
    void execute("正在重试消息", () => submitPendingTurn(pending));
  };
  const retryCurrentLoad = () => { setError(""); setLoadRetry((current) => current + 1); };
  /** The one place a message is sent. `send` reads the composer; the disambiguation
   *  buttons and other UI hand a finished sentence straight in. */
  const sendText = (raw: string) => execute("正在回复", async () => {
    if (pendingRef.current !== null) throw new Error("有一条消息尚未确认，请先重试这条消息");
    const text = raw.trim();
    const lengthError = assistantMessageLengthError(text);
    if (lengthError !== null) throw new Error(lengthError);
    if (photoState !== null) { photoInput.onNotify(photoState === "failed" ? "有照片未上传，请重试或移除后发送" : "照片正在处理，请完成后再发送", "warn"); return; }
    const materials: PendingAssistantMaterial[] = shots.map((shot, index) => ({ name: "照片"+(index+1)+"："+(shot.label ?? "照片"), text: "照片序号"+(index+1)+"，内容和拍摄日期待核对", assetId: shot.assetId }));
    if (!text && !materials.length) return;
    let id = conversationRef.current;
    let current: BackfillBatch | null;
    let boundBatchId = conversationBatchRef.current;
    if (id === null) {
      current = batch?.status === "draft" && dirty ? await save() : batch;
      boundBatchId = current?.status === "draft" ? current.id : null;
      const created = await startAssistantConversation(boundBatchId);
      id = created.conversationId;
      conversationRef.current = id; setConversationId(id);
      bindConversationBatch(boundBatchId);
    } else if (boundBatchId === null) {
      current = null;
    } else {
      const boundBatch = batch?.id === boundBatchId ? batch : batches.find((item) => item.id === boundBatchId) ?? null;
      if (boundBatch === null) throw new Error("当前对话绑定的方案无法读取；消息尚未发送，请刷新后再试");
      current = boundBatch.status === "draft" && dirty && batch?.id === boundBatchId ? await save() : boundBatch;
    }
    loadGeneration.current++; detailGeneration.current++;
    const turn: PendingAssistantTurn = { conversationId: id, turnId: crypto.randomUUID(), batchId: boundBatchId, revision: boundBatchId === null ? null : current?.revision ?? null, message: text, materials, startedAt: new Date().toISOString(), status: "unconfirmed" };
    try { writePendingAssistantTurn(scope, turn, window.sessionStorage); }
    catch { throw new Error("浏览器暂时无法保存待确认消息，尚未发送；请检查会话存储后重试"); }
    updatePending(turn);
    await submitPendingTurn(turn);
  });
  const send = () => sendText(input);
  const changeEntry = (key: string, patch: Partial<BackfillEntry>) => { if (!batch) return; setDirty(true); setBatch({ ...batch, plan: { ...batch.plan, entries: batch.plan.entries.map((e) => e.key === key ? { ...e, ...patch } : e) } }); };
  const changeObject = (key: string, patch: Partial<BackfillObject>) => { if (!batch) return; setDirty(true); setBatch({ ...batch, plan: { ...batch.plan, objects: batch.plan.objects.map((o) => o.key === key ? { ...o, ...patch } : o) } }); };
  const addObject = (type: BackfillObject["type"]) => { if (!batch) return; setDirty(true); setBatch({ ...batch, plan: { ...batch.plan, objects: [...batch.plan.objects, { key: crypto.randomUUID(), type, selected: true, name: "", aliases: [], description: "", address: "", evidence: "手动补充", questions: "" }] } }); };
  const confirm = (keys?: readonly string[]) => execute("正在记录", async () => {
    const current = await save();
    const next = await apiRequest<BackfillBatch>("/api/ai/backfill/"+current.id+"/commit", { method: "POST", body: JSON.stringify({revision:current.revision,...(keys ? {keys} : {})}) });
    remember(next); if (!active.current) return; setNotice("已确认记录"); onChanged();
  });
  const defer = (key: string, deferred: boolean) => execute(deferred ? "正在暂存" : "正在恢复", async () => {
    const current = await save(); const next = await apiRequest<BackfillBatch>("/api/ai/backfill/"+current.id+"/review", { method:"POST", body:JSON.stringify({revision:current.revision,key,deferred}) }); remember(next);
  });
  const disabled = Boolean(busy) || initializing;
  const chatBlocked = disabled || pendingTurn !== null;
  const pendingVisible = pendingTurn !== null && pendingTurn.conversationId === conversationId;
  const pendingArchiveMessage = pendingVisible ? chat.find((item) => item.turnId === pendingTurn.turnId) : undefined;
  const pendingAlreadyInArchive = pendingArchiveMessage !== undefined;
  const pendingRetryBlocked = pendingTurn?.retryBlocked === true || pendingArchiveMessage?.retryable === false || pendingArchiveMessage?.turnStatus === "interrupted";
  const displayedChat = pendingVisible && !pendingAlreadyInArchive ? [...chat, userMessageFromPending(pendingTurn)] : chat;
  const preserveAndStartNew = () => {
    const pending = pendingRef.current;
    if (pending === null || !pendingRetryBlocked) return;
    void execute("正在新建对话", async () => {
      const created = await startAssistantConversation();
      if (!active.current) return;
      loadGeneration.current++; detailGeneration.current++;
      bindConversationBatch(null);
      conversationRef.current = created.conversationId; setConversationId(created.conversationId);
      setClearedAt(null); setChat([]); setBatch(null); setDirty(false); setReviewOpen(false);
      setInput(pending.message);
      clearPendingAssistantTurn(scope, window.sessionStorage); updatePending(null);
      setNotice("本次没有自动重放；原文和已选附件已放回输入区，检查后可手动发送。");
    });
  };
  const pendingItems = batch ? [...batch.plan.entries, ...(batch.plan.actions ?? [])].filter(item => item.selected && backfillItemState(batch,item.key)==="pending") : [];
  const orphanObjects = batch?.plan.objects.filter(o=>o.selected&&!batch.committedObjectKeys?.includes(o.key)&&!batch.plan.entries.some(e=>(e.selected&&backfillItemState(batch,e.key)==="pending"||backfillItemState(batch,e.key)==="deferred")&&e.entityKeys.includes(o.key))) ?? [];
  const actionButtons = (key: string, ready: boolean) => {
    if (!batch || batch.status === "undone") return null;
    const state = backfillItemState(batch,key);
    return state === "committed" ? <span className="backfill-item-status">已记录</span> : state === "deferred" ? <div className="backfill-operation-group backfill-item-actions"><span className="backfill-item-status">暂不记录</span><button className="secondary-button" type="button" disabled={disabled} onClick={()=>void defer(key,false)}>恢复待确认</button></div> : <div className="backfill-operation-group backfill-item-actions"><button className="primary-button" type="button" disabled={disabled||!ready} onClick={()=>void confirm([key])}>确认记录</button><button className="secondary-button" type="button" disabled={disabled} onClick={()=>void defer(key,true)}>暂不记录</button></div>;
  };
  const draft = batch?.status === "draft";
  const selectedEntries = batch?.plan.entries.filter((e) => e.selected).length ?? 0;
  const selectedObjects = batch?.plan.objects.filter((o) => o.selected).length ?? 0;
  // Cleared cards stay hidden across reloads. A newly updated draft can appear
  // again; ordinary conversation replies must not resurrect the old cards.
  const showBatch = batch !== null && (clearedAt === null || Date.parse(batch.updatedAt) > Date.parse(clearedAt));
  return <div className="assistant-backfill" aria-busy={disabled} onContextMenu={(event) => { if ((event.target as HTMLElement).closest("textarea, input, select, [contenteditable]") !== null) return; event.preventDefault(); openMenu(event.clientX, event.clientY); }}>
    <div className="backfill-workspace-scroll" ref={scrollRef}>
      <div className="backfill-workspace-content">
      <div className="backfill-conversation" role="log" aria-label="和AI管家的对话" aria-live="polite">{displayedChat.length === 0 ? <p className="backfill-chat-copy ai-assistant-message backfill-intro">你好，想聊什么？也可以把资料和要求一起发来，我来帮你补记。</p> : null}{displayedChat.map((m, i) => <div className={`ai-message-row backfill-chat-message is-${m.role}`} aria-label={m.role === "user" ? "我" : "AI管家"} data-message-role={m.role} key={m.id ?? `${m.role}:${m.at ?? i}:${i}`}><div className={`backfill-chat-copy ${m.role === "user" ? "ai-user-message" : "ai-assistant-message"}`}><p>{m.text}</p>{m.role === "assistant" && m.ui?.offers?.length ? <div className="backfill-operation-group backfill-ui-offers">{m.ui.offers.map((offer, offerIndex) => <button className="secondary-button" type="button" key={`${offer.label}:${offerIndex}`} onClick={() => onUiCommand(offer.command)}>{offer.label}</button>)}</div> : null}{m.role === "assistant" && m.ui?.clarify ? <UiClarifyPrompt clarify={m.ui.clarify} onPick={(text) => { setInput(""); sendText(text); }} /> : null}{m.attachments?.length ? <div className="backfill-chat-attachments" aria-label="消息附件">{m.attachments.map((attachment) => <button type="button" key={attachment.assetId} onClick={() => void openAttachment(attachment.assetId)}>{attachment.name}</button>)}</div> : null}{m.at ? <time dateTime={m.at}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(m.at))}</time> : null}</div>{m.role === "assistant" ? <AssistantMessageActions content={m.text} /> : null}</div>)}</div>
      {showBatch && batch ? <section className="backfill-plan-preview" aria-label="当前拟写方案"><strong>{batch.status==="undone" ? "已撤销的内容" : "拟写内容"}</strong>
        {batch.plan.entries.map(e => { const state=backfillItemState(batch,e.key); return <article className={"backfill-confirm-card is-"+state} data-confirm-key={e.key} data-confirm-state={state} key={e.key}><div className="backfill-card-heading"><DraftDateTime entry={e} generatedAt={batch.createdAt} editable={draft&&state!=="committed"&&!disabled} onChange={patch=>changeEntry(e.key,patch)} /></div>{state==="deferred" ? <details><summary>查看暂存内容</summary><p className="backfill-preview-copy">{e.content}</p><div className="backfill-preview-photos">{e.assetIds.map(id=><img key={id} src={"/api/assets/"+encodeURIComponent(id)+"/thumbnail?w=400"} alt="拟写照片" />)}</div></details> : <><p className="backfill-preview-copy">{e.content}</p><div className="backfill-preview-photos">{e.assetIds.map(id=><img key={id} src={"/api/assets/"+encodeURIComponent(id)+"/thumbnail?w=400"} alt="拟写照片" />)}</div></>}{e.questions ? <p className="backfill-warning">{e.questions}</p> : null}{actionButtons(e.key,backfillEntryReady(e)&&e.entityKeys.every(key=>batch.plan.objects.some(o=>o.key===key&&o.selected&&!o.questions.trim())))}</article>; })}
        {(batch.plan.actions??[]).map(a=><article className={"backfill-confirm-card is-"+backfillItemState(batch,a.key)} data-confirm-key={a.key} data-confirm-state={backfillItemState(batch,a.key)} key={a.key}><div className="backfill-card-heading"><strong>{a.date||"日期未定"}</strong><span>{a.type==="cycle" ? "周期标记" : "习惯标记"}</span></div><p className="backfill-preview-copy">{a.marked ? "标记" : "移除"}{a.type==="cycle" ? ({period_start:"经期开始",period_end:"经期结束",intimacy:"亲密",fitness:"运动"}[a.cycleKind!]) : a.name}</p>{a.questions ? <p className="backfill-warning">{a.questions}</p> : null}{actionButtons(a.key,a.selected&&!a.questions.trim()&&Boolean(a.date))}</article>)}
        {batch.plan.objects.filter(o=>o.selected).map(o=><p className="backfill-preview-copy" key={o.key}>{TYPE_LABEL[o.type]}：{o.name}{o.type==="movie"&&o.movie?.watched ? "（已看）" : ""}</p>)}
        {draft&&(pendingItems.length+orphanObjects.length)>1 ? <div className="backfill-operation-group backfill-item-actions"><button className="primary-button" type="button" disabled={disabled||pendingItems.some(item=>"content" in item ? !backfillEntryReady(item) : !item.date||Boolean(item.questions.trim()))||batch.plan.objects.some(o=>o.selected&&!batch.committedObjectKeys?.includes(o.key)&&Boolean(o.questions.trim()))} onClick={()=>void confirm()}>确认全部（{pendingItems.length+orphanObjects.length}条）</button></div> : null}
        {draft&&pendingItems.length===0&&orphanObjects.length===1 ? <div className="backfill-operation-group backfill-item-actions"><button className="primary-button" type="button" disabled={disabled||Boolean(orphanObjects[0]?.questions.trim())} onClick={()=>void confirm()}>确认记录</button></div> : null}
      </section> : null}
      {showBatch && batch ? <details className="backfill-review" open={reviewOpen} onToggle={(e) => setReviewOpen(e.currentTarget.open)}><summary>查看和手动编辑拟写内容</summary>
      {batch ? <><p className="backfill-explanation">{batch.plan.explanation}</p>{batch.mode === "rules" ? <p className="backfill-mode">当前使用本地整理。可手动修改草稿，配置 AI 后可继续讨论。</p> : null}
        <fieldset disabled={disabled || !draft} className="backfill-plan-fields"><legend>记录草稿</legend>
          {batch.plan.entries.filter(e=>backfillItemState(batch,e.key)!=="committed").map((e, i) => <section className="backfill-draft-card" data-backfill-entry={e.key} key={e.key}>
            <label className="backfill-choice"><input type="checkbox" checked={e.selected} onChange={(v) => changeEntry(e.key, { selected: v.target.checked })} />第 {i + 1} 条记录</label>
            <div className="backfill-row"><label className="backfill-field"><span>发生日期</span><input type="date" value={e.date} max={e.kind === "journal" ? calendarToday() : undefined} onChange={(v) => changeEntry(e.key, { date: v.target.value, time: "" })} /></label><label className="backfill-field"><span>类型</span><select value={e.kind} onChange={(v) => changeEntry(e.key, { kind: v.target.value as BackfillEntry["kind"] })}><option value="journal">日记</option><option value="task">任务</option><option value="event">事件</option><option value="note">笔记</option></select></label></div>
            <label className="backfill-field"><span>正文</span><textarea rows={3} value={e.content} onChange={(v) => changeEntry(e.key, { content: v.target.value })} /></label>
            <details><summary>依据、关联与待确认</summary><p className="backfill-evidence">{e.evidence}</p>
              <label className="backfill-field"><span>待确认问题（处理后清空）</span><input value={e.questions} onChange={(v) => changeEntry(e.key, { questions: v.target.value })} /></label>
              {batch.plan.objects.map((o) => <label className="backfill-choice" key={o.key}><input type="checkbox" checked={e.entityKeys.includes(o.key)} onChange={(v) => changeEntry(e.key, { entityKeys: v.target.checked ? [...e.entityKeys, o.key] : e.entityKeys.filter((k) => k !== o.key) })} />{TYPE_LABEL[o.type]}：{o.name}</label>)}
              {batch.materials.filter((m) => m.assetId).map((m) => <label className="backfill-choice" key={m.assetId}><input type="checkbox" checked={e.assetIds.includes(m.assetId!)} onChange={(v) => changeEntry(e.key, { assetIds: v.target.checked ? [...e.assetIds, m.assetId!] : e.assetIds.filter((id) => id !== m.assetId) })} />附件：{m.name}</label>)}
              {e.duplicateIds?.length ? <p className="backfill-warning">发现相同日期和正文的记录，请跳过本条或选择补充。</p> : null}
              <label className="backfill-field"><span>写入方式（补充会追加正文，保留原文）</span><select value={e.targetId ?? ""} onChange={async (v) => { if (!v.target.value) { changeEntry(e.key, { targetId: "" }); return; } try { const r = await apiRequest<{ id: string; revision: number }>(`/api/records/${v.target.value}`); changeEntry(e.key, { targetId: r.id, targetRevision: r.revision }); } catch (err) { setError(message(err)); } }}><option value="">新增记录</option>{(e.targetCandidates ?? []).map((candidate) => <option value={candidate.id} key={candidate.id}>补充：{candidate.label}</option>)}</select></label>
            </details>
            {e.questions || !e.date ? <p className="backfill-warning">{e.questions || "日期未定；日记、任务和事件需补日期才可写入。"}</p> : null}
          </section>)}
          <button className="secondary-button" type="button" onClick={() => { setDirty(true); setBatch({ ...batch, plan: { ...batch.plan, entries: [...batch.plan.entries, { key: crypto.randomUUID(), selected: true, kind: "journal", content: "", date: "", evidence: "手动补充", questions: "", entityKeys: [], assetIds: [] }] } }); }}><Plus size={14} />添加记录草稿</button>
        </fieldset>
        {batch.status === "committed" ? <div className="backfill-operation-group">{batch.plan.objects.filter((o) => o.selected && o.existingId).map((o) => <button className="secondary-button" type="button" key={o.key} disabled={disabled} onClick={() => void execute("正在读取资料", async () => { const entity = await apiRequest<Entity>(`/api/entities/${o.existingId}`); onOpenEntity(entity); })}>查看{o.name}</button>)}</div> : null}
        <fieldset disabled={disabled || !draft} className="backfill-plan-fields"><legend>人物、地点与电影</legend>
          {batch.plan.objects.filter(o=>!batch.committedObjectKeys?.includes(o.key)).map((o) => <section className="backfill-draft-card" data-backfill-object={o.key} key={o.key}>
            <label className="backfill-choice"><input type="checkbox" checked={o.selected} onChange={(v) => changeObject(o.key, { selected: v.target.checked })} />{TYPE_LABEL[o.type]}：{o.name || "新对象"}</label>
            {o.type === "movie" ? <div className="backfill-movie-preview">{o.movie?.posterUrl ? <img src={o.movie.posterUrl} alt={`${o.name} 海报`} loading="lazy" onError={(e) => { e.currentTarget.hidden = true; }} /> : <span className="backfill-poster-fallback"><Film size={24} /></span>}<span>{o.movie?.originalTitle}<small>{o.movie?.releaseYear} {o.movie?.watched ? "已看" : ""}</small></span></div> : null}
            <label className="backfill-field"><span>名称</span><input value={o.name} onChange={(v) => changeObject(o.key, { name: v.target.value })} /></label>
            <label className="backfill-field"><span>关联已有对象或新建</span><select value={o.existingId ?? ""} onChange={(v) => changeObject(o.key, { existingId: v.target.value })}><option value="">新建{TYPE_LABEL[o.type]}</option>{entities.filter((entity) => entity.type === o.type).map((entity) => <option key={entity.id} value={entity.id}>{entity.name}{entity.type === "place" && entity.address ? `（${entity.address}）` : ""}</option>)}</select></label>
            {o.existingId ? <p className="backfill-mode">保留已有资料，只补充空缺字段与别名。</p> : null}
            {o.candidates?.length ? <label className="backfill-field"><span>电影匹配候选</span><select value={String(o.movie?.externalIds?.tmdb ?? "")} onChange={(v) => { const candidate = o.candidates?.find((c) => String(c.externalIds?.tmdb) === v.target.value); if (candidate) { const { id: _, type: __, createdAt: ___, ...details } = candidate; changeObject(o.key, { movie: { ...details, ...(o.movie?.personalReview ? { personalReview: o.movie.personalReview } : {}), ...(o.movie?.watched !== undefined ? { watched: o.movie.watched } : {}), ...(o.movie?.watchedAt ? { watchedAt: o.movie.watchedAt } : {}) }, questions: "", selected: true }); } }}><option value="">保留手动资料，需自行确认</option>{o.candidates.map((c) => <option key={c.id} value={String(c.externalIds?.tmdb ?? c.id)}>{c.name} {c.releaseYear} {c.mediaType === "tv" ? "剧集" : "电影"}</option>)}</select></label> : null}
            {o.type === "movie" ? <><label className="backfill-field"><span>我的评价</span><textarea rows={2} value={o.movie?.personalReview ?? ""} onChange={(v) => changeObject(o.key, { movie: { ...o.movie, personalReview: v.target.value } })} /></label><label className="backfill-field"><span>观看日期（不记得可留空）</span><input type="date" value={o.movie?.watchedAt ?? ""} onChange={(v) => { const { watchedAt: _, ...rest } = o.movie ?? {}; changeObject(o.key, { movie: { ...rest, ...(v.target.value ? { watchedAt: v.target.value } : {}) } }); }} /></label><label className="backfill-choice"><input type="checkbox" checked={o.movie?.watched === true} onChange={(v) => changeObject(o.key, { movie: { ...o.movie, watched: v.target.checked } })} />已看过</label><label className="backfill-field"><span>海报网址（可留空）</span><input type="url" value={o.movie?.posterUrl ?? ""} onChange={(v) => changeObject(o.key, { movie: { ...o.movie, posterUrl: v.target.value } })} /></label></> : null}
            <details><summary>对象资料与依据</summary><p className="backfill-evidence">{o.evidence}</p><label className="backfill-field"><span>别名（每行一个）</span><textarea rows={2} value={o.aliases.join("\n")} onChange={(v) => changeObject(o.key, { aliases: v.target.value.split("\n") })} /></label><label className="backfill-field"><span>说明</span><input value={o.description} onChange={(v) => changeObject(o.key, { description: v.target.value })} /></label>{o.type === "place" ? <label className="backfill-field"><span>地址（可留空）</span><input value={o.address} onChange={(v) => changeObject(o.key, { address: v.target.value })} /></label> : null}</details>
            <label className="backfill-field"><span>待确认问题（处理后清空）</span><input value={o.questions} onChange={(v) => changeObject(o.key, { questions: v.target.value })} /></label>
          </section>)}
          <div className="backfill-operation-group">{(["person", "place", "movie"] as const).map((type) => <button className="secondary-button" type="button" key={type} onClick={() => addObject(type)}><Plus size={14} />{TYPE_LABEL[type]}</button>)}</div>
        </fieldset>
      </> : null}
      {draft ? <div className="backfill-operation-group"><button className="secondary-button" type="button" disabled={disabled || !dirty} onClick={() => void execute("正在保存", async () => { await save(); setNotice("修改已保存，尚未写入记录。"); })}>保存草稿</button></div> : null}
      </details> : null}
      {showBatch && Boolean(batch?.recordIds?.length) && batch?.status !== "undone" ? <div className="backfill-operation-group backfill-result-actions"><button className="secondary-button" type="button" disabled={disabled} onClick={() => onViewRecords(batch?.recordIds ?? [])}>查看辅记</button></div> : null}
      </div>
    </div>
    <div className={"backfill-workspace-footer "+(draggingFiles ? "is-dragging" : "")} {...photoHandlers}>
      {initializing ? <p role="status">正在恢复聊天和草稿…</p> : null}
      {error ? <p className="backfill-warning" role="alert">{error}{initializing ? <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={retryCurrentLoad}>重试恢复会话</button> : null}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      {pendingVisible ? <div className="backfill-pending-turn" role={pendingError ? "alert" : "status"}><p>{pendingError || "这条消息的发送结果尚未确认。重试会复用同一消息编号。"}</p>{pendingRetryBlocked ? <button className="secondary-button" type="button" disabled={disabled} onClick={preserveAndStartNew}>保留记录并新建对话</button> : <button className="secondary-button" type="button" disabled={disabled} onClick={retryPendingTurn}>重试这条消息</button>}</div> : null}
      {busy ? <p role="status"><LoaderCircle size={14} className="spin" />{busy}…</p> : null}
      {!configured ? <p className="backfill-mode">当前使用本地模式。<button className="ai-configure-link" type="button" onClick={onOpenSettings}>配置 AI</button>后可理解更完整的要求。</p> : null}
      {privacyRequest === null ? null : <div className="backfill-privacy-request" role="alert"><p>{privacyRequest.reason}</p><div className="backfill-operation-group"><button className="primary-button" type="button" onClick={() => onPrivacyDecision("once")}>本次允许</button><button className="secondary-button" type="button" onClick={() => onPrivacyDecision("session")}>本次会话允许</button><button className="secondary-button" type="button" onClick={() => onPrivacyDecision("never")}>不用了</button></div></div>}
      <form className="ai-assistant-composer backfill-chat-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea ref={composerRef} aria-label="发给AI管家的消息" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!chatBlocked && photoState === null) void send(); } }} rows={1} disabled={chatBlocked} />
        <div className="backfill-input-actions">
          <ShotDropZone ref={shotRef} scopeKey={"assistant:"+scope} numbered addOutsideStrip disabled={chatBlocked} shots={shots} onShotsChange={setShots} onUpload={photoInput.onUploadShot} onNotify={photoInput.onNotify} onCleared={photoInput.onShotsCleared} onSubmissionState={(_scope,state)=>setPhotoState(state)} />
          <div className="backfill-operation-group">
            <button className="primary-button ai-send-button" type="submit" disabled={chatBlocked || photoState !== null || (!input.trim() && !shots.length)}>发送</button>
          </div>
        </div>
      </form>
    </div>
    {menu === null ? null : createPortal(<div ref={menuRef} className="ai-assistant-menu" role="menu" aria-label="AI 管家的操作" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
        <button type="button" role="menuitem" disabled={disabled || pendingTurn !== null} onClick={clearScreen}><Eraser size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">清屏</span></button>
        <button type="button" role="menuitem" disabled={disabled || pendingTurn !== null} onClick={startNewConversation}><MessageSquarePlus size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">新对话</span></button>
        <button type="button" role="menuitem" onClick={() => { setMenu(null); setHistoryOpen(true); }}><History size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">聊天记录</span></button>
        <button type="button" role="menuitem" onClick={() => { setMenu(null); onOpenSettings(); }}><Settings2 size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">AI 设置</span></button>
    </div>, document.body)}
    <AssistantHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} actionsDisabled={disabled || pendingTurn !== null} onOpenAttachment={(id) => void openAttachment(id)} onContinue={(detail) => {
      detailGeneration.current++;
      conversationRef.current = detail.id; setConversationId(detail.id);
      setClearedAt(detail.clearedAt);
      setChat(detail.messages.map(toChatMessage));
      bindConversationBatch(detail.batchId);
      setBatch(detail.batchId === null ? null : batches.find((item) => item.id === detail.batchId) ?? null);
      setDirty(false); setReviewOpen(false); setHistoryOpen(false);
      // The current endpoint excludes messages hidden by a cleared screen.
    }} />
    {assetPreview === null ? null : createPortal(<AssetPreview assetIds={[assetPreview.id]} index={0} assets={[assetPreview.asset]} onClose={() => setAssetPreview(null)} onIndexChange={() => undefined} />, document.body)}
  </div>;
}
