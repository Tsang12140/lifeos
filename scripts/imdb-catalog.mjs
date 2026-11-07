#!/usr/bin/env node
/**
 * IMDb 离线片库：下载 → 建库 → 查询。
 *
 * 为什么要有这个：`api.themoviedb.org` 的域名解析在国内被投毒、TCP 也被阻断，
 * 换任何国内云都绕不过去（详见 docs/todo.md §43）。IMDb 的公开数据集
 * (`datasets.imdbws.com`) 在国内反而直连通达，且 `title.akas` 里带各地区/
 * 语言又名 —— 中文片名到 tconst 的映射本地就能建起来。
 *
 * 用法：
 *   node scripts/imdb-catalog.mjs --download            下载三个数据集到 data/derived/imdb/raw（默认覆盖为最新）
 *   node scripts/imdb-catalog.mjs --download --reuse    同一批包反复建库调试时，沿用已有 gz
 *   node scripts/imdb-catalog.mjs --build               流式解析建库（不落盘解压）
 *   node scripts/imdb-catalog.mjs --status              看库的状态与覆盖
 *   node scripts/imdb-catalog.mjs --clean               删掉原始 gz（库可继续用，省 ~725 MB）
 *
 * 库的位置跟 `data/` 走（`LIFEOS_DATA_DIR` 可覆盖），落在 `derived/` 下，
 * 语义是「可丢弃、可重建」——不进备份、不进 git。
 * **部署到服务器只需要 `catalog.sqlite`（约 41 MB）**，raw 三个 gz 是建库当天的
 * 耗材，建完 `--clean` 掉即可；服务器上没有它们也能正常查。
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(process.env.LIFEOS_DATA_DIR?.trim() || join(ROOT, "data"));
const CATALOG_DIR = join(DATA_DIR, "derived", "imdb");
const RAW_DIR = join(CATALOG_DIR, "raw");
const DB_PATH = join(CATALOG_DIR, "catalog.sqlite");

const BASE = "https://datasets.imdbws.com";
const FILES = [
  { name: "title.basics.tsv.gz", label: "片目", approx: 219 },
  { name: "title.akas.tsv.gz", label: "各地区／语言又名", approx: 498 },
  { name: "title.ratings.tsv.gz", label: "评分与票数", approx: 8 },
];

/** 保留哪些片型。`tvEpisode` 占 basics 的 3/4，不记单集。 */
const KEEP_KINDS = new Set(["movie", "tvMovie", "tvSeries", "tvMiniSeries", "tvSpecial", "short"]);

/** 票数低于这个值的英文片不留（冷门片没人搜，留着只是把 LIKE 拖慢）。 */
const MIN_VOTES_FOR_NO_CJK = 5000;

/** 中日韩文字，含假名与扩展区。名字里带这些就值得留。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

const LOG = (message) => console.log(message);
const FAIL = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

/* ---------------------------------- 下载 ---------------------------------- */

