import { useEffect, useRef, useState } from "react";
import { PHOTO_WALL_ENABLED, PHOTO_WALL_DEFAULTS, photoWallPreferences, type PhotoWallPreferences } from "@lifeos/core";
import { apiRequest } from "./api";
import { errorMessage } from "./app-meta";
import "./calendar-background.css";

interface BackgroundStatus { count: number; minPhotos: number; tierPhotos: number; nextTier: number; automaticGeneration: boolean; imageUrl: string | null; version: string | null }
const sliders = [
  ["veil", "白蒙版", 0, 100, 1, "%"], ["shadow", "阴影", 0, 60, 1, "%"],
  ["border", "白边", 0, 16, 1, "px"], ["gap", "间距", 0, 32, 1, "px"],
  ["tilt", "倾斜", 0, 8, .5, "°"],
  ["seed", "排布", 1, 9999, 1, ""],
] as const;

interface CalendarBackgroundSettingsProps { month: string; hideDemo: boolean; scope: string }
export function CalendarBackgroundSettings(props: CalendarBackgroundSettingsProps) {
  return PHOTO_WALL_ENABLED ? <ActiveCalendarBackgroundSettings {...props} /> : null;
}
function ActiveCalendarBackgroundSettings({ month, hideDemo, scope }: CalendarBackgroundSettingsProps) {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [draft, setDraft] = useState<PhotoWallPreferences | null>(null), [saved, setSaved] = useState<PhotoWallPreferences | null>(null);
  const [busy, setBusy] = useState<"save" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const query = new URLSearchParams({ month, hideDemo: hideDemo ? "1" : "0" }).toString();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const check = async (signal: AbortSignal, loadAppearance = false) => {
    try {
      const [next, preferences] = await Promise.all([
        apiRequest<BackgroundStatus>(`/api/calendar/background?${query}`, { signal }),
        loadAppearance ? apiRequest("/api/calendar/background/settings", { signal }).then(photoWallPreferences) : null,
      ]);
      if (!signal.aborted) { setStatus(next); setError(null); if (preferences) { setDraft(preferences); setSaved(preferences); } }
    } catch (cause) {
      if (!signal.aborted) { setStatus(null); setError(errorMessage(cause, "照片数量或外观暂时无法读取，请重试")); }
    }
  };
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    setStatus(null); setDraft(null); setSaved(null); setError(null); setMessage(null); setBusy(null); running.current = false;
    const refresh = () => { if (!running.current) void check(active.signal); };
    void check(active.signal, true);
    window.addEventListener("focus", refresh);
    window.addEventListener("lifeos:background-revalidate", refresh);
    return () => { active.abort(); window.removeEventListener("focus", refresh); window.removeEventListener("lifeos:background-revalidate", refresh); };
  }, [query, scope]);

  const persist = async (signal: AbortSignal) => {
    if (!draft) throw Error("外观尚未读取，请重试");
    if (!dirty) return;
    const preferences = photoWallPreferences(await apiRequest("/api/calendar/background/settings", { method: "PUT", body: JSON.stringify(draft), signal }));
    if (signal.aborted) return;
    setSaved(preferences); setDraft(preferences);
    window.dispatchEvent(new CustomEvent("lifeos:background-settings", { detail: { scope, preferences } }));
  };
  const run = async (action: "save" | "generate") => {
    const active = controller.current;
    if (!active || running.current || !draft || (action === "generate" && (!status || status.count < status.minPhotos))) return;
    running.current = true; setBusy(action); setError(null); setMessage(null);
    try {
      await persist(active.signal);
      if (active.signal.aborted) return;
      if (action === "generate") {
        const next = await apiRequest<BackgroundStatus>(`/api/calendar/background/generate?${query}`, { method: "POST", signal: active.signal });
        if (active.signal.aborted) return;
        setStatus(next); setMessage("背景已生成并启用");
        window.dispatchEvent(new CustomEvent("lifeos:background-generated", { detail: { month, hideDemo, scope, ...next } }));
      } else setMessage("外观已保存，拼贴调整可通过立即生成生效");
    } catch (cause) {
      if (!active.signal.aborted) {
        await check(active.signal);
        if (!active.signal.aborted) setError(errorMessage(cause, "操作失败，请重试"));
      }
    } finally {
      if (!active.signal.aborted) { running.current = false; setBusy(null); }
    }
  };

  return <section className="calendar-settings-block calendar-background-settings" aria-labelledby="calendar-background-settings-title">
    <p className="eyebrow" id="calendar-background-settings-title">月历照片背景</p>
    <p className="settings-ai-note" data-background-count>{month.replace("-", " 年 ")} 月{status ? `有 ${status.count} 张有效照片，至少需要 ${status.minPhotos} 张。` : error ? "照片数量暂不可用。" : "正在确认照片数量。"}</p>
    {status ? <p className="settings-ai-note" data-background-tier>{status.tierPhotos ? `当前档位拼 ${status.tierPhotos} 张；下一档 ${status.nextTier} 张，还差 ${status.nextTier - status.count} 张。` : `再有 ${status.minPhotos - status.count} 张有效照片即可生成。`}{status.automaticGeneration ? "跨档后在午夜自动更新。" : "定时生成已停用，已有背景继续保留。"}立即生成按当前档位取图。</p> : null}
    <div className="calendar-background-controls">
      <label>排法<select data-background-field="layout" value={draft?.layout ?? PHOTO_WALL_DEFAULTS.layout} disabled={!!busy || !draft} onChange={e => setDraft(current => current ? { ...current, layout: e.target.value as PhotoWallPreferences["layout"] } : current)}><option value="rows">齐边拼贴</option><option value="masonry">错落照片墙</option><option value="scattered">散落相纸</option></select></label>
      {sliders.map(([key, label, min, max, step, unit]) => <label key={key}><span>{label}<output>{draft?.[key] ?? PHOTO_WALL_DEFAULTS[key]}{unit}</output></span><input type="range" data-background-field={key} aria-label={label} min={min} max={max} step={step} value={draft?.[key] ?? PHOTO_WALL_DEFAULTS[key]} disabled={!!busy || !draft || (key === "tilt" && draft.layout !== "scattered")} onChange={e => setDraft(current => current ? { ...current, [key]: Number(e.target.value) } : current)} /></label>)}
    </div>
    <p className="settings-ai-note">照片保留原始比例，背景随页面滚动，底部重复铺满。重复部分和日期汉字底图不计入有效照片。蒙版保存后生效；立即生成会先保存当前参数。</p>
    <div className="calendar-settings-actions">
      <button className="secondary-button" type="button" data-background-save disabled={!!busy || !draft || !dirty} onClick={() => void run("save")}>{busy === "save" ? "保存中…" : "保存外观"}</button>
      <button className="secondary-button" type="button" data-background-reset disabled={!!busy || !draft} onClick={() => { setDraft({ ...PHOTO_WALL_DEFAULTS }); setMessage(null); }}>恢复默认</button>
      <button className="secondary-button" type="button" data-background-generate disabled={!!busy || !draft || !status || status.count < status.minPhotos} onClick={() => void run("generate")}>{busy === "generate" ? "生成中…" : "立即生成背景"}</button>
      {error && !busy ? <button className="secondary-button" type="button" onClick={() => { const active = controller.current; if (active) void check(active.signal, !draft); }}>重新检查</button> : null}
    </div>
    {error || message ? <p className={`settings-ai-note ${error ? "settings-inline-error" : "settings-inline-success"}`} role="status">{error ?? message}</p> : null}
  </section>;
}
