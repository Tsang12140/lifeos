import { assetThumbUrl } from "./asset-urls";
import { backfillItemState, backfillEntryTime, backfillEntryReady, calendarToday } from "@lifeos/core";
import { useActionMenu } from "./action-menu";
import { AssistantReplyProgress } from "./assistant-reply-progress";
import { AssistantCitedText, AssistantDeliveryNote, isJournalSourceOffer } from "./assistant-journal-sources";
import { ReasoningIcon } from "./reasoning-icon";
import type { AssetLink } from "@lifeos/core";
import type { ComposerProps } from "./composer";
import { ShotDropZone, type ShotDropZoneHandle } from "./shot-drop-zone";
import { usePhotoInput } from "./photo-input";
import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Eraser, Film, History, LoaderCircle, MessageSquarePlus, Plus, Settings2, Check, ChevronDown, ArrowDown, ArrowUp, Square, RotateCw } from "lucide-react";
import type { Asset, BackfillBatch, BackfillChatMessage, BackfillEntry, BackfillMaterial, BackfillObject, Entity, UiClarify, UiCommand, UiTurnPlan } from "@lifeos/core";
import { AI_GEARS, apiRequest, gearLabel, type ApiError, type AiGear } from "./api";
import { scopedKey } from "./storage-scope";
import { useApplicationLock } from "./app-lock";
import type { PrivacyAccessState } from "./privacy-access-control";
import { AssistantPrivacyMenuItems } from "./assistant-privacy-menu";
import {
  clearAssistantConversation,
  loadAssistantConversation,
  loadCurrentConversation,
  sendAssistantChatTurn,
  stopAssistantChatTurn,
  startAssistantConversation,
  type AssistantArchiveMessage,
  type AssistantHistoryAttachment,
} from "./assistant-history-api";
import { assistantMessageLengthError, clearPendingAssistantTurn, pendingTurnRecoveryStatus, readPendingAssistantTurn, writePendingAssistantTurn, type PendingAssistantMaterial, type PendingAssistantTurn } from "./assistant-pending-turn";
import { assistantIdleResetDue } from "./assistant-idle";
import { AssistantHistoryDialog } from "./assistant-history-dialog";
import { AssistantShareDialog, type AssistantShareRequest } from "./assistant-share-dialog";
import { AssistantMessageTime, useAssistantMessageInfo } from "./assistant-message-info";
import { assistantMessageTime, assistantTimeDivider } from "./assistant-message-time";
import { assistantDraftPosition } from "./assistant-draft-position";
import { AssistantMessageActions } from "./assistant-message-actions";
import { clampFixedMenuPosition } from "./menu-position";
import { AssetPreview, assetContentUrl } from "./timeline";
import "./assistant-backfill.css";
import { AssistantSourceProvider } from "./assistant-source-reader";
import { AssistantWelcome } from "./assistant-welcome";
import type { RecordView } from "./api";

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
  readonly seq?: number;
  /** Compiled interface commands that came with this reply. */
  readonly ui?: UiTurnPlan;
  readonly delivery?: AssistantArchiveMessage["delivery"];
  readonly at?: string;
  readonly turnId?: string;
  readonly draftBatchId?: string;
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
  readonly privateAccessUntil: string | undefined;
  readonly pageContext?: "dreams" | undefined;
  readonly onEnterSource?: ((record: RecordView) => void) | undefined;
  readonly focusRequested?: boolean;
  readonly onFocusHandled?: () => void;
  readonly photoInput: Pick<ComposerProps, "onUploadShot" | "onNotify" | "onShotsCleared">;
  readonly scope: string;
  readonly configured: boolean;
  /** The settings-page default gear; the composer dial starts here and resets on a new conversation. */
  readonly defaultGear: AiGear;
  readonly onChanged: () => void;
  readonly onViewRecords: (ids: readonly string[]) => void;
  readonly onOpenEntity: (entity: Entity) => void;
  readonly onUiPlan: (plan: UiTurnPlan) => void;
  readonly onUiCommand: (command: UiCommand) => void;
  readonly privacyRequest: { readonly reason: string } | null;
  readonly onPrivacyDecision: (decision: "once" | "session" | "never") => void;
  /** AI 私密检索授权：右键菜单里的「检索私密」读写同一份状态。 */
  readonly privacyAccess: PrivacyAccessState;
  readonly privacyDisabled?: boolean;
  /** Whether private records are on screen right now — see `AssistantChatTurnRequest`. */
  readonly privacyVisible?: boolean;
  readonly onOpenSettings: () => void;
  readonly ref?: Ref<AssistantBackfillHandle>;
}

