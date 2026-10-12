import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { apiRequest } from "./api";
import { currentCoordinates, useWeatherAutoFollow, weatherFollowEnabled } from "./weather-follow";
import type { WeatherConfigStatus } from "./weather";
import "./weather-location.css";

export interface LocationCandidate { locationId: string; city: string; source: "browser" | "ip" }
export interface AmapStatus { enabled: boolean; hasKey: boolean; keyUnreadable: boolean }
const LocationContext = createContext<{ request: () => void; busy: boolean }>({ request: () => {}, busy: false });
export const useWeatherLocation = () => useContext(LocationContext);

async function detectLocation(): Promise<LocationCandidate> {
  let coordinates;
  try { coordinates = await currentCoordinates(); }
  catch (error) {
    let config: AmapStatus | null = null;
    try { config = await apiRequest<AmapStatus>("/api/location/config"); } catch { /* Keep the browser's useful error. */ }
    if (!config?.enabled || !config.hasKey) throw error;
    try { return await apiRequest<LocationCandidate>("/api/location/ip", { method: "POST", body: "{}" }); }
    catch (fallback) { throw new Error(`${error instanceof Error ? error.message : "浏览器定位失败"} ${fallback instanceof Error ? fallback.message : "备用定位也暂时不可用"}`); }
  }
  return apiRequest<LocationCandidate>("/api/weather/device/locate", { method: "POST", body: JSON.stringify({ ...coordinates, preview: true }) });
}

