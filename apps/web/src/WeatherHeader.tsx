import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, CloudSun, LoaderCircle, MapPin, Settings2 } from "lucide-react";
import { apiRequest } from "./api";
import { getWeatherDecision, getWeatherPhase, findWeatherDay, type WeatherCategory, type WeatherConfigStatus, type WeatherLocation, type WeatherSnapshot } from "./weather";
import { WeatherSky } from "./WeatherBackground";
import { localDateToday, localNowInput, shiftDate, weekdayShort } from "./time";
import { weatherLocationDisplayName } from "./weather-locations";

interface WeatherPayload {
  readonly weatherSnapshot: WeatherSnapshot | null;
  readonly location: WeatherLocation | null;
  /** Present when the server refused a manual refresh and said how long to wait. */
  readonly throttled?: boolean;
  readonly retryAfterMs?: number;
}

interface DateFlipState {
  readonly previous: string;
  readonly changed: readonly boolean[];
  readonly direction: "forward" | "backward";
  readonly id: number;
}

function dateDigits(value: string): readonly string[] {
  const compact = value.slice(5).replace("-", "");
  return compact.length === 4 ? compact.split("") : ["0", "0", "0", "0"];
}

function WeatherConditionGlyph({ category }: { readonly category: WeatherCategory }) {
  const cloud = <path d="M5.1 17.1h12.2a3.6 3.6 0 0 0 .4-7.18 5.65 5.65 0 0 0-10.86 1.2A3.02 3.02 0 0 0 5.1 17.1Z" />;
  const frame = { className: "weather-header-glyph", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.55, strokeLinecap: "round", strokeLinejoin: "round", width: 18, height: 18, "aria-hidden": true } as const;

  if (category === "sunny") return <svg {...frame}><circle cx="12" cy="12" r="3.35" fill="currentColor" stroke="none" /><path d="M12 2.7v2.15M12 19.15v2.15M2.7 12h2.15M19.15 12h2.15M5.44 5.44l1.52 1.52M17.04 17.04l1.52 1.52M18.56 5.44l-1.52 1.52M6.96 17.04l-1.52 1.52" /></svg>;
  if (category === "partly-cloudy") return <svg {...frame}><circle cx="8.6" cy="8.1" r="3" fill="currentColor" stroke="none" /><path d="M8.6 3.1v1.1M8.6 12v1.1M3.6 8.1h1.1M12.5 8.1h1.1M5.1 4.6l.8.8M12.1 11.6l.8.8M12.1 4.6l-.8.8M5.9 11.6l-.8.8" /><path d="M6.3 18h11.1a3.35 3.35 0 0 0 .3-6.68 5.1 5.1 0 0 0-9.72 1.12A2.7 2.7 0 0 0 6.3 18Z" fill="currentColor" stroke="none" opacity=".9" /></svg>;
  if (category === "thunderstorm") return <svg {...frame}>{cloud}<path d="M13.3 14.6h3.15l-3.72 5.45.47-3.1H10l3.3-4.65Z" fill="currentColor" stroke="none" /></svg>;
  if (category === "rainy" || category === "moderate-rainy" || category === "heavy-rainy" || category === "rainstorm") return <svg {...frame}>{cloud}<path d="M8.1 19.05l-.7 1.8M12.05 19.05l-.7 1.8M16 19.05l-.7 1.8" /></svg>;
  if (category === "snowy") return <svg {...frame}>{cloud}<path d="M8.1 19.2v2M7.1 20.2h2M11.9 19.2v2M10.9 20.2h2M15.7 19.2v2M14.7 20.2h2" /></svg>;
  if (category === "foggy") return <svg {...frame}><path d="M4 8.5h16M3 12h18M5 15.5h14" /></svg>;
  return <svg {...frame}>{cloud}</svg>;
}

