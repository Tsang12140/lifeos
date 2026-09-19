/**
 * Offline lookup over the compiled QWeather location ladder.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The owner's requirement: "不应该说什么用户输入什么城市，结果搜又搜不到之类的"
 * — the Settings dropdown must always produce a Location ID, never a dead end.
 * So the province/city/district table is compiled into the bundle at build time
 * (see compile-locations.mjs) and resolved locally. No network call, no QWeather
 * quota, no "not found".
 *
 * ── What this file is NOT ────────────────────────────────────────────────────
 * It is not a free-text city search. GeoAPI's `/v2/city/lookup` remains the
 * authority for arbitrary strings (and for anything outside China), and the API
 * side still falls back to it when `locationId` is empty. This module only
 * serves the three dropdowns.
 *
 * ── Shape of the ladder ──────────────────────────────────────────────────────
 *   Province (34)  ->  City (392)  ->  District (optional, 0..n)
 * `adm2` is the city rung, and for municipalities (北京/上海/天津/重庆) the
 * municipality *is* the city rung, with its districts underneath. The city rung
 * always carries a usable Location ID, which is what makes "select to 市 and
 * stop" a valid choice.
 */
import type { WeatherLocationOption } from "./weather-location-types";
import data from "./weather-locations.data.json";

interface RawDistrict {
  readonly id: string;
  readonly name: string;
  readonly timeZone?: string;
}

interface RawCity {
  readonly id: string;
  readonly name: string;
  readonly timeZone?: string;
  /** The city rung borrowed its seat's ID: the source has no region-wide row. */
  readonly seatOnly?: boolean;
  readonly districts: readonly RawDistrict[];
}

interface RawProvince {
  readonly name: string;
  readonly cities: readonly RawCity[];
}

interface RawLocationData {
  readonly source: string;
  readonly sourceUrl: string;
  readonly generatedAt: string;
  readonly provinceCount: number;
  readonly cityCount: number;
  readonly locationCount: number;
  readonly provinces: readonly RawProvince[];
}

const catalog = data as unknown as RawLocationData;

export interface WeatherLocationCatalogMeta {
  readonly source: string;
  readonly sourceUrl: string;
  readonly generatedAt: string;
  readonly provinceCount: number;
  readonly cityCount: number;
  readonly locationCount: number;
}

export function weatherLocationCatalogMeta(): WeatherLocationCatalogMeta {
  return {
    source: catalog.source,
    sourceUrl: catalog.sourceUrl,
    generatedAt: catalog.generatedAt,
    provinceCount: catalog.provinceCount,
    cityCount: catalog.cityCount,
    locationCount: catalog.locationCount,
  };
}

export function listProvinces(): readonly string[] {
  return catalog.provinces.map((province) => province.name);
}

export function findProvince(name: string): RawProvince | null {
  return catalog.provinces.find((province) => province.name === name) ?? null;
}

/** Cities of a province, for the second dropdown. Empty when nothing is picked. */
export function listCities(provinceName: string): readonly { readonly id: string; readonly name: string }[] {
  const province = findProvince(provinceName);
  if (province === null) return [];
  return province.cities.map((city) => ({ id: city.id, name: city.name }));
}

/** Districts of a city, for the third dropdown. May legitimately be empty. */
export function listDistricts(provinceName: string, cityName: string): readonly { readonly id: string; readonly name: string }[] {
  const province = findProvince(provinceName);
  const city = province?.cities.find((candidate) => candidate.name === cityName);
  if (city === undefined) return [];
  return city.districts.map((district) => ({ id: district.id, name: district.name }));
}

/**
 * Resolves a pick (any combination of the three rungs) into the value the
 * weather config needs.
 *
 * `locationId` prefers the most specific rung chosen, because that is what the
 * owner actually selected; `city` is the human label the header shows and is
 * always filled, so the API can still resolve by name if the ID ever needs to
 * be re-derived. Returns `null` only when nothing usable was selected.
 */
