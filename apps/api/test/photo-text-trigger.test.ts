import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PhotoTextTrigger,
  PHOTO_TEXT_DEBOUNCE_MS,
  type PhotoTextPassReport,
} from "../src/photo-text-trigger.js";
import { saveRuntimePhotoTextConfig } from "../src/photo-text-config.js";
import type { PhotoDescriptionRun } from "../src/photo-description.js";
import type { ApiConfig } from "../src/config.js";
import type { SqliteRecordRepository } from "../src/repository.js";
import type { ThumbnailCache } from "../src/route-context.js";

/**
 * The "发完日记就跑" trigger, exercised with no timer, no network and no database.
 *
 * The two things worth protecting here are opposites, and both are invisible in the happy
 * path: the save must come back **before** any of this happens (so `notify` must be a
 * synchronous nudge that starts nothing), and a burst of saves must not become a burst of
 * passes (so a run in flight must absorb the next ask instead of starting beside it).
 *
 * The clock is injected rather than slept through, because "waits five seconds" is only a
 * claim about a machine if the test can tell five seconds from zero.
 */

const WITH_OCR = {
  tencentOcr: { secretId: "id", secretKey: "key", region: "ap-guangzhou", actions: ["GeneralAccurateOCR"] },
} as unknown as ApiConfig;

const WITHOUT_OCR = {} as unknown as ApiConfig;

const repository = {} as unknown as SqliteRecordRepository;
const thumbnails = {} as unknown as ThumbnailCache;

function outcome(over: Partial<PhotoDescriptionRun> = {}): PhotoDescriptionRun {
  return {
    photos: 0,
    described: 0,
    alreadyDescribed: 0,
    noDescription: 0,
    unread: 0,
    unreadable: 0,
    skippedPrivate: 0,
    recordsUpdated: 0,
    remaining: 0,
    variant: "ocr",
    written: true,
    samples: [],
    ...over,
  };
}

