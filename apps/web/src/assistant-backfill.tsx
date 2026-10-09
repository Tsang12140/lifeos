import { backfillItemState, backfillEntryTime, backfillEntryReady, calendarToday } from "@lifeos/core";
import type { AssetLink } from "@lifeos/core";
import type { ComposerProps } from "./composer";
import { ShotDropZone, type ShotDropZoneHandle } from "./shot-drop-zone";
import { usePhotoInput } from "./photo-input";
import { useEffect, useRef, useState } from "react";
import { Film, LoaderCircle, Plus } from "lucide-react";
import type { Asset, BackfillBatch, BackfillChatAnswer, BackfillChatMessage, BackfillEntry, BackfillMaterial, BackfillObject, Entity } from "@lifeos/core";
import { apiRequest } from "./api";
import "./assistant-backfill.css";

const TYPE_LABEL = { person: "人物", place: "地点", movie: "电影" };
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
export function AssistantBackfill({ photoInput, scope, configured, onChanged, onViewRecords, onOpenEntity }: { readonly photoInput: Pick<ComposerProps, "onUploadShot" | "onNotify" | "onShotsCleared">; readonly scope: string; readonly configured: boolean; readonly onChanged: () => void; readonly onViewRecords: () => void; readonly onOpenEntity: (entity: Entity) => void }) {
  const [batch, setBatch] = useState<BackfillBatch | null>(null);
  const [batches, setBatches] = useState<readonly BackfillBatch[]>([]);
  const [shots, setShots] = useState<readonly AssetLink[]>(() => { try { return JSON.parse(sessionStorage.getItem('lifeos.assistant.photos:'+scope) ?? '[]'); } catch { return []; } });
  const [photoState, setPhotoState] = useState<"active" | "failed" | null>(null);
  const shotRef = useRef<ShotDropZoneHandle>(null);
  const busyRef = useRef(false);
  const [input, setInput] = useState(() => { try { return sessionStorage.getItem(`lifeos.backfill.input:${scope}`) ?? ""; } catch { return ""; } });
  const [chat, setChat] = useState<readonly BackfillChatMessage[]>(() => { try { const stored = JSON.parse(sessionStorage.getItem(`lifeos.backfill.chat:${scope}`) ?? "[]"); return Array.isArray(stored) ? stored.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string").slice(-40) : []; } catch { return []; } });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [entities, setEntities] = useState<readonly Entity[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const storageKey = `lifeos.backfill.edit:${scope}`;
  const active = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { active.current = true; void Promise.all([apiRequest<{ items: BackfillBatch[] }>("/api/ai/backfill"), apiRequest<{ items: Entity[] }>("/api/entities")]).then(([history, objects]) => { if (!active.current) return; setBatches(history.items); let chosen = history.items.find((b) => b.status === "draft") ?? history.items[0] ?? null; try { const local = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as BackfillBatch | null; const server = history.items.find((b) => b.id === local?.id); if (local && server?.status === "draft" && local.revision === server.revision) { chosen = local; setDirty(true); } } catch { /* optional local edit recovery */ } setBatch(chosen); if (chosen?.conversation?.length) setChat(chosen.conversation); setEntities(objects.items); }).catch((e) => { if (active.current) setError(message(e)); }); return () => { active.current = false; }; }, [scope]);
  useEffect(() => { if (batch && dirty) { try { sessionStorage.setItem(storageKey, JSON.stringify(batch)); } catch { /* explicit save remains available */ } } }, [batch, dirty, storageKey]);
  useEffect(() => { try { sessionStorage.setItem(`lifeos.backfill.input:${scope}`, input); } catch { /* optional */ } }, [input, scope]);
  useEffect(() => { const field = composerRef.current; if (field) { field.style.height = "32px"; field.style.height = `${Math.min(80, Math.max(32, field.scrollHeight))}px`; } }, [input]);
  useEffect(() => { try { sessionStorage.setItem(`lifeos.backfill.chat:${scope}`, JSON.stringify(chat.slice(-40))); } catch { /* current conversation stays in memory */ } }, [chat, scope]);
  useEffect(() => { if (!reviewOpen && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [chat, busy, reviewOpen]);
  useEffect(() => { try { sessionStorage.setItem("lifeos.assistant.photos:"+scope, JSON.stringify(shots)); } catch { /* optional */ } }, [shots, scope]);
  const { draggingFiles, handlers: photoHandlers } = usePhotoInput(shotRef, Boolean(busy));
  const execute = async (label: string, run: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(label); setError(""); setNotice(""); try { await run(); } catch (e) { setError(message(e)); } finally { busyRef.current = false; if (active.current) setBusy(""); } };
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
  const send = () => execute("正在回复", async () => {
    const text = input.trim();
    if (photoState !== null) { photoInput.onNotify(photoState === "failed" ? "有照片未上传，请重试或移除后发送" : "照片正在处理，请完成后再发送", "warn"); return; }
    const attachments: readonly BackfillMaterial[] = shots.map((shot, index) => ({ name: "照片"+(index+1)+"："+(shot.label ?? "照片"), text: "照片序号"+(index+1)+"，内容和拍摄日期待核对", assetId: shot.assetId }));
    if (!text && !attachments.length) return;
    const user: BackfillChatMessage = { role: "user", text: [text, ...attachments.map((m) => `附件：${m.name}`)].filter(Boolean).join("\n") };
    setChat((current) => [...current, user]); setInput("");
    try {
      const current = batch?.status === "draft" && dirty ? await save() : batch;
      const result = await apiRequest<BackfillChatAnswer>("/api/ai/backfill/chat", { method: "POST", body: JSON.stringify({ message: text, materials: await withImages(attachments), history: chat.slice(-20).map((m) => ({ ...m, text: m.text.slice(0, 12000) })), ...(current ? { batchId: current.id, revision: current.revision } : {}) }) });
      if (!active.current) return;
      setChat((previous) => [...previous, { role: "assistant", text: result.reply }]); if (result.action === "draft") setShots([]);
      if (result.batch) { if (result.batch.id !== batch?.id) setReviewOpen(false); remember(result.batch); }
      if (result.action === "commit" || result.action === "undo") onChanged();
    } catch (error) { if (active.current) { setInput(text); setChat((current) => [...current, { role: "assistant", text: message(error) }]); } throw error; }
  });
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
  const disabled = Boolean(busy);
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
  return <div className="assistant-backfill" aria-busy={disabled}>
    <div className="backfill-workspace-scroll" ref={scrollRef}>
      {batches.length > 0 ? <details className="backfill-chat-history"><summary>历史方案</summary><label className="backfill-field"><span>选择之前的对话</span><select value={batch?.id ?? ""} disabled={disabled || dirty} onChange={(e) => { const b = batches.find((v) => v.id === e.target.value); if (b) { setBatch(b); setChat(b.conversation ?? []); setReviewOpen(false); } }}>{batches.map((b) => <option key={b.id} value={b.id}>{b.createdAt.slice(0, 10)} {b.status === "draft" ? "待确认" : b.status === "committed" ? "已写入" : "已撤销"}（{b.plan.entries.length} 条）</option>)}</select></label></details> : null}
      <div className="backfill-conversation" role="log" aria-label="和AI管家的对话" aria-live="polite">{chat.length === 0 ? <p className="backfill-chat-copy ai-assistant-message backfill-intro">你好，想聊什么？也可以把资料和要求一起发来，我来帮你补记。</p> : null}{chat.map((m, i) => <div className={`ai-message-row backfill-chat-message is-${m.role}`} aria-label={m.role === "user" ? "我" : "AI管家"} key={i}><p className={`backfill-chat-copy ${m.role === "user" ? "ai-user-message" : "ai-assistant-message"}`}>{m.text}</p></div>)}</div>
      {batch ? <section className="backfill-plan-preview" aria-label="当前拟写方案"><strong>{batch.status==="undone" ? "已撤销的内容" : "拟写内容"}</strong>
        {batch.plan.entries.map(e => { const state=backfillItemState(batch,e.key); return <article className={"backfill-confirm-card is-"+state} data-confirm-key={e.key} data-confirm-state={state} key={e.key}><div className="backfill-card-heading"><DraftDateTime entry={e} generatedAt={batch.createdAt} editable={draft&&state!=="committed"&&!disabled} onChange={patch=>changeEntry(e.key,patch)} /></div>{state==="deferred" ? <details><summary>查看暂存内容</summary><p className="backfill-preview-copy">{e.content}</p><div className="backfill-preview-photos">{e.assetIds.map(id=><img key={id} src={"/api/assets/"+encodeURIComponent(id)+"/thumbnail?w=400"} alt="拟写照片" />)}</div></details> : <><p className="backfill-preview-copy">{e.content}</p><div className="backfill-preview-photos">{e.assetIds.map(id=><img key={id} src={"/api/assets/"+encodeURIComponent(id)+"/thumbnail?w=400"} alt="拟写照片" />)}</div></>}{e.questions ? <p className="backfill-warning">{e.questions}</p> : null}{actionButtons(e.key,backfillEntryReady(e)&&e.entityKeys.every(key=>batch.plan.objects.some(o=>o.key===key&&o.selected&&!o.questions.trim())))}</article>; })}
        {(batch.plan.actions??[]).map(a=><article className={"backfill-confirm-card is-"+backfillItemState(batch,a.key)} data-confirm-key={a.key} data-confirm-state={backfillItemState(batch,a.key)} key={a.key}><div className="backfill-card-heading"><strong>{a.date||"日期未定"}</strong><span>{a.type==="cycle" ? "周期标记" : "习惯标记"}</span></div><p className="backfill-preview-copy">{a.marked ? "标记" : "移除"}{a.type==="cycle" ? ({period_start:"经期开始",period_end:"经期结束",intimacy:"亲密",fitness:"运动"}[a.cycleKind!]) : a.name}</p>{a.questions ? <p className="backfill-warning">{a.questions}</p> : null}{actionButtons(a.key,a.selected&&!a.questions.trim()&&Boolean(a.date))}</article>)}
        {batch.plan.objects.filter(o=>o.selected).map(o=><p className="backfill-preview-copy" key={o.key}>{TYPE_LABEL[o.type]}：{o.name}{o.type==="movie"&&o.movie?.watched ? "（已看）" : ""}</p>)}
        {draft&&(pendingItems.length+orphanObjects.length)>1 ? <div className="backfill-operation-group backfill-item-actions"><button className="primary-button" type="button" disabled={disabled||pendingItems.some(item=>"content" in item ? !backfillEntryReady(item) : !item.date||Boolean(item.questions.trim()))||batch.plan.objects.some(o=>o.selected&&!batch.committedObjectKeys?.includes(o.key)&&Boolean(o.questions.trim()))} onClick={()=>void confirm()}>确认全部（{pendingItems.length+orphanObjects.length}条）</button></div> : null}
        {draft&&pendingItems.length===0&&orphanObjects.length===1 ? <div className="backfill-operation-group backfill-item-actions"><button className="primary-button" type="button" disabled={disabled||Boolean(orphanObjects[0]?.questions.trim())} onClick={()=>void confirm()}>确认记录</button></div> : null}
      </section> : null}
      {batch ? <details className="backfill-review" open={reviewOpen} onToggle={(e) => setReviewOpen(e.currentTarget.open)}><summary>查看和手动编辑拟写内容</summary>
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
      {Boolean(batch?.recordIds?.length) && batch?.status !== "undone" ? <div className="backfill-operation-group backfill-result-actions"><button className="secondary-button" type="button" disabled={disabled} onClick={onViewRecords}>查看辅记</button></div> : null}
    </div>
    <div className={"backfill-workspace-footer "+(draggingFiles ? "is-dragging" : "")} {...photoHandlers}>
      {error ? <p className="backfill-warning" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      {busy ? <p role="status"><LoaderCircle size={14} className="spin" />{busy}…</p> : null}
      {!configured ? <p className="backfill-mode">当前使用本地模式，配置 AI 后可理解更完整的要求。</p> : null}
      <form className="ai-assistant-composer backfill-chat-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea ref={composerRef} aria-label="发给AI管家的消息" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled && photoState === null) void send(); } }} rows={1} placeholder="发消息，把要求和照片一起告诉我…" disabled={disabled} />
        <div className="backfill-input-actions">
          <ShotDropZone ref={shotRef} scopeKey={"assistant:"+scope} numbered addOutsideStrip disabled={disabled} shots={shots} onShotsChange={setShots} onUpload={photoInput.onUploadShot} onNotify={photoInput.onNotify} onCleared={photoInput.onShotsCleared} onSubmissionState={(_scope,state)=>setPhotoState(state)} />
          <div className="backfill-operation-group">
            <button className="primary-button ai-send-button" type="submit" disabled={disabled || photoState !== null || (!input.trim() && !shots.length)}>发送</button>
          </div>
        </div>
      </form>
    </div>
  </div>;
}
