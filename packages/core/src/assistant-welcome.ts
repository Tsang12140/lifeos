export interface WelcomePrompt {
  readonly id: string;
  readonly text: string;
  readonly enabled: boolean;
  readonly general: boolean;
  readonly pinned: boolean;
  readonly revision: number;
  readonly textVersion: number;
}
export interface WelcomeSelection {
  readonly selectionId: string;
  readonly prompts: readonly Pick<WelcomePrompt, "id" | "text">[];
}
export interface WelcomePromptStats extends WelcomePrompt {
  readonly impressions: number;
  readonly clicks: number;
  readonly clickRate: number;
  readonly feedbackViews: number;
  readonly feedbackClicks: number;
  readonly baseWeight: number;
  readonly feedbackBonus: number;
  readonly effectiveWeight: number;
}
export interface WelcomeAdminSnapshot {
  readonly items: readonly WelcomePromptStats[];
  readonly days: 7 | 30 | 0;
}

// Initial editorial choices. Seeds are inserted once; administrator edits survive restarts.
const texts = [
  "帮我回顾这一周", "今天有什么值得试试的小事？", "帮我安排一个舒服的周末",
  "我有个想法，陪我捋一捋", "有件事拿不定主意，帮我参谋一下", "从我的笔记里，找个能动手的点子",
  "挑个我感兴趣的话题，聊深一点", "找一个可以实现的小愿望", "想约个朋友，帮我想想做什么",
  "给今天加一点新鲜感", "我现在有半小时，做点什么好？", "帮我把一件拖着的事，变得容易开始",
  "给今天安排一个值得期待的小环节", "我想学点新东西，从哪里开始？", "把我最近的几个点子连起来看看",
  "从我的记录里，找个值得继续的计划", "找一条现在能派上用场的旧笔记", "从我的收藏里，挑一篇今天值得读的",
  "给我一个十分钟的创作题", "给下一篇日记想个不一样的开头", "陪我玩一轮快问快答",
  "问我一个平时很少有人问的问题", "我想认识一个新领域，带我入个门", "挑一个我的观点，换个角度聊聊",
  "帮我想一种更清楚的表达方式", "想给一个人准备惊喜，一起出出主意", "帮我设计一次不赶时间的约会",
  "给平常的一天起个有意思的名字", "如果今天只做一件重要的事，该怎么选？", "最近有什么好点子，被我随手记下了？",
];
const excluded = new Set([11, 19, 20, 21, 25, 28]);
const general = new Set([1, 2, 4, 5, 10, 12, 14, 29]);
export const WELCOME_PROMPT_SEEDS: readonly WelcomePrompt[] = texts.map((text, index) => ({
  id: `welcome-${String(index + 1).padStart(2, "0")}`, text, enabled: !excluded.has(index + 1),
  general: general.has(index + 1), pinned: false, revision: 1, textVersion: 1,
}));
