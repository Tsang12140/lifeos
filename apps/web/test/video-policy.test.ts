import test from 'node:test';
import assert from 'node:assert/strict';
import { CappedOutput, VIDEO_POLICY as policy, planVideo, validateInputSize } from '../src/video/policy.ts';
const meta = { width: 3840, height: 2160, duration: 10, frameRate: 60, hdr: false };
test('4K and portrait obey both edges without stretching', () => {
  assert.deepEqual(planVideo(meta, policy), { width: 1920, height: 1080, frameRate: 30 });
  assert.deepEqual(planVideo({ ...meta, width: 2160, height: 3840 }, policy), { width: 1080, height: 1920, frameRate: 30 });
});
test('small 24 fps clips are not upscaled or raised to 30 fps', () => assert.deepEqual(planVideo({ ...meta, width: 640, height: 360, frameRate: 24 }, policy), { width: 640, height: 360, frameRate: 24 }));
test('invalid metadata and too-long clips fail', () => {
  for (const patch of [{ duration: 181 }, { duration: Infinity }, { frameRate: NaN }, { width: 0 }]) assert.throws(() => planVideo({ ...meta, ...patch }, policy));
});
test('HDR stops explicitly until tone mapping is tested', () => assert.throws(() => planVideo({ ...meta, hdr: true }, policy), { code: 'hdr_needs_validation' }));
test('input bytes limit is independent of compressed size', () => { validateInputSize(policy.maxInputBytes, policy); for (const n of [0, -1, Infinity, policy.maxInputBytes + 1]) assert.throws(() => validateInputSize(n, policy)); });
test('random access writes preserve patches and cross-block data', () => {
  const out = new CappedOutput(140000); out.write(65535, Uint8Array.of(1, 2, 3)); out.write(65536, Uint8Array.of(9)); out.write(0, Uint8Array.of(7));
  const bytes = new Uint8Array(out.finish()); assert.equal(bytes.length, 65538); assert.equal(bytes[0], 7); assert.deepEqual([...bytes.subarray(65535)], [1, 9, 3]);
});
test('output exceeding its cap is rejected before allocating', () => { const out = new CappedOutput(3); out.write(0, Uint8Array.of(1, 2, 3)); assert.throws(() => out.write(3, Uint8Array.of(4)), { code: 'output_too_large' }); assert.deepEqual([...new Uint8Array(out.finish())], [1, 2, 3]); });
test('invalid output offsets fail', () => { for (const offset of [-1, 0.5, NaN, Infinity]) assert.throws(() => new CappedOutput(10).write(offset, Uint8Array.of(1))); });
