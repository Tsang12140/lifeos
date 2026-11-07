import type { SqliteRecordRepository, TermNote } from "./repository.js";
import { matchesJournalTerm } from "./journal-retrieval.js";
import type { Entity } from "@lifeos/core";

/**
 * 主人自己的说法，只在本轮相关时才取出来。
 *
 * 这里刻意不做「全量词表塞进提示词」：一张 200 条的对照表每轮都跟着走，
 * 既费 token 又让模型把无关解释当成背景。命中一条才给一条，没命中就连字段
 * 都不出现——空数组会被读成「主人没有暗号」，那是另一种撒谎。
 */

/** 2–5 位 ASCII 片段，前后不粘字母数字：「DS」「RE」「ds」「x1」都算。 */
const SHORT_TOKEN = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]{1,4})(?![A-Za-z0-9_-])/g;

/** 只扫开头这么多个字符：一次对话说的是眼前这件事，长文本是贴进来的资料。 */
const SCAN_LIMIT = 4000;

/** 一次最多给几个未知写法。给多了模型会挑着问，反而更吵。 */
const UNKNOWN_LIMIT = 6;

export interface AssistantTermContext {
  /** 本轮命中、可以直接拿来理解问题的已确认说法。 */
  readonly notes: readonly { readonly term: string; readonly meaning: string }[];
  /** 本轮出现、尚未登记、今天还没提过的短写法。 */
  readonly unknownTokens: readonly string[];
  /** 命中条目的反向写法，用来扩展检索词（问「读书」也要找到写「DS」的记录）。 */
  readonly expansionTerms: readonly string[];
}

const normalize = (value: string): string => value.trim().toLowerCase();

/** 中文名（习惯、实体）本身就够解释自己，不该被当成暗号。 */
function knownNames(repository: SqliteRecordRepository, entities: readonly Entity[]): Set<string> {
  const names = new Set<string>();
  for (const habit of repository.cycleIntimacyModule().config.habits ?? []) names.add(normalize(habit.name));
  for (const entity of entities) {
    names.add(normalize(entity.name));
    for (const alias of entity.aliases ?? []) names.add(normalize(alias));
  }
  return names;
}

/**
 * A shorthand looks different from an English word: all caps, digits, or
 * separators. This only orders the candidates — it never decides that something
 * is unexplained, because an ordinary word like `token` is something the model
 * can read and will simply not ask about.
 */
const candidateRank = (token: string): number => (/[0-9_-]/.test(token) ? 0 : token === token.toUpperCase() ? 1 : 2);

