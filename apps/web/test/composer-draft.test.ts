import test from "node:test";
import assert from "node:assert/strict";
import { clearComposerDraft, composerDraftScope, readComposerDraft, writeComposerDraft } from "../src/composer-draft.ts";

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const draft = { content: "还没发出的正文", kind: "journal" as const, isPrivate: true,
  shots: [{ assetId: "asset-1", role: "photo" as const }] };

test("logged-out or unresolved sessions cannot hydrate another account's draft", () => {
  const member = { required: true, authenticated: true, accountMode: true,
    account: { id: "member-2", username: "member", displayName: "member", spaceName: "member", tenantId: "tenant-2", role: "member" as const } };
  assert.equal(composerDraftScope(false, member), null);
  assert.equal(composerDraftScope(true, { required: true, authenticated: false, accountMode: true }), null);
  assert.equal(composerDraftScope(true, { required: true, authenticated: true, accountMode: true }), null);
  assert.equal(composerDraftScope(true, member), "account:member-2");
  assert.equal(composerDraftScope(true, { required: true, authenticated: true }), "legacy");
});

test("composer drafts survive reload and stay account scoped", () => {
  const store = storage();
  assert.equal(writeComposerDraft("account:owner-1", draft, store), true);
  assert.deepEqual(readComposerDraft("account:owner-1", store), draft);
  assert.equal(readComposerDraft("account:member-2", store), null);
  assert.equal(readComposerDraft("legacy", store), null);
  writeComposerDraft("account:member-2", { ...draft, content: "另一人的草稿" }, store);
  clearComposerDraft("account:owner-1", store);
  assert.equal(readComposerDraft("account:owner-1", store), null);
  assert.equal(readComposerDraft("account:member-2", store)?.content, "另一人的草稿");
});

test("empty or malformed drafts do not leak stale text or photos", () => {
  const store = storage();
  writeComposerDraft("legacy", draft, store);
  writeComposerDraft("legacy", { ...draft, content: "", shots: [] }, store);
  assert.equal(readComposerDraft("legacy", store), null);
  store.setItem("lifeos.composerDraft.v1.account:owner-1", JSON.stringify({ version: 1, scope: "account:member-2", ...draft }));
  assert.equal(readComposerDraft("account:owner-1", store), null);
  assert.equal(writeComposerDraft("account:owner-1", { ...draft, content: "a".repeat(200_001) }, store), false);
});

test("storage denial is observable and preserves the in-memory draft", () => {
  const denied = { setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); } };
  assert.equal(writeComposerDraft("legacy", draft, denied), false);
  assert.doesNotThrow(() => clearComposerDraft("legacy", denied));
});
