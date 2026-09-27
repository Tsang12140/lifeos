import type { AssetLink } from "@lifeos/core";
import type { ComposerKind } from "./app-types";
import type { AuthState } from "./api";

const PREFIX = "lifeos.composerDraft.v1.";
const MAX_CONTENT = 200_000;
const MAX_SHOTS = 64;
const KINDS: readonly ComposerKind[] = ["journal", "task", "event", "note"];
const ROLES = ["photo", "recording", "attachment"];

export interface ComposerDraft {
  readonly content: string;
  readonly kind: ComposerKind;
  readonly isPrivate: boolean;
  readonly shots: readonly AssetLink[];
}

export function composerDraftScope(authResolved: boolean, auth: AuthState): string | null {
  if (!authResolved || (auth.required && !auth.authenticated)) return null;
  if (!auth.accountMode) return "legacy";
  return auth.account?.id ? `account:${auth.account.id}` : null;
}

function key(scope: string): string {
  if (scope !== "legacy" && !/^account:[a-z0-9-]+$/i.test(scope)) throw new Error("草稿账号范围无效");
  return PREFIX + scope;
}

function shotsOf(value: unknown): readonly AssetLink[] {
  if (!Array.isArray(value) || value.length > MAX_SHOTS) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const shot = item as { assetId?: unknown; role?: unknown; label?: unknown };
    if (typeof shot.assetId !== "string" || !shot.assetId || !ROLES.includes(String(shot.role))
      || (shot.label !== undefined && typeof shot.label !== "string")) return [];
    return [{
      assetId: shot.assetId,
      role: shot.role as AssetLink["role"],
      ...(typeof shot.label === "string" ? { label: shot.label } : {}),
    }];
  });
}

export function readComposerDraft(scope: string, storage: Pick<Storage, "getItem"> = window.localStorage): ComposerDraft | null {
  try {
    const raw = storage.getItem(key(scope));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const draft = value as { version?: unknown; scope?: unknown; content?: unknown; kind?: unknown; isPrivate?: unknown; shots?: unknown };
    if (draft.version !== 1 || draft.scope !== scope || typeof draft.content !== "string"
      || draft.content.length > MAX_CONTENT || !KINDS.includes(draft.kind as ComposerKind)
      || typeof draft.isPrivate !== "boolean") return null;
    return { content: draft.content, kind: draft.kind as ComposerKind, isPrivate: draft.isPrivate, shots: shotsOf(draft.shots) };
  } catch { return null; }
}

export function writeComposerDraft(scope: string, draft: ComposerDraft, storage: Pick<Storage, "setItem" | "removeItem"> = window.localStorage): boolean {
  try {
    const storageKey = key(scope);
    if (!draft.content && draft.shots.length === 0) { storage.removeItem(storageKey); return true; }
    if (draft.content.length > MAX_CONTENT || draft.shots.length > MAX_SHOTS) return false;
    storage.setItem(storageKey, JSON.stringify({ version: 1, scope, ...draft, savedAt: new Date().toISOString() }));
    return true;
  } catch { return false; }
}

export function clearComposerDraft(scope: string, storage: Pick<Storage, "removeItem"> = window.localStorage): void {
  try { storage.removeItem(key(scope)); } catch { /* Browser storage is optional. */ }
}
