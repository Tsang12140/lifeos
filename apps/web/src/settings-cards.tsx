import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  CloudSun,
  CloudUpload,
  Download,
  Eraser,
  FileJson,
  FileText,
  FolderOpen,
  HardDrive,
  Heart,
  History,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  PlugZap,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import {
  SUMMARY_MAX_LENGTH,
  SUMMARY_SYSTEM_PROMPT,
  clampSummaryText,
  type Asset,
  type CycleIntimacyModuleConfig,
  type CycleIntimacyModuleData,
  type Entity,
} from "@lifeos/core";
import {
  apiRequest,
  type AiStatus,
  type AiStatusState,
  type BackupRetentionPolicy,
  type BackupRetentionView,
  type BackupStatus,
  type MovieModuleStatus,
  type WeatherProfilesResponse,
  type WeatherProfilesState,
  type WeatherStatus,
} from "./api";
import { BackupCalendar } from "./BackupCalendar";
import { TimeMachine } from "./TimeMachine";
import { WeatherLocationPicker } from "./WeatherLocationPicker";
import { WeatherSky } from "./WeatherBackground";
import { getWeatherEmoji, type WeatherCategory, type WeatherPhase } from "./weather";
import { describeWeatherLocationByName, weatherLocationDisplayName } from "./weather-locations";
import { MovieSettingsCard } from "./movie";
import type { MovieModuleStatusState } from "./movie";
import {
  DEMO_HIDDEN_STORAGE_KEY,
  DEMO_ID_PREFIX,
  SETTINGS_PAGE_GROUPS,
  UI_FONT_OPTIONS,
  UI_FONT_STORAGE_KEY,
  errorMessage,
  errorStatus,
  formatBytes,
  isDemoRecord,
  isUiFontId,
  readUiFont,
} from "./app-meta";
import type { SettingsPageId, UiFontId } from "./app-types";
import { DateField } from "./date-field";
import { assetThumbUrl } from "./timeline";
import { USER_TIME_ZONE, localDateToday, localNowInput } from "./time";

export const AI_DEFAULT_BASE_URL = "https://api.deepseek.com";
type AiPresetId = AiStatus["preset"];
type AiReasoningEffort = Exclude<AiStatus["reasoningEffort"], null>;
const AI_PRESETS: readonly { readonly id: Exclude<AiPresetId, "custom">; readonly label: string; readonly detail: string; readonly model: string; readonly thinking: boolean; readonly reasoningEffort: AiReasoningEffort | null }[] = [
  { id: "quick", label: "日常问答", detail: "快速回答 · 关闭思考", model: "deepseek-flash", thinking: false, reasoningEffort: null },
  { id: "reflect", label: "深度复盘", detail: "开启思考 · high", model: "deepseek-flash", thinking: true, reasoningEffort: "high" },
  { id: "review", label: "重要复盘", detail: "开启思考 · high", model: "deepseek-v4-pro", thinking: true, reasoningEffort: "high" },
];

function aiPresetFor(model: string, thinking: boolean, reasoningEffort: AiStatus["reasoningEffort"], baseUrl: string): AiPresetId {
  if (baseUrl.trim().replace(/\/$/, "") !== AI_DEFAULT_BASE_URL) return "custom";
  if (!thinking && reasoningEffort === null && model === "deepseek-flash") return "quick";
  if (thinking && reasoningEffort === "high" && model === "deepseek-flash") return "reflect";
  if (thinking && reasoningEffort === "high" && model === "deepseek-v4-pro") return "review";
  return "custom";
}

function aiPresetLabel(id: AiPresetId): string {
  return id === "quick" ? "日常问答" : id === "reflect" ? "深度复盘" : id === "review" ? "重要复盘" : "自定义";
}

