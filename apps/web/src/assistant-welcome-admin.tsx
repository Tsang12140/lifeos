import { useEffect, useState, type FormEvent } from "react";
import type { WelcomeAdminSnapshot, WelcomePromptStats } from "@lifeos/core";
import { apiRequest } from "./api";
import "./assistant-welcome-admin.css";

const failure = (error: unknown) => error instanceof Error ? error.message : "暂时无法读取，请重试";
type Draft = { id: string | null; revision: number; text: string; enabled: boolean; general: boolean; pinned: boolean };
const emptyDraft = (): Draft => ({ id: null, revision: 0, text: "", enabled: true, general: false, pinned: false });
export function AssistantWelcomeAdmin({ statistics }: { readonly statistics: boolean }) {
  const [snapshot, setSnapshot] = useState<WelcomeAdminSnapshot | null>(null);
  const [days, setDays] = useState<7 | 30 | 0>(30), [all, setAll] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    void apiRequest<WelcomeAdminSnapshot>(`/api/admin/assistant-welcome?days=${days}`).then(value => { if (active) setSnapshot(value); }).catch(e => { if (active) setError(failure(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, reload]);
  const load = async () => { const value = await apiRequest<WelcomeAdminSnapshot>(`/api/admin/assistant-welcome?days=${days}`); setSnapshot(value); };
  const toggle = async (item: WelcomePromptStats) => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await apiRequest(`/api/admin/assistant-welcome/${item.id}`, { method: "PATCH", body: JSON.stringify({ revision: item.revision, enabled: !item.enabled }) }); await load(); setNotice(item.enabled ? "已停用" : "已启用"); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!draft || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(draft.id ? `/api/admin/assistant-welcome/${draft.id}` : "/api/admin/assistant-welcome", { method: draft.id ? "PATCH" : "POST", body: JSON.stringify(draft.id ? { revision: draft.revision, text: draft.text, enabled: draft.enabled, general: draft.general, pinned: draft.pinned } : { text: draft.text, general: draft.general }) });
      setDraft(null); await load(); setNotice("已保存");
    } catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  const items = snapshot?.items ?? [], enabled = items.filter(p => p.enabled);
  const rows = statistics ? [...items].sort((a, b) => Number(a.pinned) - Number(b.pinned) || b.clicks - a.clicks || b.impressions - a.impressions || a.id.localeCompare(b.id)) : items.filter(item => all || item.enabled);
  return <section className="welcome-admin" aria-label={statistics ? "开场问题点击统计" : "开场问题候选管理"}>
    <div className="welcome-admin-toolbar"><p>{enabled.length} 条启用，{items.length - enabled.length} 条停用</p><div className="welcome-admin-actions">{statistics ? <label>统计范围<select aria-label="开场问题统计范围" value={days} disabled={busy || loading} onChange={e => setDays(Number(e.target.value) as 7 | 30 | 0)}><option value={7}>近7天</option><option value={30}>近30天</option><option value={0}>近一年</option></select></label> : <><label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />显示停用项</label><button type="button" className="secondary-button" disabled={busy} onClick={() => { setDraft(emptyDraft()); setNotice(""); }}>新增问题</button></>}<button className="secondary-button" type="button" disabled={busy || loading} onClick={() => setReload(n => n + 1)}>刷新</button></div></div>
    {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}{notice ? <p role="status" className="settings-inline-notice">{notice}</p> : null}
    {draft && !statistics ? <form className="welcome-admin-editor" onSubmit={save}><h3>{draft.id ? "编辑问题" : "新增问题"}</h3><label className="dialog-field"><span>问题文案</span><textarea aria-label="开场问题文案" value={draft.text} maxLength={120} rows={2} required disabled={busy} onChange={e => setDraft({ ...draft, text: e.target.value.replace(/[\r\n]/g, "") })} /></label><div className="welcome-admin-options"><label><input type="checkbox" checked={draft.general} disabled={busy} onChange={e => setDraft({ ...draft, general: e.target.checked })} />较通用，略提高出现机会</label>{draft.id ? <><label><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e => setDraft({ ...draft, enabled: e.target.checked, pinned: e.target.checked && draft.pinned })} />启用</label><label><input type="checkbox" checked={draft.pinned} disabled={busy || !draft.enabled} onChange={e => setDraft({ ...draft, pinned: e.target.checked })} />首条常驻</label></> : null}</div><p>改写文案会另起一版统计。最多一条常驻，其余位置随机轮换。</p><div className="welcome-admin-actions"><button type="submit" className="primary-button" disabled={busy || !draft.text.trim()}>{busy ? "保存中…" : "保存"}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(null)}>取消</button></div></form> : null}
    {loading ? <p role="status">正在读取…</p> : snapshot ? statistics ? <><p className="welcome-admin-note">按当前文案版本统计。点击率＝点击次数 ÷ 展示次数；常驻项单独标记，样本不足10次时暂不判断热度。</p><div className="welcome-admin-table-wrap"><table className="welcome-admin-table"><thead><tr><th scope="col">问题</th><th scope="col">展示</th><th scope="col">点击</th><th scope="col">点击率</th><th scope="col">样本</th></tr></thead><tbody>{rows.map(item => <tr key={item.id} data-prompt-id={item.id}><th scope="row">{item.text}{item.pinned ? <small>常驻</small> : !item.enabled ? <small>停用</small> : null}</th><td>{item.impressions}</td><td>{item.clicks}</td><td>{(item.clickRate * 100).toFixed(1)}%</td><td>{item.impressions < 10 ? "数据不足" : "可参考"}</td></tr>)}</tbody></table></div></> : <div className="welcome-admin-list">{rows.map(item => <div className="welcome-admin-row" key={item.id} data-prompt-id={item.id}><div className="welcome-admin-copy"><p>{item.text}</p><small>{item.enabled ? "启用" : "停用"}{item.general ? "　较通用" : ""}{item.pinned ? "　常驻" : ""}</small></div><div className="welcome-admin-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setDraft({ ...item }); setNotice(""); }}>编辑</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void toggle(item)}>{item.enabled ? "停用" : "启用"}</button></div></div>)}</div> : null}
    <details className="welcome-admin-rules"><summary>轮换规则</summary><p>默认三个位置随机选取，不重复。普通项基础权重1，较通用项1.15；点击反馈最多增加0.05，总权重不超过1.20，不因点击而降低其他问题的基础机会。</p><p>反馈只使用近30天数据，同一账号每天对同一版问题最多贡献一次展示和一次点击，再加入100次未点击展示的平滑量。重复点击不会放大反馈。上面的次数保留去重后的真实展示与点击，和用于权重的每日限额分开计算。</p></details>
  </section>;
}