function DateFlipControl({ selectedDate, onChange, onStep }: { readonly selectedDate: string; readonly onChange: (date: string) => void; readonly onStep?: (direction: number) => void }) {
  const today = localDateToday();
  const previousDateRef = useRef(selectedDate);
  const flipIdRef = useRef(0);
  const [flip, setFlip] = useState<DateFlipState | null>(null);
  const digits = dateDigits(selectedDate);
  const previousDigits = dateDigits(flip?.previous ?? selectedDate);
  const step = onStep ?? ((direction: number) => onChange(shiftDate(selectedDate || today, direction)));

  useEffect(() => {
    const previous = previousDateRef.current;
    if (previous === selectedDate) return;
    previousDateRef.current = selectedDate;
    const before = dateDigits(previous);
    const after = dateDigits(selectedDate);
    const next: DateFlipState = {
      previous,
      changed: after.map((digit, index) => digit !== before[index]),
      direction: selectedDate > previous ? "forward" : "backward",
      id: ++flipIdRef.current,
    };
    setFlip(next);
    const timer = window.setTimeout(() => setFlip((current) => current?.id === next.id ? null : current), 560);
    return () => window.clearTimeout(timer);
  }, [selectedDate]);

  const accessibleDate = `${Number(selectedDate.slice(5, 7))}月${Number(selectedDate.slice(8, 10))}日${weekdayShort(selectedDate)}`;
  return <div className="weather-date-navigation" aria-label="日期导航">
    <button className="weather-date-step" type="button" onClick={() => step(-1)} aria-label="前一天"><ArrowLeft size={18} strokeWidth={2} aria-hidden="true" /></button>
    <label className="weather-date-picker" aria-label={`选择日期，当前${accessibleDate}`}>
      <span className="weather-date-flaps" aria-hidden="true">
        {digits.map((digit, index) => {
          const isChanging = flip?.changed[index] === true;
          return <span className={`date-flap ${index === 2 ? "date-flap--day-start" : ""} ${isChanging ? `is-flipping is-flipping--${flip?.direction}` : ""}`} key={isChanging ? `${flip?.id}-${index}` : index}>
            <span className="date-flap-face">{digit}</span>
            {isChanging ? <span className="date-flap-leaf"><span>{previousDigits[index]}</span></span> : null}
          </span>;
        })}
      </span>
      <CalendarDays className="weather-date-calendar" size={15} strokeWidth={1.9} aria-hidden="true" />
      <input type="date" value={selectedDate} onChange={(event) => { if (event.target.value) onChange(event.target.value); }} aria-label={`选择日期，当前${accessibleDate}`} />
    </label>
    <span className="weather-date-context">
      <strong>{weekdayShort(selectedDate)}</strong>
      {selectedDate === today ? <small>今天</small> : <button className="weather-return-today" type="button" onClick={() => onChange(today)} aria-label="回到今天">回今天</button>}
    </span>
    <button className="weather-date-step" type="button" onClick={() => step(1)} aria-label="后一天"><ArrowRight size={18} strokeWidth={2} aria-hidden="true" /></button>
  </div>;
}

