import { assertAssistantActive } from "./assistant-cancellation.js";
import { askDeepSeek, type AssistantHistoryItem } from "./assistant.js";
import { runtimeWithGear, type RuntimeAiConfig } from "./ai-config.js";
import type { ApiConfig } from "./config.js";
import { HttpError } from "./http-kit.js";
import type { ReplyPreview } from "./assistant-stream.js";
import { attemptDetailOf, isCancellation, NO_ATTEMPT_RECORDER, withAttemptDetail, type AttemptRecorder } from "./assistant-attempt-log.js";
import { decodeChatOutput, readableReply, splitChatMetadata, type ReadableReply } from "./assistant-reply-body.js";
import { hasOrphanAssistantCitation } from "@lifeos/core";

export interface ReplyDeliveryRecovery<T> { recover: (body: ReadableReply) => T | null }

/** Retry model generation once, before validating plans or performing any writes. */
export async function askAssistantJson<T>(config: ApiConfig, runtime: RuntimeAiConfig, system: string, history: readonly AssistantHistoryItem[], message: string, images: readonly string[], validate: (value: unknown) => T, onPreview?: ReplyPreview, signal?: AbortSignal, recorder: AttemptRecorder = NO_ATTEMPT_RECORDER, delivery?: ReplyDeliveryRecovery<T>): Promise<T | null> {
  let jsonObject = !delivery;
  let rejectedAnswer = "", repairHint = "响应不是完整JSON";
  // No-body chat repair uses direct prose; strict extraction callers keep schema repair.
  let attemptRuntime = runtime;
  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = new Date();
    // Raw output of *this* attempt only. Reusing `rejectedAnswer` here would
    // file the previous attempt's text against the current attempt's error.
    let raw = "";
    try {
      assertAssistantActive(signal);
      const repairHistory: readonly AssistantHistoryItem[] = attempt > 0 && rejectedAnswer ? [...history, { role: "assistant", text: rejectedAnswer }] : history;
      const retryInstruction = delivery ? "\n上次没有可用回答。这次请直接用普通文字回答当前问题，不要JSON外壳，不要思考过程，也不要附加操作信息。" : `\n上次回复未能通过格式校验：${repairHint}。修复上一条助手输出，完整回答当前请求。返回合法JSON，action为reply/new_draft/update_draft之一，reply为非空字符串；拟写方案同时提供完整plan。`;
      const answer = await askDeepSeek(config, attemptRuntime, system + (attempt === 0 ? "" : retryInstruction), repairHistory, message, images, { jsonObject, ...(delivery ? { preserveReply: true } : {}), ...(onPreview ? { onPreview } : {}), ...(signal ? { signal } : {}) });
      if (answer === null) return null; // No key: retain the existing local rules.
      raw = answer;
      rejectedAnswer = answer.slice(0, 64000);
      const text = answer.trim().replace(/^\uFEFF/, "").replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
      let value: unknown;
      const chat = delivery ? decodeChatOutput(answer) : null;
      if (chat) {
        if (chat.limited) throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "回答较长，已保留收到的内容"), { stage: "format", errorCode: "ai_reply_display_limit", errorDetail: "正文超过当前单条回答长度，已保留前12000字", receivedChars: answer.length, rawText: answer });
        const body = readableReply(answer);
        if (body && hasOrphanAssistantCitation(body.text)) throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "回复未完整说明内容，已保留收到的文字，请重试"), { stage: "format", errorCode: "ai_reply_orphan_citation", errorDetail: "正文以引用编号起头，或引用编号独占一行，缺少它应支持的事实叙述", receivedChars: answer.length, rawText: answer });
        if (chat.issue) recorder.diagnose?.({ stage: "format", errorCode: `ai_reply_${chat.issue}_ignored`, errorDetail: "正文已交付，附加格式未采用", receivedChars: answer.length, rawText: answer });
        value = chat.value;
      } else {
        try { value = JSON.parse(text); } catch (error) {
          repairHint = "JSON语法不完整";
          console.warn(`[assistant-json] stage=syntax chars=${text.length}`);
          throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "回复格式未能完整读取，请重试"), { stage: "format", errorCode: "ai_json_syntax", errorDetail: `JSON 解析失败（正文 ${text.length} 字）：${error instanceof Error ? error.message : "语法不合法"}`, receivedChars: raw.length, rawText: raw });
        }
      }
      try { return validate(value); }
      catch (error) {
        if (error instanceof HttpError && error.code === "unsafe_ai_action") throw error;
        const object = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const action = typeof object.action === "string" && ["reply", "new_draft", "update_draft"].includes(object.action) ? object.action : "missing_or_unknown";
        repairHint = action === "missing_or_unknown" ? "action缺失或取值不正确" : typeof object.reply !== "string" || !object.reply.trim() || object.reply.length > 12000 ? "reply须为1到12000字的字符串" : "拟写plan未通过字段校验，请对照输出协议检查完整结构";
        console.warn(`[assistant-json] stage=schema action=${action} reply_type=${typeof object.reply} reply_chars=${typeof object.reply === "string" ? object.reply.length : 0} plan=${object.plan !== undefined} code=${error instanceof HttpError ? error.code : "validation"}`);
        throw withAttemptDetail(new HttpError(502, "invalid_ai_reply", "AI 回复未能完整生成，请重试。原消息和草稿已保留"), { stage: "format", errorCode: "ai_schema_invalid", errorDetail: `结构校验未通过：${repairHint}（action=${action}）`, receivedChars: raw.length, rawText: raw });
      }
    } catch (error) {
      assertAssistantActive(signal);
      if (isCancellation(error)) throw error;
      // Buffered, not written. The caller flushes only once the whole turn has
      // failed — an attempt the repair retry recovered from was never a failure
      // the owner saw, and logging it would fill the page with phantom errors.
      const detail = attemptDetailOf(error);
      const body = delivery ? readableReply(detail?.rawText ?? raw) : null;
      if (body && delivery) {
        const recovered = delivery.recover(body);
        if (recovered !== null) {
          onPreview?.(body.text);
          const bodyEndedBeforeMetadata = splitChatMetadata(detail?.rawText ?? raw).metadata !== undefined;
          if (detail?.errorCode === "ai_reply_display_limit" || detail?.errorCode === "ai_reply_orphan_citation" || (!bodyEndedBeforeMetadata && (detail?.stage !== "format" || detail?.errorCode === "ai_reply_truncated"))) {
            const partial = { ...detail!, partialReply: body.text };
            recorder.fail({ ...partial, attempt: attempt + 1, model: attemptRuntime.model ?? null, effort: attemptRuntime.thinking ? attemptRuntime.reasoningEffort ?? "high" : "direct", startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime() });
            throw withAttemptDetail(error instanceof Error ? error : new Error(String(error)), partial);
          }
          console.warn(`[assistant-delivery] recovered=${detail?.errorCode ?? "format"} chars=${body.text.length} operations=false`);
          recorder.diagnose?.({ stage: "format", errorCode: detail?.errorCode ?? "ai_reply_recovered", errorDetail: "正文已交付，未执行附加操作", receivedChars: detail?.receivedChars ?? raw.length, rawText: detail?.rawText ?? raw });
          return recovered;
        }
      }
      onPreview?.("");
      recorder.fail({
        attempt: attempt + 1,
        stage: detail?.stage ?? "service",
        errorCode: detail?.errorCode ?? (error instanceof HttpError ? error.code : "chat_failed"),
        errorDetail: detail?.errorDetail ?? (error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)),
        httpStatus: detail?.httpStatus ?? null,
        receivedChars: detail?.receivedChars ?? raw.length,
        rawText: detail?.rawText ?? raw,
        model: attemptRuntime.model ?? null,
        effort: attemptRuntime.thinking ? attemptRuntime.reasoningEffort ?? "high" : "direct",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
      });
      if (!(error instanceof HttpError) || !["invalid_ai_reply", "ai_json_mode_unsupported"].includes(error.code)) throw error;
      // Compatibility fallback applies only when a provider explicitly rejects
      // response_format. Both attempts still require the same strict schema.
      if (error.code === "ai_json_mode_unsupported") jsonObject = false;
      // A normal finish can still contain only whitespace, even without thinking.
      // Retry once in direct/plain mode; never infer budget exhaustion from stop.
      if (attempt === 0 && error.code === "invalid_ai_reply" && (detail?.errorCode === "ai_reply_empty" || delivery)) {
        attemptRuntime = runtimeWithGear(attemptRuntime, "direct");
        if (delivery) jsonObject = false;
        repairHint = "上次只产出了思考、没有正文；这次请直接输出正文";
      }
      console.warn(`[assistant-json] validation_failed attempt=${attempt + 1} reason=${error.code}`);
      if (attempt === 1) throw new HttpError(502, "invalid_ai_reply", "AI 回复未能完整生成，请重试。原消息和草稿已保留");
    }
  }
  throw new Error("Unreachable structured reply state");
}
