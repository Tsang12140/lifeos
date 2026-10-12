import { DEFAULT_CONTACT_ACTIVITY_THRESHOLD, entitySearchTerms, normalizeEntitySearchTerm, type ContactActivity, type Entity } from "@lifeos/core";

const byName = new Intl.Collator("zh-CN-u-co-pinyin", { sensitivity: "base", numeric: true });
export function contactThreshold(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.5 && number <= 20 ? number : DEFAULT_CONTACT_ACTIVITY_THRESHOLD;
}

/** Search always covers the complete vocabulary, regardless of the default visibility gate. */
export function selectContacts(entities: readonly Entity[], activity: readonly ContactActivity[], mode: "common" | "all", query: string, threshold: number): readonly Entity[] {
  const scores = new Map(activity.map(item => [item.entityId, item.score]));
  const needle = normalizeEntitySearchTerm(query.trim());
  const alphabetical = mode === "all" || needle.length > 0;
  return entities.filter(entity => entity.type === "person")
    .filter(entity => needle.length > 0
      ? entitySearchTerms(entity).some(term => normalizeEntitySearchTerm(term).includes(needle))
      : mode === "all" || (entity.type === "person" && entity.isImportant === true) || (scores.get(entity.id) ?? 0) >= threshold)
    .sort((a, b) => (alphabetical ? 0 : (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)) || byName.compare(a.name, b.name) || a.id.localeCompare(b.id));
}
