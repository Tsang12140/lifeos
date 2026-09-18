/**
 * The three-rung location picker for Settings > 天气.
 *
 * ── Design constraints this satisfies ────────────────────────────────────────
 *  1. "不应该说什么用户输入什么城市，结果搜又搜不到" — there is no free-text
 *     search box at all. Every rung is a `<select>` fed from the offline
 *     catalog, so an unfindable input is structurally impossible.
 *  2. 省 -> 市 -> 区, and 区 is optional: the city rung always carries a usable
 *     Location ID, so "select to 市 and stop" is a complete choice. Nationwide
 *     there are ~2800 districts; forcing a third pick every time would be
 *     exactly the friction the owner is trying to avoid.
 *  3. Reopening Settings must show the *current* selection, so the component
 *     accepts the stored locationId/city and seeds its three rungs from it.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It does not talk to the network. GeoAPI remains the authority for place names
 * outside China, which is why the caller keeps a "手动输入 Location ID" escape
 * hatch for that case (see the Settings form).
 */
import { useEffect, useMemo, useState } from "react";
import {
  describeWeatherLocationByName,
  listCities,
  listDistricts,
  listProvinces,
  resolveWeatherLocation,
  weatherLocationCatalogMeta,
} from "./weather-locations";
import type { WeatherLocationOption } from "./weather-location-types";

export interface WeatherLocationPickerProps {
  /** The currently saved Location ID, if any. */
  readonly locationId: string;
  /** The currently saved city label, used when there is no ID to reverse-look. */
  readonly city: string;
  /** Fired whenever a complete (province + city) pick resolves. */
  readonly onChange: (option: WeatherLocationOption) => void;
  readonly disabled?: boolean;
}

export function WeatherLocationPicker({ locationId, city, onChange, disabled = false }: WeatherLocationPickerProps) {
  const provinces = useMemo(() => listProvinces(), []);
  const [province, setProvince] = useState("");
  const [cityName, setCityName] = useState("");
  const [district, setDistrict] = useState("");

  /**
   * Seed the ladder from whatever is already saved. Prefer the ID (exact), and
   * fall back to the name, because configurations written before this picker
   * existed often hold a human label like "佛山南海区" with no ID at all.
   *
   * A stored value that resolves to nothing (e.g. an overseas Location ID typed
   * by hand) deliberately leaves the ladder on its placeholder rather than
   * guessing — the caller shows the raw ID next to the picker so it is not lost.
   */
  useEffect(() => {
    const found = locationId.trim() !== "" ? describeWeatherLocationByName(locationId) : null;
    const resolved = found ?? (city.trim() !== "" ? describeWeatherLocationByName(city) : null);
    if (resolved === null) return;
    setProvince(resolved.province);
    setCityName(resolved.city);
    setDistrict(resolved.district ?? "");
  }, [locationId, city]);

  const cities = useMemo(() => (province === "" ? [] : listCities(province)), [province]);
  const districts = useMemo(
    () => (province === "" || cityName === "" ? [] : listDistricts(province, cityName)),
    [province, cityName],
  );

  /**
   * Changing a higher rung invalidates everything below it. Without this,
   * switching 广东 -> 北京 could leave 南海 selected, and the resolver would
   * silently fall back to a district-less pick — the owner would see 北京 but
   * the form would carry a Guangdong ID.
   */
  const changeProvince = (next: string) => {
    setProvince(next);
    setCityName("");
    setDistrict("");
    onChange(resolveWeatherLocation({ province: next, city: "" }) ?? { locationId: "", city: "", province: next, cityName: "" });
  };
  const changeCity = (next: string) => {
    setCityName(next);
    setDistrict("");
    const resolved = resolveWeatherLocation({ province, city: next });
    if (resolved !== null) onChange(resolved);
  };
  const changeDistrict = (next: string) => {
    setDistrict(next);
    const resolved = resolveWeatherLocation({ province, city: cityName, district: next });
    if (resolved !== null) onChange(resolved);
  };

  const meta = weatherLocationCatalogMeta();
  const preview = resolveWeatherLocation({ province, city: cityName, district });
  const selected = preview !== null && preview.cityName !== "" ? preview : null;

  return (
    <fieldset className="settings-weather-location" disabled={disabled}>
      <div className="settings-weather-location-row">
        <label>
          <span>省 / 直辖市 / 地区</span>
          <select value={province} onChange={(event) => changeProvince(event.target.value)}>
            <option value="">请选择</option>
            {provinces.map((name) => <option value={name} key={name}>{name}</option>)}
          </select>
        </label>
        <label>
          <span>市 / 州</span>
          <select value={cityName} onChange={(event) => changeCity(event.target.value)} disabled={province === ""}>
            <option value="">{province === "" ? "请先选择上级" : "请选择"}</option>
            {cities.map((entry) => <option value={entry.name} key={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        <label>
          {/* Explicitly optional: the city rung alone is a valid, complete pick. */}
          <span>区 / 县（选填）</span>
          <select value={district} onChange={(event) => changeDistrict(event.target.value)} disabled={cityName === ""}>
            <option value="">{districts.length === 0 ? (cityName === "" ? "请先选择上级" : "该市暂无下级选项") : "不选（用全市）"}</option>
            {districts.map((entry) => <option value={entry.name} key={entry.id}>{entry.name}</option>)}
          </select>
        </label>
      </div>

      <p className="settings-weather-location-note" data-weather-location-note>
        {selected === null
          ? `下拉数据内置了 ${meta.provinceCount} 个省级、${meta.cityCount} 个市级、共 ${meta.locationCount} 个和风天气位置，选择即得 Location ID，不依赖网络。`
          : <>将使用 <code>{selected.locationId}</code> · {selected.city}{selected.districtName === undefined ? "（全市）" : ""}{selected.seatOnly === true ? " · 该州没有全域记录，此为州府数据" : ""}</>}
      </p>
    </fieldset>
  );
}
