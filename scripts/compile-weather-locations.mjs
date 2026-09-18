/**
 * Compiles the official QWeather China city list into the compact
 * province -> city -> district ladder that the Settings dropdown consumes.
 *
 * Source: https://github.com/qwd/LocationList  (China-City-List-latest.csv)
 * Output: apps/web/src/weather-locations.data.json  (checked in, bundled by Vite)
 *
 * Run:  node scripts/compile-weather-locations.mjs <path-to-csv>
 *
 * Why a build step at all instead of shipping the CSV: the CSV is ~460 KB and
 * carries 6 columns of English names, timezones and coordinates we never show.
 * The compiled artifact is ~155 KB and is a pure data file — no runtime network
 * call, no QWeather quota, so "搜索不到" cannot happen.
 *
 * Re-run this only when refreshing the QWeather list. QWeather never renumbers
 * an existing Location ID, so a stale list is missing new districts rather than
 * pointing at wrong ones — the risk of falling behind is low, not zero.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error("usage: node scripts/compile-weather-locations.mjs <China-City-List-latest.csv>");
  process.exit(2);
}

/**
 * The CSV is RFC 4180: fields containing commas (every Taiwan row, whose
 * country name is "Taiwan, Province of China") are wrapped in double quotes.
 * A naive `split(",")` shifts every subsequent column by one on those rows —
 * which silently corrupts adm1/adm2 and therefore the whole ladder. Parse
 * field-by-field instead.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (char === "\r") continue;
    field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const raw = readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");
const rows = parseCsv(raw);

const headerIndex = rows.findIndex((row) => row[0] === "Location_ID");
if (headerIndex === -1) {
  console.error("header row (Location_ID,...) not found — is this the right CSV?");
  process.exit(2);
}
const header = rows[headerIndex];
const column = (name) => {
  const index = header.indexOf(name);
  if (index === -1) throw new Error(`missing column ${name}`);
  return index;
};
const ID = column("Location_ID");
const NAME_ZH = column("Location_Name_ZH");
const ADM1 = column("Adm1_Name_ZH");
const ADM2 = column("Adm2_Name_ZH");
const TIMEZONE = column("Timezone");

const data = rows.slice(headerIndex + 1).filter((row) => row.length > NAME_ZH && (row[ID] ?? "").trim() !== "");

/**
 * Strips the administrative suffix the source attaches inconsistently: the
 * city's own row says 哈尔滨 while its adm2 says 哈尔滨市. Without this the two
 * spellings look like different places.
 */
function bareName(value) {
  return value.replace(/(特别行政区|自治区|省|市|自治州|地区|盟)$/u, "");
}
function samePlace(left, right) {
  const a = bareName((left ?? "").trim());
  const b = bareName((right ?? "").trim());
  return a !== "" && a === b;
}

/**
 * Two shapes the source mixes together, and both must survive:
 *
 *  - Municipalities (北京/上海/天津/重庆): `adm2 === adm1`, and the rows are the
 *    districts themselves. There is no separate "city" level, so the city rung
 *    is the municipality and the district rung is the row.
 *  - Districts that happen to sit directly under a province (省直辖县级行政区,
 *    e.g. 仙桃/济源): here `adm1` is the province and `adm2` is the county-level
 *    city itself, so adm2 IS the useful weather location.
 *
 * Everything is grouped by `adm1` first, then by `adm2`, which reproduces the
 * three rungs without special-casing either shape.
 */
const provinces = new Map();

for (const row of data) {
  const id = (row[ID] ?? "").trim();
  const name = (row[NAME_ZH] ?? "").trim();
  const adm1 = (row[ADM1] ?? "").trim();
  const adm2 = (row[ADM2] ?? "").trim();
  const timeZone = (row[TIMEZONE] ?? "").trim();
  if (!id || !name || !adm1) continue;

  if (!provinces.has(adm1)) provinces.set(adm1, { name: adm1, cities: new Map() });
  const province = provinces.get(adm1);

  // A row whose adm2 equals its own name is the city-level entry itself.
  const cityName = adm2 || adm1;
  if (!province.cities.has(cityName)) province.cities.set(cityName, { name: cityName, id: "", districts: [] });
  const city = province.cities.get(cityName);

  /**
   * The city's own row does NOT spell its name the way adm2 does: the source
   * writes 哈尔滨 for the row and 哈尔滨市 for adm2 (and 北京 vs 北京市). Compare
   * after stripping the administrative suffix, otherwise the city row is
   * misfiled as a district that duplicates the city's own ID — 377 such
   * duplicates across the list, one per prefecture city.
   */
  const isCityItself = samePlace(name, cityName) || samePlace(name, adm1);
  if (isCityItself) {
    if (city.id === "") {
      city.id = id;
      if (timeZone) city.timeZone = timeZone;
    }
    continue;
  }
  city.districts.push({ id, name, ...(timeZone && timeZone !== city.timeZone ? { timeZone } : {}) });
}

