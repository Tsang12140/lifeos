/**
 * movie-query.ts — 把「随手选中的一段话」洗成一个能拿去搜的片名。
 *
 * 触发点在界面上：在记录编辑器里选中一段文字 → 右键 → 「识别为影片」。
 * 选中的东西是人写出来的句子，不是表单字段，所以多半带着动作词、书名号和季数：
 *
 *   重看《行尸走肉》第一季   →   行尸走肉
 *   看了「看不见的客人」     →   看不见的客人
 *   二刷《星际穿越》         →   星际穿越
 *
 * **总原则是「宁可少清，不要多清」**：清不干净，顶多搜出来的候选不准，人还能在
 * 搜索框里改；清多了把片名本身砍掉一块，那才是真麻烦 —— 而且他根本看不出是被
 * 系统砍的，只会觉得「搜出来怎么都是乱七八糟的」。
 *
 * 所以下面每条规则都带边界条件，宁可不动手：
 *
 *   - 动作词**只在开头**去。「看不见的客人」里的「看」不在开头，动不得。
 *   - 季标记**只在结尾**去，且必须整段匹配 `第X季`。「第一滴血」的「第一」后面
 *     跟的是「滴血」不是「季」，所以碰不到它。
 *   - 标点**只去首尾**。「哈利·波特与魔法石」中间那个间隔号要留着。
 *   - 链接与 IMDb ID **原样返回** —— 后端自己会从里面抠出 douban / imdb 标识，
 *     洗掉反而丢了唯一能精确定位的那条线索。
 */

/** 链接或 IMDb ID：原样交回，后端 `extractDouban` / `extractImdb` 认得它们。 */
const IDENTIFIER_LIKE = /(?:https?:\/\/)?(?:movie\.)?douban\.com\/subject\/\d+|^\s*tt\d+\s*$/iu;

/** 书名号、日式引号、中英文引号 —— 它们只用来框住片名，本身不带信息。 */
const QUOTE_CHARS = /[《》〈〉「」『』“”‘’"]/gu;

const LEADING_PUNCT = /^[\s，。、：:；;！!？?\-—–·…~～]+/u;
const TRAILING_PUNCT = /[\s，。、：:；;！!？?\-—–·…~～]+$/u;

/**
 * 动作词只可能在开头（「重看《X》」），且必须整词命中。
 * 按长度从长到短排，免得短的先命中把长的切一半。
 */
const LEADING_ACTIONS = ["重新看", "重看", "重温", "重刷", "二刷", "三刷", "四刷", "补看", "补完", "追完", "刷完", "看完", "看了", "回顾"] as const;

/** 季 / 部标记：只在结尾，且整段匹配。「第一滴血」不匹配（「第一」后面不是「季」）。 */
const TRAILING_SEASON = /(?:第\s*[一二三四五六七八九十百千\d]+\s*[季部]|S\s*\d+|Season\s*\d+)\s*$/iu;

/**
 * 把选中的一段文字洗成搜索关键词。
 *
 * 洗不出东西时返回空串（调用方据此把菜单项变灰），**不会**返回半个片名。
 *
 * @param input 用户选中的原文
 * @returns 可直接送进 `POST /api/movie/resolve` 的 `query`
 */
export function cleanMovieQuery(input: string): string {
  const raw = input.trim();
  if (raw.length === 0) return "";
  // 已经是链接 / ID 就别洗了：那是最精确的线索。
  if (IDENTIFIER_LIKE.test(raw)) return raw;

  let text = raw.replace(QUOTE_CHARS, " ").replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");

  for (const action of LEADING_ACTIONS) {
    if (text.startsWith(action)) {
      text = text.slice(action.length).replace(LEADING_PUNCT, "");
      break;
    }
  }

  // 季标记只在结尾删，且留一条后路：万一整段都被吃掉（比如输入恰好就是「第一季」），
  // 就保持原样交给搜索 —— 送个空串出去比搜不准更糟。
  const withoutSeason = text.replace(TRAILING_SEASON, "").replace(TRAILING_PUNCT, "").trim();
  if (withoutSeason.length > 0) text = withoutSeason;

  return text.replace(/\s+/gu, " ").trim();
}
