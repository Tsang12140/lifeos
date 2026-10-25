import test from 'node:test';
import assert from 'node:assert/strict';
import { appUnlockToken, setAppUnlockToken, requestAppUnlock, configureAppUnlock } from '../src/app-lock-session.ts';
import { assetContentUrl, assetThumbUrl, viewerThumbUrl } from '../src/asset-urls.ts';
test('media URLs never carry the in-memory unlock proof, so a cached thumbnail survives reloads', () => {
  setAppUnlockToken(undefined);
  assert.equal(assetContentUrl('one'), '/api/assets/one/content');
  assert.equal(assetThumbUrl('one', 400), '/api/assets/one/thumbnail?w=400&upright=1');
  setAppUnlockToken('page-proof');
  assert.equal(appUnlockToken(), 'page-proof');
  // The proof rides in the HttpOnly `lifeos_unlock` cookie instead; a query grant would
  // change every URL per page load and defeat the browser cache.
  assert.equal(assetContentUrl('one', true), '/api/assets/one/content?download=1');
  assert.equal(viewerThumbUrl('one', 1200), '/api/assets/one/thumbnail?w=1200&upright=1');
  assert.equal(assetThumbUrl('one', 1200, 90), '/api/assets/one/thumbnail?w=1200&r=90');
  setAppUnlockToken(undefined); assert.equal(assetContentUrl('one'), '/api/assets/one/content');
});
test('AI unlock requests combine missing targets and honor cancellation', async () => {
  configureAppUnlock(undefined); assert.equal(await requestAppUnlock(['notes']), false);
  let received: readonly string[] = [];
  configureAppUnlock(async targets => { received = targets; return true; });
  assert.equal(await requestAppUnlock(['notes', 'privacy-ai']), true); assert.deepEqual(received, ['notes', 'privacy-ai']);
  configureAppUnlock(async () => false); assert.equal(await requestAppUnlock(['notes']), false); configureAppUnlock(undefined);
});