export function WeatherLocationProvider({ tenantId, status, onChanged, onNotice, children }: {
  tenantId: string; status: WeatherConfigStatus | null; onChanged: () => void;
  onNotice: (message: string, tone?: "ok" | "warn") => void; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<LocationCandidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef({ status, onChanged, onNotice }); current.current = { status, onChanged, onNotice };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useWeatherAutoFollow(tenantId, onChanged);

  const apply = async (candidate: LocationCandidate) => {
    await apiRequest("/api/weather/device/location", { method: "POST", body: JSON.stringify({ locationId: candidate.locationId, city: candidate.city }) });
    if (!alive.current) return;
    current.current.onChanged(); current.current.onNotice(`已切换到${candidate.city}`, "ok");
  };
  const request = async () => {
    if (lock.current || pending) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const candidate = await detectLocation();
      if (!alive.current) return;
      if (candidate.locationId === current.current.status?.locationId) current.current.onNotice(`当前已是${candidate.city}${candidate.source === "ip" ? "（网络大致定位）" : ""}`, "ok");
      else if (weatherFollowEnabled(tenantId) && candidate.source === "browser") await apply(candidate);
      else setPending(candidate);
    } catch (cause) { if (alive.current) current.current.onNotice(cause instanceof Error ? cause.message : "获取当前位置失败，请重试", "warn"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const confirm = async () => {
    if (!pending || lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await apply(pending); if (alive.current) setPending(null); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "切换城市失败，请重试"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    if (pending && !dialog.current?.open) dialog.current?.showModal();
    else if (!pending && dialog.current?.open) dialog.current.close();
  }, [pending]);

  // Entering a page must not trigger a new permission prompt. Fixed-city mode
  // only detects in the background; it never saves or opens a confirmation.
  useEffect(() => {
    let active = true;
    let lastAttempt = 0;
    const check = async () => {
      if (document.visibilityState !== "visible" || weatherFollowEnabled(tenantId) || Date.now() - lastAttempt < 15 * 60_000) return;
      lastAttempt = Date.now();
      try {
        if (!navigator.permissions?.query) return;
        const permission = await navigator.permissions.query({ name: "geolocation" });
        if (permission.state !== "granted" || !active) return;
        const coordinates = await currentCoordinates();
        if (!active) return;
        const candidate = await apiRequest<LocationCandidate>("/api/weather/device/locate", { method: "POST", body: JSON.stringify({ ...coordinates, preview: true }) });
        if (active && candidate.locationId !== current.current.status?.locationId) current.current.onNotice(`检测到你在${candidate.city}，点击天气卡的城市可切换。`, "ok");
      } catch { /* Automatic detection is optional and keeps the chosen city. */ }
    };
    void check(); document.addEventListener("visibilitychange", check);
    return () => { active = false; document.removeEventListener("visibilitychange", check); };
  }, [tenantId]);

  return <LocationContext.Provider value={{ request: () => void request(), busy }}>
    {children}
    <dialog ref={dialog} className="modal-dialog weather-location-dialog" aria-labelledby="weather-location-title" onCancel={event => { event.preventDefault(); if (!busy) setPending(null); }}>
      <h2 id="weather-location-title">切换天气城市？</h2>
      {pending ? <p>{pending.source === "ip" ? "根据网络推测你在" : "检测到你当前位于"}<strong>{pending.city}</strong>。当前天气城市是<strong>{status?.city || "未选择"}</strong>，是否切换？</p> : null}
      <p className="weather-location-note">{pending?.source === "ip" ? "网络定位可能有偏差。" : ""}本次切换不会改变“跟随当前位置”开关。</p>
      {error ? <p role="alert" className="settings-inline-error">{error}</p> : null}
      <div className="weather-location-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setPending(null)}>保留当前城市</button><button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? "切换中…" : `切换到${pending?.city ?? "定位城市"}`}</button></div>
    </dialog>
  </LocationContext.Provider>;
}

export function AmapLocationSettings() {
  const [status, setStatus] = useState<AmapStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [key, setKey] = useState("");
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setStatus(null); setError(null);
    void apiRequest<AmapStatus>("/api/location/config").then(value => { if (active) { setStatus(value); setEnabled(value.enabled); } }, cause => { if (active) setError(cause instanceof Error ? cause.message : "高德配置读取失败"); });
    return () => { active = false; };
  }, [retry]);
  const save = async () => {
    if (!status || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const value = await apiRequest<AmapStatus>("/api/location/config", { method: "POST", body: JSON.stringify({ enabled, ...(key.trim() ? { apiKey: key.trim() } : {}), clearApiKey: clear }) });
      setStatus(value); setKey(""); setClear(false); setMessage("高德配置已保存");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "高德配置保存失败"); }
    finally { setBusy(false); }
  };
  return <section className="settings-amap-card" aria-labelledby="amap-title">
    <h3 id="amap-title">高德备用定位</h3>
    <p className="weather-location-note">优先使用浏览器定位。启用后，手动定位失败时通过高德查询大致城市，仅支持国内 IPv4。Key 在服务器加密保存，也为后续地点搜索预留。</p>
    <label className="weather-location-option"><input type="checkbox" checked={enabled} disabled={!status || busy} onChange={event => setEnabled(event.target.checked)} />启用网络备用定位</label>
    <label className="dialog-field"><span>高德 Web 服务 API Key{status?.hasKey ? "（已配置，留空保留）" : ""}</span><input type="password" autoComplete="new-password" value={key} disabled={!status || busy || clear} onChange={event => setKey(event.target.value)} /></label>
    {status?.keyUnreadable ? <p role="alert" className="settings-inline-error">已保存的 Key 暂时无法解密，请检查服务端配置；留空保存会保留原密文。</p> : null}
    {status?.hasKey || status?.keyUnreadable ? <label className="weather-location-option"><input type="checkbox" checked={clear} disabled={busy} onChange={event => setClear(event.target.checked)} />清除已保存的高德 Key</label> : null}
    <div className="weather-location-actions"><button type="button" className="secondary-button" disabled={!status || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存高德配置"}</button>{!status && error ? <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>重试读取</button> : null}</div>
    {message ? <p role="status">{message}</p> : null}{error ? <p role="alert" className="settings-inline-error">{error}</p> : null}
  </section>;
}
