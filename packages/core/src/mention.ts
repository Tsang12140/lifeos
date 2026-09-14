import type { Entity, EntityId, EntityKind } from "./model.js";

/** The character a user types to mention a person. */
export const MENTION_MARKER = "@";

/** The character a user types to mention a place. */
export const PLACE_MARKER = "#";

/**
 * Which entity kinds each marker resolves to. Both markers share the same
 * safety rules: only known names or aliases match, and a marker glued to a
 * latin word is never one. `##` (or `@@`) is the picker's force-new trigger,
 * never a mention — a marker preceded by any marker is skipped.
 */
export const MENTION_MARKERS: readonly { readonly marker: string; readonly kinds: readonly EntityKind[] }[] = [
  { marker: "@", kinds: ["person"] },
  { marker: "#", kinds: ["place"] },
];

/**
 * Kinds the default parse resolves. `@` stays people-only; `#` adds places
 * because the typed marker itself is the user's explicit intent — nothing is
 * guessed from prose.
 */
export const MENTION_ENTITY_KINDS: readonly EntityKind[] = ["person"];

export interface MentionOptions {
  /** Which entity kinds a mention may resolve to. Defaults to every marker's kinds. */
  readonly kinds?: readonly EntityKind[];
}

export interface EntityMention {
  readonly entityId: EntityId;
  readonly entityType: EntityKind;
  /** The substring that matched, without the marker. */
  readonly matched: string;
  /** Index of the marker character. */
  readonly start: number;
  /** Index just past the matched name. */
  readonly end: number;
}

/** Every string that identifies an entity: its name plus any aliases. */
export function entitySearchTerms(entity: Entity): readonly string[] {
  return [entity.name, ...(entity.aliases ?? [])].filter((term) => term.trim().length > 0);
}

export function normalizeEntitySearchTerm(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
}

export function canonicalPersonName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z][A-Za-z\s_-]*$/u.test(trimmed)) return trimmed;
  const words = trimmed.normalize("NFKC").replace(/([a-z])([A-Z])/gu, "$1 $2").split(/[\s_-]+/u).filter(Boolean);
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1).toLocaleLowerCase()).join("");
}

function isLatinWordChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9]/.test(value);
}

interface Candidate {
  readonly term: string;
  readonly folded: string;
  readonly entity: Entity;
  readonly marker: string;
}

function candidateEndAt(text: string, start: number, candidate: Candidate): number | null {
  let textIndex = start;
  let candidateIndex = 0;
  while (candidateIndex < candidate.folded.length) {
    const character = text[textIndex];
    if (character === undefined) return null;
    if (/\s/u.test(character)) {
      if (candidateIndex === 0) return null;
      textIndex += 1;
      continue;
    }
    const foldedCharacter = character.normalize("NFKC").toLocaleLowerCase();
    if (!candidate.folded.startsWith(foldedCharacter, candidateIndex)) return null;
    candidateIndex += foldedCharacter.length;
    textIndex += 1;
  }
  return textIndex;
}

/**
 * Finds `@person` and `#place` mentions that match a known entity name or
 * alias. Only known names count, which is what keeps `someone@example.com`,
 * a password, or a hex colour like `#fff` out of the results: an unknown
 * token is not a mention. A marker preceded by a latin letter or digit, or
 * by another marker, is skipped outright. A marker only resolves to the
 * kinds assigned to it, so `#阿彬` and `@江边` both stay plain text.
 */
export function findEntityMentions(
  text: string,
  entities: readonly Entity[],
  options: MentionOptions = {},
): readonly EntityMention[] {
  const allowed = options.kinds === undefined ? undefined : new Set<EntityKind>(options.kinds);
  const candidates: Candidate[] = [];
  for (const entity of entities) {
    const marker = MENTION_MARKERS.find((entry) => entry.kinds.includes(entity.type));
    if (marker === undefined || (allowed !== undefined && !allowed.has(entity.type))) continue;
    for (const term of entitySearchTerms(entity)) {
      candidates.push({ term, folded: normalizeEntitySearchTerm(term), entity, marker: marker.marker });
    }
  }
  if (candidates.length === 0) return [];
  // Longest term first so "@阿彬（同事）" is not eaten by a shorter "@阿彬".
  candidates.sort((left, right) => right.folded.length - left.folded.length);

  const mentions: EntityMention[] = [];
  let handledUntil = 0;
  for (let at = 0; at < text.length; at += 1) {
    const marker = text[at];
    if (!MENTION_MARKERS.some((entry) => entry.marker === marker)) continue;
    const previous = text[at - 1];
    const blocked = isLatinWordChar(previous) || MENTION_MARKERS.some((entry) => entry.marker === previous) || at < handledUntil;
    if (blocked) continue;
    const hit = candidates.find((candidate) => {
      if (candidate.marker !== marker) return false;
      const end = candidateEndAt(text, at + 1, candidate);
      if (end === null) return false;
      // A latin term must end at a boundary, so "#bar" cannot match "#barbecue".
      const after = text[end];
      return !isLatinWordChar(candidate.folded[candidate.folded.length - 1]) || !isLatinWordChar(after);
    });
    if (hit !== undefined) {
      const end = candidateEndAt(text, at + 1, hit);
      if (end === null) continue;
      mentions.push({ entityId: hit.entity.id, entityType: hit.entity.type, matched: text.slice(at + 1, end), start: at, end });
      handledUntil = end;
    }
  }
  return mentions;
}
