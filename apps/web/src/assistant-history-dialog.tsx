import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  groupConversationsByDay,
  splitHistoryMatches,
  type AssistantConversationSummary,
} from "@lifeos/core";
import { History, Search, X } from "lucide-react";
import { AssistantMessageActions } from "./assistant-message-actions";
import { AssistantHistoryRangePicker } from "./assistant-history-range";
import {
  continueAssistantConversation,
  listAssistantConversations,
  loadAssistantConversation,
  loadCurrentConversation,
  type AssistantArchiveMessage,
  type AssistantConversationView,
} from "./assistant-history-api";
import { assetContentUrl } from "./timeline";
import { isBackdropDismiss } from "./dialog-dismiss";

const MESSAGE_TIME = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

function mergeOlderMessages(older: readonly AssistantArchiveMessage[], newer: readonly AssistantArchiveMessage[]): readonly AssistantArchiveMessage[] {
  const byId = new Map<string, AssistantArchiveMessage>();
  for (const item of [...older, ...newer]) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

/** The archive viewer. Its transcript page is independent from the latest page used to continue. */
export function AssistantHistoryDialog({ open, onClose, onContinue, onOpenAttachment, actionsDisabled = false }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onContinue: (conversation: AssistantConversationView) => void;
  readonly onOpenAttachment: (assetId: string) => void;
  readonly actionsDisabled?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const threadScrollRef = useRef<HTMLElement>(null);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const [items, setItems] = useState<readonly AssistantConversationSummary[]>([]);
  const [listHasMore, setListHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [rangePickerOpen, setRangePickerOpen] = useState(false);
  const [appliedFromDate, setAppliedFromDate] = useState("");
  const [appliedToDate, setAppliedToDate] = useState("");
  const [listRefresh, setListRefresh] = useState(0);
  const [selected, setSelected] = useState<AssistantConversationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMoreItems, setLoadingMoreItems] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const generation = ++listGeneration.current;
    setBusy(true); setLoadingMoreItems(false); setError(""); setItems([]); setNextCursor(null); setListHasMore(false);
    void listAssistantConversations(applied, null, { from: appliedFromDate || undefined, to: appliedToDate || undefined })
      .then((page) => {
        if (generation !== listGeneration.current) return;
        setItems(page.items); setListHasMore(page.hasMore); setNextCursor(page.nextCursor);
      })
      .catch((e) => { if (generation === listGeneration.current) setError(e instanceof Error ? e.message : "聊天记录读取失败"); })
      .finally(() => { if (generation === listGeneration.current) setBusy(false); });
    return () => { if (generation === listGeneration.current) listGeneration.current++; };
  }, [open, applied, appliedFromDate, appliedToDate, listRefresh]);

  // A hidden dialog should not retain a previous account's selected transcript.
  useEffect(() => {
    if (open) return;
    listGeneration.current++; detailGeneration.current++;
    setSelected(null); setQuery(""); setApplied(""); setFromDate(""); setToDate(""); setAppliedFromDate(""); setAppliedToDate(""); setRangePickerOpen(false); setError("");
    setLoadingMoreItems(false); setLoadingOlderMessages(false); setContinuing(false);
  }, [open]);

  const groups = useMemo(() => groupConversationsByDay(items), [items]);

  const loadMoreConversations = async () => {
    if (loadingMoreItems || !listHasMore || nextCursor === null) return;
    const generation = listGeneration.current;
    setLoadingMoreItems(true); setError("");
    try {
      const page = await listAssistantConversations(applied, nextCursor, { from: appliedFromDate || undefined, to: appliedToDate || undefined });
      if (generation !== listGeneration.current) return;
      setItems((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const item of page.items) byId.set(item.id, item);
        return [...byId.values()];
      });
      setListHasMore(page.hasMore); setNextCursor(page.nextCursor);
    } catch (e) {
      if (generation === listGeneration.current) setError(e instanceof Error ? e.message : "更多对话读取失败");
    } finally {
      if (generation === listGeneration.current) setLoadingMoreItems(false);
    }
  };

  const openConversation = async (id: string) => {
    if (continuing) return;
    const generation = ++detailGeneration.current;
    setError(""); setSelected(null); setLoadingOlderMessages(false);
    try {
      const detail = await loadAssistantConversation(id);
      if (generation !== detailGeneration.current) return;
      setSelected(detail);
    } catch (e) {
      if (generation === detailGeneration.current) setError(e instanceof Error ? e.message : "这段对话读取失败");
    }
  };

  const loadEarlierMessages = async () => {
    if (selected === null || !selected.hasMore || selected.nextBeforeSeq === null || loadingOlderMessages) return;
    const id = selected.id;
    const generation = detailGeneration.current;
    const beforeSeq = selected.nextBeforeSeq;
    const thread = threadScrollRef.current;
    const previousHeight = thread?.scrollHeight ?? 0;
    setLoadingOlderMessages(true); setError("");
    try {
      const older = await loadAssistantConversation(id, beforeSeq);
      if (generation !== detailGeneration.current) return;
      setSelected((current) => current?.id !== id ? current : {
        ...current,
        messages: mergeOlderMessages(older.messages, current.messages),
        hasMore: older.hasMore,
        nextBeforeSeq: older.nextBeforeSeq,
      });
      requestAnimationFrame(() => {
        if (thread !== null) thread.scrollTop += thread.scrollHeight - previousHeight;
      });
    } catch (e) {
      if (generation === detailGeneration.current) setError(e instanceof Error ? e.message : "更早的消息读取失败");
    } finally {
      if (generation === detailGeneration.current) setLoadingOlderMessages(false);
    }
  };

  const resume = async () => {
    if (selected === null || actionsDisabled || continuing) return;
    const conversation = selected;
    const generation = detailGeneration.current;
    setContinuing(true); setError("");
    try {
      await continueAssistantConversation(conversation.id);
      if (generation !== detailGeneration.current || !open || selected?.id !== conversation.id) return;
      const current = await loadCurrentConversation();
      if (generation !== detailGeneration.current || !open || selected?.id !== conversation.id) return;
      if (current.conversation === null || current.conversation.id !== conversation.id) throw new Error("继续后的当前对话与所选记录不一致，请重新打开记录");
      onContinue(current.conversation);
    } catch (e) {
      setError(e instanceof Error ? e.message : "继续这段对话失败");
    } finally { setContinuing(false); }
  };

  if (!open) return createPortal(<dialog ref={dialogRef} className="modal-dialog assistant-history-dialog" />, document.body);
  const interactionsBlocked = continuing;
  const requestClose = () => { if (continuing) return; setRangePickerOpen(false); detailGeneration.current++; onClose(); };
  return createPortal(<dialog ref={dialogRef} className="modal-dialog assistant-history-dialog" aria-label="AI 管家聊天记录" onKeyDownCapture={(event) => {
    if (event.key !== "Escape" || !rangePickerOpen) return;
    event.preventDefault(); event.stopPropagation();
    setRangePickerOpen(false);
    dialogRef.current?.querySelector<HTMLButtonElement>(".assistant-history-range-trigger")?.focus();
  }} onCancel={(event) => {
    event.preventDefault();
    if (rangePickerOpen && !isBackdropDismiss(event.nativeEvent)) {
      setRangePickerOpen(false);
      dialogRef.current?.querySelector<HTMLButtonElement>(".assistant-history-range-trigger")?.focus();
      return;
    }
    requestClose();
  }}>
    <div className="dialog-header">
      <div><p className="eyebrow">AI 管家</p><h2>聊天记录</h2></div>
      <button className="icon-button compact-icon-button" type="button" disabled={continuing} onClick={requestClose} aria-label="关闭聊天记录"><X size={17} aria-hidden="true" /></button>
    </div>
    <form className="assistant-history-search" onSubmit={(event) => {
      event.preventDefault();
      if (fromDate && !toDate) {
        setError("请选择结束日期，或清除日期范围后搜索全部日期");
        setRangePickerOpen(true);
        return;
      }
      if (fromDate && toDate && fromDate > toDate) { setError("开始日期不能晚于结束日期"); return; }
      setRangePickerOpen(false);
      setError(""); detailGeneration.current++; setSelected(null); setApplied(query); setAppliedFromDate(fromDate); setAppliedToDate(toDate); setListRefresh((current) => current + 1);
    }}>
      <label className="assistant-history-search-field"><Search size={15} aria-hidden="true" /><input type="search" aria-label="搜索聊天记录" placeholder="搜索你和 AI 说过的话" value={query} disabled={interactionsBlocked} onChange={(event) => setQuery(event.target.value)} /></label>
      <AssistantHistoryRangePicker
        fromDate={fromDate}
        toDate={toDate}
        onChange={(from, to) => { setFromDate(from); setToDate(to); }}
        disabled={interactionsBlocked}
        open={rangePickerOpen}
        onOpenChange={setRangePickerOpen}
      />
      <div className="assistant-history-search-actions">
        <button className="secondary-button" type="submit" disabled={interactionsBlocked}>搜索</button>
        {applied.length > 0 || appliedFromDate || appliedToDate || fromDate || toDate ? <button className="secondary-button" type="button" disabled={interactionsBlocked} onClick={() => { detailGeneration.current++; setQuery(""); setFromDate(""); setToDate(""); setRangePickerOpen(false); setSelected(null); setApplied(""); setAppliedFromDate(""); setAppliedToDate(""); setListRefresh((current) => current + 1); }}>清除</button> : null}
      </div>
    </form>
    <div className="dialog-body assistant-history-body">
      <nav className="assistant-history-days" aria-label="按日期分组">
        {busy ? <p className="assistant-history-note" role="status">正在读取…</p> : null}
        {!busy && items.length === 0 ? <p className="assistant-history-note">{applied.length > 0 ? `没有找到包含「${applied}」的对话` : appliedFromDate || appliedToDate ? "当前日期范围没有找到对话" : "还没有聊天记录。在 AI 管家聊过之后，这里就会留下。"}</p> : null}
        {groups.map((group) => <section className="assistant-history-day" key={group.key}>
          <h3>{group.label}</h3>
          <ul>{group.items.map((item) => <li key={item.id}>
            <button className={selected?.id === item.id ? "is-selected" : ""} type="button" disabled={interactionsBlocked} aria-current={selected?.id === item.id ? "true" : undefined} onClick={() => void openConversation(item.id)}>
              <span className="assistant-history-item-preview">{item.preview.length > 0 ? splitHistoryMatches(item.preview, applied).map((segment, position) => segment.match ? <mark key={position}>{segment.text}</mark> : <span key={position}>{segment.text}</span>) : "（这段对话没有你的发言）"}</span>
              <small>{item.messageCount} 条</small>
            </button>
          </li>)}</ul>
        </section>)}
        {listHasMore ? <button className="secondary-button assistant-history-load-more" type="button" disabled={busy || loadingMoreItems || interactionsBlocked} onClick={() => void loadMoreConversations()}>{loadingMoreItems ? "正在加载对话…" : "加载更多对话"}</button> : null}
      </nav>
      <article className="assistant-history-thread" aria-label="对话内容" ref={threadScrollRef}>
        {error.length > 0 ? <p className="assistant-history-error" role="alert">{error}</p> : null}
        {selected === null
          ? <p className="assistant-history-note"><History size={14} aria-hidden="true" />从左边选一段对话，或者先搜索一个词。</p>
          : <>
            <header className="assistant-history-thread-head">
              <span>当前显示 {selected.messages.length} 条</span>
              <button className="secondary-button" type="button" disabled={actionsDisabled || continuing} onClick={() => void resume()}>{continuing ? "正在继续…" : "继续这段对话"}</button>
            </header>
            {selected.hasMore ? <button className="secondary-button assistant-history-load-older" type="button" disabled={interactionsBlocked || loadingOlderMessages} onClick={() => void loadEarlierMessages()}>{loadingOlderMessages ? "正在加载更早消息…" : "加载更早消息"}</button> : null}
            <div className="assistant-history-messages">
              {selected.messages.map((message) => <div className={`ai-message-row assistant-history-message is-${message.role}`} key={message.id}>
                <div className="assistant-history-message-content">
                  <p className="assistant-history-message-copy">{splitHistoryMatches(message.text, applied).map((segment, position) => segment.match ? <mark key={position}>{segment.text}</mark> : <span key={position}>{segment.text}</span>)}</p>
                  {message.attachments?.length ? <div className="assistant-history-attachments" aria-label="消息附件">{message.attachments.map((attachment) => <a key={attachment.assetId} href={assetContentUrl(attachment.assetId)} onClick={(event) => { event.preventDefault(); onOpenAttachment(attachment.assetId); }}>{attachment.name}</a>)}</div> : null}
                  {message.role === "assistant" ? <AssistantMessageActions content={message.text} /> : null}
                  <time className="assistant-history-message-time" dateTime={message.at}>{MESSAGE_TIME.format(new Date(message.at))}</time>
                </div>
              </div>)}
            </div>
          </>}
      </article>
    </div>
    <div className="dialog-footer"><button className="secondary-button" type="button" disabled={continuing} onClick={requestClose}>关闭</button></div>
  </dialog>, document.body);
}
