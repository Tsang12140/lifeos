import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "./api";
import { errorMessage } from "./app-meta";
import "./pool-transition.css";

type Snapshot = {
  enabled: boolean; localPrimary: boolean; accountIds?: readonly string[] | null; busy: boolean; total: number; verifiedBytes: number;
  counts: Record<string, number>; scanError: string | null;
  issues: readonly { accountId: string; assetId: string; kind: string; state: string; error: string | null }[];
};
const reason: Record<string, string> = {
  quota_exceeded: "存储或月流量额度不足", local_source_unavailable: "旧原件缺失或无法读取",
  external_source_not_migrated: "外部引用需要单独核对", source_changed: "原件已变化，请重新扫描",
  source_changed_after_upload: "复制期间原件发生变化", source_hash_mismatch: "旧原件与登记的哈希不一致",
  readback_mismatch: "云端读回校验不一致", upload_needs_reconciliation: "上传结果待核对，暂不重复上传",
  interrupted_upload: "上次上传被中断，需要核对", interrupted_verification: "上次校验被中断，可重试",
};

export function PoolTransitionCard() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const reload = useCallback(async () => {
    try { const next = await apiRequest<Snapshot>("/api/admin/storage-pool/transition"); setData(next); setError(null); setUnavailable(false); }
    catch (cause) { setError(errorMessage(cause, "过渡状态读取失败")); setUnavailable(typeof cause === "object" && cause !== null && "status" in cause && cause.status === 503); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!data?.enabled && !data?.busy) return;
    const timer = setInterval(() => { void reload(); }, 3000);
    return () => clearInterval(timer);
  }, [data?.enabled, data?.busy, reload]);
  const act = async (action: "start" | "pause" | "scan" | "retry") => {
    setBusy(true); setError(null);
    try { setData(await apiRequest<Snapshot>("/api/admin/storage-pool/transition", { method: "POST", body: JSON.stringify({ action }) })); }
    catch (cause) { setError(errorMessage(cause, "存储过渡操作失败")); }
    finally { setBusy(false); }
  };
  return <div className="pool-transition" data-pool-transition>
    <strong>平滑接入存储池</strong>
    <p>旧存储继续读取和保存，后台复制到池中，读回校验后才计为已验证。现有文件和引用保留。</p>
    {data ? <>
      <span role="status">{data.enabled ? "双轨复制已开启" : data.localPrimary ? "后台复制已暂停，日常仍使用旧存储" : "尚未开始过渡"}{data.busy ? "，正在处理" : ""}</span>
      {data.accountIds?.length ? <small>当前只处理指定的 {data.accountIds.length} 个账号，暂停后继续不会扩大范围。</small> : null}
      <progress aria-label="存储池复制验证进度" max={Math.max(1, data.total)} value={data.counts.verified ?? 0} />
      <div className="pool-transition-counts"><span>已验证 {data.counts.verified ?? 0} / {data.total}</span><span>待处理 {(data.counts.queued ?? 0) + (data.counts.uploading ?? 0) + (data.counts.verifying ?? 0)}</span><span>失败 {data.counts.failed ?? 0}</span><span>待核对 {data.counts.pending ?? 0}</span><span>已验证大小 {(data.verifiedBytes / 1024 ** 2).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB</span></div>
      <small>包含照片等本地原件、可恢复回收站原件和加密业务数据快照。读回校验会消耗池的月流量。数据库快照恢复依赖服务器身份库中的主密钥，须继续保留现有整站备份。</small>
      {data.scanError ? <p role="alert">部分空间未能完成扫描，尚不能确认全部数据已复制。</p> : null}
      {data.issues.length ? <details><summary>查看失败和待核对项目（最多100项）</summary><ul>{data.issues.map((issue, index) => <li key={index}>{issue.kind === "database" ? "业务数据快照" : issue.assetId}：{reason[issue.error ?? ""] ?? "复制失败，请核对接入层和额度"}</li>)}</ul></details> : null}
    </> : unavailable ? <p>部署并核验同机存储池接入后，可以在这里开始复制。</p> : <p role="status">正在读取过渡状态…</p>}
    <div className="pool-transition-actions">
      <button className="primary-button" type="button" disabled={busy || unavailable || !data} onClick={() => void act(data?.enabled ? "pause" : "start")}>{busy ? "处理中" : data?.enabled ? "暂停复制" : data?.localPrimary ? "继续复制" : "开始双轨复制"}</button>
      <button className="secondary-button" type="button" disabled={busy || !data?.enabled} onClick={() => void act("scan")}>扫描新增数据</button>
      <button className="secondary-button" type="button" disabled={busy || !data?.enabled || !(data.counts.failed > 0)} onClick={() => void act("retry")}>重试失败项</button>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void reload()}>刷新状态</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
