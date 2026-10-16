/**
 * Whether private records are shown, and whether the owner has allowed the
 * assistant to look at them for a while.
 *
 * Default is OFF, and that is a deliberate change of behaviour: private records
 * used to sit in the timeline behind a click-to-reveal mask. From now on they do
 * not reach the list at all until this is turned on.
 *
 * Two separate things are tracked, because they answer different questions:
 *
 *   · `visible`  — the standing switch. "I want to see my private records."
 *   · `grant`    — a one-off or session-long yes, given in the moment when the
 *                  owner asked for something that only private records answer.
 *
 * This is a consent gate, not a security boundary. The records API already hands
 * private records to any authenticated client; what this protects is the owner's
 * attention and what ends up in the assistant's context — not the bytes.
 */
import { scopedKey } from "./storage-scope.ts";

/** Both keys carry the card's name: the privacy switch must not follow the browser. */
export const PRIVACY_VISIBLE_KEY = scopedKey("lifeos.privacy.visible.v1");
export const PRIVACY_SESSION_GRANT_KEY = scopedKey("lifeos.privacy.session-grant.v1");

export interface PrivacyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Reads the standing switch. Anything unreadable means "off". */
export function readPrivacyVisible(storage: Pick<PrivacyStorage, "getItem"> = window.localStorage): boolean {
  try { return storage.getItem(PRIVACY_VISIBLE_KEY) === "1"; } catch { return false; }
}

export function writePrivacyVisible(visible: boolean, storage: Pick<PrivacyStorage, "setItem" | "removeItem"> = window.localStorage): void {
  try {
    if (visible) storage.setItem(PRIVACY_VISIBLE_KEY, "1");
    else storage.removeItem(PRIVACY_VISIBLE_KEY);
  } catch { /* storage is an optional convenience */ }
}

/**
 * The session-long yes. Lives in `sessionStorage` on purpose: closing the tab
 * ends the permission, so a grant given on a shared machine does not outlive the
 * sitting.
 */
export function readPrivacySessionGrant(storage: Pick<PrivacyStorage, "getItem"> = window.sessionStorage): boolean {
  try { return storage.getItem(PRIVACY_SESSION_GRANT_KEY) === "1"; } catch { return false; }
}

export function writePrivacySessionGrant(granted: boolean, storage: Pick<PrivacyStorage, "setItem" | "removeItem"> = window.sessionStorage): void {
  try {
    if (granted) storage.setItem(PRIVACY_SESSION_GRANT_KEY, "1");
    else storage.removeItem(PRIVACY_SESSION_GRANT_KEY);
  } catch { /* storage is an optional convenience */ }
}

/** The single question the UI asks: do private records show right now? */
export function privacyRevealed(visible: boolean, sessionGrant: boolean, oneShot = false): boolean {
  return visible || sessionGrant || oneShot;
}