/**
 * Autonomous prefectures (自治州) and province-direct counties (省直辖县级行政区)
 * have no row that names the prefecture itself as a city — 延边朝鲜族自治州's rows
 * are its county-level cities (延吉/敦化/…) plus, for some prefectures, a row
 * named after the prefecture (延边, id 101060306). The first row is the
 * prefecture's *seat*, not the prefecture.
 *
 * So the city rung must not blindly inherit `districts[0].id`. Prefer the row
 * that names the prefecture (that is the region-wide forecast); if there is
 * none, use the seat but keep it labelled and distinct so an ID never appears
 * at two levels at once.
 */
for (const province of provinces.values()) {
  for (const city of province.cities.values()) {
    if (city.id !== "") continue;
    const selfRow = city.districts.find((district) => samePlace(district.name, city.name) || samePlace(bareName(district.name), bareName(city.name)));
    if (selfRow !== undefined) {
      city.id = selfRow.id;
      if (selfRow.timeZone) city.timeZone = selfRow.timeZone;
      city.districts = city.districts.filter((district) => district !== selfRow);
      continue;
    }
    if (city.districts.length === 0) continue;
    // No prefecture-wide row: the seat city is the best available answer, and
    // it is *removed* from the district rung so the same ID cannot be chosen
    // twice with different labels.
    const seat = city.districts[0];
    city.id = seat.id;
    if (seat.timeZone) city.timeZone = seat.timeZone;
    city.seatOnly = true;
    city.districts = city.districts.filter((district) => district !== seat);
  }
}

/**
 * A city with no id of its own is a province-direct county (adm2 == the county
 * name and every row is a district of it). Promote its first district so the
 * city rung is never an empty `<option>` — selecting it must always yield an ID.
 */
const provincesOut = [];
for (const province of provinces.values()) {
  const cities = [];
  for (const city of province.cities.values()) {
    // The pass above guarantees an id for any city that has at least one row;
    // only a genuinely empty grouping can reach here without one.
    if (!city.id) continue;
    // Drop a district that merely repeats its city (北京 -> 北京), it adds nothing.
    const districts = city.districts.filter((district) => !samePlace(district.name, city.name));
    cities.push({
      id: city.id,
      name: city.name,
      ...(city.timeZone ? { timeZone: city.timeZone } : {}),
      // `seatOnly` means the city rung borrowed its seat's ID because the
      // source has no prefecture-wide row; the UI shows this so the owner
      // knows the forecast is the seat's, not a region aggregate.
      ...(city.seatOnly === true ? { seatOnly: true } : {}),
      districts,
    });
  }
  if (cities.length === 0) continue;
  provincesOut.push({ name: province.name, cities });
}

// Stable, human-expected ordering: by Location ID where it is numeric (the
// official list is already grouped that way: 10101 Beijing, 10128 Guangdong...),
// falling back to name for the non-numeric Hong Kong / Macao / Taiwan IDs.
const idRank = (value) => (/^\d+$/.test(value) ? { numeric: true, value: Number.parseInt(value, 10) } : { numeric: false, value: value });
function compareId(left, right) {
  const a = idRank(left);
  const b = idRank(right);
  if (a.numeric && b.numeric) return a.value - b.value;
  if (a.numeric !== b.numeric) return a.numeric ? -1 : 1;
  return String(a.value).localeCompare(String(b.value), "en");
}
/**
 * The source list is not fully sorted by ID (Taiwan's province row predates its
 * own cities), so ordering by the first city's ID keeps provinces in the
 * canonical Beijing-first sequence the list is authored in.
 */
provincesOut.sort((left, right) => compareId(left.cities[0].id, right.cities[0].id) || left.name.localeCompare(right.name, "zh-Hans-CN"));
for (const province of provincesOut) {
  province.cities.sort((left, right) => compareId(left.id, right.id) || left.name.localeCompare(right.name, "zh-Hans-CN"));
  for (const city of province.cities) {
    city.districts.sort((left, right) => compareId(left.id, right.id) || left.name.localeCompare(right.name, "zh-Hans-CN"));
  }
}

const output = {
  source: "QWeather LocationList (China-City-List)",
  sourceUrl: "https://github.com/qwd/LocationList",
  generatedAt: new Date().toISOString(),
  provinceCount: provincesOut.length,
  cityCount: provincesOut.reduce((total, province) => total + province.cities.length, 0),
  locationCount: provincesOut.reduce((total, province) => total + province.cities.reduce((sum, city) => sum + 1 + city.districts.length, 0), 0),
  provinces: provincesOut,
};

/**
 * The artifact belongs beside the module that imports it, so Vite bundles it
 * like any other source file. Resolved from this script's own location rather
 * than the process cwd, so the command works from any directory.
 */
const target = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/src/weather-locations.data.json");
writeFileSync(target, `${JSON.stringify(output)}\n`, "utf8");
const bytes = JSON.stringify(output).length;
console.log(`wrote ${target}`);
console.log(`provinces=${output.provinceCount} cities=${output.cityCount} locations=${output.locationCount} bytes=${bytes}`);