/** A clock the test drives. Timers fire in time order, including ones registered while firing. */
function fakeClock() {
  let nextId = 0;
  let now = 0;
  const tasks = new Map<number, { readonly at: number; readonly fn: () => void }>();
  return {
    setTimeout: (fn: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout> => {
      const handle = ++nextId;
      tasks.set(handle, { at: now + delayMs, fn });
      return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>): void => {
      tasks.delete(handle as unknown as number);
    },
    pending: (): number => tasks.size,
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** Let every pending microtask run, so an awaited pass can finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

function build(options: {
  readonly run: () => Promise<PhotoDescriptionRun>;
  readonly clock?: ReturnType<typeof fakeClock>;
  readonly config?: ApiConfig;
  readonly debounceMs?: number;
  readonly sliceGapMs?: number;
  readonly slice?: number;
  readonly onError?: (error: unknown) => void;
  readonly onReport?: (report: PhotoTextPassReport) => void;
}) {
  const clock = options.clock ?? fakeClock();
  const trigger = new PhotoTextTrigger({
    repository,
    config: options.config ?? WITH_OCR,
    thumbnails,
    debounceMs: options.debounceMs ?? 5_000,
    // Zero by default so a multi-slice test does not have to drive the gap as well as the
    // debounce; the gap has its own case below.
    sliceGapMs: options.sliceGapMs ?? 0,
    ...(options.slice === undefined ? {} : { slice: options.slice }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    run: options.run,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
  });
  return { trigger, clock };
}

test("a save only nudges: nothing runs until the typing has stopped", async () => {
  const calls: number[] = [];
  const { trigger, clock } = build({ run: async () => { calls.push(1); return outcome(); } });
  trigger.notify();
  await settle();
  assert.equal(calls.length, 0, "the save must not wait for a pass");
  assert.equal(clock.pending(), 1, "…but a pass must be scheduled behind it");
  clock.advance(4_999);
  await settle();
  assert.equal(calls.length, 0, "not before the debounce elapses");
  clock.advance(1);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(clock.pending(), 0, "and nothing keeps ticking afterwards");
  trigger.stop();
});

test("a burst of saves collapses into one pass", async () => {
  const calls: number[] = [];
  const { trigger, clock } = build({ run: async () => { calls.push(1); return outcome(); } });
  trigger.notify();
  clock.advance(2_000);
  trigger.notify();
  clock.advance(2_000);
  trigger.notify();
  clock.advance(2_000);
  await settle();
  assert.equal(calls.length, 0, "still inside the quiet window");
  clock.advance(PHOTO_TEXT_DEBOUNCE_MS);
  await settle();
  assert.equal(calls.length, 1, "three saves, one pass");
  trigger.stop();
});

test("a pass already running absorbs the next ask instead of running beside it", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const { trigger, clock } = build({
    run: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return outcome();
    },
  });
  trigger.notify();
  clock.advance(PHOTO_TEXT_DEBOUNCE_MS);
  await settle();
  assert.equal(calls, 1);

  // Two more saves while the first pass is still reading. Neither may start a second pass.
  trigger.notify();
  clock.advance(PHOTO_TEXT_DEBOUNCE_MS);
  await settle();
  assert.equal(calls, 1, "one pass at a time, always");

  release?.();
  await settle();
  assert.equal(calls, 1, "the stored ask waits for the pass to end");
  clock.advance(PHOTO_TEXT_DEBOUNCE_MS);
  await settle();
  assert.equal(calls, 2, "and then runs once — not twice, for two asks");
  trigger.stop();
});

test("slices continue while photos are being answered, and stop when the library is clean", async () => {
  const script: Array<Partial<PhotoDescriptionRun>> = [
    { described: 20, remaining: 5 },
    { described: 5, remaining: 0 },
  ];
  let call = 0;
  const { trigger } = build({ run: async () => outcome(script[Math.min(call++, script.length - 1)]!) , slice: 20 });
  const report = await trigger.runOnce();
  assert.equal(report?.slices, 2);
  assert.equal(report?.read, 25);
  assert.equal(report?.remaining, 0);
  trigger.stop();
});

test("a refused photo stops the pass instead of hammering a closed door", async () => {
  let calls = 0;
  const { trigger } = build({
    run: async () => {
      calls += 1;
      // Work is waiting, but nothing moved: a spent package, a rejected key, no credentials.
      return outcome({ remaining: 9, unread: 9 });
    },
  });
  const report = await trigger.runOnce();
  assert.equal(calls, 1, "the second slice would fail the same way");
  assert.equal(report?.read, 0);
  assert.equal(report?.unread, 9);
  assert.equal(report?.remaining, 9, "what is still waiting is reported, not hidden");
  trigger.stop();
});

test("a single pass reads a bounded number of slices", async () => {
  let calls = 0;
  const { trigger } = build({
    run: async () => {
      calls += 1;
      return outcome({ described: 1, remaining: 99 });
    },
  });
  const report = await trigger.runOnce();
  assert.equal(calls, 5, "a first run over a huge library must not become an hour of traffic");
  assert.equal(report?.slices, 5);
  assert.equal(report?.remaining, 99, "the rest is left for the next pass");
  trigger.stop();
});

test("slices are separated by a gap, so the event loop serves her browser in between", async () => {
  let calls = 0;
  const { trigger, clock } = build({
    sliceGapMs: 1_500,
    run: async () => {
      calls += 1;
      return calls === 1 ? outcome({ described: 20, remaining: 3 }) : outcome({ described: 3, remaining: 0 });
    },
  });
  const running = trigger.runOnce();
  await settle();
  assert.equal(calls, 1, "the second slice waits");
  assert.equal(clock.pending(), 1, "…on a timer, not on a busy loop");
  clock.advance(1_499);
  await settle();
  assert.equal(calls, 1);
  clock.advance(1);
  await settle();
  assert.equal(calls, 2);
  assert.equal((await running)?.slices, 2);
  trigger.stop();
});

test("a failing pass is swallowed: it reports, and it never rejects a save", async () => {
  const errors: unknown[] = [];
  const { trigger } = build({
    run: async () => { throw new Error("network down"); },
    onError: (error) => errors.push(error),
  });
  const report = await trigger.runOnce();
  assert.equal(report, null);
  assert.equal(errors.length, 1);
  trigger.stop();
});

test("stop() cancels a scheduled pass and refuses later nudges", async () => {
  const calls: number[] = [];
  const { trigger, clock } = build({ run: async () => { calls.push(1); return outcome(); } });
  trigger.notify();
  assert.equal(clock.pending(), 1);
  trigger.stop();
  assert.equal(clock.pending(), 0, "the scheduled pass is cancelled, not left to fire into a closing server");
  trigger.notify();
  clock.advance(60_000);
  await settle();
  assert.equal(calls.length, 0);
});

test("a machine with no OCR key never schedules anything", async () => {
  const calls: number[] = [];
  const { trigger, clock } = build({
    config: WITHOUT_OCR,
    run: async () => { calls.push(1); return outcome({ unread: 3 }); },
  });
  trigger.notify();
  assert.equal(clock.pending(), 0, "no recogniser, no work, no timer");
  clock.advance(60_000);
  await settle();
  assert.equal(calls.length, 0);
  // The operator hook still works — that is how the button and the scripts read the library.
  assert.equal((await trigger.runOnce())?.unread, 3);
  trigger.stop();
});

test("switching OCR off stops the trigger arming at all, even with a key present", async () => {
  const root = mkdtempSync(join(tmpdir(), "lifeos-photo-text-off-"));
  try {
    const config = { ...WITH_OCR, dataDirectory: root } as unknown as ApiConfig;
    saveRuntimePhotoTextConfig(config, { ocr: false });

    const calls: number[] = [];
    const { trigger, clock } = build({
      config,
      run: async () => { calls.push(1); return outcome({ described: 1 }); },
    });
    trigger.notify();
    assert.equal(clock.pending(), 0, "a switched-off feature must not even wake up to find nothing to do");
    clock.advance(120_000);
    await settle();
    assert.equal(calls.length, 0);
    trigger.stop();

    // …and switching it back on is picked up on the very next save, with no restart.
    saveRuntimePhotoTextConfig(config, { ocr: true });
    const back = build({ config, run: async () => { calls.push(1); return outcome({ described: 1 }); } });
    back.trigger.notify();
    assert.equal(back.clock.pending(), 1);
    back.clock.advance(PHOTO_TEXT_DEBOUNCE_MS);
    await settle();
    assert.equal(calls.length, 1);
    back.trigger.stop();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the engines that answered are reported once each, across slices", async () => {
  const script: Array<Partial<PhotoDescriptionRun>> = [
    { described: 2, remaining: 1, engines: ["GeneralAccurateOCR"] },
    { described: 1, remaining: 0, engines: ["GeneralBasicOCR", "GeneralAccurateOCR"] },
  ];
  let call = 0;
  const { trigger } = build({ run: async () => outcome(script[Math.min(call++, script.length - 1)]!) });
  const report = await trigger.runOnce();
  assert.deepEqual(report?.engines, ["GeneralAccurateOCR", "GeneralBasicOCR"]);
  trigger.stop();
});
