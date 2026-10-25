import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrivacyAccess, privateAccessUntil, privacyAccessKey, PRIVACY_DAY_MS } from '../src/privacy-access.ts';

test('temporary privacy access expires at its original deadline and never extends on read', () => {
  const now = Date.parse('2026-10-20T01:00:00Z'), expires = now + PRIVACY_DAY_MS;
  assert.equal(parsePrivacyAccess(String(expires), now), expires);
  assert.equal(parsePrivacyAccess(String(expires), now + 60000), expires);
  assert.equal(parsePrivacyAccess(String(expires), expires), null);
  assert.equal(privateAccessUntil(expires, expires), undefined);
  assert.equal(privateAccessUntil(expires, now), '2026-10-21T01:00:00.000Z');
  assert.equal(parsePrivacyAccess('always', expires), 'always');
  assert.equal(privateAccessUntil('always'), 'always');
  for (const value of [null, '', '1', 'true', 'NaN', '{}', '-1']) assert.equal(parsePrivacyAccess(value, now), null);
});
test('display and AI grants are separate and scoped to the active account', () => {
  assert.notEqual(privacyAccessKey('display', 'a'), privacyAccessKey('ai', 'a'));
  assert.notEqual(privacyAccessKey('display', 'a'), privacyAccessKey('display', 'b'));
});
