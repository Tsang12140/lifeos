import test from "node:test";
import assert from "node:assert/strict";
import {
  PRIVACY_SESSION_GRANT_KEY,
  PRIVACY_VISIBLE_KEY,
  privacyRevealed,
  readPrivacySessionGrant,
  readPrivacyVisible,
  writePrivacySessionGrant,
  writePrivacyVisible,
} from "../src/privacy-visibility.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test("private records stay hidden until the owner turns the switch on", () => {
  const storage = memoryStorage();
  assert.equal(readPrivacyVisible(storage), false);
  writePrivacyVisible(true, storage);
  assert.equal(readPrivacyVisible(storage), true);
  assert.equal(storage.getItem(PRIVACY_VISIBLE_KEY), "1");
  writePrivacyVisible(false, storage);
  assert.equal(readPrivacyVisible(storage), false);
  // 关掉是删键而不是写 "0"：默认值只能有一个来源。
  assert.equal(storage.getItem(PRIVACY_VISIBLE_KEY), null);
});

test("an unreadable store is never read as a yes", () => {
  assert.equal(readPrivacyVisible({ getItem: () => { throw new Error("blocked"); } }), false);
  assert.equal(readPrivacySessionGrant({ getItem: () => { throw new Error("blocked"); } }), false);
});

test("a session grant lasts the sitting and can be given back", () => {
  const storage = memoryStorage();
  assert.equal(readPrivacySessionGrant(storage), false);
  writePrivacySessionGrant(true, storage);
  assert.equal(storage.getItem(PRIVACY_SESSION_GRANT_KEY), "1");
  assert.equal(readPrivacySessionGrant(storage), true);
  writePrivacySessionGrant(false, storage);
  assert.equal(readPrivacySessionGrant(storage), false);
});

test("showing private records takes any one of the three yeses", () => {
  assert.equal(privacyRevealed(false, false), false);
  assert.equal(privacyRevealed(true, false), true);
  assert.equal(privacyRevealed(false, true), true);
  assert.equal(privacyRevealed(false, false, true), true);
  assert.equal(privacyRevealed(true, true, true), true);
});
