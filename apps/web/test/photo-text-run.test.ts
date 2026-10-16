import { test } from "node:test";
import assert from "node:assert/strict";
import { PHOTO_TEXT_MAX_SLICES, PHOTO_TEXT_SLICE_SIZE, runPhotoTextSlices } from "../src/photo-text-run.ts";

test("一片就读完时只发一次请求，并把张数报出来", async () => {
  const calls: number[] = [];
  const outcome = await runPhotoTextSlices(async (limit) => {
    calls.push(limit);
    return { described: 4, noDescription: 1, remaining: 0 };
  });
  assert.deepEqual(calls, [PHOTO_TEXT_SLICE_SIZE]);
  assert.deepEqual(outcome, { read: 5, stalled: false, slices: 1 });
});

test("还有剩下的就继续切，直到 remaining 归零", async () => {
  let left = 25;
  const outcome = await runPhotoTextSlices(async () => {
    const n = Math.min(PHOTO_TEXT_SLICE_SIZE, left);
    left -= n;
    return { described: n, noDescription: 0, remaining: left };
  });
  assert.equal(outcome.read, 25);
  assert.equal(outcome.stalled, false);
  assert.equal(outcome.slices, 3);
  assert.equal(left, 0);
});

test("读到没有文字的照片也算前进：它是答案，不是空转", async () => {
  let step = 0;
  const outcome = await runPhotoTextSlices(async () => {
    step += 1;
    // 第一片一张字都没读到，但确认了三张图没有文字 —— 必须继续，不能当成停手。
    if (step === 1) return { described: 0, noDescription: 3, remaining: 2 };
    return { described: 2, noDescription: 0, remaining: 0 };
  });
  assert.deepEqual(outcome, { read: 5, stalled: false, slices: 2 });
});

test("剩下还有、这一片却一张都没settle：立刻停手，不再空跑", async () => {
  let calls = 0;
  const outcome = await runPhotoTextSlices(async () => {
    calls += 1;
    return { described: 0, noDescription: 0, remaining: 7 };
  });
  assert.equal(calls, 1);
  assert.deepEqual(outcome, { read: 0, stalled: true, slices: 1 });
});

test("一直没有报错却也不清空：停在上限，不会无限循环", async () => {
  let calls = 0;
  const outcome = await runPhotoTextSlices(async () => {
    calls += 1;
    return { described: 1, noDescription: 0, remaining: 1 };
  });
  assert.equal(calls, PHOTO_TEXT_MAX_SLICES);
  assert.equal(outcome.slices, PHOTO_TEXT_MAX_SLICES);
  assert.equal(outcome.stalled, true);
  assert.equal(outcome.read, PHOTO_TEXT_MAX_SLICES);
});

test("进度是逐片累加的，不是最后一片的数", async () => {
  let left = 6;
  const seen: number[] = [];
  const outcome = await runPhotoTextSlices(async () => {
    const n = Math.min(2, left);
    left -= n;
    return { described: n, noDescription: 0, remaining: left };
  }, (read) => seen.push(read));
  assert.deepEqual(seen, [2, 4, 6]);
  assert.equal(outcome.slices, 3);
});

test("本来就没事可做：不算停手，也不该被当成失败", async () => {
  const outcome = await runPhotoTextSlices(async () => ({ described: 0, noDescription: 0, remaining: 0 }));
  assert.deepEqual(outcome, { read: 0, stalled: false, slices: 1 });
});

test("请求本身抛错就往上抛，不吞掉 —— 面板要能说清是失败而不是没有照片", async () => {
  await assert.rejects(() => runPhotoTextSlices(async () => {
    throw new Error("boom");
  }), /boom/);
});
