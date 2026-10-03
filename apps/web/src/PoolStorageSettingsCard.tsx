import { useCallback, useEffect, useState } from "react";
import { HardDrive, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { apiRequest } from "./api";
import { errorMessage } from "./app-meta";
import "./pool-storage.css";

const GIB = 1024 ** 3;

type PoolUser = {
  accountId: string;
  username: string;
  displayName: string;
  spaceName: string;
  role: string;
  disabled: boolean;
  storageUsedBytes: number;
  storageReservedBytes: number;
  storageLimitBytes: number;
  trafficUsedBytes: number;
  trafficReservedBytes: number;
  trafficLimitBytes: number;
  legacyAssetCount: number | null;
  legacyBytes: number | null;
  unassignedLegacyBytes: number | null;
  legacyUnknownAssetCount: number | null;
};

type PoolOverview = {
  available: true;
  consumer: string;
  month: string;
  project: {
    storageUsedBytes: number;
    storageLimitBytes: number;
    storageFreeBytes: number;
    trafficUsedBytes: number;
    trafficLimitBytes: number;
    trafficFreeBytes: number;
  };
  allocationFree: { storageBytes: number; trafficBytes: number };
  users: readonly PoolUser[];
  unassigned: { storageObjects: number | null; storageBytes: number | null; trafficBytes: number | null };
  legacyInventoryComplete: boolean;
  accountingMismatch?: { storageBytes: number; trafficBytes: number };
  poolObjectIssues?: readonly { accountId: string; assetId: string; bytes: number; state: string }[];
};

function quotaWriteBlocked(overview: PoolOverview | null): boolean {
  return overview === null || !overview.legacyInventoryComplete || overview.accountingMismatch !== undefined
    || (overview.unassigned.storageBytes ?? 0) > 0 || (overview.unassigned.trafficBytes ?? 0) > 0
    || (overview.poolObjectIssues?.length ?? 0) > 0;
}

type Draft = { storage: string; traffic: string };
type PoolLoadState = "loading" | "ready" | "unavailable" | "failed";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${units[unit]}`;
}

function formatRemaining(bytes: number): string {
  return bytes < 0 ? `超出 ${formatBytes(Math.abs(bytes))}` : formatBytes(bytes);
}

function formatKnownBytes(bytes: number | null): string {
  return bytes === null ? "大小待核对" : formatBytes(bytes);
}

function quotaDraft(bytes: number): string {
  return String(bytes / GIB);
}

function quotaBytes(value: string): number | null {
  if (!value.trim()) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const bytes = Math.round(amount * GIB);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function progressPercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? Number.POSITIVE_INFINITY : 0;
  return Math.max(0, (used / limit) * 100);
}

function UsageMeter({ label, used, limit, remaining }: { label: string; used: number; limit: number; remaining?: number }) {
  const actualPercent = progressPercent(used, limit);
  const barPercent = Number.isFinite(actualPercent) ? Math.min(100, actualPercent) : 100;
  const overLimit = actualPercent > 100;
  return <div className="pool-usage-meter" data-pool-meter={label}>
    <div className="pool-usage-meter-heading"><strong>{label}</strong><span className={overLimit ? "is-over" : undefined}>{Number.isFinite(actualPercent) ? `${actualPercent.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%${overLimit ? " 超额" : ""}` : "超额"}</span></div>
    <progress aria-label={`${label}使用比例`} max={100} value={barPercent}>{barPercent}%</progress>
    <div className="pool-usage-values"><span>已用 <strong>{formatBytes(used)}</strong></span><span>上限 <strong>{formatBytes(limit)}</strong></span>{remaining === undefined ? null : <span>剩余 <strong>{formatRemaining(remaining)}</strong></span>}</div>
  </div>;
}

function makeDrafts(users: readonly PoolUser[]): Record<string, Draft> {
  return Object.fromEntries(users.map((user) => [user.accountId, { storage: quotaDraft(user.storageLimitBytes), traffic: quotaDraft(user.trafficLimitBytes) }]));
}

export function PoolStorageSettingsCard() {
  const [state, setState] = useState<PoolLoadState>("loading");
  const [overview, setOverview] = useState<PoolOverview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async (preserveDrafts = false) => {
    setState("loading");
    setError(null);
    try {
      const result = await apiRequest<PoolOverview>("/api/admin/storage-pool");
      if (result.available !== true) throw new Error("存储池尚未启用或暂时不可用");
      setOverview(result);
      setDrafts((current) => preserveDrafts ? { ...makeDrafts(result.users), ...current } : makeDrafts(result.users));
      setState("ready");
    } catch (cause) {
      const status = typeof cause === "object" && cause !== null && "status" in cause ? (cause as { status?: unknown }).status : undefined;
      setOverview(null);
      setState(status === 503 ? "unavailable" : "failed");
      setError(errorMessage(cause, "存储池用量读取失败"));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const updateDraft = (accountId: string, key: keyof Draft, value: string) => {
    setDrafts((current) => ({ ...current, [accountId]: { ...(current[accountId] ?? { storage: "0", traffic: "0" }), [key]: value } }));
    setNotice(null);
  };

  const save = async (user: PoolUser) => {
    const draft = drafts[user.accountId];
    if (!draft || state !== "ready" || quotaWriteBlocked(overview) || savingIds.has(user.accountId)) return;
    const storageLimitBytes = quotaBytes(draft.storage);
    const trafficLimitBytes = quotaBytes(draft.traffic);
    if (storageLimitBytes === null || trafficLimitBytes === null) {
      setError("额度必须是有效的非负数字，且不能超过安全整数范围。");
      return;
    }
    const storageDelta = storageLimitBytes - user.storageLimitBytes;
    const trafficDelta = trafficLimitBytes - user.trafficLimitBytes;
    if ((storageDelta > 0 && storageDelta > overview!.allocationFree.storageBytes) || (trafficDelta > 0 && trafficDelta > overview!.allocationFree.trafficBytes)) {
      setError("项目可分配余额不足。请降低额度，或等其他用户释放额度后再保存。");
      return;
    }

    setSavingIds((current) => new Set(current).add(user.accountId));
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/api/admin/accounts/${encodeURIComponent(user.accountId)}/pool-quota`, {
        method: "PUT",
        body: JSON.stringify({ storageLimitBytes, trafficLimitBytes }),
      });
      setNotice(`${user.displayName} 的存储池额度已保存。`);
      await reload(true);
      setDrafts((current) => ({ ...current, [user.accountId]: { storage: quotaDraft(storageLimitBytes), traffic: quotaDraft(trafficLimitBytes) } }));
    } catch (cause) {
      setError(errorMessage(cause, `${user.displayName} 的额度保存失败`));
    } finally {
      setSavingIds((current) => { const next = new Set(current); next.delete(user.accountId); return next; });
    }
  };

  return <section className="pool-usage-card" aria-labelledby="pool-usage-title" data-pool-state={state}>
    <div className="pool-usage-card-heading">
      <div className="settings-card-icon"><HardDrive size={18} aria-hidden="true" /></div>
      <div className="settings-card-copy"><strong id="pool-usage-title">弹指存储池</strong><small>项目用量来自 PoolConsumer；用户流量按经接入层下载到 LifeOS 服务器的字节统计。</small></div>
      <button className="secondary-button pool-usage-refresh" type="button" onClick={() => void reload(true)} disabled={state === "loading" || savingIds.size > 0} aria-label="刷新存储池用量">
        {state === "loading" ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}<span>刷新</span>
      </button>
    </div>

    {state === "loading" ? <p className="pool-usage-state" role="status">正在读取弹指项目用量…</p> : null}
    {state === "unavailable" ? <div className="pool-usage-state is-unavailable" role="status"><strong>存储池不可用，额度编辑已停用</strong><span>{error || "接入层尚未启用或暂时无法读取用量。"}</span></div> : null}
    {state === "failed" ? <div className="pool-usage-state is-unavailable" role="alert"><strong>无法读取存储池用量，额度编辑已停用</strong><span>{error}</span></div> : null}

    {state === "ready" && overview ? <>
      <div className="pool-project-summary" data-pool-consumer={overview.consumer}>
        <div className="pool-project-meta"><span>项目 ID <strong>{overview.consumer}</strong></span><span>月流量统计月份（UTC） <strong>{overview.month}</strong></span></div>
        <div className="pool-project-meters">
          <UsageMeter label="项目存储" used={overview.project.storageUsedBytes} limit={overview.project.storageLimitBytes} remaining={overview.project.storageFreeBytes} />
          <UsageMeter label="项目月流量" used={overview.project.trafficUsedBytes} limit={overview.project.trafficLimitBytes} remaining={overview.project.trafficFreeBytes} />
        </div>
      </div>

      <div className="pool-allocation-summary" aria-label="项目尚可分配给用户的额度">
        <strong>用户额度尚可分配</strong>
        <span>存储 <b className={overview.allocationFree.storageBytes < 0 ? "is-over" : undefined}>{formatRemaining(overview.allocationFree.storageBytes)}</b></span>
        <span>月流量 <b className={overview.allocationFree.trafficBytes < 0 ? "is-over" : undefined}>{formatRemaining(overview.allocationFree.trafficBytes)}</b></span>
      </div>

      <div className="pool-legacy-notice" data-pool-unassigned>
        <strong>无法归属到 LifeOS 用户的存储池用量</strong>
        <span>{overview.unassigned.storageObjects === null ? "对象数量待核对" : `${overview.unassigned.storageObjects.toLocaleString("zh-CN")} 个对象`}，存储 {formatKnownBytes(overview.unassigned.storageBytes)}，本月流量 {formatKnownBytes(overview.unassigned.trafficBytes)}</span>
        <small>{overview.unassigned.storageObjects === 0 && overview.unassigned.storageBytes === 0 && overview.unassigned.trafficBytes === 0 ? "当前没有无法归属的存储池用量。" : "这些数值保留在项目实际用量中，不会分摊给任何用户。"}历史本地文件单独列出，不计入存储池用量。</small>
      </div>
      {overview.accountingMismatch && (overview.accountingMismatch.storageBytes > 0 || overview.accountingMismatch.trafficBytes > 0) ? <div className="pool-legacy-notice is-mismatch" data-pool-accounting-mismatch role="alert">
        <strong>存储池账目需要核对</strong>
        <span>LifeOS 账本超出项目实测：存储 {formatBytes(overview.accountingMismatch.storageBytes)}，本月流量 {formatBytes(overview.accountingMismatch.trafficBytes)}。</span>
        <small>额度编辑以及新的上传和下载会暂停，直到账目恢复一致。</small>
      </div> : null}
      {!overview.legacyInventoryComplete ? <div className="pool-legacy-notice is-mismatch" data-pool-legacy-incomplete>
        <strong>历史本地文件归属或大小待核对</strong>
        <span>无法归属或无法读取大小的文件会单独显示，不会混入存储池实际用量。</span>
        <small>完成历史文件盘点前，额度编辑以及新的存储池上传和下载会暂停。</small>
      </div> : null}
      {(overview.poolObjectIssues?.length ?? 0) > 0 ? <div className="pool-legacy-notice is-mismatch" data-pool-object-issues role="alert">
        <strong>有待核对的存储池操作</strong>
        <span>{overview.poolObjectIssues!.length.toLocaleString("zh-CN")} 个对象处于未决状态，额度编辑及新的上传和下载已暂停。</span>
      </div> : null}

      <div className="pool-user-list" aria-label="用户存储池额度">
        {overview.users.map((user) => {
          const draft = drafts[user.accountId] ?? { storage: quotaDraft(user.storageLimitBytes), traffic: quotaDraft(user.trafficLimitBytes) };
          const storageBytes = quotaBytes(draft.storage);
          const trafficBytes = quotaBytes(draft.traffic);
          const saving = savingIds.has(user.accountId);
          const blocked = quotaWriteBlocked(overview);
          const valid = storageBytes !== null && trafficBytes !== null;
          const changed = valid && (storageBytes !== user.storageLimitBytes || trafficBytes !== user.trafficLimitBytes);
          const wouldOverAllocate = valid && ((storageBytes > user.storageLimitBytes && storageBytes - user.storageLimitBytes > overview.allocationFree.storageBytes) || (trafficBytes > user.trafficLimitBytes && trafficBytes - user.trafficLimitBytes > overview.allocationFree.trafficBytes));
          return <article className="pool-user-card" key={user.accountId} data-pool-user={user.accountId}>
            <div className="pool-user-heading"><div><strong>{user.spaceName || user.displayName}</strong><span>{user.displayName}，{user.username}{user.disabled ? "，已停用" : ""}</span></div><span className="pool-user-role">{user.role === "owner" ? "所有者" : "成员"}</span></div>
            <div className="pool-user-meters">
              <UsageMeter label="存储" used={user.storageUsedBytes} limit={user.storageLimitBytes} />
              <UsageMeter label={`月流量（UTC ${overview.month}）`} used={user.trafficUsedBytes} limit={user.trafficLimitBytes} />
            </div>
            {(user.storageReservedBytes > 0 || user.trafficReservedBytes > 0) ? <small className="pool-user-reserved">正在处理的预占额度：存储 {formatBytes(user.storageReservedBytes)}，月流量 {formatBytes(user.trafficReservedBytes)}</small> : null}
            {(user.legacyAssetCount === null || user.legacyAssetCount > 0 || user.legacyUnknownAssetCount === null || user.legacyUnknownAssetCount > 0 || (user.legacyBytes !== null && user.legacyBytes > 0) || user.unassignedLegacyBytes === null || user.unassignedLegacyBytes > 0) ? <div className="pool-user-legacy"><strong>历史本地文件（不计入存储池）</strong><span>{user.legacyAssetCount === null ? "文件数待核对" : `${user.legacyAssetCount.toLocaleString("zh-CN")} 个文件`}，大小 {user.legacyBytes === null ? "待核对" : formatBytes(user.legacyBytes)}</span>{user.legacyUnknownAssetCount === null ? <span>无法确认文件数量及大小</span> : user.legacyUnknownAssetCount > 0 ? <span>{user.legacyUnknownAssetCount.toLocaleString("zh-CN")} 个文件大小待核对</span> : null}{user.unassignedLegacyBytes === null ? <span>其中无法归属的大小待核对</span> : user.unassignedLegacyBytes > 0 ? <span>其中无法归属 {formatBytes(user.unassignedLegacyBytes)}</span> : null}</div> : null}
            <div className="pool-user-quota-editor">
              <label><span>分配存储额度（GiB）</span><input type="number" min="0" step="0.01" inputMode="decimal" value={draft.storage} onChange={(event) => updateDraft(user.accountId, "storage", event.target.value)} disabled={state !== "ready" || blocked || saving} aria-label={`${user.displayName}存储额度 GiB`} /></label>
              <label><span>分配月流量额度（GiB）</span><input type="number" min="0" step="0.01" inputMode="decimal" value={draft.traffic} onChange={(event) => updateDraft(user.accountId, "traffic", event.target.value)} disabled={state !== "ready" || blocked || saving} aria-label={`${user.displayName}月流量额度 GiB`} /></label>
              <button className="secondary-button" type="button" onClick={() => void save(user)} disabled={state !== "ready" || blocked || saving || !changed || !valid || wouldOverAllocate}>
                {saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}<span>{saving ? "保存中" : "保存额度"}</span>
              </button>
            </div>
            {blocked ? <small className="pool-quota-hint">历史用量或账本尚未核对，额度编辑暂不可用。</small> : null}
            {wouldOverAllocate ? <small className="pool-quota-hint is-error">当前项目可分配余额不足，保存已禁用。</small> : null}
          </article>;
        })}
      </div>
    </> : null}

    {error && state === "ready" ? <p className="pool-usage-error" role="alert">{error}</p> : null}
    {notice ? <p className="pool-usage-notice" role="status">{notice}</p> : null}
  </section>;
}