async function download({ reuse = false } = {}) {
  mkdirSync(RAW_DIR, { recursive: true });
  for (const file of FILES) {
    const target = join(RAW_DIR, file.name);
    if (existsSync(target)) {
      const mb = statSync(target).size / 1048576;
      // 默认**重下**：IMDb 每周换数据，旧包大小也合格 —— 只看大小就会把上周的包
      // 当成「已完整」静默跳过，`--build --force` 于是拿旧数据重建，看起来更新了
      // 其实没有。只有显式 `--reuse`（同一批包要反复建库调试）才允许沿用。
      if (reuse) {
        if (mb > file.approx * 0.8) {
          LOG(`沿用 ${file.name}（--reuse，已存在 ${mb.toFixed(0)} MB）`);
          continue;
        }
        LOG(`重下 ${file.name}（现有 ${mb.toFixed(0)} MB 不足）`);
      } else {
        LOG(`覆盖 ${file.name}（现有 ${mb.toFixed(0)} MB，拉最新）`);
      }
    }
    LOG(`下载 ${file.name}（${file.label}，约 ${file.approx} MB）…`);
    const started = Date.now();
    let received = 0;
    let lastReport = 0;
    const ac = new AbortController();
    const guard = setTimeout(() => ac.abort(), 30 * 60_000);
    try {
      const res = await fetch(`${BASE}/${file.name}`, {
        headers: { "user-agent": "lifeos-imdb-catalog/1.0" },
        signal: ac.signal,
      });
      if (!res.ok) FAIL(`${file.name} 返回 HTTP ${res.status}`);
      const body = Readable.fromWeb(res.body);
      body.on("data", (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastReport > 15_000) {
          lastReport = now;
          const mb = received / 1048576;
          const rate = mb / ((now - started) / 1000);
          LOG(`  ${mb.toFixed(0)} / ${file.approx} MB · ${rate.toFixed(2)} MB/s`);
        }
      });
      await pipeline(body, createWriteStream(target));
      LOG(`  完成：${(statSync(target).size / 1048576).toFixed(0)} MB，用时 ${((Date.now() - started) / 1000 / 60).toFixed(1)} 分钟`);
    } catch (error) {
      if (existsSync(target)) rmSync(target, { force: true });
      FAIL(`${file.name} 下载失败：${error.name === "AbortError" ? "超时" : (error.cause?.code ?? error.message)}`);
    } finally {
      clearTimeout(guard);
    }
  }
}

/* ---------------------------------- 建库 ---------------------------------- */

/** 逐行读 gz，回调拿到整行字符串；表头自动跳过。 */
async function eachRow(file, handler) {
  const path = join(RAW_DIR, file);
  if (!existsSync(path)) FAIL(`缺少 ${file}，先跑 --download`);
  const input = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let line = 0;
  let seen = 0;
  for await (const row of input) {
    line += 1;
    if (line === 1) continue; // IMDb 的 TSV 都有表头
    seen += 1;
    if (seen % 2_000_000 === 0) LOG(`  ${file}：已读 ${(seen / 1e6).toFixed(0)} 百万行`);
    handler(row, line);
  }
  return seen;
}

const nullIfEmpty = (value) => (value === undefined || value === "" || value === "\\N" ? null : value);

