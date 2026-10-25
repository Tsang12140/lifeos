import { useEffect, useRef, useState } from "react";
import { Download, Upload, X, LoaderCircle, LockKeyhole } from "lucide-react";
import { apiRequest, apiUploadRequest } from "./api";
import "./archive-transfer.css";

type Counts = { records: number; deletedRecords: number; entities: number; assets: number; trashedAssets: number; summaries: number; cycleEvents: number };
type Estimate = { counts: Counts; selection: Selection; complete: boolean; originalBytes: number; cloudReadBytes: number; estimatedBytes: number; requiresAccountPassword: boolean; maxBytes: number };
type Category = "journal" | "task" | "event" | "note" | "entity" | "summary" | "cycle" | "asset";
type Selection = { categories: Category[]; from?: string; to?: string };
type TableSummary = { add: number; skip: number; conflict: number };
type MergeSummary = { complete: boolean; selection: Selection; tables: Record<string, TableSummary>; files: { write: number; reuse: number }; strippedReferences: number; conflicts: { table: string; key: string; label: string; reason: string }[]; conflictTotal: number };
type Job = { id: string; phase: "working" | "ready" | "failed"; kind: "export" | "upload" | "import"; bytes?: number; error?: string; counts?: Counts; targetCounts?: Counts; exportedAt?: string; expiresAt: string; version?: 1 | 2; selection?: Selection; replaceAllowed?: boolean; merge?: MergeSummary };
type Batch = { id: string; committedAt: string; exportedAt: string; selection: Selection; added: Record<string, number> };
export function archiveBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(2)} GB`; }
function countText(counts: Counts): string { return `${counts.records} 条记录（含 ${counts.deletedRecords} 条已删除）　${counts.entities} 个人物地点　${counts.assets} 个原件　${counts.trashedAssets} 个回收站原件　${counts.summaries} 条小结　${counts.cycleEvents} 条周期记录`; }

const CATEGORIES: readonly { id: Category; label: string }[] = [
  { id: "journal", label: "日记" }, { id: "task", label: "待办" }, { id: "event", label: "事件" }, { id: "note", label: "笔记" },
  { id: "entity", label: "人物与地点" }, { id: "summary", label: "手写小结" }, { id: "cycle", label: "周期记录" }, { id: "asset", label: "全部照片原件" },
];
const ALL_CATEGORIES = CATEGORIES.map(item => item.id);
const TABLE_LABELS: Record<string, string> = {
  records: "记录", entities: "人物与地点", assets: "照片原件", asset_trash: "回收站原件", day_summaries: "手写小结",
  cycle_intimacy_module: "周期设置", cycle_intimacy_events: "周期记录", note_folders: "笔记文件夹", note_versions: "笔记版本",
  weather_device_locations: "天气位置", weather_day_cache: "天气缓存", weather_observation: "天气观测",
};
const BATCH_FIELDS: readonly [string, string][] = [["records", "条记录"], ["entities", "个人物地点"], ["assets", "个原件"], ["summaries", "条小结"], ["cycleEvents", "条周期记录"], ["folders", "个文件夹"]];
function batchText(added: Record<string, number>): string {
  const parts = BATCH_FIELDS.filter(([key]) => (added[key] ?? 0) > 0).map(([key, unit]) => `${added[key]} ${unit}`);
  return parts.length ? parts.join("　") : "没有新增内容";
}
function selectionQuery(selection: Selection): string {
  const params = new URLSearchParams({ categories: selection.categories.join(",") });
  if (selection.from) params.set("from", selection.from);
  if (selection.to) params.set("to", selection.to);
  return params.toString();
}

export function ArchiveTransferCard() {
  const [mode, setMode] = useState<"export" | "import" | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [selection, setSelection] = useState<Category[]>([...ALL_CATEGORIES]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [undoArmed, setUndoArmed] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const jobRef = useRef<Job | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const processVersion = useRef<number | null>(null);
  const committing = useRef(false);
  const fileDragDepth = useRef(0);
  const [fileDragActive, setFileDragActive] = useState(false);
  jobRef.current = job;

  function updateBusy(next: boolean) { busyRef.current = next; setBusy(next); }
  function clearFileDrag() { fileDragDepth.current = 0; setFileDragActive(false); }
  function discardJob() {
    const current = jobRef.current;
    jobRef.current = null; setJob(null);
    if (current) void apiRequest(`/api/archive/jobs/${current.id}`, { method: "DELETE" }).catch(() => {});
  }
  function receiveFiles(files: readonly File[]) {
    if (!files.length) return;
    if (busyRef.current) return;
    if (files.length !== 1) { setError("一次只能选择一个完整加密包，现有选择未更改。"); return; }
    const next = files[0]!;
    if (!/\.lifeos$/i.test(next.name)) { setError("请选择 .lifeos 完整加密包，现有选择未更改。"); return; }
    if (next.size > 20 * 1024 ** 3) { setError("完整加密包不能超过 20 GB，现有选择未更改。"); return; }
    generation.current++;
    abort.current?.abort();
    discardJob();
    setFile(next); setPassword(""); setConfirmation(""); setReplaceConfirmed(false); setUploadProgress(null); setError(null); setShowConflicts(false);
    clearFileDrag();
  }
  function clipboardFiles(clipboard: DataTransfer): File[] {
    const files = Array.from(clipboard.files);
    if (files.length) return files;
    return Array.from(clipboard.items).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => file !== null);
  }
  async function loadBatch() {
    try {
      const result = await apiRequest<{ items: Batch[] }>("/api/archive/batches");
      setBatch(result.items[0] ?? null); setUndoArmed(false);
    } catch { setBatch(null); }
  }

  useEffect(() => { void loadBatch(); }, []);
  useEffect(() => () => { generation.current++; abort.current?.abort(); const current = jobRef.current; if (current) void apiRequest(`/api/archive/jobs/${current.id}`, { method: "DELETE" }).catch(() => {}); }, []);
  useEffect(() => { const element = dialog.current; if (mode && element && !element.open) element.showModal(); if (!mode && element?.open) element.close(); }, [mode]);
  // The estimate follows the checkbox tick: it is the only place that knows how big the selection is.
  useEffect(() => {
    if (mode !== "export") return;
    const version = ++generation.current;
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    const timer = setTimeout(() => {
      updateBusy(true); setError(null);
      void apiRequest<Estimate>(`/api/archive/estimate?${selectionQuery({ categories: selection, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`, { signal: controller.signal })
        .then(next => { if (generation.current === version) setEstimate(next); })
        .catch(next => { if (generation.current === version && !controller.signal.aborted) setError(next instanceof Error ? next.message : "无法读取完整包大小"); })
        .finally(() => { if (generation.current === version) updateBusy(false); });
    }, 260);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, selection.join(","), from, to]);

  async function close() {
    if (busyRef.current && jobRef.current?.kind === "import" && jobRef.current.phase === "ready") return;
    generation.current++; abort.current?.abort();
    processVersion.current = null; committing.current = false;
    discardJob();
    setMode(null); updateBusy(false); setPassword(""); setConfirmation(""); setFile(null); setError(null); setEstimate(null); setReplaceConfirmed(false); setUploadProgress(null); setShowConflicts(false); clearFileDrag();
    if (fileInput.current) fileInput.current.value = "";
  }
  async function open(mode: "export" | "import") {
    setMode(mode); setError(null); setMessage(null); discardJob(); setPassword(""); setConfirmation(""); setReplaceConfirmed(false); setFile(null); setUploadProgress(null); setShowConflicts(false); clearFileDrag();
    if (fileInput.current) fileInput.current.value = "";
    if (mode === "export") { setEstimate(null); setSelection([...ALL_CATEGORIES]); setFrom(""); setTo(""); }
  }
  function toggleCategory(id: Category) {
    setSelection(current => current.includes(id) ? current.filter(item => item !== id) : [...ALL_CATEGORIES].filter(item => item === id || current.includes(item)));
  }
  async function poll(initial: Job, version: number, signal: AbortSignal): Promise<void> {
    let next = initial; jobRef.current = next; setJob(next);
    while (next.phase === "working") {
      await new Promise<void>((resolve) => setTimeout(resolve, 800)); signal.throwIfAborted();
      next = await apiRequest<Job>(`/api/archive/jobs/${next.id}`, { signal });
      if (version !== generation.current) return;
      jobRef.current = next; setJob(next);
    }
    if (next.phase === "failed") throw new Error(next.error ?? "完整包处理失败");
  }
  async function process() {
    if (busyRef.current || processVersion.current !== null) return;
    const version = ++generation.current; const controller = new AbortController(); abort.current = controller;
    processVersion.current = version;
    updateBusy(true); setError(null); setUploadProgress(null);
    try {
      let next: Job;
      if (jobRef.current) { await apiRequest(`/api/archive/jobs/${jobRef.current.id}`, { method: "DELETE" }); jobRef.current = null; setJob(null); }
      if (mode === "export") next = await apiRequest<Job>("/api/archive/export", { method: "POST", body: JSON.stringify({ password, selection: { categories: selection, ...(from ? { from } : {}), ...(to ? { to } : {}) } }), signal: controller.signal });
      else {
        if (!file) throw new Error("请选择完整加密包");
        next = await apiUploadRequest<Job>("/api/archive/uploads", file, { contentType: "application/octet-stream", signal: controller.signal, onProgress: (progress) => { if (version === generation.current) setUploadProgress(`${archiveBytes(progress.loaded)} / ${archiveBytes(file.size)}`); } });
        jobRef.current = next;
        if (version !== generation.current) { void apiRequest(`/api/archive/jobs/${next.id}`, { method: "DELETE" }).catch(() => {}); return; }
        next = await apiRequest<Job>("/api/archive/import", { method: "POST", body: JSON.stringify({ id: next.id, password }), signal: controller.signal });
      }
      setPassword(""); setConfirmation("");
      if (version !== generation.current) { void apiRequest(`/api/archive/jobs/${next.id}`, { method: "DELETE" }).catch(() => {}); return; }
      await poll(next, version, controller.signal);
    } catch (error) { if (generation.current === version) setError(error instanceof Error ? error.message : "完整包处理失败"); }
    finally { if (processVersion.current === version) processVersion.current = null; if (generation.current === version) { updateBusy(false); setPassword(""); setConfirmation(""); } }
  }
  async function commit(importMode: "merge" | "replace") {
    if (!job || busyRef.current || committing.current) return;
    if (importMode === "replace" && !replaceConfirmed) return;
    committing.current = true;
    updateBusy(true); setError(null);
    try {
      const result = await apiRequest<{ backup: string; batchId?: string; merge?: MergeSummary }>("/api/archive/commit", { method: "POST", body: JSON.stringify({ id: job.id, mode: importMode, ...(importMode === "replace" ? { replaceConfirmed: true } : {}) }) });
      jobRef.current = null; setJob(null); setFile(null);
      setMessage(importMode === "merge" && result.merge ? `已增量导入：${batchText({ records: result.merge.tables.records?.add ?? 0, entities: result.merge.tables.entities?.add ?? 0, assets: result.merge.files.write, summaries: result.merge.tables.day_summaries?.add ?? 0, cycleEvents: result.merge.tables.cycle_intimacy_events?.add ?? 0, folders: result.merge.tables.note_folders?.add ?? 0 })}。现有内容没有被修改或删除。` : "完整包已整体替换。当前数据已自动备份，刷新页面查看替换后的内容。")
      setMode(null);
      await loadBatch();
      window.dispatchEvent(new Event("lifeos:archive-imported"));
    } catch (error) { setError(error instanceof Error ? error.message : "导入失败"); }
    finally { committing.current = false; updateBusy(false); }
  }
  async function undoBatch() {
    if (!batch || busyRef.current) return;
    if (!undoArmed) { setUndoArmed(true); return; }
    updateBusy(true); setError(null);
    try {
      await apiRequest(`/api/archive/batches/${batch.id}`, { method: "DELETE" });
      setMessage("这次增量导入的内容已整批撤销，原件也一并清理。");
      await loadBatch();
      window.dispatchEvent(new Event("lifeos:archive-imported"));
    } catch (next) { setError(next instanceof Error ? next.message : "无法撤销这次导入"); setUndoArmed(false); }
    finally { updateBusy(false); }
  }
  const ready = job?.phase === "ready" && job.kind === mode;
  const merge = ready && mode === "import" ? job?.merge : undefined;
  const replaceAllowed = ready && mode === "import" ? (job?.version === 1 || job?.replaceAllowed === true) : false;
  const canReplaceWhole = replaceAllowed && job?.version === 2;
  const selectionComplete = selection.length === ALL_CATEGORIES.length && !from && !to;
  const canProcess = password.length >= 10 && password.length <= 1024 && (mode === "import" ? !!file && file.size <= 20 * 1024 ** 3 : !!estimate && selection.length > 0 && (estimate.requiresAccountPassword || password === confirmation));
  const conflictNote = merge ? merge.conflictTotal > 0 : false;
  return <>
    <section className="settings-card archive-transfer-card" data-archive-card>
      <div className="settings-card-icon"><LockKeyhole size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong>完整加密包</strong><small>只导出你勾选的内容；导入时只增不改，冲突会列出来让你自己判断。</small></div>
      <div className="archive-actions"><button className="primary-button" type="button" data-archive-open="export" onClick={() => void open("export")}><Download size={15} aria-hidden="true" /><span>下载完整加密包</span></button><button className="secondary-button" type="button" data-archive-open="import" onClick={() => void open("import")}><Upload size={15} aria-hidden="true" /><span>导入完整加密包</span></button></div>
      {batch ? <p className="archive-batch" data-archive-batch><span className="archive-batch-copy">上次增量导入：{new Date(batch.committedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}，新增 {batchText(batch.added)}</span><button className="danger-button" type="button" data-archive-undo disabled={busy} onClick={() => void undoBatch()}>{undoArmed ? "确认撤销这次导入" : "撤销整批导入"}</button></p> : null}
      {message ? <p className="archive-message" role="status"><span className="archive-message-copy">{message}</span><button className="secondary-button" type="button" onClick={() => window.location.reload()}>刷新页面</button></p> : null}
      {error && !mode ? <p className="dialog-error" role="alert" data-archive-error>{error}</p> : null}
    </section>
    <dialog ref={dialog} className="modal-dialog archive-dialog" data-archive-dialog aria-labelledby="archive-title" onCancel={(event) => { event.preventDefault(); void close(); }} onPasteCapture={(event) => { if (mode !== "import" || ready) return; const files = clipboardFiles(event.clipboardData); if (!files.length) return; event.preventDefault(); event.stopPropagation(); if (!busyRef.current) receiveFiles(files); }}>
      <div className="dialog-header"><h2 id="archive-title">{mode === "export" ? "下载完整加密包" : "导入完整加密包"}</h2><button className="icon-button compact-icon-button" type="button" aria-label="关闭完整包窗口" disabled={busy && ready} onClick={() => void close()}><X size={17} aria-hidden="true" /></button></div>
      <div className="archive-dialog-body">
        <p>完整包仅包含当前空间，不包含账号登录会话或服务密钥。导入不会覆盖或删除现有内容；密码改动后，旧下载包仍需当时的密码。</p>
        {mode === "export" ? <div className="archive-selection" data-archive-selection>
          <div className="archive-selection-head"><span>导出范围</span><div className="archive-selection-tools"><button className="archive-link-button" type="button" disabled={busy} onClick={() => setSelection([...ALL_CATEGORIES])}>全选</button><button className="archive-link-button" type="button" disabled={busy || !selection.length} onClick={() => setSelection([])}>清空</button></div></div>
          <div className="archive-categories" role="group" aria-label="导出范围">
            {CATEGORIES.map(item => <label className="archive-category" key={item.id} data-archive-category={item.id}><input type="checkbox" checked={selection.includes(item.id)} disabled={busy} onChange={() => toggleCategory(item.id)} /><span>{item.label}</span></label>)}
          </div>
          <div className="archive-range">
            <label className="archive-field"><span>开始日期（可留空）</span><input data-archive-from type="date" value={from} disabled={busy} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className="archive-field"><span>结束日期（可留空）</span><input data-archive-to type="date" value={to} disabled={busy} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <small className="archive-hint">勾选的记录会自动带上它们引用的照片原件；只勾选部分内容时，导入端只能增量导入。</small>
        </div> : null}
        {mode === "export" && estimate ? <div className="archive-size" data-archive-estimate><strong>预计约 {archiveBytes(estimate.estimatedBytes)}</strong><span>{selectionComplete ? "全部分类，可整体替换到另一个空间" : "部分内容，只用于增量导入"}</span><span>{countText(estimate.counts)}</span><span>生成后直接下载，不新增对象存储副本。</span>{estimate.cloudReadBytes ? <span>需从对象存储读取 {archiveBytes(estimate.cloudReadBytes)} 原件，会计入下载流量。</span> : null}<span>生成期间临时使用服务器磁盘，15 分钟后自动清理。</span></div> : null}
        {mode === "import" && !ready ? <div className="archive-field" data-archive-file-field>
          <span>选择完整加密包</span>
          <button className={`archive-file-drop${fileDragActive ? " is-dragging" : ""}${file ? " has-file" : ""}`} data-archive-file-drop type="button" disabled={busy} aria-describedby="archive-file-help" onClick={() => fileInput.current?.click()}
            onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.stopPropagation(); fileDragDepth.current++; if (!busyRef.current) setFileDragActive(true); }}
            onDragOver={(event) => { const types = Array.from(event.dataTransfer.types); if (!types.includes("Files") && !types.includes("text/uri-list")) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = types.includes("Files") && !busyRef.current ? "copy" : "none"; }}
            onDragLeave={(event) => { event.stopPropagation(); fileDragDepth.current = Math.max(0, fileDragDepth.current - 1); if (!fileDragDepth.current) setFileDragActive(false); }}
            onDrop={(event) => { const types = Array.from(event.dataTransfer.types); const files = Array.from(event.dataTransfer.files); if (!files.length && !types.includes("text/uri-list")) return; event.preventDefault(); event.stopPropagation(); clearFileDrag(); if (busyRef.current) return; if (!files.length) { setError("请拖入实际的 .lifeos 文件，不接受网页链接。"); return; } receiveFiles(files); }}>
            <span className="archive-file-drop-icon"><Upload size={19} aria-hidden="true" /></span>
            <span className="archive-file-drop-copy"><strong>{file ? "已选择完整加密包" : "点击选择，或拖入一个 .lifeos 文件"}</strong><small id="archive-file-help">也可粘贴剪贴板中的实际文件</small></span>
            {file ? <span className="archive-file-selection"><span className="archive-file-name" title={file.name}>{file.name}</span><small>{archiveBytes(file.size)}</small></span> : null}
          </button>
          <input ref={fileInput} className="visually-hidden" data-archive-file type="file" accept=".lifeos" aria-label="选择完整加密包文件" tabIndex={-1} disabled={busy} onChange={(event) => { receiveFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
        </div> : null}
        {!ready ? <><label className="archive-field"><span>{mode === "export" ? estimate?.requiresAccountPassword ? "当前账号密码" : "设置加密包密码（至少10个字符）" : "生成这份包时的密码"}</span><input data-archive-password type="password" autoComplete={mode === "export" && !estimate?.requiresAccountPassword ? "new-password" : "current-password"} value={password} disabled={busy} maxLength={1024} onChange={(event) => setPassword(event.target.value)} /></label>{mode === "export" && estimate && !estimate.requiresAccountPassword ? <label className="archive-field"><span>再输入一次包密码</span><input data-archive-password-confirm type="password" autoComplete="new-password" value={confirmation} disabled={busy} maxLength={1024} onChange={(event) => setConfirmation(event.target.value)} /></label> : null}</> : null}
        {busy ? <p className="archive-working" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{estimate === null && mode === "export" && !job ? "读取内容与大小…" : mode === "export" ? "生成完整加密包…" : ready ? "备份当前数据并导入…" : uploadProgress ? `上传 ${uploadProgress}，随后解密校验…` : "解密并校验完整包…"}</p> : null}
        {ready && job ? <div className="archive-size" data-archive-ready><strong>{mode === "export" ? "实际文件大小" : "文件大小"} {archiveBytes(job.bytes ?? 0)}</strong>{job.counts ? <span>{countText(job.counts)}</span> : null}{mode === "export" ? <span>文件已加密，15 分钟内可下载。请妥善保管包密码。</span> : <><span>已通过解密和原件校验。</span>{job.targetCounts ? <span>当前空间：{countText(job.targetCounts)}</span> : null}{replaceAllowed ? <label className="archive-replace"><input data-archive-replace type="checkbox" checked={replaceConfirmed} disabled={busy} onChange={(event) => setReplaceConfirmed(event.target.checked)} /><span>{canReplaceWhole ? "我确认可以整体替换：先备份当前数据库，再用这份包替换全部内容。不勾选时只做增量导入。" : "我确认用这份完整包替换当前空间。替换前自动备份当前数据库，原有照片文件保留。"}</span></label> : null}</>}</div> : null}
        {merge ? <div className="archive-merge" data-archive-merge>
          <div className="archive-merge-head"><strong>增量导入预览</strong><span className={conflictNote ? "archive-merge-flag" : "archive-merge-flag is-quiet"}>{conflictNote ? `${merge.conflictTotal} 处冲突会被跳过` : "没有冲突"}</span></div>
          <ul className="archive-merge-counts">
            {Object.entries(merge.tables).filter(([, value]) => value.add > 0 || value.skip > 0 || value.conflict > 0).map(([name, value]) => <li key={name}><span>{TABLE_LABELS[name] ?? name}</span><span className="archive-merge-numbers">新增 {value.add}　已有 {value.skip}{value.conflict ? `　冲突 ${value.conflict}` : ""}</span></li>)}
          </ul>
          <span className="archive-hint">照片：写入 {merge.files.write} 个，按内容复用 {merge.files.reuse} 个{merge.strippedReferences ? `；${merge.strippedReferences} 处指向包外的引用会被移除` : ""}。</span>
          {merge.conflictTotal ? <div className="archive-conflicts"><button className="archive-link-button" type="button" onClick={() => setShowConflicts(value => !value)}>{showConflicts ? "收起冲突清单" : `查看冲突清单（${merge.conflictTotal}）`}</button>{showConflicts ? <ul data-archive-conflicts>{merge.conflicts.map(item => <li key={`${item.table}-${item.key}`}><strong>{item.label}</strong><span>{item.reason}</span></li>)}{merge.conflictTotal > merge.conflicts.length ? <li><span>还有 {merge.conflictTotal - merge.conflicts.length} 条冲突未列出。</span></li> : null}</ul> : null}</div> : null}
        </div> : null}
        {error ? <p className="dialog-error" role="alert" data-archive-error>{error}</p> : null}
      </div>
      <div className="dialog-footer archive-actions"><button className="secondary-button" type="button" disabled={busy && ready} onClick={() => void close()}>{busy ? "取消处理" : "关闭"}</button>{ready && job ? mode === "export" ? <a className="primary-button" data-archive-download href={`/api/archive/jobs/${job.id}/download`} download>下载到电脑（{archiveBytes(job.bytes ?? 0)}）</a> : canReplaceWhole ? <><button className="danger-button" data-archive-replace-commit type="button" disabled={busy || !replaceConfirmed} onClick={() => void commit("replace")}>确认整体替换</button><button className="primary-button" data-archive-commit type="button" disabled={busy} onClick={() => void commit("merge")}>增量导入</button></> : <button className="primary-button" data-archive-commit type="button" disabled={busy || (job.version === 1 && !replaceConfirmed)} onClick={() => void commit(job.version === 1 ? "replace" : "merge")}>{job.version === 1 ? "确认替换并导入" : "增量导入"}</button> : <button className="primary-button" data-archive-process type="button" disabled={busy || !canProcess} onClick={() => void process()}>{mode === "export" ? "生成加密包" : "上传并校验"}</button>}</div>
    </dialog>
  </>;
}