export function AiSettingsCard({ statusState, open = false, assistantVisible, onAssistantVisibleChange, onChanged, onRetry }: { readonly statusState: AiStatusState; readonly open?: boolean; readonly assistantVisible: boolean; readonly onAssistantVisibleChange: (visible: boolean) => void; readonly onChanged: (status: AiStatus) => void; readonly onRetry: () => void }) {
  const status = statusState.status;
  const statusReady = statusState.phase === "ready" && status !== null;
  const [expanded, setExpanded] = useState(open);
  const [enabled, setEnabled] = useState(status?.enabled ?? true);
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl || AI_DEFAULT_BASE_URL);
  const [model, setModel] = useState(status?.model || "deepseek-flash");
  const [thinking, setThinking] = useState(status?.thinking ?? false);
  const [reasoningEffort, setReasoningEffort] = useState<AiStatus["reasoningEffort"]>(status?.reasoningEffort ?? null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setExpanded(true); }, [open]);
  useEffect(() => { if (open) window.dispatchEvent(new Event("lifeos:close-ai")); }, [open]);
  useEffect(() => {
    if (status === null) return;
    setEnabled(status.enabled); setBaseUrl(status.baseUrl || AI_DEFAULT_BASE_URL); setModel(status.model || "deepseek-flash"); setThinking(status.thinking); setReasoningEffort(status.reasoningEffort);
  }, [status?.enabled, status?.baseUrl, status?.model, status?.thinking, status?.reasoningEffort]);
  const currentPreset = aiPresetFor(model, thinking, reasoningEffort, baseUrl);
  const call = async (path: string, body: Record<string, unknown>) => apiRequest<AiStatus & { readonly ok?: boolean; readonly message?: string }>(path, { method: "POST", body: JSON.stringify(body) });
  const applyPreset = (preset: (typeof AI_PRESETS)[number]) => { if (!statusReady) return; setModel(preset.model); setThinking(preset.thinking); setReasoningEffort(preset.reasoningEffort); setMessage(null); setError(null); };
  const save = async () => {
    if (!statusReady || busy) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const next = await call("/api/ai/config", { enabled, baseUrl, model, thinking, reasoningEffort: thinking ? reasoningEffort ?? "high" : null, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      const nextStatus: AiStatus = { preset: next.preset, enabled: next.enabled, configured: next.configured, keyConfigured: next.keyConfigured, keyUnreadable: next.keyUnreadable, provider: next.provider, model: next.model, baseUrl: next.baseUrl, thinking: next.thinking, reasoningEffort: next.reasoningEffort, keySource: next.keySource, summaryPrompt: next.summaryPrompt, summaryPromptCustom: next.summaryPromptCustom };
      setApiKey(""); onChanged(nextStatus); setMessage("AI 配置已保存");
    } catch (cause) { setError(errorMessage(cause, "AI 配置保存失败，请重试")); }
    finally { setBusy(false); }
  };
  const test = async () => {
    if (!statusReady || busy) return;
    setBusy(true); setMessage(null); setError(null);
    try { const result = await call("/api/ai/config/test", { baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }); setMessage(result.message ?? "AI 服务连接成功"); }
    catch (cause) { setError(errorMessage(cause, "AI 服务连接失败，请检查地址和 API Key")); }
    finally { setBusy(false); }
  };
  const keyConfigured = status?.keyConfigured === true;
  const confirmedLabel = status === null ? null : !status.enabled ? "已关闭" : keyConfigured ? "已启用" : status.keyUnreadable ? "密钥读不出来" : "规则回退";
  const stateLabel = statusState.phase === "ready" ? confirmedLabel : statusState.phase === "loading" ? status === null ? "正在读取状态…" : "正在刷新状态…" : status === null ? "状态暂时不可读取" : "状态读取失败";
  return <div className="settings-card settings-ai-card">
    <div className="settings-ai-head">
      <div className="settings-card-icon"><Bot size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong>DeepSeek AI</strong><small>API Key：{keyConfigured ? "已配置" : "未配置"}{status?.keyUnreadable ? "（文件里那把现在读不出来，重新填一次即可覆盖）" : ""} · provider：DeepSeek</small></div>
      <span className={`settings-status ${statusState.phase === "ready" && status?.enabled && keyConfigured ? "is-ready" : ""}`} data-ai-status-phase={statusState.phase}>{stateLabel}</span>
      <button className="secondary-button settings-action" type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? "收起配置" : "配置 AI"}</button>
    </div>
    <div className="settings-ai-effective" aria-label="当前生效的 AI 配置">
      <div className="settings-ai-effective-item" data-ai-effective="model"><span>当前模型</span><strong>{status?.model || "—"}</strong></div>
      <div className="settings-ai-effective-item" data-ai-effective="thinking"><span>思考</span><strong>{status?.thinking ? "开启" : "关闭"}</strong></div>
      <div className="settings-ai-effective-item" data-ai-effective="reasoning"><span>推理强度</span><strong>{status?.thinking && status.reasoningEffort !== null ? status.reasoningEffort : "— / 不启用"}</strong></div>
      <div className="settings-ai-effective-item is-wide" data-ai-effective="base-url"><span>服务地址</span><strong title={status?.baseUrl}>{status?.baseUrl || "—"}</strong></div>
      <div className="settings-ai-effective-item" data-ai-effective="key"><span>API Key</span><strong>{keyConfigured ? "已配置" : "未配置"}</strong></div>
    </div>
    {statusState.phase === "failed" ? <div className="settings-config-read-error" role="alert"><span>{statusState.error}</span>{status === null ? null : <small>上次确认：{confirmedLabel}</small>}<button className="secondary-button" type="button" onClick={onRetry}>重试读取</button></div> : null}
    {status === null ? <p className="settings-config-unavailable">状态确认后，才能调整 AI 服务配置或提交测试。</p> : null}
    <label className="settings-ai-visibility"><input type="checkbox" checked={assistantVisible} onChange={(event) => onAssistantVisibleChange(event.target.checked)} /><span><strong>显示 AI 助手</strong><small>只控制悬浮 AI 界面；不影响服务启用、API Key 或已保存对话。</small></span></label>
    <div className="settings-ai-presets" aria-label="AI 快捷档位">
      <div className="settings-ai-form-heading"><span>快捷档位</span><strong data-ai-current-preset={`preset-${currentPreset}`}>{aiPresetLabel(currentPreset)}</strong></div>
      <div className="settings-ai-preset-grid">{AI_PRESETS.map((preset) => <button className={`settings-ai-preset ${currentPreset === preset.id ? "is-selected" : ""}`} data-ai-preset={preset.id} aria-pressed={currentPreset === preset.id} type="button" key={preset.id} onClick={() => applyPreset(preset)} disabled={!statusReady}><strong>{preset.label}<em className="settings-ai-preset-id">{preset.id}</em></strong><small>{preset.detail}</small><em>{preset.model}</em></button>)}</div>
    </div>
    <details className="settings-ai-advanced" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><SlidersHorizontal size={15} aria-hidden="true" /><span>高级配置：模型、服务地址、推理与密钥</span><ChevronDown size={15} aria-hidden="true" /></summary>
      <div className="settings-ai-form">
      <div className="settings-ai-fields">
        <label><span>模型</span><input data-ai-field="model" value={model} disabled={!statusReady} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-flash" /></label>
        <label><span>思考开关</span><span className="settings-ai-toggle"><input data-ai-field="thinking" type="checkbox" checked={thinking} disabled={!statusReady} onChange={(event) => { const next = event.target.checked; setThinking(next); setReasoningEffort(next ? reasoningEffort ?? "high" : null); }} /><span>{thinking ? "开启" : "关闭"}</span></span></label>
        <label><span>推理强度</span><select data-ai-field="reasoning-effort" value={thinking ? reasoningEffort ?? "high" : ""} disabled={!statusReady || !thinking} onChange={(event) => setReasoningEffort(event.target.value === "low" || event.target.value === "high" || event.target.value === "max" ? event.target.value : null)}><option value="">— / 不启用</option><option value="low">low</option><option value="high">high</option><option value="max">max</option></select></label>
        <label><span>API Key</span><input data-ai-field="api-key" type="password" value={apiKey} disabled={!statusReady} onChange={(event) => setApiKey(event.target.value)} placeholder={keyConfigured ? "已保存，留空表示继续使用" : "填写 DeepSeek API Key"} autoComplete="new-password" /></label>
        <label className="is-wide"><span>服务地址</span><input data-ai-field="base-url" value={baseUrl} disabled={!statusReady} onChange={(event) => setBaseUrl(event.target.value)} placeholder={AI_DEFAULT_BASE_URL} /></label>
        <label className="settings-ai-enabled is-wide"><input data-ai-field="enabled" type="checkbox" checked={enabled} disabled={!statusReady} onChange={(event) => setEnabled(event.target.checked)} /><span>启用真实 AI；关闭后仍保留本地规则模式</span></label>
      </div>
      <div className="settings-ai-actions"><button className="secondary-button" type="button" onClick={() => void test()} disabled={!statusReady || busy}>{busy ? "处理中…" : "测试连接"}</button><button className="primary-button" type="button" onClick={() => void save()} disabled={!statusReady || busy || !baseUrl.trim() || !model.trim()}>{busy ? "保存中…" : "保存配置"}</button></div>{message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}<small className="settings-ai-note">API Key 只写入 API 服务端的加密配置文件，不进入浏览器本地存储或 SQLite 备份。</small>
      </div>
    </details>
  </div>;
}

/**
 * Everything a Bitiful cdnb bucket needs except the key pair. Kept in one place
 * so the form can offer a one-click fill instead of making the owner retype six
 * fields whose values are already fixed by the provider.
 */
const BITIFUL_PRESET = { endpoint: "https://s3.bitiful.net", region: "cn-east-1", bucket: "cdnb", prefix: "product-backup/lifeos", forcePathStyle: false } as const;

/** Shown until the server answers; mirrors apps/api's documented defaults. */
const DEFAULT_RETENTION_DRAFT: BackupRetentionPolicy = { dailyDays: 7, weeklyWeeks: 8, monthlyMonths: 12, trashDays: 30 };

const RETENTION_TIER_LABELS: Record<BackupRetentionView["entries"][number]["tier"], string> = {
  daily: "日备",
  weekly: "周备",
  monthly: "月备",
  newest: "最新",
  none: "将清理",
};

