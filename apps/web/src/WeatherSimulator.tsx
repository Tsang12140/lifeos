import { useState } from "react";
import { WeatherSky } from "./WeatherBackground";
import { SunEventHint } from "./SunEventHint";
import { getMoonPosition, getSolarPosition, getSunEventMoment, getWeatherPhase, type WeatherCategory, type WeatherDay, type WeatherPhase } from "./weather";

const SIMULATED_DAY: WeatherDay = {
  fxDate: "2000-01-01",
  textDay: "晴",
  tempMax: "28",
  tempMin: "20",
  iconDay: "100",
  windDirDay: "",
  windScaleDay: "",
  sunrise: "06:00",
  sunset: "18:00",
};

const WEATHER_CHOICES: readonly { readonly category: WeatherCategory; readonly label: string }[] = [
  { category: "sunny", label: "晴" },
  { category: "partly-cloudy", label: "晴间多云" },
  { category: "cloudy", label: "多云" },
  { category: "overcast", label: "阴" },
  { category: "rainy", label: "小雨" },
  { category: "moderate-rainy", label: "中雨" },
  { category: "heavy-rainy", label: "大雨" },
  { category: "rainstorm", label: "暴雨" },
  { category: "thunderstorm", label: "雷雨" },
  { category: "snowy", label: "雪" },
  { category: "foggy", label: "雾" },
];

const PHASE_LABELS: Record<WeatherPhase, string> = {
  dawn: "清晨",
  morning: "上午",
  day: "白天",
  afternoon: "午后",
  dusk: "傍晚",
  night: "夜晚",
};

function clockFromMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function WeatherSimulator() {
  const [minute, setMinute] = useState(12 * 60);
  const [category, setCategory] = useState<WeatherCategory>("sunny");
  const clock = clockFromMinute(minute);
  const phase = getWeatherPhase(SIMULATED_DAY, SIMULATED_DAY.fxDate, SIMULATED_DAY.fxDate, clock);
  const solarPosition = getSolarPosition(SIMULATED_DAY, clock, true);
  const moonPosition = getMoonPosition(SIMULATED_DAY, clock, true);
  const sunEvent = getSunEventMoment(SIMULATED_DAY, clock, true);
  const weatherLabel = WEATHER_CHOICES.find((choice) => choice.category === category)?.label ?? "晴";

  return <div className="weather-simulator">
    <div className={`weather-header weather-header--${category} weather-header--${phase} weather-simulator-preview`} data-weather-simulator-preview data-category={category} data-phase={phase} aria-label={`天气预览，${clock}，${weatherLabel}，${PHASE_LABELS[phase]}`}>
      <div className="weather-header-background" aria-hidden="true"><WeatherSky category={category} phase={phase} solarPosition={solarPosition} moonPosition={moonPosition} /></div>
      <div className="weather-header-scrim" aria-hidden="true" />
      <div className="weather-simulator-preview-content">
        <div className="weather-simulator-preview-time"><strong>{clock}</strong><span>{PHASE_LABELS[phase]}</span></div>
        <div className="weather-simulator-preview-condition"><span>模拟天气</span><strong>{weatherLabel}</strong>{sunEvent ? <SunEventHint event={sunEvent} /> : null}</div>
      </div>
    </div>

    <div className="weather-simulator-controls">
      <label className="weather-simulator-choice"><span>天气</span><select value={category} aria-label="模拟天气" onChange={(event) => { const next = WEATHER_CHOICES.find((choice) => choice.category === event.target.value); if (next) setCategory(next.category); }}>{WEATHER_CHOICES.map((choice) => <option value={choice.category} key={choice.category}>{choice.label}</option>)}</select></label>
      <label className="weather-simulator-time-control" htmlFor="weather-simulator-time"><span>时间</span><output htmlFor="weather-simulator-time">{clock}</output></label>
      <input id="weather-simulator-time" className="weather-simulator-range" type="range" min="0" max="1439" step="1" value={minute} aria-label="模拟时间" aria-valuetext={clock} onChange={(event) => setMinute(Math.max(0, Math.min(1439, Number(event.target.value))))} />
      <div className="weather-simulator-ticks" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:59</span></div>
    </div>
    <p className="weather-simulator-note">示意日出 06:00，日落 18:00。这里只预览效果，不会改动真实天气。</p>
  </div>;
}
