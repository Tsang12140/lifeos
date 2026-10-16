/**
 * One browser keeps one drawer per origin — and every profile is served from the
 * same one. `localStorage`, `sessionStorage` and IndexedDB are therefore shared
 * between the real library and any test card: the interface font, the private
 * records switch, and a half-typed draft all leak across the boundary.
 *
 * This module names the drawer. The profile name is injected by the launcher as
 * `VITE_LIFEOS_PROFILE` (`.review/profile-serve.mjs`), and **the real library is
 * never injected** — its keys stay exactly as they were, so nothing has to be
 * migrated and nothing looks lost after this change lands.
 *
 * It rides on `import.meta.env` rather than a Vite `define`: measured on Vite
 * 7.3.6, a `define` entry was not substituted into dev-served source, and a name
 * that silently stays undefined is indistinguishable from "the real library".
 *
 * The scope answers "whose drawer is this", not "who is signed in": account
 * scoping (`composerDraftScope`'s `account:<id>`) still nests inside it.
 */
const injected = import.meta.env?.VITE_LIFEOS_PROFILE;

/** Empty for the real library; the card's name otherwise. */
export const PROFILE_SCOPE: string = typeof injected === "string" ? injected.trim() : "";

/** Real library: the key unchanged. Any card: the name appended, so keys stay unique. */
export function scopedKey(key: string): string {
  return PROFILE_SCOPE === "" ? key : `${key}@${PROFILE_SCOPE}`;
}