export function AssistantBackfill({ privateAccessUntil, pageContext, photoInput, scope, configured, defaultGear, onChanged, onViewRecords, onOpenEntity, onOpenSettings, onUiPlan, onUiCommand, privacyRequest, onPrivacyDecision, privacyAccess, privacyDisabled = false, privacyVisible = false, focusRequested = false, onFocusHandled, onEnterSource, ref }: AssistantBackfillProps) {
  const applicationLock = useApplicationLock();
  const [batch, setBatch] = useState<BackfillBatch | null>(null);
  const [batches, setBatches] = useState<readonly BackfillBatch[]>([]);
  const [shots, setShots] = useState<readonly AssetLink[]>(() => { try { return JSON.parse(sessionStorage.getItem(scopedKey('lifeos.assistant.photos:'+scope)) ?? '[]'); } catch { return []; } });
  const [photoState, setPhotoState] = useState<"active" | "failed" | null>(null);
  const shotRef = useRef<ShotDropZoneHandle>(null);
  const [photoToolbarTarget, setPhotoToolbarTarget] = useState<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const [input, setInput] = useState(() => { try { return sessionStorage.getItem(scopedKey(`lifeos.backfill.input:${scope}`)) ?? ""; } catch { return ""; } });
  const [chat, setChat] = useState<readonly BackfillChatViewMessage[]>([]);
  const [shareRequest, setShareRequest] = useState<AssistantShareRequest | null>(null);
  // The conversation this panel is appending to. Null until the first save
  // creates one, so the archive stays empty for someone who never chats.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [entities, setEntities] = useState<readonly Entity[]>([]);
  const [busy, setBusy] = useState("");
  const [initializing, setInitializing] = useState(true);
  /** 初始化失败时界面要解冻（见下方 catch），但手动重试入口得留着。 */
  const [loadFailed, setLoadFailed] = useState(false);
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
  const storageKey = scopedKey(`lifeos.backfill.edit:${scope}`);
  const active = useRef(true);
  const loadGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const [streamReply, setStreamReply] = useState("");
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const readingTurnRef = useRef<string | null>(null);
  const readingConversationRef = useRef<string | null>(null);
  const readingPositionRef = useRef(0);
  const readMoreRef = useRef(false);
  const scrollInitializedRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The archive id, kept in a ref as well so two quick sends cannot each open
  // their own conversation before the first id has landed in state.
  const conversationRef = useRef<string | null>(pendingTurn?.conversationId ?? null);
  const pendingRef = useRef<PendingAssistantTurn | null>(pendingTurn);
  const bindConversationBatch = (id: string | null) => { conversationBatchRef.current = id; };
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  useActionMenu(menuRef, menu !== null, () => setMenu(null));
  // 回答档位（2026-10-15）：初始取设置页默认档，本次对话内可换，新建对话回默认。
  // The panel mounts before /api/ai/status resolves, so defaultGear starts as the
  // fallback ("direct") and corrects itself moments later — follow it until the
  // owner picks a gear by hand, otherwise the dial would freeze on the fallback.
  const [gear, setGear] = useState<AiGear>(defaultGear);
  const gearTouchedRef = useRef(false);
  useEffect(() => {
    if (gearTouchedRef.current) return;
    resetGearToDefault();
  }, [defaultGear]);
  const pickGear = (next: AiGear) => {
    gearTouchedRef.current = true;
    setGear(next);
  };
  const resetGearToDefault = () => {
    gearTouchedRef.current = false;
    setGear(defaultGear);
  };
  const [gearMenu, setGearMenu] = useState<MenuState | null>(null);
  const gearMenuRef = useRef<HTMLDivElement>(null);
  useActionMenu(gearMenuRef, gearMenu !== null, () => setGearMenu(null));
  const [historyOpen, setHistoryOpen] = useState(false);

  const toChatMessage = (item: AssistantArchiveMessage): BackfillChatViewMessage => ({
    role: item.role, text: item.text, id: item.id, seq: item.seq, at: item.at,
    // The archive stores the compiled plan with the reply, so reloading a
    // conversation redraws its clarify/offer buttons instead of dropping them.
    ...(item.ui === undefined ? {} : { ui: item.ui }),
    ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.draftBatchId ? { draftBatchId: item.draftBatchId } : {}),
    ...(item.turnStatus ? { turnStatus: item.turnStatus } : {}),
    ...(item.retryable !== undefined ? { retryable: item.retryable } : {}),
    ...(item.attachments?.length ? { attachments: item.attachments } : {}),
  });
  const updatePending = (next: PendingAssistantTurn | null) => {
    pendingRef.current = next;
    setPendingTurn(next);
    setPendingError("");
  };
  /**
   * An unconfirmed message must not be lost, but it must not lock the panel
   * either. 清屏 and 新对话 both park it first — original text back into the
   * composer, pending marker cleared — and then go ahead. Before 2026-10-17
   * they refused outright (and were disabled), so a failed reply left the owner
   * with no way to clear the screen or start over.
   */
  const parkPendingTurn = (): string | null => {
    const pending = pendingRef.current;
    if (pending === null) return null;
    clearPendingAssistantTurn(scope, window.sessionStorage);
    updatePending(null);
    setInput(pending.message);
    return pending.message;
  };
  const execute = async (label: string, run: () => Promise<void>) => {
    if (busyRef.current || initializing) return;
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try { await run(); }
    catch (e) { if (active.current) setError(message(e)); }
    finally { busyRef.current = false; if (active.current) setBusy(""); }
  };
  const openMenu = (x: number, y: number) => setMenu({ x, y });
  // 手机顶栏「更多操作」把菜单锚在按钮右下角（rect.right - 12），窄屏上会伸到视口
  // 外面；菜单宽度在挂载前不可知，所以在拿到实际尺寸后把整体推回可视区。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (menu === null || element === null) return;
    const rect = element.getBoundingClientRect();
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8));
    if (x !== menu.x || y !== menu.y) setMenu({ x, y });
  }, [menu]);
  // 「检索私密」从顶栏 Switch 搬进右键菜单（2026-10-23 主人要求）：
  // 状态仍归 main.tsx 的 privacyAi，这里只负责应用锁上锁时清空。菜单项本身在
  // assistant-privacy-menu 里，与「单条消息」那份右键菜单共用同一段逻辑。
  useEffect(() => {
    if (applicationLock?.ready && applicationLock.locked("privacy-ai") && privacyAccess.active) privacyAccess.change(null);
  }, [applicationLock?.ready, applicationLock?.status.unlocked, applicationLock?.status.targets, privacyAccess.value, privacyAccess.key]);
  const clearScreen = () => {
    setMenu(null);
    void execute("正在清屏", async () => {
      // Park any unconfirmed message first: the owner asked for a clear screen,
      // not for their text to disappear or for the button to refuse.
      const parked = parkPendingTurn();
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
      setChat([]); setError("");
      // 正常清屏不再弹任何提示（主人 2026-10-17：去掉「屏幕已清空，历史记录仍保留」）。
      // 只有把未确认的原文放回了输入区才需要说一声，否则原文像是凭空消失了。
      setNotice(parked === null ? "" : "未确认的原文已放回输入区，检查后可手动发送");
    });
  };
  const startNewConversation = () => {
    setMenu(null);
    void execute("正在新建对话", async () => {
      const parked = parkPendingTurn();
      const created = await startAssistantConversation();
      if (!active.current) return;
      loadGeneration.current++; detailGeneration.current++;
      conversationRef.current = created.conversationId;
      bindConversationBatch(null);
      setConversationId(created.conversationId); setClearedAt(null); setChat([]); setBatch(null); setDirty(false);
      resetGearToDefault();
      setReviewOpen(false);
      if (parked !== null) setNotice("新对话已开始；未确认的原文已放回输入区，检查后可手动发送。");
    });
  };
  useImperativeHandle(ref, () => ({ openMenu, openHistory: () => setHistoryOpen(true), clearScreen, startNewConversation }));
  /**
   * 闲置翻篇（2026-10-23 主人要求）：一两个小时没找管家，就自动把屏幕收干净。
   *
   * 只清屏幕、不落库 —— 真正的新对话等第一条消息发出时，由 sendText 的
   * `id === null` 分支去建。翻篇本身零写操作，否则每次翻篇都会在库里留一条
   * 空对话，而那条空对话对主人没有任何意义（虽然它不进历史列表）。
   *
   * 不弹提示（主人 2026-10-23：「不用额外提示，直接显示新的那个就行了」）：
   * 屏幕本来就变成空的欢迎页，再说一句「已清空」只是多余的噪音。
   *
   * `nextBatch` 只给初始化路径用：草稿属于方案，不属于对话，翻篇时不该跟着消失。
   */
  const startFreshConversationWhenIdle = (nextBatch: BackfillBatch | null = null, nextDirty = false): void => {
    loadGeneration.current++; detailGeneration.current++;
    conversationRef.current = null;
    bindConversationBatch(null);
    setConversationId(null);
    setClearedAt(null); setChat([]); setBatch(nextBatch); setDirty(nextDirty);
    resetGearToDefault(); setReviewOpen(false);
    setNotice("");
  };
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null || menu === null) return;
    const rect = element.getBoundingClientRect();
    const next = clampFixedMenuPosition(menu.x, menu.y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    if (next.x !== menu.x || next.y !== menu.y) setMenu({ ...menu, ...next });
  }, [menu]);
  useLayoutEffect(() => {
    const element = gearMenuRef.current;
    if (element === null || gearMenu === null) return;
    const rect = element.getBoundingClientRect();
    const next = clampFixedMenuPosition(gearMenu.x, gearMenu.y - rect.height, rect.width, rect.height, window.innerWidth, window.innerHeight);
    element.style.left = `${next.x}px`;
    element.style.top = `${next.y}px`;
  }, [gearMenu]);
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
      // 打开时先判一次闲置：浏览器关了一晚再打开，组件是重新挂载的，
      // 只靠下面那个每分钟的定时器，会先把旧对话画出来再闪一下换掉。
      // 有未确认消息时一律不翻篇 —— 那条原文还等着重试。
      if (pending === null && archived !== null && assistantIdleResetDue({
        lastMessageAt: archived.messages.at(-1)?.at,
        visibleMessageCount: archived.messages.length,
        now: Date.now(),
      })) {
        startFreshConversationWhenIdle(chosen, recoveredDraft);
        setInitializing(false);
        setLoadFailed(false);
        return;
      }
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
      setLoadFailed(false);
    }).catch((e) => {
      if (!active.current || generation !== loadGeneration.current) return;
      setError(message(e));
      // 初始化失败也必须解冻界面：以前这里只 setError，`initializing` 永远停在
      // true ⇒ `disabled` 永远为真 ⇒ 整个面板的按钮都点不动，不只是清屏/新对话
      // （2026-10-17）。重试入口改由 loadFailed 保留，见下方提示条。
      setInitializing(false);
      setLoadFailed(true);
    });
    return () => {
      active.current = false;
      if (generation === loadGeneration.current) loadGeneration.current++;
      detailGeneration.current++;
    };
  }, [scope, storageKey, loadRetry]);
  /**
   * 面板是常驻挂载的（只有 scope 变才重建），所以「闲置」不能只在初始化时判一次：
   * 关掉面板两小时再打开，组件根本不会重新初始化。这里每分钟看一眼。
   *
   * 下面每一条都是「不能翻篇」的理由，缺一条都可能变成丢东西：
   * 输入框有字（还没发）、选着照片、有未确认消息（等着重试）、草稿没存、
   * 正在回复、审核面板 / 聊天记录 / 右键菜单开着、照片还在上传。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!active.current || initializing || busyRef.current) return;
      if (dirty || input.trim().length > 0 || shots.length > 0 || pendingTurn !== null) return;
      if (reviewOpen || historyOpen || menu !== null || photoState !== null) return;
      const last = chat.length === 0 ? undefined : chat[chat.length - 1]?.at;
      if (!assistantIdleResetDue({ lastMessageAt: last, visibleMessageCount: chat.length, now: Date.now() })) return;
      startFreshConversationWhenIdle();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [chat, dirty, input, shots, pendingTurn, reviewOpen, historyOpen, menu, photoState, initializing]);
  useEffect(() => { if (batch && dirty) { try { sessionStorage.setItem(storageKey, JSON.stringify(batch)); } catch { /* explicit save remains available */ } } }, [batch, dirty, storageKey]);
  useEffect(() => { try { sessionStorage.setItem(scopedKey(`lifeos.backfill.input:${scope}`), input); } catch { /* optional */ } }, [input, scope]);
  useEffect(() => { const field = composerRef.current; if (field) { field.style.height = "32px"; field.style.height = `${Math.min(80, Math.max(32, field.scrollHeight))}px`; } }, [input]);
  // During a reply keep the question at the top; never chase its growing tail.
  const updateReadingPosition = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    readingPositionRef.current = scroller.scrollTop;
    setHasMoreBelow(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 12);
  };
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || reviewOpen) return;
    if (readingConversationRef.current !== conversationId) readingTurnRef.current = null;
    if (readingTurnRef.current) {
      const question = [...scroller.querySelectorAll<HTMLElement>('[data-message-role="user"]')].find(e => e.dataset.turnId === readingTurnRef.current);
      if (question && !readMoreRef.current) {
        const top = question.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - (parseFloat(getComputedStyle(scroller).paddingTop) || 0);
        // The browser clamps until enough answer exists; once aligned it stays put.
        scroller.scrollTop = Math.max(0, top);
      } else scroller.scrollTop = readingPositionRef.current;
    } else if (!initializing && scrollInitializedRef.current !== conversationId) {
      scroller.scrollTop = scroller.scrollHeight;
      scrollInitializedRef.current = conversationId;
    }
    updateReadingPosition();
  }, [chat, streamReply, pendingTurn, busy, reviewOpen, initializing, conversationId]);
  useEffect(() => {
    const scroller = scrollRef.current, content = contentRef.current;
    if (!scroller || !content) return;
    const observer = new ResizeObserver(updateReadingPosition);
    observer.observe(scroller); observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const readFurther = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    readMoreRef.current = true;
    scroller.scrollTop += Math.max(80, scroller.clientHeight * .75);
    updateReadingPosition();
  };
  useEffect(() => { try { sessionStorage.setItem(scopedKey("lifeos.assistant.photos:"+scope), JSON.stringify(shots)); } catch { /* optional */ } }, [shots, scope]);
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
  const privateAccessRef = useRef(privateAccessUntil);
  privateAccessRef.current = privateAccessUntil;
  const submitPendingTurn = async (turn: PendingAssistantTurn) => {
    privateTurnRef.current = Boolean(privateAccessRef.current);
    setPendingError("");
    setStopError("");
    setStreamReply("");
    readingTurnRef.current = turn.turnId;
    readingConversationRef.current = turn.conversationId;
    readMoreRef.current = false;
    let receivedBody = "";
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
        ...(turn.pageContext ? { pageContext: turn.pageContext } : {}),
        effort: gear,
      }, text => { if (text) receivedBody = text; if (active.current && pendingRef.current?.turnId === turn.turnId) setStreamReply(text); });
      if (!active.current) return;
      setStreamReply("");
      if (result.conversationId !== turn.conversationId || result.turnId !== turn.turnId) throw new Error("服务器返回的消息编号不匹配，本条仍保留待确认");
      const userMessage = userMessageFromPending(turn);
      const assistantMessage: BackfillChatViewMessage = { role: "assistant", text: result.reply, id: `${turn.turnId}:assistant`, at: new Date().toISOString(), ...(result.action === "draft" && result.batch && result.batch.id !== turn.batchId ? { draftBatchId: result.batch.id } : {}), ...(result.ui === undefined ? {} : { ui: result.ui }), ...(result.delivery ? { delivery: result.delivery } : {}), turnId: turn.turnId };
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
      setStreamReply("");
      const partial = (e as { partialReply?: string }).partialReply ?? receivedBody;
      if (partial) setChat(current => [...current.filter(item => !(item.role === "assistant" && item.turnId === turn.turnId)), { role: "assistant", text: partial, id: turn.turnId + ":partial", turnId: turn.turnId, at: new Date().toISOString(), delivery: { status: "incomplete", issue: "format" } }]);
      const status = (e as ApiError).status;
      if (status === 409 || status === 400 || status === 404 || status === 413) {
        const blocked = { ...turn, retryBlocked: true };
        try { writePendingAssistantTurn(scope, blocked, window.sessionStorage); } catch { /* keep current marker in memory */ }
        updatePending(blocked);
        setPendingError(status === 409
          ? `${message(e)}。服务器拒绝了同编号重放；本条已保留。为避免重复写入，请保留记录并新建对话。`
          : `${message(e)}。这条请求未被接受，不能用相同内容自动重试；请保留记录并新建对话后检查原文。`);
      } else {
        setPendingError(message(e));
      }
      throw e;
    }
  };
  useEffect(() => { if (!privateAccessUntil && replying && privateTurnRef.current) void stopReply(); }, [privateAccessUntil]);
  const privateTurnRef = useRef(false);
  const stopReply = async () => {
    const turn = pendingRef.current;
    if (!turn || stopping) return;
    setStopping(true); setStopError("");
    try { await stopAssistantChatTurn(turn.conversationId, turn.turnId); }
    catch { if (active.current && pendingRef.current?.turnId === turn.turnId) setStopError("暂时没能停止，请再点一次。"); }
    finally { if (active.current) setStopping(false); }
  };
  const retryPendingTurn = () => {
    const pending = pendingRef.current;
    if (pending === null || pending.retryBlocked) return;
    void execute("正在重试消息", () => submitPendingTurn(pending));
  };
  const retryCurrentLoad = () => { setError(""); setLoadFailed(false); setLoadRetry((current) => current + 1); };
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
    const turn: PendingAssistantTurn = { ...(pageContext ? { pageContext } : {}), conversationId: id, turnId: crypto.randomUUID(), batchId: boundBatchId, revision: boundBatchId === null ? null : current?.revision ?? null, message: text, materials, startedAt: new Date().toISOString(), status: "unconfirmed" };
    try { writePendingAssistantTurn(scope, turn, window.sessionStorage); }
    catch { throw new Error("浏览器暂时无法保存待确认消息，尚未发送；请检查会话存储后重试"); }
    updatePending(turn);
    if (raw === input) setInput("");
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
  const replying = busy === "正在回复" || busy === "正在重试消息";
  useEffect(() => {
    window.dispatchEvent(new Event('lifeos:private-ai-access'));
    if (initializing || replying || !conversationRef.current) return;
    const id = conversationRef.current, generation = ++detailGeneration.current;
    void loadCurrentConversation().then(current => {
      if (active.current && generation === detailGeneration.current && current.conversation?.id === id && conversationRef.current === id) setChat(current.conversation.messages.map(toChatMessage));
    }).catch(() => { /* permission still gates source reads server-side */ });
  }, [privateAccessUntil, initializing, replying]);
  const disabled = Boolean(busy) || initializing;
  const chatBlocked = disabled || pendingTurn !== null;
  /**
   * 消息上的右键菜单要带上整个管家都有的两项，所以这个钩子必须等
   * clearScreen / startNewConversation / disabled 全部就绪之后再挂
   * （2026-10-17）。scope 变化时收起菜单的副作用一并搬过来。
   */
  const { openMessageInfo, messageInfo, closeMessageInfo } = useAssistantMessageInfo({
    onClearScreen: clearScreen,
    onNewConversation: startNewConversation,
    // 只跟 busy/初始化走：未确认的消息不再让这两项变灰（parkPendingTurn 会保留原文）。
    actionsDisabled: disabled,
    // 正文上右键命中消息区自己的菜单，它 stopPropagation 后外层不会再开菜单，
    // 所以「检索私密」必须挂在同一份 extras 里，否则正文右键就看不到。
    privacyAccess,
    privacyDisabled,
  });
  useLayoutEffect(() => { setShareRequest(null); closeMessageInfo(); }, [scope]);
  useEffect(() => {
    if (!focusRequested || chatBlocked || !composerRef.current) return;
    composerRef.current.focus({ preventScroll: true });
    if (document.activeElement === composerRef.current) onFocusHandled?.();
  }, [focusRequested, chatBlocked, onFocusHandled]);
  const pendingVisible = pendingTurn !== null && pendingTurn.conversationId === conversationId;
  const pendingRecoveryVisible = pendingVisible && !replying && !initializing;
  const pendingArchiveMessage = pendingVisible ? chat.find((item) => item.turnId === pendingTurn.turnId) : undefined;
  const pendingAlreadyInArchive = pendingArchiveMessage !== undefined;
  const pendingRetryBlocked = pendingTurn?.retryBlocked === true || (pendingArchiveMessage?.retryable === false && pendingArchiveMessage?.turnStatus !== "running") || pendingArchiveMessage?.turnStatus === "interrupted";
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
      resetGearToDefault();
      parkPendingTurn();
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
  const draftPosition = batch ? assistantDraftPosition(displayedChat, batch) : -1;
  const draftCards = showBatch && batch ? <div className="backfill-draft-turn" data-draft-batch-id={batch.id}>
      {showBatch && batch ? <section className="backfill-plan-preview" aria-label="当前拟写方案"><strong>{batch.status==="undone" ? "已撤销的内容" : "拟写内容"}</strong>
        {batch.plan.entries.map(e => { const state=backfillItemState(batch,e.key); return <article className={"backfill-confirm-card is-"+state} data-confirm-key={e.key} data-confirm-state={state} key={e.key}><div className="backfill-card-heading"><DraftDateTime entry={e} generatedAt={batch.createdAt} editable={draft&&state!=="committed"&&!disabled} onChange={patch=>changeEntry(e.key,patch)} /></div>{state==="deferred" ? <details><summary>查看暂存内容</summary><p className="backfill-preview-copy">{e.content}</p><div className="backfill-preview-photos">{e.assetIds.map(id=><img key={id} src={assetThumbUrl(id,400)} alt="拟写照片" />)}</div></details> : <><p className="backfill-preview-copy">{e.content}</p><div className="backfill-preview-photos">{e.assetIds.map(id=><img key={id} src={assetThumbUrl(id,400)} alt="拟写照片" />)}</div></>}{e.questions ? <p className="backfill-warning">{e.questions}</p> : null}{actionButtons(e.key,backfillEntryReady(e)&&e.entityKeys.every(key=>batch.plan.objects.some(o=>o.key===key&&o.selected&&!o.questions.trim())))}</article>; })}
        {(batch.plan.actions??[]).map(a=><article className={"backfill-confirm-card is-"+backfillItemState(batch,a.key)} data-confirm-key={a.key} data-confirm-state={backfillItemState(batch,a.key)} key={a.key}><div className="backfill-card-heading"><strong>{a.date||"日期未定"}</strong><span>{a.type==="cycle" ? "周期标记" : "习惯标记"}</span></div><p className="backfill-preview-copy">{a.marked ? "标记" : "移除"}{a.type==="cycle" ? ({period_start:"经期开始",period_end:"经期结束",intimacy:"亲密",fitness:"运动"}[a.cycleKind!]) : a.name}</p>{a.type === "cycle" ? <p className="backfill-preview-copy">当事人：{batch.moduleSnapshot?.config.subjectId ? entities.find(entity => entity.id === batch.moduleSnapshot?.config.subjectId)?.name ?? "已移除的联系人" : "本人"}</p> : null}{a.questions ? <p className="backfill-warning">{a.questions}</p> : null}{actionButtons(a.key,a.selected&&!a.questions.trim()&&Boolean(a.date))}</article>)}
        {batch.plan.objects.filter(o=>o.selected).map(o=><p className="backfill-preview-copy" key={o.key}>{TYPE_LABEL[o.type]}：{o.name}{o.type==="movie"&&o.movie?.watched ? "（已看）" : ""}</p>)}
        {draft&&(pendingItems.length+orphanObjects.length)>1 ? <div className="backfill-operation-group backfill-item-actions"><button className="primary-button" type="button" disabled={disabled||pendingItems.some(item=>"content" in item ? !backfillEntryReady(item) : !item.date||Boolean(item.questions.trim()))||batch.plan.objects.some(o=>o.selected&&!batch.committedObjectKeys?.includes(o.key)&&Boolean(o.questions.trim()))} onClick={()=>void confirm()}>确认全部（{pendingItems.length+orphanObjects.length}条）</button></div> : null}
        {draft&&pendingItems.length===0&&orphanObjects.length===1 ? <div className="backfill-operation-group backfill-item-actions"><button className="primary-button" type="button" disabled={disabled||Boolean(orphanObjects[0]?.questions.trim())} onClick={()=>void confirm()}>确认记录</button></div> : null}
      </section> : null}
      {showBatch && batch ? <details className="backfill-review" open={reviewOpen} onToggle={(e) => setReviewOpen(e.currentTarget.open)}><summary>查看和手动编辑拟写内容</summary>
      {batch ? <><p className="backfill-explanation">{batch.plan.explanation}</p>{batch.mode === "rules" ? <p className="backfill-mode">当前使用本地整理。可手动修改草稿，配置 AI 后可继续讨论。</p> : null}
        <fieldset disabled={disabled || !draft} className="backfill-plan-fields"><legend>记录草稿</legend>
          {batch.plan.entries.filter(e=>backfillItemState(batch,e.key)!=="committed").map((e, i) => <section className="backfill-draft-card" data-backfill-entry={e.key} key={e.key}>
            <label className="backfill-choice"><input type="checkbox" checked={e.selected} onChange={(v) => changeEntry(e.key, { selected: v.target.checked })} />第 {i + 1} 条记录</label>
            <div className="backfill-row"><label className="backfill-field"><span>发生日期</span><input type="date" value={e.date} max={e.kind === "journal" ? calendarToday() : undefined} onChange={(v) => changeEntry(e.key, { date: v.target.value, time: "" })} /></label><label className="backfill-field"><span>类型</span><select value={e.kind} onChange={(v) => changeEntry(e.key, { kind: v.target.value as BackfillEntry["kind"] })}><option value="journal">{e.nature === "dream" ? "梦境" : "日记"}</option><option value="task">任务</option><option value="event">事件</option><option value="note">笔记</option></select></label></div>
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
  </div> : null;
  const shareConversation = (index: number) => setShareRequest({ conversationId, initialIndex: index, messages: chat.map((message, i) => ({ ...message, id: message.id ?? "live:" + i })) });
  return <AssistantSourceProvider key={scope} onEnter={record => { setHistoryOpen(false); onEnterSource?.(record); }}><div className="assistant-backfill" aria-busy={disabled} onContextMenu={(event) => { if ((event.target as HTMLElement).closest("textarea, input, select, [contenteditable]") !== null) return; event.preventDefault(); openMenu(event.clientX, event.clientY); }}>
    <div className="backfill-reading-area">
    <div className="backfill-workspace-scroll" ref={scrollRef} onScroll={updateReadingPosition} onWheel={() => { readMoreRef.current = true; }} onTouchStart={() => { readMoreRef.current = true; }} onPointerDown={() => { readMoreRef.current = true; }} onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) readMoreRef.current = true; }} tabIndex={0} aria-label="对话内容">
      <div className="backfill-workspace-content" ref={contentRef}>
      <div className="backfill-conversation" role="log" aria-label="和AI管家的对话" aria-live="polite">{draftPosition === -1 ? draftCards : null}{displayedChat.length === 0 ? <AssistantWelcome key={String(conversationId) + String(clearedAt)} disabled={chatBlocked || photoState !== null} hasDraft={Boolean(input.trim() || shots.length)} onPick={prompt => { if (input.trim() || shots.length) { setInput(current => current.trim() ? current + "\n" + prompt : prompt); requestAnimationFrame(() => composerRef.current?.focus()); return; } return sendText(prompt); }} /> : null}{displayedChat.map((m, i) => <Fragment key={m.id ?? `${m.role}:${m.at ?? i}:${i}`} >{assistantTimeDivider(displayedChat[i - 1]?.at, m.at) ? <p className="assistant-time-divider">{assistantMessageTime(m.at)}</p> : null}<div onContextMenu={event => { if (chat[i]) openMessageInfo(event, m.at, m.text, () => shareConversation(i)); }} className={`ai-message-row backfill-chat-message is-${m.role}`} aria-label={m.role === "user" ? "我" : "AI管家"} data-message-role={m.role} data-turn-id={m.turnId} key={m.id ?? `${m.role}:${m.at ?? i}:${i}`}><div className={`backfill-chat-copy ${m.role === "user" ? "ai-user-message" : "ai-assistant-message"}`}>{m.role === "assistant" ? <><AssistantCitedText text={m.text} offers={m.ui?.offers} disabled={disabled} /><AssistantDeliveryNote delivery={m.delivery} /></> : <p>{m.text}</p>}{m.role === "assistant" && m.ui?.offers?.some(offer => !isJournalSourceOffer(offer)) ? <div className="backfill-operation-group backfill-ui-offers">{m.ui.offers.filter(offer => !isJournalSourceOffer(offer)).map((offer, offerIndex) => <button className="secondary-button" type="button" key={`${offer.label}:${offerIndex}`} onClick={() => onUiCommand(offer.command)}>{offer.label}</button>)}</div> : null}{m.role === "assistant" && m.ui?.clarify ? <UiClarifyPrompt clarify={m.ui.clarify} onPick={(text) => { setInput(""); sendText(text); }} /> : null}{m.attachments?.length ? <div className="backfill-chat-attachments" aria-label="消息附件">{m.attachments.map((attachment) => <button type="button" key={attachment.assetId} onClick={() => void openAttachment(attachment.assetId)}>{attachment.name}</button>)}</div> : null}</div><div className="assistant-message-meta">{m.role === "assistant" ? <AssistantMessageActions content={m.text} onShare={() => shareConversation(i)} /> : null}<AssistantMessageTime at={m.at} /></div></div>{i === draftPosition ? draftCards : null}</Fragment>)}</div>
      {replying && streamReply ? <div className="ai-message-row backfill-chat-message is-assistant is-streaming" data-message-role="assistant" aria-label="AI管家正在回复"><div className="backfill-chat-copy ai-assistant-message"><AssistantCitedText text={streamReply} /></div></div> : null}
      {replying && !streamReply ? <AssistantReplyProgress thinking={gear !== "direct"} /> : null}
      {pendingRecoveryVisible ? <div className="ai-message-row backfill-chat-message is-assistant backfill-reply-failure" data-message-role="assistant" aria-label="AI管家"><div className="backfill-chat-copy ai-assistant-message"><p role="status">{pendingRetryBlocked ? pendingError : pendingError ? displayedChat.some(item => item.turnId === pendingTurn?.turnId && item.delivery?.status === "incomplete") ? "可以重试这轮回答，已收到的正文会保留。" : "这次回复没能完成。点下方重试，我再来一次。" : "上次回复还没完成，可以接着重试。"}</p></div><div className="assistant-message-actions">{pendingRetryBlocked ? <button className="secondary-button" type="button" disabled={disabled} onClick={preserveAndStartNew}>保留记录并新建对话</button> : <button className="assistant-message-actions__copy" type="button" aria-label="重试这条消息" title="重试这条消息" disabled={disabled} onClick={retryPendingTurn}><RotateCw size={14} aria-hidden="true" /></button>}</div></div> : null}

      </div>
    </div>
    {hasMoreBelow ? <button className="backfill-read-more" type="button" aria-label="向下阅读更多内容" title="向下阅读更多内容" onClick={readFurther}><ArrowDown size={19} aria-hidden="true" /></button> : null}
    </div>
    <div className={"backfill-workspace-footer "+(draggingFiles ? "is-dragging" : "")} {...photoHandlers}>
      {initializing ? <p role="status">正在恢复聊天和草稿…</p> : null}
      {error && !(pendingRecoveryVisible && pendingError) ? <p className="backfill-warning" role="alert"><CircleAlert className="backfill-warning-icon" size={15} aria-hidden="true" /><span className="backfill-warning-text">{error}</span>{initializing || loadFailed ? <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={retryCurrentLoad}>重试恢复会话</button> : null}</p> : null}{notice ? <p className="backfill-notice" role="status">{notice}</p> : null}

      {stopError ? <p role="status">{stopError}</p> : null}
      {busy && !replying ? <p role="status"><LoaderCircle size={14} className="spin" />{busy}…</p> : null}
      {!configured ? <p className="backfill-mode">当前使用本地模式。<button className="ai-configure-link" type="button" onClick={onOpenSettings}>配置 AI</button>后可理解更完整的要求。</p> : null}
      {privacyRequest === null ? null : <div className="backfill-privacy-request" role="alert"><p>{privacyRequest.reason}</p><div className="backfill-operation-group"><button className="primary-button" type="button" onClick={() => onPrivacyDecision("once")}>本次允许</button><button className="secondary-button" type="button" onClick={() => onPrivacyDecision("session")}>本次会话允许</button><button className="secondary-button" type="button" onClick={() => onPrivacyDecision("never")}>不用了</button></div></div>}
      <form className="ai-assistant-composer backfill-chat-composer" onSubmit={(e) => { e.preventDefault(); if (!chatBlocked && photoState === null && (input.trim() || shots.length)) void send(); }}>
        <textarea ref={composerRef} aria-label="发给AI管家的消息" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!chatBlocked && photoState === null && (input.trim() || shots.length)) void send(); } }} rows={1} disabled={chatBlocked} />
        <div className="backfill-input-actions">
          <ShotDropZone ref={shotRef} toolbarTarget={photoToolbarTarget} scopeKey={"assistant:"+scope} numbered addOutsideStrip disabled={chatBlocked} shots={shots} onShotsChange={setShots} onUpload={photoInput.onUploadShot} onNotify={photoInput.onNotify} onCleared={photoInput.onShotsCleared} onSubmissionState={(_scope,state)=>setPhotoState(state)} />
          <div className="backfill-photo-slot" ref={setPhotoToolbarTarget} />
          <div className="backfill-operation-group">
            <button className="secondary-button ai-gear-button" type="button" aria-label={`思考强度：${gearLabel(gear)}`} aria-haspopup="menu" aria-expanded={gearMenu !== null} disabled={disabled} title="思考强度" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setGearMenu({ x: rect.left, y: rect.top - 8 }); }}><ReasoningIcon /><span>{gearLabel(gear)}</span><ChevronDown size={14} aria-hidden="true" /></button>
            {replying ? <button className="primary-button ai-send-button ai-stop-button" type="button" aria-label={stopping ? "正在停止回答" : "停止回答"} title="停止回答" disabled={stopping || pendingTurn === null} onClick={() => void stopReply()}><Square size={14} fill="currentColor" aria-hidden="true" /></button> : <button className={`primary-button ai-send-button${input.trim() || shots.length ? " is-sendable" : ""}`} type="submit" aria-label="发送" title="发送" disabled={chatBlocked || photoState !== null}><ArrowUp className="ai-send-icon" size={16} strokeWidth={2.2} aria-hidden="true" /><span className="ai-send-label">发送</span></button>}
          </div>
        </div>
      </form>
    </div>
    {menu === null ? null : createPortal(<div ref={menuRef} className="ai-assistant-menu" role="menu" aria-label="AI 管家的操作" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
        <button type="button" role="menuitem" disabled={disabled} onClick={clearScreen}><Eraser size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">清屏</span></button>
        <button type="button" role="menuitem" disabled={disabled} onClick={startNewConversation}><MessageSquarePlus size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">新对话</span></button>
        <div className="action-menu-separator" role="separator" />
        <AssistantPrivacyMenuItems access={privacyAccess} disabled={privacyDisabled} onBeforeUnlock={() => setMenu(null)} />
        <div className="action-menu-separator" role="separator" />
        <button type="button" role="menuitem" onClick={() => { setMenu(null); setHistoryOpen(true); }}><History size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">聊天记录</span></button>
        <button type="button" role="menuitem" onClick={() => { setMenu(null); onOpenSettings(); }}><Settings2 size={14} aria-hidden="true" /><span className="ai-assistant-menu-label">AI 设置</span></button>
    </div>, document.body)}
    {gearMenu === null ? null : createPortal(<div ref={gearMenuRef} className="ai-assistant-menu ai-gear-menu" role="menu" aria-label="推理程度" style={{ left: gearMenu.x, top: gearMenu.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
        {/* 视觉标题：说明这组单选是什么。菜单自己已经用 aria-label 报了同一个名字，
            所以这里 aria-hidden，避免读屏把名字念两遍。 */}
        <p className="ai-gear-menu-heading" aria-hidden="true">推理程度</p>
        {AI_GEARS.map((option) => <button type="button" role="menuitemradio" aria-checked={gear === option.id} key={option.id} onClick={() => { setGearMenu(null); pickGear(option.id); }}><span className="ai-gear-check" aria-hidden="true">{gear === option.id ? <Check size={14} /> : null}</span><span className="ai-assistant-menu-label">{option.label}</span></button>)}
    </div>, document.body)}
    {messageInfo}
    {shareRequest ? <AssistantShareDialog request={shareRequest} onClose={() => setShareRequest(null)} /> : null}
    <AssistantHistoryDialog onUiCommand={onUiCommand} open={historyOpen} onClose={() => setHistoryOpen(false)} actionsDisabled={disabled || pendingTurn !== null} onOpenAttachment={(id) => void openAttachment(id)} onContinue={(detail) => {
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
  </div></AssistantSourceProvider>;
}
