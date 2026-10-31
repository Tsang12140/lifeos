/**
 * Deciding what to do when the body of a record was edited in two places.
 *
 * The body travels as one string, so a save always carries the whole text. That
 * makes "read the latest version, then save again" dangerous: refreshing the
 * record also refreshes its revision, the server then has nothing to refuse, and
 * whatever the other device wrote is replaced by a draft that never saw it. This
 * is the decision table that keeps that from happening silently.
 *
 * `base`   the body as it was when this editor opened the record
 * `mine`   the body in the editor right now
 * `theirs` the body the server has right now
 *
 * Only one-sided edits are resolved automatically. Two-sided edits stay a
 * conflict on purpose — guessing "take the newest" is exactly what loses a
 * paragraph.
 */
export type BodyMerge =
  | { readonly kind: "same" }
  | { readonly kind: "take-theirs"; readonly text: string }
  | { readonly kind: "keep-mine" }
  | { readonly kind: "conflict" };

export function mergeBodies(base: string, mine: string, theirs: string): BodyMerge {
  if (mine === theirs) return { kind: "same" };
  if (mine === base) return { kind: "take-theirs", text: theirs };
  if (theirs === base) return { kind: "keep-mine" };
  return { kind: "conflict" };
}