export function resolveWeatherLocation(input: {
  readonly province?: string;
  readonly city?: string;
  readonly district?: string;
  readonly districtId?: string;
}): WeatherLocationOption | null {
  const provinceName = (input.province ?? "").trim();
  if (provinceName === "") return null;
  const province = findProvince(provinceName);
  if (province === null) return null;
  const cityName = (input.city ?? "").trim();
  if (cityName === "") return null;
  const city = province.cities.find((candidate) => candidate.name === cityName);
  if (city === undefined) return null;

  const districtName = (input.district ?? "").trim();
  const district = districtName === ""
    ? undefined
    : city.districts.find((candidate) => candidate.name === districtName) ?? (input.districtId !== undefined ? city.districts.find((candidate) => candidate.id === input.districtId) : undefined);

  // A district name that does not exist in the chosen city is a stale selection
  // (e.g. the owner changed the province and the old district name lingered).
  // Falling back to the city rung is correct here — silently keeping a foreign
  // district would send a Location ID that belongs to another province.
  const locationId = district?.id ?? city.id;
  /**
   * The header label keeps the short form the rest of the app uses
   * (佛山南海区 -> 佛山南海), not 广东省佛山市南海区, which is too long for the
   * header chip.
   *
   * Municipalities need care: there the province and city rungs share a name
   * (北京市), so prefixing both would read 北京北京海淀. Drop the duplicate, but
   * keep one copy — 海淀 alone would lose which municipality it belongs to.
   */
  const bareCity = city.name.replace(/(特别行政区|自治区|省|市)$/u, "");
  const bareProvince = province.name.replace(/(特别行政区|自治区|省|市)$/u, "");
  const municipality = bareCity !== "" && bareCity === bareProvince;
  const cityPart = municipality ? bareProvince : bareCity;
  const label = district === undefined ? city.name : `${cityPart}${district.name}`;

  return {
    locationId,
    city: label === "" ? city.name : label,
    province: province.name,
    cityName: city.name,
    ...(district === undefined ? {} : { districtName: district.name }),
    ...(city.seatOnly === true && district === undefined ? { seatOnly: true } : {}),
  };
}

/**
 * Reverse lookup for the Settings form: given a stored Location ID, recover the
 * three dropdown positions so reopening Settings shows the current selection
 * instead of an empty ladder. Returns `null` for IDs outside China or IDs that
 * were hand-typed before the dropdown existed — the form must then fall back to
 * showing the raw ID rather than claiming a wrong city.
 */
export function describeWeatherLocation(locationId: string): {
  readonly province: string;
  readonly city: string;
  readonly district: string | null;
} | null {
  const id = locationId.trim();
  if (id === "") return null;
  for (const province of catalog.provinces) {
    for (const city of province.cities) {
      if (city.id === id) return { province: province.name, city: city.name, district: null };
      const district = city.districts.find((candidate) => candidate.id === id);
      if (district !== undefined) return { province: province.name, city: city.name, district: district.name };
    }
  }
  return null;
}

/**
 * The compact label used by weather surfaces.  Keep this formatter beside the
 * catalog so the header and historical record chips cannot grow their own
 * slightly-different province/city rules.
 */
function shortWeatherLocationName(location: {
  readonly province: string;
  readonly city: string;
  readonly district: string | null;
}): string {
  if (location.district === null) return location.city;
  const bareCity = location.city.replace(/(特别行政区|自治区|省|市)$/u, "");
  const bareProvince = location.province.replace(/(特别行政区|自治区|省|市)$/u, "");
  const municipality = bareCity !== "" && bareCity === bareProvince;
  return `${municipality ? bareProvince : bareCity}${location.district}`;
}

export interface WeatherLocationDisplayValue {
  readonly id?: string;
  readonly name?: string;
  readonly adm2?: string;
  readonly adm1?: string;
}

/** Exact aliases only; unlike describeWeatherLocationByName this never turns an
 * unrecognised long string into its nearest city. */
