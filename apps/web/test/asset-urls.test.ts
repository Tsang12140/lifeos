import test from 'node:test';
import assert from 'node:assert/strict';
import { assetThumbDensitySet, assetThumbUrl, syncThumbVersions, viewerThumbUrl } from '../src/asset-urls.ts';

test('a thumbnail URL carries the cache tag so it may be kept forever', () => {
  syncThumbVersions({ one: 'abcdef0123456789' });
  assert.equal(assetThumbUrl('one', 240), '/api/assets/one/thumbnail?w=240&upright=1&v=abcdef0123456789');
  assert.equal(assetThumbUrl('one', 240, 90), '/api/assets/one/thumbnail?w=240&r=90&v=abcdef0123456789');
  assert.equal(viewerThumbUrl('one', 2048), '/api/assets/one/thumbnail?w=2048&upright=1&v=abcdef0123456789');
  // An asset with no tag (uploaded a moment ago) keeps the short-lived URL instead
  // of inventing one: a wrong tag is a 409, not a cache miss.
  assert.equal(assetThumbUrl('two', 240), '/api/assets/two/thumbnail?w=240&upright=1');
  syncThumbVersions({});
});

test('the gallery grid offers one URL per density instead of always downloading 400px', () => {
  syncThumbVersions({ one: 'abcdef0123456789' });
  assert.equal(
    assetThumbDensitySet('one', [160, 240, 400]),
    '/api/assets/one/thumbnail?w=160&upright=1&v=abcdef0123456789 1x, '
      + '/api/assets/one/thumbnail?w=240&upright=1&v=abcdef0123456789 2x, '
      + '/api/assets/one/thumbnail?w=400&upright=1&v=abcdef0123456789 3x',
  );
  syncThumbVersions({});
});