function yearOf(value) {
  const raw = nullIfEmpty(value);
  if (raw === null || !/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1870 && year <= 2100 ? year : null;
}

async function build({ force }) {
  if (existsSync(DB_PATH) && !force) {
    FAIL(`${DB_PATH} 已存在；加 --force 覆盖重建`);
  }
  // 先确认原始包齐不齐，**再**动旧库。顺序反过来的话，`--build --force` 会在
  // 删完好库之后才报「缺少 title.basics.tsv.gz」—— 库没了，重建还得重下 725 MB。
  const missing = FILES.filter((file) => !existsSync(join(RAW_DIR, file.name)));
  if (missing.length > 0) {
    FAIL(`缺少 raw/${missing.map((f) => f.name).join("、")}，先跑 --download（旧库未动）`);
  }
  mkdirSync(CATALOG_DIR, { recursive: true });
  if (existsSync(DB_PATH)) {
    try {
      rmSync(DB_PATH, { force: true });
    } catch (error) {
      // Windows 上服务还握着句柄时是 EBUSY / EPERM，直接抛只剩一段栈没法判断。
      FAIL(`删不掉旧库（${error.code ?? error.message}），先停掉正在跑的 API/预览再重建：${DB_PATH}`);
    }
  }
  const db = new DatabaseSync(DB_PATH);
  // 建库期间把安全设置调快：这是离线一次性写入，不需要掉电保护。
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -200000;");

  db.exec(`
    create table candidate (
      tconst text primary key,
      kind text not null,
      name text not null,
      original_title text,
      year integer,
      votes integer,
      rating real
    ) without rowid;
    create table term (
      tconst text not null,
      term text not null,
      weight integer not null
    );
    create index term_lookup on term(term);
    create index term_tconst on term(tconst);
  `);

  // ---- 1. 评分与票数（小文件，先读进内存方便后面 join；约 150 万条）
  LOG("读评分与票数…");
  const ratings = new Map();
  await eachRow("title.ratings.tsv.gz", (row) => {
    const [tconst, average, votes] = row.split("\t");
    const vote = Number(votes);
    if (!Number.isFinite(vote)) return;
    ratings.set(tconst, { votes: vote, rating: Number(average) || null });
  });
  LOG(`  评分条目 ${ratings.size.toLocaleString()}`);

  // ---- 2. 片目
  LOG("读片目（这一步最慢）…");
  const insertCandidate = db.prepare(
    "insert or replace into candidate (tconst, kind, name, original_title, year, votes, rating) values (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertTerm = db.prepare("insert into term (tconst, term, weight) values (?, ?, ?)");
  const seenTitles = new Set();
  db.exec("begin");
  let kept = 0;
  await eachRow("title.basics.tsv.gz", (row) => {
    const [tconst, titleType, primaryTitle, originalTitle, isAdult, startYear] = row.split("\t");
    if (!KEEP_KINDS.has(titleType)) return;
    if (isAdult === "1") return;
    const name = nullIfEmpty(primaryTitle);
    if (name === null) return;
    const stats = ratings.get(tconst) ?? { votes: 0, rating: null };
    seenTitles.add(tconst);
    insertCandidate.run(
      tconst,
      titleType === "movie" || titleType === "tvMovie" || titleType === "short" ? "movie" : "tv",
      name,
      nullIfEmpty(originalTitle),
      yearOf(startYear),
      stats.votes,
      stats.rating,
    );
    insertTerm.run(tconst, normalizeTerm(name), 0);
    const original = nullIfEmpty(originalTitle);
    if (original !== null && original !== name) insertTerm.run(tconst, normalizeTerm(original), 0);
    kept += 1;
  });
  db.exec("commit");
  ratings.clear();
  LOG(`  保留片目 ${kept.toLocaleString()}`);

  // ---- 3. 又名：只收有中日韩字、或地区/语言指向中文的
  LOG("读地区／语言又名…");
  const hasCjk = new Set();
  /**
   * 顺手记下「最像观众认得的那个中文名」，最后用来替换显示名。
   * IMDb 的 primaryTitle 是英文（Farewell My Concubine），用户搜「霸王别姬」
   * 却在候选列表里看到一串英文 —— 所以中文名要提到台面上，英文退成原名。
   *
   * 打分不是「有汉字就赢」：`type=imdbDisplay` 是 IMDb 页面上的显示名（最贴观众），
   * `attributes=original script title` 是原始剧本名 —— 《路边野餐》的剧本原名是
   * 《惶然录》，按「汉字优先」会把它当成片名推出去。所以显示名加权、剧本名扣分。
   */
  const cjkNames = new Map();
  db.exec("begin");
  let akaKept = 0;
  await eachRow("title.akas.tsv.gz", (row) => {
    const [titleId, , title, region, language, types, attributes] = row.split("\t");
    if (!seenTitles.has(titleId)) return;
    const name = nullIfEmpty(title);
    if (name === null) return;
    const cjk = CJK.test(name);
    const chineseRegion = region !== null && /^(CN|HK|TW|MO)$/i.test(region);
    const chineseLanguage = language !== null && /^(zh|cn|cmn|yue|chi|zho|mandarin)/i.test(language);
    if (!cjk && !chineseRegion && !chineseLanguage) return;
    hasCjk.add(titleId);
    insertTerm.run(titleId, normalizeTerm(name), cjk ? 1 : 2);
    akaKept += 1;
    if (!cjk) return;
    const score =
      (/imdbDisplay/i.test(types ?? "") ? 10 : 0) +
      (region === "CN" || (language !== null && /^(zh|cn|cmn|mandarin)/i.test(language))
        ? 3
        : region !== null && /^(HK|TW|MO)$/i.test(region)
          ? 2
          : 1) -
      (/original script title/i.test(attributes ?? "") ? 5 : 0);
    if (score <= 0) return;
    const previous = cjkNames.get(titleId);
    if (previous === undefined || score > previous.score) cjkNames.set(titleId, { name, score });
  });
  db.exec("commit");
  LOG(`  中文／CJK 又名 ${akaKept.toLocaleString()} 条，覆盖 ${hasCjk.size.toLocaleString()} 部`);

  // ---- 4. 把中文名提成显示名（英文退回 original_title）
  LOG("把中文名提到显示名…");
  // SET 子句里的 `name` 引用的还是旧值，所以 original_title 拿到的是英文主名。
  const promote = db.prepare("update candidate set name = ?, original_title = coalesce(original_title, name) where tconst = ?");
  db.exec("begin");
  let promoted = 0;
  for (const [tconst, entry] of cjkNames) {
    promote.run(entry.name, tconst);
    promoted += 1;
  }
  db.exec("commit");
  cjkNames.clear();
  LOG(`  ${promoted.toLocaleString()} 部改用中文名`);

  // ---- 5. 瘦身：没有 CJK 名、票数又不够的英文片删掉
  LOG("裁剪冷门英文片…");
  const beforeCount = db.prepare("select count(*) c from candidate").get().c;
  db.exec("create temp table keep as select tconst from candidate where votes >= " + MIN_VOTES_FOR_NO_CJK);
  const keepCjk = db.prepare("select tconst from term where weight = 1").all();
  db.exec("begin");
  const markKeep = db.prepare("insert or ignore into keep values (?)");
  for (const row of keepCjk) markKeep.run(row.tconst);
  db.exec("delete from candidate where tconst not in (select tconst from keep)");
  db.exec("delete from term where tconst not in (select tconst from candidate)");
  db.exec("commit");
  const afterCount = db.prepare("select count(*) c from candidate").get().c;
  LOG(`  ${beforeCount.toLocaleString()} → ${afterCount.toLocaleString()}`);

  // ---- 6. 收尾：分析 + 体积
  db.exec("analyze");
  db.exec("vacuum");
  const terms = db.prepare("select count(*) c from term").get().c;
  db.close();
  const mb = statSync(DB_PATH).size / 1048576;
  LOG(`\n建库完成：${DB_PATH}`);
  LOG(`  ${afterCount.toLocaleString()} 部片 / ${terms.toLocaleString()} 条可搜名字 / ${mb.toFixed(0)} MB`);
}

/* ---------------------------------- 查询 ---------------------------------- */

/**
 * 查询串规范化：全角转半角、去括号内容、去标点、小写。
 * 与 `packages/core` 的 `normalizeEntitySearchTerm` 保持同一套「宽进」原则，
 * 但这里额外去掉「(1993)」「【国语】」这类尾巴，否则用户从别处复制的
 * 片名带年份就搜不到。
 */
export function normalizeTerm(input) {
  return String(input)
    .normalize("NFKC")
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, " ")
    .replace(/[·・:：,，.。!！?？'"“”‘’、\-—_/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function search(db, query, limit) {
  const term = normalizeTerm(String(query));
  if (term.length === 0) return [];
  // 1) 精确同名（含「片名 + 年份」这种写的，靠规范化后的完全相等兜住）
  const exact = db
    .prepare(
      `select c.tconst, c.kind, c.name, c.original_title, c.year, c.votes, c.rating, min(t.weight) as weight
       from term t join candidate c on c.tconst = t.tconst
       where t.term = ?
       group by c.tconst
       order by c.votes desc, c.year desc
       limit ?`,
    )
    .all(term, limit);
  if (exact.length >= limit) return exact;

  // 2) 前缀（能走索引）
  const prefix = db
    .prepare(
      `select c.tconst, c.kind, c.name, c.original_title, c.year, c.votes, c.rating, min(t.weight) as weight
       from term t join candidate c on c.tconst = t.tconst
       where t.term like ? escape '\\'
       group by c.tconst
       order by length(t.term), c.votes desc
       limit ?`,
    )
    .all(`${escapeLike(term)}%`, limit);

  // 3) 包含（全扫，但库已裁剪过；中文两字查询走这里）
  const contains = db
    .prepare(
      `select c.tconst, c.kind, c.name, c.original_title, c.year, c.votes, c.rating, min(t.weight) as weight
       from term t join candidate c on c.tconst = t.tconst
       where t.term like ? escape '\\'
       group by c.tconst
       order by length(t.term), c.votes desc
       limit ?`,
    )
    .all(`%${escapeLike(term)}%`, limit);

  const merged = new Map();
  for (const row of [...exact, ...prefix, ...contains]) {
    if (!merged.has(row.tconst)) merged.set(row.tconst, row);
  }
  return [...merged.values()].slice(0, limit);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/* ---------------------------------- 状态 ---------------------------------- */

function status() {
  if (!existsSync(DB_PATH)) {
    LOG("库还没建。先 --download 再 --build。");
    return;
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const count = db.prepare("select count(*) c from candidate").get().c;
  const terms = db.prepare("select count(*) c from term").get().c;
  const kinds = db.prepare("select kind, count(*) c from candidate group by kind").all();
  const cjk = db.prepare("select count(distinct tconst) c from term where weight = 1").get().c;
  const years = db.prepare("select min(year) a, max(year) b from candidate where year is not null").get();
  const mb = statSync(DB_PATH).size / 1048576;
  LOG(`${DB_PATH}`);
  LOG(`  ${count.toLocaleString()} 部 · ${terms.toLocaleString()} 条名字 · ${cjk.toLocaleString()} 部有中文名 · ${mb.toFixed(0)} MB`);
  LOG(`  片型 ${kinds.map((k) => `${k.kind} ${k.c.toLocaleString()}`).join(" · ")} · 年份 ${years.a}–${years.b}`);
  const raws = existsSync(RAW_DIR) ? readdirSync(RAW_DIR) : [];
  let rawBytes = 0;
  for (const raw of raws) {
    const mb = statSync(join(RAW_DIR, raw)).size / 1048576;
    rawBytes += mb;
    LOG(`  原始包 ${raw} ${mb.toFixed(0)} MB`);
  }
  if (raws.length > 0) {
    LOG(`  原始包合计 ${rawBytes.toFixed(0)} MB —— 只是建库耗材，--clean 可删（库不受影响）`);
  }
  db.close();

  const probe = process.argv[3];
  if (probe !== undefined) {
    const again = new DatabaseSync(DB_PATH, { readOnly: true });
    const started = Date.now();
    const hits = search(again, probe, 8);
    LOG(`\n试搜「${probe}」耗时 ${Date.now() - started}ms，命中 ${hits.length}`);
    for (const hit of hits) LOG(`  ${hit.name}${hit.year ? ` (${hit.year})` : ""} · ${hit.kind} · ${hit.votes} 票 · ${hit.tconst}`);
    again.close();
  }
}

/* ---------------------------------- 入口 ---------------------------------- */

const argv = new Set(process.argv.slice(2));
if (argv.has("--download")) {
  await download({ reuse: argv.has("--reuse") });
  LOG("下载完成。接着跑 --build");
} else if (argv.has("--build")) {
  await build({ force: argv.has("--force") });
} else if (argv.has("--status")) {
  status();
} else if (argv.has("--clean")) {
  const freed = existsSync(RAW_DIR)
    ? readdirSync(RAW_DIR).reduce((sum, raw) => sum + statSync(join(RAW_DIR, raw)).size, 0)
    : 0;
  rmSync(RAW_DIR, { recursive: true, force: true });
  LOG(`原始 gz 已删除（释放 ${(freed / 1048576).toFixed(0)} MB），库仍可用。`);
  LOG("要再建库就重跑 --download（会拉最新，不是从本地旧包重建）。");
} else {
  LOG("用法：--download [--reuse] | --build [--force] | --status [试搜词] | --clean");
}
