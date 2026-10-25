/**
 * 「多久没找 AI 管家就算翻篇」的判定。
 *
 * 主人 2026-10-23：一两个小时没找它，就自动开一段新对话，别把上次的聊天一直摆在屏幕上。
 * 之所以抽成纯函数：这条边界必须能脱离 React、脱离真实时钟被测
 * （`apps/web/test/assistant-idle.test.ts`），否则只能靠等两小时来验证。
 */
export const ASSISTANT_IDLE_RESET_MS = 2 * 60 * 60 * 1000;

export interface AssistantIdleInput {
  /** 屏幕上最后一条消息的时间（服务端 ISO）。缺时间就没法判断，按不翻篇处理。 */
  readonly lastMessageAt: string | undefined;
  /** 屏幕上现在有多少条消息。0 说明屏幕本来就是干净的。 */
  readonly visibleMessageCount: number;
  readonly now: number;
  readonly thresholdMs?: number;
}

/**
 * 只有「屏幕上有旧内容」才需要翻篇 —— 空对话再新建一次，只会白多一行库记录。
 * 时间读不出来、或者时间落在未来（服务端时钟偏差）时都不翻篇：
 * 宁可留着旧对话，也不能把一个没看懂的时间当成「很久以前」。
 */
export function assistantIdleResetDue({
  lastMessageAt,
  visibleMessageCount,
  now,
  thresholdMs = ASSISTANT_IDLE_RESET_MS,
}: AssistantIdleInput): boolean {
  if (visibleMessageCount <= 0 || lastMessageAt === undefined) return false;
  const at = Date.parse(lastMessageAt);
  if (!Number.isFinite(at)) return false;
  return now - at >= thresholdMs;
}