export function BackupSettingsCard({ backupStatus, backupBusy, onBackup, onChanged }: { readonly backupStatus: BackupStatus; readonly backupBusy: boolean; readonly onBackup: (action: "local" | "s3" | "test" | "dual") => void; readonly onChanged: (status: BackupStatus) => void }) {
  const s3 = backupStatus.s3;
  const localTransport = s3.transport === "file" || s3.endpoint.startsWith("file:");
  const [enabled, setEnabled] = useState(s3.enabled);
  const [endpoint, setEndpoint] = useState(s3.endpoint || "https://s3.bitiful.net");
  const [region, setRegion] = useState(s3.region || "cn-east-1");
  const [bucket, setBucket] = useState(s3.bucket || "cdnb");
  const [prefix, setPrefix] = useState(s3.prefix || "product-backup/lifeos");
  const [forcePathStyle, setForcePathStyle] = useState(s3.forcePathStyle);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(backupStatus.schedule.enabled);
  const [scheduleHour, setScheduleHour] = useState(backupStatus.schedule.hour);
  const [scheduleMinute, setScheduleMinute] = useState(backupStatus.schedule.minute);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsConfiguring = !s3.configured || localTransport;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [retention, setRetention] = useState<BackupRetentionView | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retentionDraft, setRetentionDraft] = useState<BackupRetentionPolicy>(DEFAULT_RETENTION_DRAFT);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionMessage, setRetentionMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<BackupRetentionView>("/api/backup/retention", { signal: controller.signal })
      .then((view) => {
        if (controller.signal.aborted) return;
        setRetention(view);
        setRetentionDraft(view.policy);
      })
      .catch(() => { /* the panel stays hidden while the endpoint is unavailable */ });
    return () => controller.abort();
  }, [backupStatus.runs]);
  const saveRetention = async () => {
    if (retentionSaving) return;
    setRetentionSaving(true);
    setRetentionMessage(null);
    try {
      const view = await apiRequest<BackupRetentionView>("/api/backup/retention", { method: "POST", body: JSON.stringify(retentionDraft) });
      setRetention(view);
      setRetentionDraft(view.policy);
      setRetentionMessage("保留策略已保存，下一次备份完成后按新策略清理");
    } catch (cause) {
      setRetentionMessage(errorMessage(cause, "保存保留策略失败"));
    } finally {
      setRetentionSaving(false);
    }
  };
  useEffect(() => {
    setEnabled(s3.enabled);
    setEndpoint(s3.endpoint || "https://s3.bitiful.net");
    setRegion(s3.region || "cn-east-1");
    setBucket(s3.bucket || "cdnb");
    setPrefix(s3.prefix || "product-backup/lifeos");
    setForcePathStyle(s3.forcePathStyle);
  }, [s3.enabled, s3.endpoint, s3.region, s3.bucket, s3.prefix, s3.forcePathStyle]);
  useEffect(() => {
    setScheduleEnabled(backupStatus.schedule.enabled);
    setScheduleHour(backupStatus.schedule.hour);
    setScheduleMinute(backupStatus.schedule.minute);
  }, [backupStatus.schedule.enabled, backupStatus.schedule.hour, backupStatus.schedule.minute]);
  const latestRun = (provider: "local" | "s3") => backupStatus.runs.find((run) => run.provider === provider && run.kind !== "test");
  const localRun = latestRun("local");
  const s3Run = latestRun("s3");
  const s3RunWroteLocally = s3Run?.location?.startsWith("file:") ?? false;
  const formatRun = (run: typeof localRun) => {
    if (!run) return "从未备份";
    if (run.status === "skipped") return `已跳过 · ${run.error ?? "未配置"}`;
    if (run.status === "failed") return `失败 · ${run.error ?? "未知错误"}`;
    return run.finishedAt ? new Date(run.finishedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "已完成";
  };
  const formatBytes = (size: number | undefined) => size === undefined ? "" : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  const formatWhen = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const formatTotal = (count: number, bytes: number) => count === 0 ? "0 份" : `${count} 份 · ${formatBytes(bytes)}`;
  const dual = backupStatus.lastDualBackup;
  const dualWroteLocally = dual?.s3.location?.startsWith("file:") ?? false;
  const dualLabel = dual === null ? "尚未执行" : dual.status === "success" ? dualWroteLocally ? "本地与「本机目录模拟」均已写入" : "本地与对象存储均成功" : dual.status === "local_only" ? "本地成功 · 远端已跳过" : dual.status === "partial" ? "本地成功 · 远端失败" : "本地失败 · 未上传远端";
  const s3BadgeLabel = localTransport ? (s3.configured && s3.enabled ? "本机目录模拟 · 未联网" : "仅本地备份") : s3.configured && s3.enabled ? "对象存储已启用" : "仅本地备份";
  const s3BadgeClass = localTransport ? "is-blocked" : s3.configured && s3.enabled ? "is-ready" : "";
  const applyPreset = () => {
    setEndpoint(BITIFUL_PRESET.endpoint);
    setRegion(BITIFUL_PRESET.region);
    setBucket(BITIFUL_PRESET.bucket);
    setPrefix(BITIFUL_PRESET.prefix);
    setForcePathStyle(BITIFUL_PRESET.forcePathStyle);
    setError(null);
    setMessage("已填入 Bitiful（cdnb）预设，只剩 Access Key 和 Secret Key 需要粘贴");
  };
  const save = async () => {
    if (saving) return;
    setSaving(true); setMessage(null); setError(null);
    try {
      await apiRequest("/api/backup/config", { method: "POST", body: JSON.stringify({ enabled, endpoint, region, bucket, prefix, forcePathStyle, ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim() } : {}), ...(secretAccessKey.trim() ? { secretAccessKey: secretAccessKey.trim() } : {}) }) });
      setAccessKeyId(""); setSecretAccessKey("");
      onChanged(await apiRequest<BackupStatus>("/api/backup/status"));
      setMessage("对象存储配置已保存");
    } catch (cause) {
      setError(errorMessage(cause, "保存对象存储配置失败，请检查字段"));
    } finally { setSaving(false); }
  };
  const saveSchedule = async () => {
    if (scheduleSaving) return;
    setScheduleSaving(true);
    setScheduleMessage(null);
    try {
      await apiRequest("/api/backup/schedule", { method: "POST", body: JSON.stringify({ enabled: scheduleEnabled, hour: scheduleHour, minute: scheduleMinute }) });
      onChanged(await apiRequest<BackupStatus>("/api/backup/status"));
      setScheduleMessage(scheduleEnabled ? `已设置每天 ${String(scheduleHour).padStart(2, "0")}:${String(scheduleMinute).padStart(2, "0")} 执行` : "定时双备份已停用");
    } catch (cause) {
      setScheduleMessage(errorMessage(cause, "保存定时备份失败"));
    } finally {
      setScheduleSaving(false);
    }
  };
  return <div className="settings-backup-card">
    <div className="settings-backup-overview"><div className="settings-backup-icon"><CloudUpload size={19} aria-hidden="true" /></div><div className="settings-card-copy"><strong>数据备份</strong></div><span className={`settings-status ${s3BadgeClass}`}>{s3BadgeLabel}</span></div>
    {localTransport ? <p className="settings-backup-warning" data-backup-local-transport>{s3.warning ?? "当前对象存储 Endpoint 是本机目录（file://），备份不会联网上传。"}</p> : null}
    <div className="settings-backup-stats"><div><small>最近本地结果</small><strong>{formatRun(localRun)}{localRun?.status === "success" && localRun.sizeBytes === undefined ? "" : localRun?.status === "success" && localRun.sizeBytes !== undefined ? ` · ${formatBytes(localRun.sizeBytes)}` : ""}</strong></div><div><small>最近对象存储结果</small><strong>{formatRun(s3Run)}{s3Run?.status === "success" && s3Run.sizeBytes !== undefined ? ` · ${formatBytes(s3Run.sizeBytes)}` : ""}{s3RunWroteLocally ? " · 本机目录" : ""}</strong></div><div><small>下次定时双备份</small><strong>{backupStatus.schedule.enabled && backupStatus.schedule.nextRunAt ? new Date(backupStatus.schedule.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "未启用"}</strong></div></div>
    <div className="settings-backup-dual" data-backup-dual-status><div><span>双备份结果</span><strong className={`is-${dual?.status ?? "empty"}`}>{dualLabel}</strong>{dual?.s3.status === "skipped" || dual?.s3.status === "failed" ? <small>{dual.s3.error ?? "远端没有成功"}</small> : null}</div><button className="primary-button" data-backup-action="dual" type="button" onClick={() => onBackup("dual")} disabled={backupBusy || saving}>{backupBusy ? "执行中…" : "立即双备份"}</button></div>
    <div className="settings-backup-actions"><button className="secondary-button" type="button" onClick={() => onBackup("local")} disabled={backupBusy || saving}><HardDrive size={15} aria-hidden="true" /><span>{backupBusy ? "备份中" : "备份到本地"}</span></button><button className="primary-button" type="button" onClick={() => onBackup("s3")} disabled={backupBusy || saving || !s3.configured || !s3.enabled}><CloudUpload size={15} aria-hidden="true" /><span>备份到对象存储</span></button><button className="icon-text-button" type="button" onClick={() => onBackup("test")} disabled={backupBusy || saving || !s3.configured || !s3.enabled}><PlugZap size={15} aria-hidden="true" /><span>测试连接</span></button></div>
    <details className="settings-backup-advanced" data-backup-schedule-details><summary><History size={15} aria-hidden="true" /><span>高级：定时双备份</span><ChevronDown size={15} aria-hidden="true" /></summary><div className="settings-backup-schedule" data-backup-schedule><div className="settings-backup-schedule-head"><div><span>定时双备份</span><small>服务端执行 · Asia/Shanghai</small></div><label className="settings-switch"><input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} /><span aria-hidden="true" /></label></div><div className="settings-backup-schedule-controls"><label><span>每天</span><select value={scheduleHour} onChange={(event) => setScheduleHour(Number(event.target.value))}>{Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{String(hour).padStart(2, "0")}</option>)}</select></label><b>:</b><label><span>时刻</span><select value={scheduleMinute} onChange={(event) => setScheduleMinute(Number(event.target.value))}>{[0, 15, 30, 45].map((minute) => <option value={minute} key={minute}>{String(minute).padStart(2, "0")}</option>)}</select></label><button className="secondary-button" type="button" onClick={() => void saveSchedule()} disabled={scheduleSaving}>{scheduleSaving ? "保存中…" : "保存排程"}</button></div><div className="settings-backup-schedule-next">{scheduleEnabled && backupStatus.schedule.nextRunAt ? `即将执行：${new Date(backupStatus.schedule.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` : "定时双备份未启用"}{scheduleMessage ? <span role="status"> · {scheduleMessage}</span> : null}</div></div></details>
    {retention === null ? null : <details className="settings-backup-retention settings-backup-advanced" data-backup-retention open={retentionOpen} onToggle={(event) => setRetentionOpen(event.currentTarget.open)}><summary><Archive size={15} aria-hidden="true" /><span>高级：保留策略 · 日备 {retention.policy.dailyDays} 天 · 周备 {retention.policy.weeklyWeeks} 周 · 月备 {retention.policy.monthlyMonths} 个月</span><span className="settings-backup-retention-count" data-backup-retention-count>{retention.summary.keepCount} 份保留 · {retention.summary.deleteCount} 份待清理</span><ChevronDown size={15} aria-hidden="true" /></summary>
      <div className="settings-backup-retention-body">
        <ul className="settings-backup-retention-rules" data-backup-retention-rules>{retention.described.map((line) => <li key={line}>{line}</li>)}</ul>
        <div className="settings-backup-retention-stats">
          <div><small>当前保留</small><strong>{formatTotal(retention.summary.keepCount, retention.summary.keepBytes)}</strong></div>
          <div><small>待清理</small><strong>{formatTotal(retention.summary.deleteCount, retention.summary.deleteBytes)}</strong></div>
          <div><small>下次清理</small><strong>{retention.cleanupScheduled && retention.nextCleanupAt ? formatWhen(retention.nextCleanupAt) : "定时备份未启用"}</strong></div>
        </div>
        <p className="settings-backup-retention-scope" data-backup-retention-scope>清理不会直接删掉：本地副本移入备份目录下的 <code>_trash</code>，云端对象移入 <code>{(s3.prefix || "product-backup/lifeos") + "-trash"}</code>，在回收站留满 {retention.policy.trashDays} 天后才真正删除。{retention.cleanupTrigger}</p>
        <div className="settings-backup-retention-list">{retention.entries.length === 0 ? <p className="settings-backup-retention-note">还没有备份。</p> : retention.entries.slice(0, 12).map((entry) => <div className={`settings-backup-retention-row ${entry.keep ? "is-keep" : "is-drop"}`} key={entry.fileName} data-backup-retention-row={entry.keep ? "keep" : "drop"}><span className={`settings-backup-retention-tier is-${entry.tier}`}>{RETENTION_TIER_LABELS[entry.tier]}</span><span className="settings-backup-retention-when">{formatWhen(entry.startedAt)}{entry.sizeBytes === undefined ? "" : ` · ${formatBytes(entry.sizeBytes)}`}</span><span className="settings-backup-retention-why">{entry.reason}</span></div>)}{retention.entries.length > 12 ? <p className="settings-backup-retention-note">仅显示最近 12 份，共 {retention.entries.length} 份。</p> : null}</div>
        {retention.trashed.length > 0 ? <div className="settings-backup-retention-trashed" data-backup-retention-trashed><p className="settings-backup-retention-note">已清理 {retention.trashed.length} 份，仍在回收站里（可以拿回来）。最近几份：</p>{retention.trashed.slice(0, 6).map((entry) => <div className="settings-backup-retention-row is-drop" key={entry.id ?? `${entry.fileName}@${entry.prunedAt}`}><span className="settings-backup-retention-tier is-none">回收站</span><span className="settings-backup-retention-when">{formatWhen(entry.prunedAt)}</span><span className="settings-backup-retention-why">{entry.fileName} · {entry.provider === "s3" ? "云端" : "本地"}</span></div>)}</div> : null}
        {retention.connectionTestCount > 0 ? <p className="settings-backup-retention-note">另有 {retention.connectionTestCount} 个连接测试文件（{formatBytes(retention.connectionTestBytes)}）不算备份，不参与保留。</p> : null}
        <div className="settings-backup-retention-form"><label><span>日备保留天数</span><input type="number" min={retention.limits.dailyDays.min} max={retention.limits.dailyDays.max} value={retentionDraft.dailyDays} onChange={(event) => setRetentionDraft({ ...retentionDraft, dailyDays: Number(event.target.value) })} /></label><label><span>周备保留周数</span><input type="number" min={retention.limits.weeklyWeeks.min} max={retention.limits.weeklyWeeks.max} value={retentionDraft.weeklyWeeks} onChange={(event) => setRetentionDraft({ ...retentionDraft, weeklyWeeks: Number(event.target.value) })} /></label><label><span>月备保留月数</span><input type="number" min={retention.limits.monthlyMonths.min} max={retention.limits.monthlyMonths.max} value={retentionDraft.monthlyMonths} onChange={(event) => setRetentionDraft({ ...retentionDraft, monthlyMonths: Number(event.target.value) })} /></label><label><span>回收站保留天数</span><input type="number" min={retention.limits.trashDays.min} max={retention.limits.trashDays.max} value={retentionDraft.trashDays} onChange={(event) => setRetentionDraft({ ...retentionDraft, trashDays: Number(event.target.value) })} /></label><button className="secondary-button" type="button" data-backup-retention-save onClick={() => void saveRetention()} disabled={retentionSaving}>{retentionSaving ? "保存中…" : "保存保留策略"}</button></div>
        {retentionMessage ? <p className="settings-inline-success" role="status">{retentionMessage}</p> : null}
      </div></details>}
    <details className="settings-backup-details settings-backup-advanced" data-backup-config-details open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}><summary><FolderOpen size={15} aria-hidden="true" /><span>{needsConfiguring ? "高级：填写对象存储配置（Endpoint / Region / Bucket / 密钥）" : "高级：对象存储配置与本地目录"}</span><ChevronDown size={15} aria-hidden="true" /></summary><div className="settings-backup-details-body"><div><small>本地目录</small><code>{backupStatus.localDirectory ?? "未配置"}</code></div><div><small>当前 Endpoint</small><code>{s3.endpoint || "未配置"}</code></div><div><small>当前 Bucket / Prefix</small><code>{s3.configured ? `${s3.bucket} / ${s3.prefix}` : "尚未保存云端配置"}</code></div><div className="settings-backup-form"><label><span>Endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://s3.bitiful.net" /></label><div className="settings-backup-form-row"><label><span>Region</span><input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="cn-east-1" /></label><label><span>Bucket</span><input value={bucket} onChange={(event) => setBucket(event.target.value)} placeholder="cdnb" /></label></div><label><span>Prefix / 文件夹</span><input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="product-backup/lifeos" /></label><div className="settings-backup-form-row"><label><span>Access Key</span><input value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} autoComplete="off" placeholder={s3.configured ? "已保存，留空不变" : "填写 Access Key"} /></label><label><span>Secret Key</span><input value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} type="password" autoComplete="new-password" placeholder={s3.configured ? "已保存，留空不变" : "填写 Secret Key"} /></label></div><label className="settings-backup-checkbox"><input type="checkbox" checked={forcePathStyle} onChange={(event) => setForcePathStyle(event.target.checked)} /><span>使用 Path-style URL（MinIO / 自建 S3 时开启；cdnb 保持关闭）</span></label><label className="settings-backup-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>启用对象存储自动备份</span></label><div className="settings-backup-form-actions"><button className="secondary-button" type="button" data-backup-preset onClick={applyPreset} disabled={saving}>填入 Bitiful 预设</button><button className="primary-button" type="button" onClick={() => void save()} disabled={saving || !endpoint.trim() || !region.trim() || !bucket.trim()}>{saving ? "保存中…" : "保存对象存储配置"}</button></div>{message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}<p className="settings-backup-note">密钥只提交给 API 服务端并加密保存，不会进入浏览器本地存储或 SQLite 备份。保存后再点上方“测试连接”，确认 cdnb 真实可写。</p></div></div></details>
    <details className="settings-backup-advanced settings-backup-history"><summary><History size={15} aria-hidden="true" /><span>高级：备份历史</span><ChevronDown size={15} aria-hidden="true" /></summary><BackupCalendar initialRuns={backupStatus.runs} /></details>
  </div>;
}

