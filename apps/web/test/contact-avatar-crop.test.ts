import test from "node:test";
import assert from "node:assert/strict";
import { avatarCrop } from "../src/contact-avatar-crop.ts";

test("avatar crop keeps square samples inside portrait, landscape and tiny images at every drag edge", () => {
  for (const [width, height] of [[1200, 600], [600, 1200], [800, 800], [8, 4]]) {
    for (const zoom of [1, 1.5, 3]) for (const x of [-100, 0, 100]) for (const y of [-100, 0, 100]) {
      const c = avatarCrop(width!, height!, zoom, x, y);
      assert.ok(c.sx >= -1e-8 && c.sy >= -1e-8);
      assert.ok(c.sx + c.size <= width! + 1e-8 && c.sy + c.size <= height! + 1e-8);
      assert.ok(c.width >= 1 && c.height >= 1);
    }
  }
  assert.deepEqual(avatarCrop(1200, 600, 1, 0, 0), { width: 2, height: 1, x: 0, y: 0, sx: 300, sy: 0, size: 600 });
  assert.equal(avatarCrop(1200, 600, 1, 100, 0).sx, 0);
  assert.equal(avatarCrop(1200, 600, 1, -100, 0).sx, 600);
});
