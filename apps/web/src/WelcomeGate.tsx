import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, CloudSun, KeyRound, LoaderCircle, LocateFixed, LockKeyhole } from "lucide-react";
import { apiRequest, type AuthState } from "./api";
import { WeatherLocationPicker } from "./WeatherLocationPicker";
import { locateWeatherDevice, setWeatherFollowEnabled } from "./weather-follow";
import type { WeatherConfigStatus } from "./weather";
import type { WeatherLocationOption } from "./weather-location-types";
import "./welcome.css";

type Stage = "login" | "invite" | "create" | "weather";

function problem(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function inviteFromLink(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("invite")?.trim() ?? "";
}

export function WelcomeGate({ onLogin, loginError, loginLoading, onFinished }: {
  readonly onLogin: (username: string, password: string) => void;
  readonly loginError: string | null;
  readonly loginLoading: boolean;
  readonly onFinished: () => void;
}) {
  const [stage, setStage] = useState<Stage>(() => inviteFromLink() ? "invite" : "login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(inviteFromLink);
  const [displayName, setDisplayName] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [weatherLocation, setWeatherLocation] = useState<WeatherLocationOption | null>(null);
  const [manualWeather, setManualWeather] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An invitation link only checks the code. It never consumes the invitation
  // or creates an account until the recipient explicitly submits the form.
  useEffect(() => {
    let active = true;
    const verifyFromLink = () => {
      const code = inviteFromLink();
      if (!code) return;
      setInviteCode(code); setStage("invite"); setError(null); setBusy(true);
      void apiRequest<{ valid: boolean }>("/api/auth/invite/check", { method: "POST", body: JSON.stringify({ code }) })
        .then((result) => {
          if (!active || inviteFromLink() !== code) return;
          if (result.valid) setStage("create");
          else setError("邀请码无效或已使用，请向邀请你的人索取新的邀请码。");
        })
        .catch((cause) => { if (active && inviteFromLink() === code) setError(problem(cause, "暂时无法验证邀请码，请稍后重试。")); })
        .finally(() => { if (active && inviteFromLink() === code) setBusy(false); });
    };
    verifyFromLink();
    window.addEventListener("hashchange", verifyFromLink);
    return () => { active = false; window.removeEventListener("hashchange", verifyFromLink); };
  }, []);

  const switchTo = (next: Stage) => { setError(null); setStage(next); };
  const checkInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !inviteCode.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await apiRequest<{ valid: boolean }>("/api/auth/invite/check", { method: "POST", body: JSON.stringify({ code: inviteCode.trim() }) });
      if (!result.valid) { setError("邀请码无效或已使用，请向邀请你的人索取新的邀请码。"); return; }
      switchTo("create");
    } catch (cause) { setError(problem(cause, "暂时无法验证邀请码，请稍后重试。")); }
    finally { setBusy(false); }
  };
  const register = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const chosenName = displayName.trim() || username.trim();
      const result = await apiRequest<AuthState>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ code: inviteCode.trim(), username: username.trim(), displayName: chosenName, spaceName: `${chosenName.slice(0, 75)} 的空间`, password }),
      });
      if (!result.authenticated || !result.account?.tenantId) throw new Error("账号已创建，但登录状态无法确认，请重新登录。 ");
      if (inviteFromLink()) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setTenantId(result.account.tenantId);
      switchTo("weather");
    } catch (cause) { setError(problem(cause, "创建账号失败，请重试。")); }
    finally { setBusy(false); }
  };
  const useCurrentLocation = async () => {
    if (busy || !tenantId) return;
    setBusy(true); setError(null);
    try {
      await locateWeatherDevice();
      setWeatherFollowEnabled(tenantId, true);
      onFinished();
    } catch (cause) { setError(problem(cause, "定位失败；你也可以手动选择城市。")); }
    finally { setBusy(false); }
  };
  const useSelectedCity = async () => {
    if (busy || !tenantId || weatherLocation === null) return;
    setBusy(true); setError(null);
    try {
      await apiRequest<WeatherConfigStatus>("/api/weather/device/location", {
        method: "POST",
        body: JSON.stringify({ locationId: weatherLocation.locationId, city: weatherLocation.city }),
      });
      setWeatherFollowEnabled(tenantId, false);
      onFinished();
    } catch (cause) { setError(problem(cause, "保存城市失败，请重试。")); }
    finally { setBusy(false); }
  };

  return <main className="welcome-screen"><div className="welcome-shell">
    <div className="welcome-brand" aria-label="LifeOS"><span className="welcome-brand-mark" aria-hidden="true"><span /><span /><span /></span><span>LifeOS</span></div>
    <section className="welcome-panel" aria-labelledby="welcome-title">
      <div className="welcome-step-icon" aria-hidden="true">{stage === "weather" ? <CloudSun size={24} /> : stage === "login" ? <LockKeyhole size={24} /> : <KeyRound size={24} />}</div>
      <p className="welcome-eyebrow">{stage === "weather" ? "最后一步 · 天气" : stage === "login" ? "你的私人空间" : "受邀加入"}</p>
      <h1 id="welcome-title">{stage === "login" ? "欢迎回来" : stage === "invite" ? "输入邀请码" : stage === "create" ? "创建你的空间" : "天气位置"}</h1>
      <p className="welcome-intro">{stage === "login" ? "登录后，继续记录自己的生活。" : stage === "invite" ? "邀请码由管理员发放，只能用于创建一个独立空间。" : stage === "create" ? "设置自己的账号和密码。你的记录与其他空间互不相通。" : "选择定位，或固定一个城市。"}</p>

      {stage === "login" ? <form className="welcome-form" onSubmit={(event) => { event.preventDefault(); onLogin(username, password); }}>
        <label><span>账号</span><input autoFocus name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label><span>密码</span><input type="password" name="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {loginError ? <p className="welcome-error" role="alert">{loginError}</p> : null}
        <button className="primary-button welcome-main-action" type="submit" disabled={loginLoading || !username.trim() || !password}>{loginLoading ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}<span>{loginLoading ? "登录中…" : "进入 LifeOS"}</span></button>
        <button className="welcome-text-action" type="button" onClick={() => switchTo("invite")}>第一次来？使用邀请码创建空间</button>
      </form> : null}

      {stage === "invite" ? <form className="welcome-form" onSubmit={(event) => void checkInvite(event)}>
        <label><span>邀请码</span><input autoFocus autoComplete="off" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="粘贴管理员给你的邀请码" required /></label>
        {error ? <p className="welcome-error" role="alert">{error}</p> : null}
        <button className="primary-button welcome-main-action" type="submit" disabled={busy || !inviteCode.trim()}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}<span>{busy ? "验证中…" : "继续"}</span></button>
        <button className="welcome-text-action" type="button" onClick={() => switchTo("login")}><ArrowLeft size={15} />返回登录</button>
      </form> : null}

      {stage === "create" ? <form className="welcome-form" onSubmit={(event) => void register(event)}>
        <label><span>登录账号</span><input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} required /></label>
        <label><span>称呼（选填，与登录账号不同）</span><input autoComplete="nickname" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="可以怎么称呼你" maxLength={80} /></label>
        <label><span>设置密码（至少 10 位）</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} required /></label>
        {error ? <p className="welcome-error" role="alert">{error}</p> : null}
        <button className="primary-button welcome-main-action" type="submit" disabled={busy || !username.trim() || password.length < 10}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}<span>{busy ? "创建中…" : "创建并登录"}</span></button>
        <button className="welcome-text-action" type="button" onClick={() => switchTo("invite")}><ArrowLeft size={15} />返回邀请码</button>
      </form> : null}

      {stage === "weather" ? <div className="welcome-weather">
        <button className="welcome-location-action" type="button" onClick={() => void useCurrentLocation()} disabled={busy}><LocateFixed size={19} /><strong>允许定位</strong><ArrowRight size={17} /></button>
        <button className="welcome-location-action" type="button" onClick={() => setManualWeather((open) => !open)} aria-expanded={manualWeather} aria-controls="welcome-manual-weather" disabled={busy}><CloudSun size={19} /><strong>选固定城市</strong><ArrowRight size={17} /></button>
        {manualWeather ? <div id="welcome-manual-weather" className="welcome-manual-weather"><WeatherLocationPicker locationId={weatherLocation?.locationId ?? ""} city={weatherLocation?.city ?? ""} onChange={setWeatherLocation} disabled={busy} showDetail={false} />
          <button className="secondary-button welcome-main-action" type="button" onClick={() => void useSelectedCity()} disabled={busy || !weatherLocation?.locationId}>使用所选城市</button></div> : null}
        {error ? <p className="welcome-error" role="alert">{error}</p> : null}
        <button className="welcome-text-action" type="button" onClick={onFinished} disabled={busy}>稍后再选</button>
      </div> : null}
    </section>
    <p className="welcome-footnote">每个账号拥有独立的记录、照片和设置。</p>
  </div></main>;
}