const WEATHER_PREVIEW_OPTIONS: readonly { readonly category: WeatherCategory; readonly label: string }[] = [
  { category: "sunny", label: "晴" },
  { category: "partly-cloudy", label: "少云" },
  { category: "cloudy", label: "多云" },
  { category: "overcast", label: "阴" },
  { category: "rainy", label: "小雨" },
  { category: "moderate-rainy", label: "中雨" },
  { category: "heavy-rainy", label: "大雨" },
  { category: "rainstorm", label: "暴雨" },
  { category: "thunderstorm", label: "雷雨" },
  { category: "snowy", label: "下雪" },
  { category: "foggy", label: "雾" },
];
const WEATHER_PHASE_LABELS: readonly { readonly phase: WeatherPhase; readonly label: string }[] = [
  { phase: "day", label: "白天" },
  { phase: "night", label: "夜晚" },
];

function WeatherScenePreviewDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<WeatherPhase>("day");
  const [category, setCategory] = useState<WeatherCategory>("sunny");
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={dialogRef} className="modal-dialog weather-preview-dialog" aria-labelledby="weather-preview-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="dialog-header"><div><p className="eyebrow">天气场景</p><h2 id="weather-preview-title">预览天气效果</h2></div><button ref={closeButtonRef} className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭天气效果预览"><X size={17} aria-hidden="true" /></button></div>
    <div className="weather-preview-controls">
      <fieldset className="weather-preview-phase"><legend>时段</legend><div className="weather-preview-segmented" role="group" aria-label="选择时段">{WEATHER_PHASE_LABELS.map((option) => <button key={option.phase} type="button" aria-pressed={phase === option.phase} className={phase === option.phase ? "is-selected" : ""} onClick={() => setPhase(option.phase)}>{option.label}</button>)}</div></fieldset>
      <label className="weather-preview-category"><span>天气类型</span><select value={category} onChange={(event) => setCategory(event.target.value as WeatherCategory)}>{WEATHER_PREVIEW_OPTIONS.map((option) => <option key={option.category} value={option.category}>{option.label}</option>)}</select></label>
    </div>
    <div className="weather-preview-scene" data-weather-preview-scene aria-label={`${WEATHER_PREVIEW_OPTIONS.find((option) => option.category === category)?.label ?? "天气"}，${phase === "night" ? "夜晚" : "白天"}`}><WeatherSky category={category} phase={phase} animate={false} /><span className="weather-preview-scene-label">{WEATHER_PREVIEW_OPTIONS.find((option) => option.category === category)?.label} · {phase === "night" ? "夜晚" : "白天"}</span></div>
    <p className="weather-preview-note">这里只展示视觉效果，不保存选择、不请求天气 API，也不会消耗额度。</p>
    <div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>完成</button></div>
  </dialog>;
}

