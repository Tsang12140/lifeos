import { asksAboutDreams, isDreamRecord, type BackfillChatMessage, type BackfillPlan } from "@lifeos/core";
import type { SqliteRecordRepository } from "./repository.js";
import { journalDateRange } from "./journal-retrieval.js";
import { dateForTime } from "./timeline-query.js";

interface TransferRequest { readonly mode: "move" | "copy"; readonly instruction: string }
/** Recognize the requested destination separately from the source. Never take instructions from assistant prose. */
function explicitTransfer(message: string): TransferRequest | undefined {
  const instruction = message.replace(/```[\s\S]*?```|[“「『"][^”」』"\n]*[”」』"]|^\s*>.*$/gm, "");
  if (/别|不要|不用|取消|停止|先不|先只|先讨论|怎么|如何|能不能|可以吗|什么意思|[？?]/.test(instruction)) return;
  if (!/(?:日记|记录|这条|那条|整条)/.test(instruction)) return;
  if (!/(?:复制|拷贝|迁移|移动|挪|搬|转|改|归|放)[\s\S]{0,30}(?:梦境|梦的页面)/.test(instruction)) return;
  return { mode: /复制|拷贝/.test(instruction) ? "copy" : "move", instruction: message };
}
export function dreamTransferRequest(message: string, history: readonly BackfillChatMessage[]): TransferRequest | undefined {
  const direct = explicitTransfer(message);
  if (direct) return direct;
  if (/不用|不要|取消|停止|先不|换个话题/.test(message) || !/这不就是|就是这条|整条|全文|完整|不是一段/.test(message)) return;
  // Continue a short chain of corrections; an unrelated user topic expires it.
  for (const previous of history.filter(item => item.role === "user").slice(-4).reverse()) {
    const request = explicitTransfer(previous.text);
    if (request) return request;
    if (/不用|不要|取消|停止|换个话题/.test(previous.text) || !/这不就是|就是这条|整条|全文|完整|不是一段/.test(previous.text)) return;
  }
  return;
}

const normalize = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");
export function proposeDreamTransfer(repository: SqliteRecordRepository, request: TransferRequest, message: string, today: string, preferredSourceId?: string): { reply: string; plan?: BackfillPlan } {
  const range = journalDateRange(request.instruction, today);
  // Private writes remain outside the existing backfill permission boundary.
  let sources = repository.list({ kind: "journal" }).filter(record => !record.isPrivate && !record.isDemo && !isDreamRecord(record)).filter(record => {
    const date = dateForTime(record.occurredAt ?? record.createdAt, "Asia/Shanghai");
    return date <= today && (!range || date >= range.from && date <= range.to);
  });
  const prefix = message.split(/[-—]{2,}|这不就是|这就是|就是这条/)[0]!.trim();
  const identifiesSource = message !== request.instruction && /这不就是|就是这条/.test(message) && normalize(prefix).length >= 8;
  if (identifiesSource) {
    sources = sources.filter(record => normalize(record.body.edited ?? record.body.original).includes(normalize(prefix)));
  } else if (asksAboutDreams(request.instruction) && /写梦|做梦|梦见|噩梦|梦的|有关梦/.test(request.instruction)) {
    sources = sources.filter(record => asksAboutDreams(record.body.edited ?? record.body.original));
  }
  if (sources.length > 1 && preferredSourceId && !identifiesSource && !/另|换|不同|不是这/.test(message)) {
    sources = sources.filter(record => record.id === preferredSourceId);
  }
  if (sources.length !== 1) return { reply: sources.length ? `找到 ${sources.length} 条可能的普通日记，暂时不能确定是哪条。请贴出要处理那条的开头，并说“就是这条”；我会用它定位完整原记录。` : "本次没有定位到可处理的普通日记。请核对日期，或贴出原记录开头并说“就是这条”。私密或上锁记录不会在这里迁移；本次没有新建或修改记录。" };
  const source = sources[0]!;
  const content = source.body.edited ?? source.body.original;
  const date = dateForTime(source.occurredAt ?? source.createdAt, "Asia/Shanghai");
  const label = request.mode === "move" ? "迁移" : "复制";
  return {
    reply: `已找到 ${date} 的完整日记，下面保留整条正文和附件。确认后${request.mode === "move" ? "把原记录改为梦境，保留原日期和记录 ID" : "新建一条完整梦境副本，保留原日记"}；现在还没有改动记录。`,
    plan: { objects: [], explanation: `${label}整条日记到梦境，正文、照片和原日期保持不变。`, entries: [{ key: `transfer-${source.id}`, selected: true, kind: "journal", nature: "dream", content, date, time: "", evidence: `${date} 的完整原记录`, questions: "", entityKeys: [], assetIds: source.assetRefs.map(ref => ref.assetId), transfer: { sourceId: source.id, sourceRevision: source.revision, mode: request.mode } }] },
  };
}
