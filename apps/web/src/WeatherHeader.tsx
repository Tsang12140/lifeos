import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, CloudSun, LoaderCircle, MapPin, RefreshCw, Settings2 } from "lucide-react";
import { apiRequest } from "./api";
import { getWeatherDecision, getWeatherEmoji, getWeatherPhase, findWeatherDay, type WeatherConfigStatus, type WeatherLocation, type WeatherSnapshot } from "./weather";
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
      <span className="weather-date-context"><strong>{weekdayShort(selectedDate)}</strong><small>{selectedDate === today ? "今天" : ""}</small></span>
      <CalendarDays className="weather-date-calendar" size={15} strokeWidth={1.9} aria-hidden="true" />
      <input type="date" value={selectedDate} onChange={(event) => { if (event.target.value) onChange(event.target.value); }} aria-label={`选择日期，当前${accessibleDate}`} />
    </label>
    <button className="weather-date-step" type="button" onClick={() => step(1)} aria-label="后一天"><ArrowRight size={18} strokeWidth={2} aria-hidden="true" /></button>
    {selectedDate !== today ? <button className="weather-return-today" type="button" onClick={() => onChange(today)}>回到今天</button> : null}
  </div>;
}

export function WeatherHeader({ selectedDate, status, onOpenSettings, onDateChange, onDateStep, onNotice }: { readonly selectedDate: string; readonly status: WeatherConfigStatus | null; readonly onOpenSettings: () => void; readonly onDateChange: (date: string) => void; readonly onDateStep?: (direction: number) => void; readonly onNotice?: (message: string) => void }) {
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
        onNotice?.(`刷新太快了，${seconds} 秒后再试`);
      } else if (options.manual === true) {
        setArmed(false);
      }
    } catch {
      setPayload({ weatherSnapshot: null, location: null });
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

  return <section className={`weather-header ${displayDay && decision ? `weather-header--${decision.category}` : "weather-header--empty"}`} aria-label={`${selectedDate} 的天气`}>
    {displayDay && decision ? <div className="weather-header-background" aria-hidden="true"><WeatherSky category={decision.category} phase={phase} /></div> : null}
    <div className="weather-header-scrim" aria-hidden="true" />
    <div className="weather-header-content">
      <DateFlipControl selectedDate={selectedDate} onChange={onDateChange} onStep={onDateStep} />
      <div className="weather-header-summary">
        {status?.configured && displayDay && decision ? <>
          <span className="weather-header-place"><MapPin size={13} aria-hidden="true" />{locationLabel}</span>
          <span className="weather-header-reading"><span className="weather-header-condition"><span className="weather-header-emoji" aria-hidden="true">{getWeatherEmoji(displayDay.iconDay)}</span><strong>{displayDay.textDay}</strong></span><strong className="weather-header-temperature">{temperature}</strong></span>
        </> : status?.configured ? <span className="weather-header-unavailable">{loading ? "正在读取天气…" : "天气暂时不可用"}</span> : <button className="weather-configure-button" type="button" onClick={onOpenSettings}><CloudSun size={16} aria-hidden="true" /><span>天气未配置</span><Settings2 size={15} aria-hidden="true" /></button>}
      </div>
    </div>
    {status?.configured ? <div className="weather-header-actions">
      <button className="weather-header-refresh" type="button" onClick={() => void refresh({ manual: true, escalate: armed })} aria-label={`刷新${selectedDate}天气`} title={armed ? "刷新天气（再按一次立即刷新）" : "刷新天气"} data-weather-armed={armed ? "on" : "off"}>{manualBusy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}</button>
    </div> : null}
  </section>;
}