export function WeatherSettingsCard({ profilesState, onChanged, onProfilesChanged, onRetry }: { readonly profilesState: WeatherProfilesState; readonly onChanged: (status: WeatherStatus) => void; readonly onProfilesChanged: (payload: WeatherProfilesResponse) => void; readonly onRetry: () => void }) {
  const profilesPayload = profilesState.status;
  const status = profilesPayload?.status ?? null;
  const profiles = profilesPayload?.items ?? [];
  const activeProfileId = profilesPayload?.activeProfileId ?? null;
  const statusReady = profilesState.phase === "ready" && profilesPayload !== null;
  const [enabled, setEnabled] = useState(status?.enabled ?? true);
  const [apiKey, setApiKey] = useState("");
  const [locationId, setLocationId] = useState(status?.locationId ?? "");
  const [city, setCity] = useState(status?.city ?? "");
  const [apiHost, setApiHost] = useState(status?.apiHost ?? "devapi.qweather.com");
  const [profileName, setProfileName] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(activeProfileId);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualLocationId, setManualLocationId] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  /**
   * A saved location the dropdown cannot place — an overseas ID typed before
   * this picker existed, or a hand-written one. It has nowhere to sit in the
   * three rungs, so without the manual field below it would vanish from the
   * form and be silently dropped on the next save. Auto-reveal that field in
   * exactly that case; if the owner closes it again, respect that (the effect
   * only re-runs when `unplaceable` itself changes).
   */
  const unplaceable = locationId.trim() !== "" && describeWeatherLocationByName(locationId) === null && (city.trim() === "" || describeWeatherLocationByName(city) === null);
  useEffect(() => {
    if (unplaceable) setManualLocationId(true);
  }, [unplaceable]);

  useEffect(() => {
    if (!status) return;
    setEnabled(status.enabled);
    setLocationId(status.locationId);
    setCity(status.city);
    setApiHost(status.apiHost || "devapi.qweather.com");
  }, [status]);

  useEffect(() => {
    setSelectedProfileId(activeProfileId);
    const active = profiles.find((profile) => profile.id === activeProfileId);
    if (active) setProfileName(active.label);
  }, [activeProfileId, profiles]);

  const save = async () => {
    if (!statusReady || busy || (!locationId.trim() && !city.trim())) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await apiRequest<WeatherStatus>("/api/weather/config", { method: "POST", body: JSON.stringify({ enabled, locationId, city, apiHost, ...(apiKey.trim() ? { apiKey } : {}) }) });
      onChanged(next);
      setApiKey("");
      setMessage("天气配置已保存");
    } catch (caught) {
      setError(errorMessage(caught, "天气配置保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!statusReady || testing || !locationId.trim()) return;
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      await apiRequest<{ ok: true; message: string }>("/api/weather/config/test", { method: "POST", body: JSON.stringify({ locationId, apiHost, ...(apiKey.trim() ? { apiKey } : {}) }) });
      setMessage("天气 API 连接成功");
    } catch (caught) {
      setError(errorMessage(caught, "天气 API 连接失败"));
    } finally {
      setTesting(false);
    }
  };

  const activateProfile = async (id: string) => {
    if (!statusReady || !id || busy || testing) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await apiRequest<WeatherProfilesResponse>("/api/weather/profiles/activate", { method: "POST", body: JSON.stringify({ id }) });
      onProfilesChanged(next);
      onChanged(next.status);
      setSelectedProfileId(next.activeProfileId);
      setApiKey("");
      setMessage("天气方案已切换");
    } catch (caught) {
      setError(errorMessage(caught, "天气方案切换失败"));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    if (!statusReady || busy || testing || (!locationId.trim() && !city.trim())) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next = await apiRequest<WeatherProfilesResponse>("/api/weather/profiles", { method: "POST", body: JSON.stringify({ ...(selectedProfileId === null ? {} : { id: selectedProfileId }), label: profileName.trim() || city.trim() || locationId.trim(), locationId, city, apiHost, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), activate: true }) });
      onProfilesChanged(next);
      onChanged(next.status);
      setSelectedProfileId(next.activeProfileId);
      setApiKey("");
      setMessage("天气方案已保存并应用");
    } catch (caught) {
      setError(errorMessage(caught, "天气方案保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const stateLabel = profilesState.phase === "ready" ? status?.configured ? "已连接" : "未配置" : profilesState.phase === "loading" ? status === null ? "正在读取状态…" : "正在刷新状态…" : status === null ? "状态暂时不可读取" : "状态读取失败";
  return <div className="settings-weather-card">
    <div className="settings-weather-overview"><div className="settings-card-icon"><CloudSun size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>天气动画与预报</strong><small className="settings-weather-scope">{status?.locationScope === "device" ? "本设备独立城市" : "沿用服务端默认城市"}</small></div><span className={`settings-status ${profilesState.phase === "ready" && status?.configured ? "is-ready" : ""}`} data-weather-status-phase={profilesState.phase}>{stateLabel}</span><button className="secondary-button settings-action" type="button" onClick={() => setPreviewOpen(true)}>预览天气效果</button></div>
    {profilesState.phase === "failed" ? <div className="settings-config-read-error" role="alert"><span>{profilesState.error}</span>{status === null ? null : <small>上次确认：{status.configured ? "已连接" : "未配置"}</small>}<button className="secondary-button" type="button" onClick={onRetry}>重试读取</button></div> : null}
    {status === null ? <p className="settings-config-unavailable">状态确认后，才能调整天气、方案或提交测试。</p> : null}
    <div className="settings-weather-form">
      <div className="settings-subsection-heading"><strong>当前方案</strong><small>切换已保存方案会立即应用；新方案请先填写位置。</small></div>
      <div className="settings-weather-profile-row"><label><span>已保存的天气方案</span><select value={selectedProfileId ?? ""} onChange={(event) => { const id = event.target.value; setSelectedProfileId(id || null); if (id) void activateProfile(id); }} disabled={!statusReady || busy || testing}><option value="">当前手动配置 / 服务端默认</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.label} · {profile.city || profile.locationId}{profile.hasKey ? "" : " · 缺少 Key"}</option>)}</select></label><label><span>方案名称</span><input value={profileName} disabled={!statusReady} onChange={(event) => setProfileName(event.target.value)} placeholder="例如：佛山南海区" /></label></div>
      <div className="settings-subsection-heading"><strong>位置</strong><small>天气预报和表头动画都使用这里的位置。</small></div>
      <WeatherLocationPicker locationId={locationId} city={city} disabled={!statusReady || busy || testing} onChange={(option) => { setLocationId(option.locationId); setCity(option.city); }} />
      <details className="settings-weather-manual" open={manualLocationId} onToggle={(event) => setManualLocationId(event.currentTarget.open)}>
        <summary><span>手动输入位置 ID（境外位置 / 旧配置迁移）</span></summary>
        <div className="settings-weather-form-row"><label><span>位置 ID</span><input value={locationId} disabled={!statusReady} onChange={(event) => setLocationId(event.target.value)} placeholder="例如 101280601" /></label><label><span>城市名（备用）</span><input value={city} disabled={!statusReady} onChange={(event) => setCity(event.target.value)} placeholder="例如 佛山南海区" /></label></div>
      </details>
      <details className="settings-weather-advanced">
        <summary><SlidersHorizontal size={15} aria-hidden="true" /><span>高级：连接与密钥</span><ChevronDown size={15} aria-hidden="true" /></summary>
        <div className="settings-weather-advanced-body"><label><span>API Key</span><input type="password" value={apiKey} disabled={!statusReady} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder={status?.hasKey ? "已保存，留空不变" : "填写和风天气 Key"} /></label><label><span>API Host</span><input value={apiHost} disabled={!statusReady} onChange={(event) => setApiHost(event.target.value)} placeholder="devapi.qweather.com" /></label><label className="settings-backup-checkbox"><input type="checkbox" checked={enabled} disabled={!statusReady} onChange={(event) => setEnabled(event.target.checked)} /><span>启用天气模块与表头动画</span></label></div>
      </details>
      <div className="settings-weather-actions"><button className="icon-text-button" type="button" onClick={() => void test()} disabled={!statusReady || testing || busy || !locationId.trim()}>{testing ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}<span>{testing ? "测试中…" : "测试连接"}</span></button><button className="secondary-button" type="button" onClick={() => void saveProfile()} disabled={!statusReady || busy || testing || (!locationId.trim() && !city.trim())}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}<span>{busy ? "保存中…" : "保存并应用方案"}</span></button><button className="primary-button" type="button" onClick={() => void save()} disabled={!statusReady || busy || testing || (!locationId.trim() && !city.trim())}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}<span>{busy ? "保存中…" : "仅保存默认配置"}</span></button></div>
      {message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      <p className="settings-weather-note">测试成功后可保存为方案；方案会加密保存 API Host、API Key 和位置 ID，之后直接切换即可。未配置 Key 时，表头不会伪造天气数据。</p>
    </div>
    <WeatherScenePreviewDialog open={previewOpen} onClose={() => setPreviewOpen(false)} />
  </div>;
}

