/**
 * 本地 IMDb 片库查询。
 *
 * 库由 `scripts/imdb-catalog.mjs --build` 生成，落在 `<data>/derived/imdb/catalog.sqlite`。
 * 语义是「可丢弃、可重建」：没有这个文件时所有查询返回 `null`，调用方应当
 * 回退到在线源，而不是报错。
 *
 * ⚠️ 查询串的规范化与建库脚本 `normalizeTerm()` 必须**逐字一致** —— 建库时
 * 用的是那一套，查询时换了另一套就永远对不上。改一处必须同步改另一处。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApiConfig } from "./config.js";

export interface ImdbCatalogHit {
  readonly tconst: string;
  readonly kind: "movie" | "tv";
  readonly name: string;
  readonly originalTitle?: string;
  readonly year?: number;
  readonly votes: number;
  readonly rating?: number;
}

export interface ImdbCatalogStatus {
  readonly available: boolean;
  readonly path: string;
  readonly titles: number;
  readonly terms: number;
  readonly sizeMb: number;
}

interface CatalogHandle {
  readonly db: DatabaseSync;
  readonly mtimeMs: number;
}

let handle: CatalogHandle | null = null;
let warnedPath: string | null = null;

export function imdbCatalogPath(config: ApiConfig): string {
  return join(config.dataDirectory, "derived", "imdb", "catalog.sqlite");
}

/**
 * 重建库会换掉文件本身，所以每次按 mtime 校验句柄；换了就重开。
 * 打开失败只警告一次，绝不把「库坏了」升级成「搜片失败」。
 */
function openCatalog(config: ApiConfig): DatabaseSync | null {
  const path = imdbCatalogPath(config);
  if (!existsSync(path)) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (handle !== null && handle.mtimeMs === mtimeMs) return handle.db;
  if (handle !== null) {
    try {
      handle.db.close();
    } catch {
      /* 旧句柄关不掉不影响新开 */
    }
    handle = null;
  }
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    handle = { db, mtimeMs };
    return db;
  } catch (error) {
    if (warnedPath !== path) {
      warnedPath = path;
      console.warn(`[imdb] 本地片库打不开，已跳过：${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

/** 与 `scripts/imdb-catalog.mjs` 的 `normalizeTerm()` 保持同一套规则。 */
export function normalizeImdbTerm(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, " ")
    .replace(/[·・:：,，.。!！?？'"“”‘’、\-—_/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const COLUMNS = "c.tconst, c.kind, c.name, c.original_title, c.year, c.votes, c.rating";

function toHit(row: Record<string, unknown>): ImdbCatalogHit {
  const original = typeof row.original_title === "string" && row.original_title.length > 0 ? row.original_title : undefined;
  const year = typeof row.year === "number" ? row.year : undefined;
  const rating = typeof row.rating === "number" ? row.rating : undefined;
  return {
    tconst: String(row.tconst),
    kind: row.kind === "tv" ? "tv" : "movie",
    name: String(row.name),
    ...(original === undefined ? {} : { originalTitle: original }),
    ...(year === undefined ? {} : { year }),
    votes: typeof row.votes === "number" ? row.votes : 0,
    ...(rating === undefined ? {} : { rating }),
  };
}

/**
 * 三级匹配：同名 → 前缀（走索引）→ 包含（全表扫）。
 *
 * 第三级只在**前两级几乎没收获**时才跑：库里有几百万条名字，`LIKE '%霸王%'`
 * 是实打实的全表扫，平时靠前缀就够（用户打的多半是片名开头那几个字）。
 * 只有当前缀一条都没命中（比如他记得的是片名中间的字），才付这份代价。
 */
export function searchImdbCatalog(config: ApiConfig, query: string, limit = 8): ImdbCatalogHit[] | null {
  const db = openCatalog(config);
  if (db === null) return null;
  const term = normalizeImdbTerm(query);
  if (term.length === 0) return [];

  const exact = db
    .prepare(
      `select ${COLUMNS}, min(t.weight) as weight
       from term t join candidate c on c.tconst = t.tconst
       where t.term = ?
       group by c.tconst
       order by c.votes desc, c.year desc
       limit ?`,
    )
    .all(term, limit) as Record<string, unknown>[];

  const merged = new Map<string, Record<string, unknown>>();
  for (const row of exact) merged.set(String(row.tconst), row);
  if (merged.size >= limit) return [...merged.values()].slice(0, limit).map(toHit);

  const prefix = db
    .prepare(
      `select ${COLUMNS}, min(t.weight) as weight
       from term t join candidate c on c.tconst = t.tconst
       where t.term like ? escape '\\'
       group by c.tconst
       order by length(t.term), c.votes desc
       limit ?`,
    )
    .all(`${escapeLike(term)}%`, limit) as Record<string, unknown>[];
  for (const row of prefix) {
    const key = String(row.tconst);
    if (!merged.has(key)) merged.set(key, row);
  }
  if (merged.size >= Math.min(limit, 3)) return [...merged.values()].slice(0, limit).map(toHit);

  const contains = db
    .prepare(
      `select ${COLUMNS}, min(t.weight) as weight
       from term t join candidate c on c.tconst = t.tconst
       where t.term like ? escape '\\'
       group by c.tconst
       order by length(t.term), c.votes desc
       limit ?`,
    )
    .all(`%${escapeLike(term)}%`, limit) as Record<string, unknown>[];
  for (const row of contains) {
    const key = String(row.tconst);
    if (!merged.has(key)) merged.set(key, row);
  }
  return [...merged.values()].slice(0, limit).map(toHit);
}

/** 用户贴了 `tt0111161` 或 IMDb 链接时，直接按 tconst 取一条。 */
export function lookupImdbTconst(config: ApiConfig, tconst: string): ImdbCatalogHit | null {
  const db = openCatalog(config);
  if (db === null) return null;
  const row = db
    .prepare(`select ${COLUMNS} from candidate c where c.tconst = ?`)
    .get(tconst.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row === undefined ? null : toHit(row);
}

export function imdbCatalogStatus(config: ApiConfig): ImdbCatalogStatus {
  const path = imdbCatalogPath(config);
  if (!existsSync(path)) return { available: false, path, titles: 0, terms: 0, sizeMb: 0 };
  const sizeMb = Math.round((statSync(path).size / 1048576) * 10) / 10;
  const db = openCatalog(config);
  if (db === null) return { available: false, path, titles: 0, terms: 0, sizeMb };
  try {
    const titles = Number((db.prepare("select count(*) c from candidate").get() as { c: number }).c);
    const terms = Number((db.prepare("select count(*) c from term").get() as { c: number }).c);
    return { available: true, path, titles, terms, sizeMb };
  } catch {
    return { available: false, path, titles: 0, terms: 0, sizeMb };
  }
}