function describeWeatherLocationByExactName(name: string): {
  readonly province: string;
  readonly city: string;
  readonly district: string | null;
} | null {
  const needle = name.trim();
  if (needle === "") return null;
  for (const province of catalog.provinces) {
    for (const city of province.cities) {
      const bareCity = city.name.replace(/(特别行政区|自治区|省|市)$/u, "");
      const cityNames = new Set([city.name, bareCity]);
      if (cityNames.has(needle)) return { province: province.name, city: city.name, district: null };
      for (const district of city.districts) {
        const bareDistrict = district.name.replace(/(特别行政区|自治区|省|市|区|县)$/u, "");
        const districtNames = new Set([
          district.name,
          bareDistrict,
          `${city.name}${district.name}`,
          `${city.name}${bareDistrict}`,
          `${city.name}${bareDistrict}区`,
          `${bareCity}${district.name}`,
          `${bareCity}${bareDistrict}`,
          `${bareCity}${bareDistrict}区`,
        ]);
        if (districtNames.has(needle)) return { province: province.name, city: city.name, district: district.name };
      }
    }
  }
  return null;
}

/**
 * Resolve a weather response's own location into the label shown to the owner.
 *
 * A response may be an old archive row whose `name` accidentally contains the
 * numeric Location ID.  The response ID is authoritative in that case, and a
 * strict catalog lookup prevents a fuzzy city-name match from silently
 * replacing a historical location with today's configured city.  Unknown
 * numeric values are codes, not names, so they deliberately become “地点未知”;
 * non-code names (including foreign locations) remain visible as supplied.
 */
export function weatherLocationDisplayName(value: WeatherLocationDisplayValue | null | undefined): string {
  const id = value?.id?.trim() ?? "";
  const name = value?.name?.trim() ?? "";
  const nameIsNumericCode = /^\d+$/u.test(name);
  if (name !== "") {
    if (!nameIsNumericCode) {
      const exactName = describeWeatherLocationByExactName(name);
      if (exactName !== null) return shortWeatherLocationName(exactName);
      // A real name wins over an unresolved (or accidentally mismatched)
      // numeric ID.  This is important for foreign locations, whose provider
      // IDs are not in the China catalog.
      return name;
    }
    const byId = id === "" ? null : describeWeatherLocation(id);
    if (byId !== null) return shortWeatherLocationName(byId);
    const nameAsId = describeWeatherLocation(name);
    if (nameAsId !== null) return shortWeatherLocationName(nameAsId);
    const administrativeName = value?.adm2?.trim() || value?.adm1?.trim() || "";
    if (administrativeName !== "") return administrativeName;
    return "地点未知";
  }
  const byId = id === "" ? null : describeWeatherLocation(id);
  if (byId !== null) return shortWeatherLocationName(byId);
  const administrativeName = value?.adm2?.trim() || value?.adm1?.trim() || "";
  return administrativeName === "" ? "地点未知" : administrativeName;
}

/**
 * Same as above, but accepts a city *name* too. The project's existing configs
 * often store a human name ("佛山南海区") with no ID, so Settings has to be able
 * to point the dropdown at something.
 */
export function describeWeatherLocationByName(city: string): {
  readonly province: string;
  readonly city: string;
  readonly district: string | null;
} | null {
  const needle = city.trim();
  if (needle === "") return null;
  const byId = describeWeatherLocation(needle);
  if (byId !== null) return byId;
  const bare = needle.replace(/(特别行政区|自治区|省|市)$/u, "");
  for (const province of catalog.provinces) {
    for (const city of province.cities) {
      const bareCity = city.name.replace(/(特别行政区|自治区|省|市)$/u, "");
      if (city.name === needle || bareCity === needle) return { province: province.name, city: city.name, district: null };
      // "佛山南海区" -> city 佛山市 + district 南海
      if (bareCity !== "" && needle.startsWith(bareCity)) {
        const rest = bare.replace(bareCity, "");
        const district = city.districts.find((candidate) => candidate.name === rest || rest.startsWith(candidate.name));
        if (district !== undefined) return { province: province.name, city: city.name, district: district.name };
        if (city.name !== needle) return { province: province.name, city: city.name, district: null };
      }
      const direct = city.districts.find((candidate) => candidate.name === needle);
      if (direct !== undefined) return { province: province.name, city: city.name, district: direct.name };
    }
  }
  return null;
}
