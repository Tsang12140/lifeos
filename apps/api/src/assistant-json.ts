import { assertAssistantActive } from "./assistant-cancellation.js";
import { askDeepSeek, type AssistantHistoryItem } from "./assistant.js";
import type { RuntimeAiConfig } from "./ai-config.js";
import type { ApiConfig } from "./config.js";
import { HttpError } from "./http-kit.js";
import type { ReplyPreview } from "./assistant-stream.js";

/** Retry model generation once, before validating plans or performing any writes. */
export async function askAssistantJson<T>(config: ApiConfig, runtime: RuntimeAiConfig, system: string, history: readonly AssistantHistoryItem[], message: string, images: readonly string[], validate: (value: unknown) => T, onPreview?: ReplyPreview, signal?: AbortSignal): Promise<T | null> {
  let jsonObject = true;
  let rejectedAnswer = "", repairHint = "响应不是完整JSON";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      assertAssistantActive(signal);
      const repairHistory: readonly AssistantHistoryItem[] = attempt > 0 && rejectedAnswer ? [...history, { role: "assistant", text: rejectedAnswer }] : history;
      const answer = await askDeepSeek(config, runtime, system + (attempt === 0 ? "" : `\n上次回复未能通过格式校验：${repairHint}。修复上一条助手输出，完整回答当前请求。返回合法JSON，action为reply/new_draft/update_draft之一，reply为非空字符串；拟写方案同时提供完整plan。`), repairHistory, message, images, { jsonObject, ...(onPreview ? { onPreview } : {}), ...(signal ? { signal } : {}) });
      if (answer === null) return null; // No key: retain the existing local rules.
      rejectedAnswer = answer.slice(0, 64000);
      const text = answer.trim().replace(/^\uFEFF/, "").replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
      let value: unknown;
      try { value = JSON.parse(text); } catch {
        repairHint = "JSON语法不完整";
        console.warn(`[assistant-json] stage=syntax chars=${text.length}`);
        throw new HttpError(502, "invalid_ai_reply", "回复格式未能完整读取，请重试");
      }
      try { return validate(value); }
      catch (error) {
        if (error instanceof HttpError && error.code === "unsafe_ai_action") throw error;
        const object = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const action = typeof object.action === "string" && ["reply", "new_draft", "update_draft"].includes(object.action) ? object.action : "missing_or_unknown";
        repairHint = action === "missing_or_unknown" ? "action缺失或取值不正确" : typeof object.reply !== "string" || !object.reply.trim() || object.reply.length > 12000 ? "reply须为1到12000字的字符串" : "拟写plan未通过字段校验，请对照输出协议检查完整结构";
        console.warn(`[assistant-json] stage=schema action=${action} reply_type=${typeof object.reply} reply_chars=${typeof object.reply === "string" ? object.reply.length : 0} plan=${object.plan !== undefined} code=${error instanceof HttpError ? error.code : "validation"}`);
        throw new HttpError(502, "invalid_ai_reply", "AI 回复未能完整生成，请重试。原消息和草稿已保留");
      }
    } catch (error) {
      assertAssistantActive(signal);
      onPreview?.("");
      if (!(error instanceof HttpError) || !["invalid_ai_reply", "ai_json_mode_unsupported"].includes(error.code)) throw error;
      // Compatibility fallback applies only when a provider explicitly rejects
      // response_format. Both attempts still require the same strict schema.
      if (error.code === "ai_json_mode_unsupported") jsonObject = false;
      console.warn(`[assistant-json] validation_failed attempt=${attempt + 1} reason=${error.code}`);
      if (attempt === 1) throw new HttpError(502, "invalid_ai_reply", "AI 回复未能完整生成，请重试。原消息和草稿已保留");
    }
  }
  throw new Error("Unreachable structured reply state");
}
