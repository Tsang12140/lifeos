import { useMemo, type ReactNode } from "react";
import { BriefcaseBusiness, House, MapPin } from "lucide-react";
import {
  MENTION_MARKERS,
  entitySearchTerms,
  findEntityMentions,
  normalizeEntitySearchTerm,
  PLACE_ROLES,
} from "@lifeos/core";
import type { Entity } from "@lifeos/core";
import type { RecordView } from "./api";
import type { ModuleCommand } from "./movie";
import { isMovieEntity, relationLabelFor } from "./app-meta";

export const PLACE_ROLE_LABELS: Record<(typeof PLACE_ROLES)[number], string> = { home: "家", work: "工作", other: "其他" };

/**
 * Secondary information for a quick-picker row. The picker already tells us
 * whether it contains people or places, so repeating "人物/地点" is noise.
 */
export function entityHint(entity: Entity, entities: readonly Entity[] = []): string {
  if (isMovieEntity(entity)) {
    return [entity.originalTitle, entity.releaseYear === undefined ? undefined : String(entity.releaseYear), entity.doubanRating === undefined ? undefined : `豆瓣 ${entity.doubanRating}`].filter(Boolean).join(" · ");
  }
  const parts: string[] = [];
  if (entity.type === "person") {
    const relation = relationLabelFor(entity.id, entities);
    if (relation !== undefined) parts.push(relation);
  }
  if (entity.type === "place") {
    if (entity.role !== undefined) parts.push(PLACE_ROLE_LABELS[entity.role]);
    const { period } = entity;
    if (period !== undefined && (period.from !== undefined || period.until !== undefined)) {
      parts.push(`${period.from ?? "…"} – ${period.until ?? "至今"}`);
    }
  }
  const aliasText = (entity.aliases ?? []).join("、");
  if (aliasText.length > 0) parts.push(aliasText);
  if (parts.length === 0 && entity.description?.trim()) {
    const description = entity.description.trim().replace(/\s+/g, " ");
    parts.push(description.length > 36 ? `${description.slice(0, 36)}…` : description);
  }
  return parts.join(" · ");
}

export interface MentionQuery {
  readonly query: string;
  readonly marker: string;
  readonly start: number;
  readonly end: number;
  readonly forceNew: boolean;
}

export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const upto = value.slice(0, caret);
  // The last typed marker wins; `##名字` or `@@名字` means "skip the known
  // list, offer to create" — and its replacement range starts at the FIRST
  // marker so the doubled trigger is removed when a name is inserted.
  let at = -1;
  let marker = "";
  for (const entry of MENTION_MARKERS) {
    const index = upto.lastIndexOf(entry.marker);
    if (index > at) {
      at = index;
      marker = entry.marker;
    }
  }
  if (at === -1) return null;
  const previous = upto[at - 1];
  if (previous !== undefined && /[A-Za-z0-9]/.test(previous)) return null;
  const forceNew = previous === marker;
  const query = upto.slice(at + 1);
  const isCompactQuery = !/[\s@#]/.test(query);
  const isSpacedEnglishName = /^[A-Za-z][A-Za-z\s_-]*[A-Za-z]$/u.test(query);
  if (query.length > 24 || /[@#]/.test(query) || (!isCompactQuery && !isSpacedEnglishName)) return null;
  return { query, marker, start: forceNew ? at - 1 : at, end: caret, forceNew };
}

export function mentionSuggestions(entities: readonly Entity[], marker: string, query: string, recentIds: readonly string[] = []): readonly Entity[] {
  const kinds = MENTION_MARKERS.find((entry) => entry.marker === marker)?.kinds ?? [];
  const pool = entities.filter((entity) => kinds.includes(entity.type));
  const needle = normalizeEntitySearchTerm(query);
  const matched = needle.length === 0 ? pool : pool.filter((entity) => entitySearchTerms(entity).some((term) => normalizeEntitySearchTerm(term).includes(needle)));
  return rankByRecency(matched, recentIds).slice(0, 10);
}

/**
 * Recently used first, everything else in the order it arrived.
 * Stability matters: anything not recently used keeps its relative position.
 */
export function rankByRecency(items: readonly Entity[], recentIds: readonly string[]): readonly Entity[] {
  if (recentIds.length === 0 || items.length < 2) return items;
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  return [...items].sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}

/**
 * The order places were last written about, most recent first.
 * `occurredAt` is preferred over `createdAt` because a backfilled entry is
 * still a use of that place.
 */
export function recentPlaceIds(records: readonly RecordView[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const sorted = [...records].sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt?.value ?? left.createdAt.value) || 0;
    const rightTime = Date.parse(right.occurredAt?.value ?? right.createdAt.value) || 0;
    return rightTime - leftTime;
  });
  for (const record of sorted) {
    for (const ref of record.entityRefs) {
      if (ref.entityType !== "place" || seen.has(ref.entityId)) continue;
      seen.add(ref.entityId);
      ordered.push(ref.entityId);
    }
  }
  return ordered;
}

export function hasKnownMentionPrefix(entities: readonly Entity[], marker: string, query: string): boolean {
  const kinds = MENTION_MARKERS.find((entry) => entry.marker === marker)?.kinds ?? [];
  const normalizedQuery = normalizeEntitySearchTerm(query);
  return normalizedQuery.length > 0 && entities
    .filter((entity) => kinds.includes(entity.type))
    .some((entity) => entitySearchTerms(entity).some((term) => normalizedQuery.startsWith(normalizeEntitySearchTerm(term))));
}

export interface SlashQuery {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/** A slash only becomes a command trigger at the start of a token. */
export function slashQueryAt(value: string, caret: number): SlashQuery | null {
  const upto = value.slice(0, caret);
  const slash = upto.lastIndexOf("/");
  if (slash < 0) return null;
  const previous = upto[slash - 1];
  if (previous !== undefined && !/\s/u.test(previous)) return null;
  const query = upto.slice(slash + 1);
  if (/\s|[@#]/u.test(query) || query.length > 24) return null;
  return { query, start: slash, end: caret };
}

export function slashSuggestions(commands: readonly ModuleCommand[], query: string): readonly ModuleCommand[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return commands;
  return commands.filter((command) => [command.label, ...command.aliases].some((term) => term.toLocaleLowerCase().startsWith(needle)));
}

/** Record text where `@person` and `#place` render as capsules, markers hidden. */
export function RecordText({ text, entities }: { readonly text: string; readonly entities: readonly Entity[] }) {
  const mentions = useMemo(() => findEntityMentions(text, entities), [text, entities]);
  if (mentions.length === 0) return <>{text}</>;
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((mention, index) => {
    if (mention.start > cursor) parts.push(text.slice(cursor, mention.start));
    const entity = entitiesById.get(mention.entityId);
    const PlaceIcon = entity?.type === "place" && entity.role === "home" ? House : entity?.type === "place" && entity.role === "work" ? BriefcaseBusiness : MapPin;
    parts.push(<span className={`mention-chip ${mention.entityType === "place" ? "is-place" : ""}`} key={`${mention.entityId}-${mention.start}-${index}`}>
      {mention.entityType === "place" ? <PlaceIcon size={13} strokeWidth={1.9} aria-hidden="true" /> : null}{entity?.name ?? mention.matched}
    </span>);
    cursor = mention.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Re-exported for callers that still need the vocabulary helper next to text. */
export { mentionVocabulary, refAsEntity } from "./app-meta";
export type { RecordView };