function extractTokens(message: string): readonly string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const match of Array.from(message.slice(0, SCAN_LIMIT).matchAll(SHORT_TOKEN))) {
    const raw = match[1]!;
    const key = normalize(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  // Stable sort, so equally plausible candidates keep the order they were written.
  return out.sort((a, b) => candidateRank(a) - candidateRank(b));
}

/** Does the message actually contain this term? `ds` must not match inside `words`. */
function mentionsTerm(message: string, term: string): boolean {
  return matchesJournalTerm(message.toLowerCase(), term);
}

/**
 * `note` 命中两种方向：问题里写了暗号（DS），或者写了它被确认过的含义（读书）。
 * 两种都要把「另一半」拿去扩展检索词，否则问哪一边都只找得到自己那一半记录。
 */
function matchNotes(message: string, notes: readonly TermNote[]): readonly { note: TermNote; byMeaning: boolean }[] {
  const lower = message.toLowerCase();
  return notes.flatMap((note): { note: TermNote; byMeaning: boolean }[] => {
    if (mentionsTerm(lower, normalize(note.term))) return [{ note, byMeaning: false }];
    if (lower.includes(normalize(note.meaning))) return [{ note, byMeaning: true }];
    return [];
  });
}

/**
 * Shorthands nobody has explained yet, from any text the model is about to read.
 *
 * Called twice: once with the owner's own message, once with the retrieved record
 * bodies. The second pass matters most — when he asks about 读书 and the matching
 * record says DS, that mismatch is exactly the moment worth one question.
 */
export function unexplainedTokens(repository: SqliteRecordRepository, texts: readonly string[], today: string, entities?: readonly Entity[]): readonly string[] {
  const notes = repository.listTermNotes();
  const known = knownNames(repository, entities ?? repository.listEntities());
  const registered = new Set(notes.map(note => normalize(note.term)));
  const asked = new Set(repository.termsAskedOn(today).map(normalize));
  const seen = new Set<string>(), out: string[] = [];
  for (const text of texts) {
    for (const token of extractTokens(text)) {
      const key = normalize(token);
      if (registered.has(key) || known.has(key) || asked.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out.slice(0, UNKNOWN_LIMIT);
}

export function assistantTermContext(repository: SqliteRecordRepository, message: string, today: string, entities?: readonly Entity[]): AssistantTermContext {
  const notes = repository.listTermNotes();
  if (!notes.length && !extractTokens(message).length) return { notes: [], unknownTokens: [], expansionTerms: [] };
  const hits = matchNotes(message, notes);
  const expansion = new Set<string>();
  for (const { note, byMeaning } of hits) {
    // 命中暗号就补含义，命中含义就补暗号——只补有实际检索价值的那一边。
    for (const candidate of byMeaning ? [note.term] : [note.meaning]) {
      const normalized = normalize(candidate);
      if (normalized.length >= 2) expansion.add(normalized);
    }
  }
  return {
    notes: hits.map(({ note }) => ({ term: note.displayTerm, meaning: note.meaning })),
    unknownTokens: unexplainedTokens(repository, [message], today, entities),
    expansionTerms: [...expansion],
  };
}

/**
 * 给出去就记账。同一个写法一天只出现在「待确认」里一次，第二天自然重来；
 * 不设「一天只准问一次」的总闸——问的是不同的东西，不该互相挤掉配额。
 */
export function recordTermAsks(repository: SqliteRecordRepository, tokens: readonly string[], today: string): void {
  for (const token of tokens) repository.recordTermAsk(normalize(token), today);
}

/**
 * 写入只发生在主人亲口解释之后，而且必须能在本轮消息里找到那个写法：
 * 模型凭一段回忆造出来的对照，会把以后每一次计数都悄悄算错。
 *
 * `message` 可以是本轮消息加最近几轮对话：反问一次之后，他往往只答「对」，
 * 那个写法只存在于上一轮的问题里。
 *
 * 返回一句告知文本，由调用方贴在回答末尾；返回 undefined 表示没有写入，
 * 此时调用方不应提到这件事。
 */
export function applyTermNote(repository: SqliteRecordRepository, raw: unknown, message: string | readonly string[], now: string): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as Record<string, unknown>;
  const display = typeof input.term === "string" ? input.term.trim() : "";
  // One short phrase, not a paragraph: the row exists to be read inline.
  const meaning = typeof input.meaning === "string" ? input.meaning.trim().replace(/\s+/g, " ") : "";
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,4}$/.test(display) || meaning.length > 20) return;
  const term = normalize(display);
  const texts = typeof message === "string" ? [message] : message;
  if (!texts.some(text => mentionsTerm(text, term))) return;
  // An empty meaning is how "forget it" is expressed: the row goes away instead of
  // sitting there with a stale explanation the owner cannot reach.
  if (!meaning) return repository.deleteTermNote(term) ? `\n\n（已忘掉 ${display} 的解释。）` : undefined;
  repository.saveTermNote({ term, displayTerm: display, meaning, at: now });
  return `\n\n（已记下：${display} ＝ ${meaning}。不对就说一声，我改。）`;
}

export const TERM_NOTE_RULE = [
  "termNotes 是主人确认过的个人说法（如「DS＝读书」）。只在与本轮内容相关时直接拿来理解问题，不要复述解释、不要主动科普、不要每轮都提；不相关时连提都不提。",
  "unknownTokens 是本轮还没登记的短写法，可能来自主人刚说的话，也可能来自你检索到的记录正文。该问的时候：你无法确定它指什么，而它出现在主人的记录里或影响这次回答——尤其是主人用普通词提问、检索到的记录里却是另一种写法，那正是要问的一刻。不要因为「从上下文能猜个大概」就跳过：猜出来的不算知道，下次仍然对不上。不该问的时候：通用词（AI、PDF、Wi-Fi、型号），或者你确实读得懂。问法：一次最多一个，放在回答最后一句话里顺带问，不要单独起一段质问、不要打断正文；没得问就一个字都不提。",
  "绝不猜测写法含义，也不要因为它出现就改去否定记录的存在。",
  "termNote 不是写记录，不需要主人点确认：它只是记下主人刚说过的这句话，属于你自己的备忘，只影响你以后怎么理解这个词，不改动任何记录。所以不要说「我没有写入权限」、不要让主人自己去别处记。主人亲口说明含义后，直接在 lifeos 附加块里加 termNote:{term:\"原样写法\",meaning:\"简短含义\"}，后端会在回答末尾自动注明「已记下」，主人看到不对会纠正。主人说忘掉或说错了，用 termNote:{term:\"原样写法\",meaning:\"\"} 表示删除。不要自行推断后写入，不要为了凑格式而输出。",
].join("\n");

/**
 * The plain-text endpoint has no JSON envelope, so a write there travels as one
 * trailing marker line the server strips before the owner ever sees it. Ugly on
 * purpose: it cannot be confused with prose, and a half-written sentence never
 * becomes an instruction.
 */
export const TERM_NOTE_RULE_PLAIN = [
  "termNotes 是主人确认过的个人说法（如「DS＝读书」）。只在与本轮内容相关时直接拿来理解问题，不要复述解释、不要主动科普、不要每轮都提；不相关时连提都不提。",
  "unknownTokens 是本轮还没登记的短写法，可能来自主人刚说的话，也可能来自下面最近记录的正文。该问的时候：你无法确定它指什么，而它出现在记录里或影响这次回答——尤其是主人用普通词提问、记录里却是另一种写法，那正是要问的一刻。不要因为「从上下文能猜个大概」就跳过：猜出来的不算知道，下次仍然对不上。通用词（AI、PDF、Wi-Fi、型号）或者你确实读得懂，就不要问。问法：一次最多一个，放在回答最后一句话里顺带问，不要单独起一段质问、不要打断正文；没得问就一个字都不提。",
  "绝不猜测写法含义，也不要因为它出现就改去否定记录的存在。",
  "termNote 不是写记录：它只记下主人刚说过的这句话，是你自己的备忘，只影响你以后怎么理解这个词，不改动任何记录，所以不算违反「只读」。主人亲口说明含义后，在回答最后单独一行输出 <<term DS=读书>>；主人说忘掉或说错了，输出 <<term DS>>。这一行由程序读走、不会显示给主人，正文里不要解释它、不要提到它。不要自行推断后写入。",
].join("\n");
