import { useEffect, useState } from "react";
import type { EntityCandidate, TextEntityDecision } from "@lifeos/core";
import { apiRequest } from "./api";
import { EntityMentionReview } from "./entity-mention-review";

export interface NameHistoryReview {
  readonly recordId: string;
  readonly revision: number;
  readonly text: string;
  readonly isPrivate: boolean;
  readonly candidates: readonly EntityCandidate[];
  readonly decisions: readonly TextEntityDecision[];
}

export function EntityNameHistoryReview({ reviews, onReviewed, onChanged }: { reviews: readonly NameHistoryReview[]; onReviewed: (id: string) => void; onChanged: () => void }) {
  const [active, setActive] = useState<NameHistoryReview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setError(""); }, [reviews]);
  return <section className="entity-name-history-review" aria-label="核对历史称呼">
    <p>有 {reviews.length} 条记录的称呼存在歧义。资料尚未保存，请逐条核对，再保存。</p>
    {reviews.map(review => <div className="entity-name-history-row" key={review.recordId}><span>{review.isPrivate ? "私密记录，点击后查看上下文" : review.text.slice(0, 80)}</span><button className="secondary-button" type="button" disabled={busy} onClick={() => { setError(""); setActive(review); }}>核对记录</button></div>)}
    {error ? <p className="dialog-error" role="alert">{error}</p> : null}
    {active && !busy ? <EntityMentionReview key={`${active.recordId}:${active.revision}`} text={active.text} candidates={active.candidates} decisions={active.decisions} onClose={() => setActive(null)} onConfirm={decisions => {
      setBusy(true);
      void apiRequest(`/api/records/${encodeURIComponent(active.recordId)}`, { method: "PATCH", body: JSON.stringify({ revision: active.revision, entityMentions: decisions }) }).then(() => { onReviewed(active.recordId); setActive(null); onChanged(); }).catch(error => {
        setError(`${error instanceof Error ? error.message : "核对保存失败"}。可再次保存资料，刷新待核对列表。`);
        setActive(null);
      }).finally(() => setBusy(false));
    }} /> : null}
    {busy ? <p role="status">正在保存核对结果…</p> : null}
  </section>;
}
