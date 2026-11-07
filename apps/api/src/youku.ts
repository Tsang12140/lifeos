/**
 * 优酷搜索作为**兜底源**。
 *
 * 定位说明：它不是电影元数据库 —— 只能给「片名 / 年份 / 类型 / 国家 / 封面」，
 * 给不了简介与导演，冷门片只可能有解说视频。所以只在本地 IMDb 库没命中、
 * 或需要补一张封面时才用它。
 *
 * 结构（实测 2026-11-08）：`originNodes` 三层嵌套，正片条目长这样：
 *   { feature: "1993 · 电影 · 中国", ugcSupply: 0, showId, thumbUrl,
 *     action: { report: { trackInfo: { object_title: "霸王别姬" } } } }
 * `feature` 的第 1 段是年份、第 2 段是片型、第 3 段是国家，后面可能还有
 * 「共8集」。同一个关键词会混进 UGC 解说（`ugcSupply: 3`，feature 里的年份
 * 是上传年而非上映年）—— **必须按 ugcSupply 滤掉**，否则「霸王别姬」会
 * 多出一部 2015 年的假片。
 */
const SEARCH_ENDPOINT = "https://search.youku.com/api/search";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 只认这两类。纪录片/综艺/游戏/旅游一律不要 —— 实测「路边野餐」会返回同名旅游综艺。 */
const ACCEPTED_KINDS = new Map<string, "movie" | "tv">([
  ["电影", "movie"],
  ["电视剧", "tv"],
]);

/** 同一进程里两次请求之间至少隔这么久，别把人家接口当自家数据库用。 */
const MIN_GAP_MS = 400;
/** 失败后静默这么久再试，避免一次网络抖动让每次搜索都卡在超时上。 */
const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 8_000;

export interface YoukuHit {
  readonly showId: string;
  readonly name: string;
  readonly year?: number;
  readonly mediaType: "movie" | "tv";
  readonly country?: string;
  readonly posterUrl?: string;
}

let lastRequestAt = 0;
let downUntil = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseFeature(feature: string): { year?: number; kind?: "movie" | "tv"; country?: string } {
  // "1993 · 电影 · 中国" / "2023 · 电视剧 · 美国 · 共8集"
  const parts = feature.split("·").map((part) => part.trim());
  const yearMatch = /^(\d{4})$/.exec(parts[0] ?? "");
  const kind = ACCEPTED_KINDS.get(parts[1] ?? "");
  const country = parts[2] !== undefined && parts[2].length > 0 ? parts[2] : undefined;
  return {
    ...(yearMatch === null ? {} : { year: Number(yearMatch[1]) }),
    ...(kind === undefined ? {} : { kind }),
    ...(country === undefined ? {} : { country }),
  };
}

/** 深度优先把带 feature 的条目全捞出来，层级不重要、结构也别写死。 */
function collectEntries(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectEntries(child, out);
    return;
  }
  const record = asRecord(node);
  if (record === null) return;
  if (typeof record.feature === "string" && asRecord(asRecord(asRecord(record.action)?.report)?.trackInfo) !== null) {
    out.push(record);
  }
  for (const value of Object.values(record)) collectEntries(value, out);
}

function entryToHit(entry: Record<string, unknown>): YoukuHit | null {
  const trackInfo = asRecord(asRecord(asRecord(entry.action)?.report)?.trackInfo);
  const name = textOf(trackInfo?.object_title);
  const showId = textOf(entry.showId) ?? textOf(trackInfo?.group_id);
  const feature = textOf(entry.feature);
  if (name === undefined || showId === undefined || feature === undefined) return null;
  // UGC 解说的 feature 年份是上传年，留着只会造出假片。
  if (Number(entry.ugcSupply ?? 0) !== 0) return null;
  const parsed = parseFeature(feature);
  if (parsed.kind === undefined) return null;
  const poster = textOf(entry.thumbUrl);
  return {
    showId,
    name,
    mediaType: parsed.kind,
    ...(parsed.year === undefined ? {} : { year: parsed.year }),
    ...(parsed.country === undefined ? {} : { country: parsed.country }),
    ...(poster === undefined ? {} : { posterUrl: poster }),
  };
}

/** 「片名完全就是这个词」的排前面，其次按上映年新的排 —— 优酷原始顺序里同名衍生剧很容易插队。 */
function rank(hits: readonly YoukuHit[], query: string): YoukuHit[] {
  const needle = query.trim().toLowerCase();
  return [...hits].sort((left, right) => {
    const leftExact = left.name.trim().toLowerCase() === needle ? 1 : 0;
    const rightExact = right.name.trim().toLowerCase() === needle ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;
    return (right.year ?? 0) - (left.year ?? 0);
  });
}

/**
 * 搜索优酷。**永不抛错**：它是兜底源，失败就是没结果，让调用方安静降级。
 * 返回 `null` 表示「这次没问出去」（冷却中/超时），`[]` 表示「问了但没有」。
 */
export async function searchYouku(query: string, limit = 6): Promise<YoukuHit[] | null> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  if (Date.now() < downUntil) return null;

  const gap = Date.now() - lastRequestAt;
  if (gap < MIN_GAP_MS) await new Promise((resolveDelay) => setTimeout(resolveDelay, MIN_GAP_MS - gap));
  lastRequestAt = Date.now();

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("keyword", trimmed);
  url.searchParams.set("page", "1");

  let body: unknown;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": DESKTOP_UA, referer: "https://www.youku.com/", accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      downUntil = Date.now() + COOLDOWN_MS;
      return null;
    }
    body = await response.json();
  } catch {
    downUntil = Date.now() + COOLDOWN_MS;
    return null;
  }

  const root = asRecord(body);
  if (root === null) return [];
  const entries: Record<string, unknown>[] = [];
  collectEntries(root.originNodes ?? root.pageComponentList ?? [], entries);

  const seen = new Set<string>();
  const hits: YoukuHit[] = [];
  for (const entry of entries) {
    const hit = entryToHit(entry);
    if (hit === null || seen.has(hit.showId)) continue;
    seen.add(hit.showId);
    hits.push(hit);
  }
  return rank(hits, trimmed).slice(0, limit);
}