interface AssetTrashPendingItem {
  readonly asset: Asset;
  readonly dueAt: string;
  readonly daysRemaining: number;
  readonly overdue: boolean;
}

interface AssetTrashItem {
  readonly asset: Asset;
  readonly trashedAt: string;
  readonly origin: "orphan-scan" | "asset-delete";
  readonly daysRemaining: number;
}

interface AssetTrashView {
  readonly graceDays: number;
  readonly trashDays: number;
  readonly nextRunAt: string;
  readonly pending: readonly AssetTrashPendingItem[];
  readonly trashed: readonly AssetTrashItem[];
}

/** The derived-thumbnail cache: how much of it there is, and where it lives. */
interface AssetThumbnailCacheView {
  readonly count: number;
  readonly bytes: number;
  readonly widths: readonly number[];
  readonly directory: string;
}

const ASSET_TRASH_ORIGIN_LABELS: Record<AssetTrashItem["origin"], string> = { "orphan-scan": "自动清理", "asset-delete": "手动删除" };

function assetTrashName(asset: Asset): string {
  return asset.originalName !== undefined && asset.originalName.trim() !== "" ? asset.originalName : "未命名照片";
}

function assetTrashMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: USER_TIME_ZONE, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function assetTrashRemaining(days: number): string {
  return days <= 0 ? "即将清理" : `还剩 ${days} 天`;
}

/**
 * The two halves of the asset lifecycle, made visible: uploads waiting out
 * their grace period, and collected files that can still be put back.
 */
