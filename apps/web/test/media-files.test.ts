import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageFile, isVideoFile, MEDIA_FILE_ACCEPT } from '../src/media-files.ts';

test('common video extensions work without MIME and with generic desktop MIME', () => {
  for (const extension of ['mp4', 'MOV', 'mkv', 'webm', 'm4v', '3gp', 'ts']) {
    for (const type of ['', 'application/octet-stream']) {
      const file = new File(['fixture'], `clip.${extension}`, { type });
      assert.equal(isVideoFile(file), true);
      assert.equal(isImageFile(file), false);
    }
    assert.ok(MEDIA_FILE_ACCEPT.includes(`.${extension.toLowerCase()}`));
  }
});

test('mixed batches keep their media types and unknown files are excluded', () => {
  const files = [new File(['a'], 'photo.JPG'), new File(['b'], 'clip.MOV'), new File(['c'], 'photo.png', { type: 'image/png' }), new File(['d'], 'clip.mkv'), new File(['e'], 'notes.txt', { type: 'text/plain' })];
  assert.deepEqual(files.filter(file => isImageFile(file) || isVideoFile(file)).map(file => isVideoFile(file) ? 'video' : 'photo'), ['photo', 'video', 'photo', 'video']);
  assert.equal(isVideoFile(new File(['x'], 'misnamed.mp4', { type: 'image/png' })), false);
  assert.equal(isImageFile(new File(['x'], 'misnamed.jpg', { type: 'video/mp4' })), false);
});