export function WeatherHeader({ selectedDate, status, onOpenSettings, onDateChange, onDateStep, onNotice }: { readonly selectedDate: string; readonly status: WeatherConfigStatus | null; readonly onOpenSettings: () => void; readonly onDateChange: (date: string) => void; readonly onDateStep?: (direction: number) => void; readonly onNotice?: (message: string, tone?: "ok" | "warn") => void }) {
  const [payload, setPayload] = useState<WeatherPayload>({ weatherSnapshot: null, location: null });
  const [loading, setLoading] = useState(false);
  // Only a manual press spins the refresh button. Stepping through dates also
  // refreshes, and flipping that icon on every step read as the button
  // flickering. The sky dissolve and the date flip already say "something
  // changed", so the automatic path stays quiet.
  const [manualBusy, setManualBusy] = useState(false);
  // A refused manual refresh arms the escape hatch: pressing again asks the
  // server to escalate, which is the owner saying they do not care about the
  // quota. Cleared by a successful refresh.
  const [armed, setArmed] = useState(false);
  const today = localDateToday();
  const refresh = useCallback(async (options: { readonly manual?: boolean; readonly escalate?: boolean } = {}) => {
    if (!status?.configured) {
      setPayload({ weatherSnapshot: null, location: null });
      return;
    }
    setLoading(true);
    const isManual = options.manual === true;
    if (isManual) setManualBusy(true);
    try {
      const query = selectedDate && selectedDate !== today ? `&date=${encodeURIComponent(selectedDate)}` : "";
      const manual = options.manual === true ? `&force=1${options.escalate === true ? "&escalate=1" : ""}` : "";
      const next = await apiRequest<WeatherPayload>(`/api/weather?x=1${query}${manual}`);
      setPayload(next);
      if (next.throttled === true) {
        const seconds = Math.max(1, Math.ceil((next.retryAfterMs ?? 0) / 1000));
        setArmed(true);
        onNotice?.(`刷新太快了，${seconds} 秒后再试`, "warn");
      } else if (options.manual === true) {
        setArmed(false);
        onNotice?.("天气已刷新", "ok");
      }
    } catch {
      setPayload({ weatherSnapshot: null, location: null });
      if (isManual) onNotice?.("天气刷新失败，请稍后重试", "warn");
    } finally {
      setLoading(false);
      if (isManual) setManualBusy(false);
    }
  }, [selectedDate, status?.configured, today, onNotice]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const displayDay = findWeatherDay(payload.weatherSnapshot, selectedDate) ?? payload.weatherSnapshot?.today ?? null;
  const decision = getWeatherDecision(payload.weatherSnapshot, displayDay);
  // The phase only says what colour the sky is and where the light sits. It
  // rides on the same 30-minute refresh as the forecast, so a dawn card can
  // linger a few minutes past sunrise; that is cheaper than a per-minute tick.
  const phase = getWeatherPhase(displayDay, selectedDate, today, localNowInput().slice(11, 16));
  // Use the location returned with this day's weather.  A historical response
  // must not inherit the currently configured city merely because its label is
  // missing or encoded as a legacy numeric ID.
  const locationLabel = payload.location === null
    ? "地点未知"
    : weatherLocationDisplayName(payload.location);
  const temperature = displayDay ? `${displayDay.tempMin}~${displayDay.tempMax}°` : null;

  const weatherSceneClass = displayDay && decision ? `weather-header--${decision.category} weather-header--${phase}` : "weather-header--empty";
  return <section className={`weather-header ${weatherSceneClass}`} aria-label={`${selectedDate} 的天气`}>
    {displayDay && decision ? <div className="weather-header-background" aria-hidden="true"><WeatherSky category={decision.category} phase={phase} /></div> : null}
    <div className="weather-header-scrim" aria-hidden="true" />
    <div className="weather-header-content">
      <DateFlipControl selectedDate={selectedDate} onChange={onDateChange} onStep={onDateStep} />
      <div className="weather-header-summary" role={status?.configured ? "button" : undefined} tabIndex={status?.configured ? 0 : undefined} aria-label={status?.configured ? `刷新${selectedDate}天气` : undefined} aria-busy={manualBusy || loading ? "true" : undefined} onClick={status?.configured ? () => void refresh({ manual: true, escalate: armed }) : undefined} onKeyDown={status?.configured ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void refresh({ manual: true, escalate: armed }); } } : undefined}>
        {status?.configured && displayDay && decision ? <>
          <span className="weather-header-place"><MapPin size={13} aria-hidden="true" />{locationLabel}</span>
          <span className="weather-header-reading"><span className="weather-header-condition"><WeatherConditionGlyph category={decision.category} /><strong>{displayDay.textDay}</strong></span><strong className="weather-header-temperature">{temperature}</strong></span>
        </> : status?.configured ? <span className="weather-header-unavailable">{loading ? "正在读取天气…" : "天气暂时不可用"}</span> : <button className="weather-configure-button" type="button" onClick={onOpenSettings}><CloudSun size={16} aria-hidden="true" /><span>天气未配置</span><Settings2 size={15} aria-hidden="true" /></button>}
      </div>
    </div>
    {status?.configured && manualBusy ? <span className="weather-header-refresh-status" aria-hidden="true"><LoaderCircle className="spin" size={15} /></span> : null}
  </section>;
}