export function AssetTrashSettingsCard({ onAssetsChanged }: { readonly onAssetsChanged: () => void }) {
  const [view, setView] = useState<AssetTrashView | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiRequest<AssetTrashView>("/api/assets/trash", { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setView(payload);
        setUnavailable(null);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        // Without LIFEOS_ASSET_ROOT the host never opted into local files, so
        // the panel says so instead of showing an error the owner cannot act on.
        setView(null);
        setUnavailable(errorMessage(cause, "照片回收站暂不可用"));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const act = async (id: string, requestPath: string, method: "POST" | "DELETE", done: string) => {
    if (busyId !== null) return;
    setBusyId(id);
    setMessage(null);
    setError(null);
    try {
      await apiRequest<void>(requestPath, { method });
      onAssetsChanged();
      setConfirmId(null);
      setReload((current) => current + 1);
      setMessage(done);
    } catch (cause) {
      setError(errorMessage(cause, "操作失败，请重试"));
    } finally {
      setBusyId(null);
    }
  };

  const pending = view?.pending ?? [];
  const trashed = view?.trashed ?? [];
  return <div className="settings-asset-trash-card" data-asset-trash>
    <div className="settings-asset-trash-overview">
      <div className="settings-card-icon"><Trash2 size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong>照片回收站</strong><small>拖进输入框、又没保存的照片，会先在原处留 {view?.graceDays ?? 7} 天；过期后由服务端自动收走，再在回收站放 {view?.trashDays ?? 30} 天可以拿回来。</small></div>
      <button className="icon-text-button" type="button" onClick={() => setReload((current) => current + 1)} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}<span>{loading ? "读取中" : "刷新"}</span></button>
    </div>
    {unavailable !== null ? <p className="settings-asset-trash-note" data-asset-trash-unavailable>{unavailable}；服务端配置 LIFEOS_ASSET_ROOT 后这里会显示实物。</p> : null}
    {view === null ? null : <>
      <div className="settings-asset-trash-stats">
        <div><small>待清理</small><strong data-asset-trash-pending-count>{pending.length} 张</strong></div>
        <div><small>回收站</small><strong data-asset-trash-trashed-count>{trashed.length} 张</strong></div>
        <div><small>下次自动清理</small><strong data-asset-trash-next-run>{assetTrashMoment(view.nextRunAt)}</strong></div>
      </div>
      <div className="settings-asset-trash-group">
        <p className="settings-asset-trash-group-head">待清理<span>没人引用，到期即收走</span></p>
        {pending.length === 0 ? <p className="settings-asset-trash-note">没有等着过期的照片。</p> : <ul className="settings-asset-trash-list" data-asset-trash-pending>{pending.map((item) => <li className="settings-asset-trash-row" key={item.asset.id}><img src={assetThumbUrl(item.asset.id, 400)} alt="" loading="lazy" decoding="async" /><span className="settings-asset-trash-meta"><strong>{assetTrashName(item.asset)}</strong><small>{formatBytes(item.asset.sizeBytes) ?? "尺寸未知"}{item.asset.createdAt === undefined ? "" : ` · ${assetTrashMoment(item.asset.createdAt.value)} 上传`}</small></span><span className={`settings-asset-trash-days ${item.overdue ? "is-overdue" : ""}`}>{assetTrashRemaining(item.daysRemaining)}</span></li>)}</ul>}
      </div>
      <div className="settings-asset-trash-group">
        <p className="settings-asset-trash-group-head">回收站<span>可以恢复，也可以立即删掉</span></p>
        {trashed.length === 0 ? <p className="settings-asset-trash-note">回收站是空的。</p> : <ul className="settings-asset-trash-list" data-asset-trash-trashed>{trashed.map((item) => <li className="settings-asset-trash-row" key={item.asset.id}><img src={`/api/assets/trash/${encodeURIComponent(item.asset.id)}/content`} alt="" loading="lazy" decoding="async" /><span className="settings-asset-trash-meta"><strong>{assetTrashName(item.asset)}</strong><small>{ASSET_TRASH_ORIGIN_LABELS[item.origin]} · {formatBytes(item.asset.sizeBytes) ?? "尺寸未知"} · {assetTrashMoment(item.trashedAt)} 收走</small></span><span className="settings-asset-trash-days">{assetTrashRemaining(item.daysRemaining)}</span><span className="settings-asset-trash-actions"><button className="icon-text-button" type="button" data-asset-trash-restore disabled={busyId !== null} onClick={() => void act(item.asset.id, `/api/assets/trash/${encodeURIComponent(item.asset.id)}/restore`, "POST", `已恢复「${assetTrashName(item.asset)}」`)}><RotateCcw size={14} aria-hidden="true" /><span>恢复</span></button><button className={`danger-button settings-asset-trash-purge ${confirmId === item.asset.id ? "is-armed" : ""}`} type="button" data-asset-trash-purge disabled={busyId !== null} onClick={() => { if (confirmId !== item.asset.id) { setConfirmId(item.asset.id); setMessage(null); return; } void act(item.asset.id, `/api/assets/trash/${encodeURIComponent(item.asset.id)}`, "DELETE", `已永久删除「${assetTrashName(item.asset)}」`); }}>{busyId === item.asset.id ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}<span>{confirmId === item.asset.id ? "再点一次真删" : "立即删除"}</span></button></span></li>)}</ul>}
      </div>
    </>}
    {message !== null ? <p className="settings-inline-success" role="status">{message}</p> : null}
    {error !== null ? <p className="settings-inline-error" role="alert">{error}</p> : null}
  </div>;
}

/**
 * The derived-thumbnail cache, made visible for the same reason the trash panel is:
 * it is LifeOS's own copy of the owner's photos, it grows without being asked, and the
 * one thing the owner needs to know is that deleting it costs nothing. So the card
 * states the two facts that matter — how much disk it holds, and that it rebuilds —
 * and offers a single button to empty it.
 */
export function ThumbnailCacheSettingsCard() {
  const [view, setView] = useState<AssetThumbnailCacheView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiRequest<AssetThumbnailCacheView>("/api/assets/thumbnails", { signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) setView(payload); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause, "缩略图缓存暂不可用")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  // Same two-step as deleting a photo for good: the first click only arms.
  const clear = async () => {
    if (busy) return;
    if (!armed) { setArmed(true); setMessage(null); return; }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const cleared = await apiRequest<{ readonly removed: number; readonly freedBytes: number }>("/api/assets/thumbnails", { method: "DELETE" });
      setArmed(false);
      setReload((current) => current + 1);
      setMessage(cleared.removed === 0 ? "本来就没有缩略图。" : `已清掉 ${cleared.removed} 张缩略图，腾出 ${formatBytes(cleared.freedBytes) ?? "0 B"}；下次显示会自动重建。`);
    } catch (cause) {
      setError(errorMessage(cause, "清空失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="settings-asset-trash-card" data-thumb-cache>
    <div className="settings-asset-trash-overview">
      <div className="settings-card-icon"><ImageIcon size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong>缩略图缓存</strong><small>时间轴、照片底纹和投放区显示的都是 {view === null || view.widths.length === 0 ? "400 / 1200" : view.widths.join(" / ")} px 的派生小图，由服务端从原图生成、按原图内容命名。它只是缓存：删掉不影响任何照片，下次显示会自动重建。</small></div>
      <button className="icon-text-button" type="button" onClick={() => setReload((current) => current + 1)} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}<span>{loading ? "读取中" : "刷新"}</span></button>
    </div>
    <div className="settings-asset-trash-stats">
      <div><small>缩略图</small><strong data-thumb-cache-count>{view === null ? "—" : `${view.count} 张`}</strong></div>
      <div><small>占用</small><strong data-thumb-cache-bytes>{view === null ? "—" : formatBytes(view.bytes) ?? "0 B"}</strong></div>
    </div>
    {view === null ? null : <p className="settings-asset-trash-note">存放在 <code data-thumb-cache-directory>{view.directory}</code></p>}
    <div className="settings-asset-trash-actions">
      <button className={`danger-button settings-asset-trash-purge ${armed ? "is-armed" : ""}`} type="button" data-thumb-cache-clear disabled={busy || view === null} onClick={() => void clear()}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}<span>{armed ? "再点一次清空" : "清空缩略图缓存"}</span></button>
    </div>
    {message !== null ? <p className="settings-inline-success" role="status">{message}</p> : null}
    {error !== null ? <p className="settings-inline-error" role="alert">{error}</p> : null}
  </div>;
}

export function FontSettingsCard({ value, onChange }: { readonly value: UiFontId; readonly onChange: (value: UiFontId) => void }) {
  const selected = UI_FONT_OPTIONS.find((option) => option.id === value) ?? UI_FONT_OPTIONS[0];
  return <div className="settings-card settings-font-card"><div className="settings-card-icon"><Type size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>界面字体</strong><small>仅影响本浏览器的 LifeOS 界面；Maple Mono 继续用于日期和数字等宽信息。</small></div><select className="settings-font-select" value={value} aria-label="界面字体" onChange={(event) => { if (isUiFontId(event.target.value)) onChange(event.target.value); }}><option value={selected.id}>{selected.label}</option>{UI_FONT_OPTIONS.filter((option) => option.id !== selected.id).map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></div>;
}

export function CycleSettingsCard({ module, onSaveConfig }: { readonly module: CycleIntimacyModuleData | null; readonly onSaveConfig: (config: CycleIntimacyModuleConfig) => Promise<void> }) {
  const [draft, setDraft] = useState<CycleIntimacyModuleConfig | null>(module?.config ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(module?.config ?? null); }, [module]);
  if (draft === null) return <div className="settings-card"><div className="settings-card-icon"><Heart size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>正在读取周期设置</strong><small>私密模块配置只在本机登录后读取。</small></div></div>;
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onSaveConfig(draft); } catch (caught) { setError(errorMessage(caught, "周期设置暂时无法保存，请重试")); }
    finally { setBusy(false); }
  };
  return <div className="settings-card cycle-settings-card">
    <div className="settings-card-icon"><Heart size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>周期与亲密记录</strong><small>关闭模块后已有私密记录仍会保留；日历中的快捷入口使用同一份配置。</small></div>
    <label className="cycle-enable"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => current ? { ...current, enabled: event.target.checked } : current)} /><span><strong>在日历中启用</strong><small>显示周期推算与私密记录入口。</small></span></label>
    <div className="dialog-fields-grid"><label className="dialog-field"><span>周期天数</span><input type="number" min="15" max="90" value={draft.cycleLength} onChange={(event) => setDraft((current) => current ? { ...current, cycleLength: Number(event.target.value) } : current)} /></label><label className="dialog-field"><span>预计持续天数</span><input type="number" min="1" max="21" value={draft.periodLength} onChange={(event) => setDraft((current) => current ? { ...current, periodLength: Number(event.target.value) } : current)} /></label></div>
    <label className="dialog-field"><span>最近一次经期开始（可选）</span><input type="date" value={draft.anchorStart ?? ""} onChange={(event) => setDraft((current) => { if (!current) return current; const { anchorStart: _anchorStart, ...rest } = current; return event.target.value ? { ...rest, anchorStart: event.target.value } : rest; })} /></label>
    <p className="cycle-dialog-note">虚影月亮只表示按以上间隔推算的预计日期；确认开始或结束后，会以实心月亮覆盖它。</p>
    <div className="cycle-settings-actions"><button className="primary-button" type="button" onClick={() => void save()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{busy ? "保存中" : "保存周期设置"}</span></button></div>
    {error ? <p className="settings-inline-error" role="alert"><CircleHelp size={16} aria-hidden="true" />{error}</p> : null}
  </div>;
}

export function SettingsView({ page, onNavigatePage, onImport, onLogout, logoutBusy, authRequired, aiStatusState, onAiStatusChange, onRetryAiStatus, assistantVisible, onAssistantVisibleChange, backupStatus, backupBusy, onBackup, onBackupStatusChange, weatherProfilesState, onWeatherStatusChange, onWeatherProfilesChange, onRetryWeatherProfiles, movieStatusState, onMovieStatusChange, onRetryMovieStatus, demoCount, hideDemo, demoBusy, demoDeleteArmed, onToggleDemo, onDeleteDemo, uiFont, onUiFontChange, onAssetsChanged, cycleModule, onSaveCycleConfig }: { page: SettingsPageId; onNavigatePage: (page: SettingsPageId) => void; onImport: () => void; onLogout: () => void; logoutBusy: boolean; authRequired: boolean; aiStatusState: AiStatusState; onAiStatusChange: (status: AiStatus) => void; onRetryAiStatus: () => void; assistantVisible: boolean; onAssistantVisibleChange: (visible: boolean) => void; backupStatus: BackupStatus; backupBusy: boolean; onBackup: (action: "local" | "s3" | "test" | "dual") => void; onBackupStatusChange: (status: BackupStatus) => void; weatherProfilesState: WeatherProfilesState; onWeatherStatusChange: (status: WeatherStatus) => void; onWeatherProfilesChange: (payload: WeatherProfilesResponse) => void; onRetryWeatherProfiles: () => void; movieStatusState: MovieModuleStatusState; onMovieStatusChange: (status: MovieModuleStatus) => void; onRetryMovieStatus: () => void; demoCount: number; hideDemo: boolean; demoBusy: boolean; demoDeleteArmed: boolean; onToggleDemo: () => void; onDeleteDemo: () => void; uiFont: UiFontId; onUiFontChange: (value: UiFontId) => void; onAssetsChanged: () => void; cycleModule: CycleIntimacyModuleData | null; onSaveCycleConfig: (config: CycleIntimacyModuleConfig) => Promise<void> }) {
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const activePage = SETTINGS_PAGE_GROUPS.flatMap((group) => group.pages).find((candidate) => candidate.id === page) ?? SETTINGS_PAGE_GROUPS[0].pages[0];
  useEffect(() => { window.requestAnimationFrame(() => pageHeadingRef.current?.focus()); }, [page]);
  const pageDescription: Record<SettingsPageId, string> = {
    "account/session": "访问权限与当前会话。",
    "data/import-export": "把记录带进来或导出为可保存的文件。",
    "data/backup": "查看备份状态，并管理本地与对象存储策略。",
    "data/demo": "控制预置记录的显示与删除。",
    "data/photos": "管理照片回收站与可再生的缩略图缓存。",
    "appearance/interface": "调整当前浏览器里的界面显示。",
    "integrations/weather": "天气位置、方案和天气场景。",
    "integrations/ai": "AI 助手显示方式与服务配置。",
    "integrations/movie": "管理观影模块与影片识别服务。",
    "private/cycle": "周期与亲密模块的私密设置。",
    about: "了解本机优先的数据边界。",
  };
  const pageContent = page === "account/session" ? <div className="settings-card settings-account-card"><div className="settings-card-icon"><LockKeyhole size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>{authRequired ? "已登录" : "本机访问"}</strong><small>{authRequired ? "当前会话受访问密码保护。" : "当前实例未启用登录密码。"}</small></div>{authRequired ? <button className="danger-button settings-action" type="button" onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <LogOut size={16} aria-hidden="true" />}<span>{logoutBusy ? "退出中" : "退出登录"}</span></button> : null}</div>
    : page === "data/import-export" ? <div className="settings-card settings-data-grid"><div className="settings-card-icon"><FileJson size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>备份与导出</strong><small>导入前请确认 JSON 来自可信的 LifeOS 实例；导出文件包含你的记录内容。</small></div><div className="settings-card-actions"><button className="secondary-button" type="button" onClick={onImport}><Upload size={15} aria-hidden="true" /><span>导入 JSON</span></button><a className="secondary-button" href="/api/export?format=json" download><FileJson size={15} aria-hidden="true" /><span>导出 JSON</span></a><a className="secondary-button" href="/api/export?format=markdown" download><FileText size={15} aria-hidden="true" /><span>导出 Markdown</span></a></div></div>
    : page === "data/backup" ? <BackupSettingsCard backupStatus={backupStatus} backupBusy={backupBusy} onBackup={onBackup} onChanged={onBackupStatusChange} />
    : page === "data/demo" ? <div className="settings-card settings-demo-card"><div className="settings-card-icon"><Sparkles size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>{hideDemo ? "演示数据已隐藏" : `显示 ${demoCount} 条演示记录`}</strong><small>删除操作只会处理带有演示标记的记录，不会动你的个人内容。</small></div><label className="settings-switch" title="显示演示数据"><input type="checkbox" checked={!hideDemo} onChange={onToggleDemo} aria-label="显示演示数据" /><span aria-hidden="true" /></label><button className={`danger-button settings-demo-delete ${demoDeleteArmed ? "is-armed" : ""}`} type="button" onClick={onDeleteDemo} disabled={demoBusy || demoCount === 0}>{demoBusy ? "删除中…" : demoDeleteArmed ? `再次点击删除 ${demoCount} 条` : "删除全部演示数据"}</button></div>
    : page === "data/photos" ? <><AssetTrashSettingsCard onAssetsChanged={onAssetsChanged} /><ThumbnailCacheSettingsCard /></>
    : page === "appearance/interface" ? <FontSettingsCard value={uiFont} onChange={onUiFontChange} />
    : page === "integrations/weather" ? <WeatherSettingsCard profilesState={weatherProfilesState} onChanged={onWeatherStatusChange} onProfilesChanged={onWeatherProfilesChange} onRetry={onRetryWeatherProfiles} />
    : page === "integrations/ai" ? <AiSettingsCard statusState={aiStatusState} open={false} assistantVisible={assistantVisible} onAssistantVisibleChange={onAssistantVisibleChange} onChanged={onAiStatusChange} onRetry={onRetryAiStatus} />
    : page === "integrations/movie" ? <MovieSettingsCard statusState={movieStatusState} onChanged={onMovieStatusChange} onRetry={onRetryMovieStatus} />
    : page === "private/cycle" ? <CycleSettingsCard module={cycleModule} onSaveConfig={onSaveCycleConfig} />
    : <div className="settings-card settings-about-card"><div className="settings-card-icon"><Activity size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>LifeOS · 本机优先</strong><small>记录、设置和已保存的服务配置由当前 LifeOS 实例管理。天气、AI 和观影服务只有在你主动启用并配置后才会连接外部服务。</small></div></div>;
  return <section className="settings-page" aria-labelledby="settings-title">
    <header className="settings-page-header"><p className="eyebrow">Workspace</p><h1 id="settings-title">设置</h1><p>按用途整理设置；选择一个页面后，只显示这一页的内容。</p></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分区">{SETTINGS_PAGE_GROUPS.map((group) => <div className="settings-nav-group" key={group.id}><h2>{group.label}</h2>{group.pages.map((item) => <button id={`settings-page-${item.id.replace("/", "-")}`} type="button" key={item.id} className={item.id === page ? "is-active" : ""} aria-current={item.id === page ? "page" : undefined} onClick={() => onNavigatePage(item.id)}>{item.label}</button>)}</div>)}</nav>
      <div className="settings-mobile-selector"><label htmlFor="settings-mobile-selector"><span>设置页面</span><select id="settings-mobile-selector" value={page} onChange={(event) => onNavigatePage(event.target.value as SettingsPageId)}>{SETTINGS_PAGE_GROUPS.flatMap((group) => group.pages.map((item) => <option value={item.id} key={item.id}>{group.label} · {item.label}</option>))}</select></label></div>
      <article className="settings-page-content" aria-labelledby="settings-page-title"><div className="settings-section-heading"><h2 id="settings-page-title" ref={pageHeadingRef} tabIndex={-1}>{activePage.label}</h2><p>{pageDescription[page]}</p></div>{pageContent}</article>
    </div>
  </section>;
}
