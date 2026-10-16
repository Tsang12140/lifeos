import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOcrFailure,
  createPhotoTextChain,
  nextAllowanceReset,
  parseOcrActions,
} from "../src/photo-text-chain.js";

/**
 * The downgrade chain (§11), exercised entirely offline. `fetchImpl` is injected, so the
 * whole decision path — which tier answers, whether a photo is re-run on the next one,
 * when the pass stops calling at all — is tested without a key and without a network.
 *
 * Two distinctions these tests exist to protect, both easy to get wrong:
 *
 *   · a *refusal* (the package is spent) moves the chain, whereas a *blip* (rate limit,
 *     timeout) skips one photo and leaves the chain alone — demoting the library on a
 *     blip would be permanent in practice, because photos already read are skipped next;
 *   · `blank` (the picture was read, it has no words) and `unread` (it was never read)
 *     are different answers. The first may be filed as an empty marker; the second must
 *     not be filed at all, or one bad minute would mark the whole library wordless.
 */

const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const CREDENTIALS = { secretId: "id", secretKey: "key", region: "ap-guangzhou" } as const;
const TIERS = ["GeneralAccurateOCR", "GeneralBasicOCR"] as const;

interface Reply {
  readonly text?: string;
  readonly code?: string;
  readonly http?: number;
}

/**
 * A `fetch` stand-in that answers per action. Each action gets its own queue of replies,
 * consumed in order; once a queue runs dry its last entry repeats. Returning `text` means
 * a successful read, `code` an error, and neither an empty (wordless) success.
 */
function fakeFetch(script: Readonly<Record<string, readonly Reply[]>>) {
  const seen: string[] = [];
  const impl = async (_url: string, init: { readonly headers: Record<string, string> }) => {
    const action = init.headers["x-tc-action"] as string;
    seen.push(action);
    const queue = script[action] ?? [{ code: "FailedOperation.OcrFailed" }];
    const used = seen.filter((entry) => entry === action).length - 1;
    const reply = queue[Math.min(used, queue.length - 1)] as Reply;
    const status = reply.http ?? 200;
    const body = reply.code === undefined
      ? { Response: { TextDetections: reply.text === undefined ? [] : [{ DetectedText: reply.text }], RequestId: "test" } }
      : { Response: { Error: { Code: reply.code, Message: "test" }, RequestId: "test" } };
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  };
  return { impl: impl as unknown as typeof fetch, seen };
}

function chainWith(script: Readonly<Record<string, readonly Reply[]>>, overrides: { now?: () => number; cooldownMs?: number } = {}) {
  const fake = fakeFetch(script);
  const chain = createPhotoTextChain({
    credentials: CREDENTIALS,
    actions: TIERS,
    fetchImpl: fake.impl,
    ...overrides,
  });
  return { chain, seen: fake.seen };
}

test("parseOcrActions 读优先级清单，坏名字宁可丢掉也不停手", () => {
  assert.deepEqual(parseOcrActions("GeneralAccurateOCR,GeneralBasicOCR"), ["GeneralAccurateOCR", "GeneralBasicOCR"]);
  assert.deepEqual(parseOcrActions(" GeneralBasicOCR , GeneralAccurateOCR "), ["GeneralBasicOCR", "GeneralAccurateOCR"]);
  assert.deepEqual(parseOcrActions("NopeOCR,GeneralBasicOCR"), ["GeneralBasicOCR"], "未知名丢弃");
  assert.deepEqual(parseOcrActions("GeneralBasicOCR,GeneralBasicOCR"), ["GeneralBasicOCR"], "重复项合并");
  assert.deepEqual(parseOcrActions(undefined), ["GeneralBasicOCR"], "未配置回落到免费安全档");
  assert.deepEqual(parseOcrActions(""), ["GeneralBasicOCR"]);
  assert.deepEqual(parseOcrActions("全都是错的"), ["GeneralBasicOCR"]);
});

test("classifyOcrFailure 把拒绝分成三类", () => {
  for (const code of [
    "ResourceUnavailable.ResourcePackageRunOut",
    "ResourceUnavailable.InArrears",
    "FailedOperation.UnOpenError",
  ]) {
    assert.equal(classifyOcrFailure(code), "downgrade", `${code} 应换档`);
  }
  for (const code of [
    "AuthFailure.SignatureFailure",
    "AuthFailure.SecretIdNotFound",
    "InvalidParameterValue.InvalidParameterValueLimit",
    "InvalidAction",
  ]) {
    assert.equal(classifyOcrFailure(code), "abort", `${code} 应停手（换档也没用）`);
  }
  for (const code of [
    "RequestLimitExceeded",
    "FailedOperation.OcrFailed",
    "FailedOperation.EngineRecognizeTimeout",
    "Local.NetworkError",
    "Local.ImageUnusable",
    "Http.502",
  ]) {
    assert.equal(classifyOcrFailure(code), "skip", `${code} 只该跳过这一张`);
  }
});

test("首选档读到字就不动档位", async () => {
  const { chain, seen } = chainWith({ GeneralAccurateOCR: [{ text: "精品茶具" }] });
  const result = await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  assert.deepEqual(result, { kind: "text", text: "精品茶具", engine: "GeneralAccurateOCR" });
  assert.deepEqual(seen, ["GeneralAccurateOCR"]);
  assert.equal(chain.currentAction(), "GeneralAccurateOCR");
  assert.deepEqual(chain.events, []);
});

test("「图里没有字」是答案不是故障：回 blank、不降档", async () => {
  const { chain, seen } = chainWith({ GeneralAccurateOCR: [{ code: "FailedOperation.ImageNoText" }] });
  const result = await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  assert.deepEqual(result, { kind: "blank", engine: "GeneralAccurateOCR" }, "确认没字要能与「没问成」区分");
  assert.deepEqual(seen, ["GeneralAccurateOCR"], "这张图对哪一档都是没字，不该再去问下一档");
  assert.equal(chain.currentAction(), "GeneralAccurateOCR");
});

test("额度耗尽换下一档，并用新档重试同一张", async () => {
  const { chain, seen } = chainWith({
    GeneralAccurateOCR: [{ code: "ResourceUnavailable.ResourcePackageRunOut" }],
    GeneralBasicOCR: [{ text: "菜单正文" }],
  });
  const result = await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  assert.deepEqual(result, { kind: "text", text: "菜单正文", engine: "GeneralBasicOCR" }, "换档后当场重试，不把这页丢给下一轮");
  assert.deepEqual(seen, ["GeneralAccurateOCR", "GeneralBasicOCR"]);
  assert.equal(chain.currentAction(), "GeneralBasicOCR");
  assert.ok(
    chain.events.some((event) => event.includes("GeneralAccurateOCR") && event.includes("GeneralBasicOCR")),
    `换档要留下记录，实际: ${JSON.stringify(chain.events)}`,
  );
});

test("降过档以后，后续照片直接用低档，不再白试首选", async () => {
  const { chain, seen } = chainWith({
    GeneralAccurateOCR: [{ code: "ResourceUnavailable.ResourcePackageRunOut" }],
    GeneralBasicOCR: [{ text: "正文" }],
  });
  await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  seen.length = 0;
  const second = await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  assert.deepEqual(seen, ["GeneralBasicOCR"], "额度已尽，不该再对首选档发一次注定失败的请求");
  assert.deepEqual(second, { kind: "text", text: "正文", engine: "GeneralBasicOCR" });
});

test("限频/超时只跳过这一张：回 unread、档位原地不动", async () => {
  const { chain, seen } = chainWith({
    GeneralAccurateOCR: [{ code: "RequestLimitExceeded" }],
    GeneralBasicOCR: [{ text: "不该被问到" }],
  });
  assert.deepEqual(await chain.recognize({ image: IMAGE, mime: "image/jpeg" }), { kind: "unread" }, "抖动绝不能回 blank —— 那会写下一个不该写的标记");
  assert.deepEqual(seen, ["GeneralAccurateOCR"], "一次网络抖动不能把整个库降级");
  assert.equal(chain.currentAction(), "GeneralAccurateOCR");
});

test("密钥出错时整轮停手，冷却过后才再试", async () => {
  let now = Date.parse("2026-10-16T00:00:00+08:00");
  const { chain, seen } = chainWith(
    {
      GeneralAccurateOCR: [{ code: "AuthFailure.SignatureFailure" }],
      GeneralBasicOCR: [{ text: "不该被问到" }],
    },
    { now: () => now, cooldownMs: 60_000 },
  );

  assert.deepEqual(await chain.recognize({ image: IMAGE, mime: "image/jpeg" }), { kind: "unread" });
  assert.deepEqual(seen, ["GeneralAccurateOCR"], "密钥问题不是这一档的问题，不该往下试");
  assert.equal(chain.currentAction(), "GeneralAccurateOCR");

  seen.length = 0;
  assert.deepEqual(await chain.recognize({ image: IMAGE, mime: "image/jpeg" }), { kind: "unread" }, "冷却期内不再发请求");
  assert.deepEqual(seen, [], "冷却期必须真的省下请求");

  now += 60_001;
  await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  assert.deepEqual(seen, ["GeneralAccurateOCR"], "冷却过后回头试首选档（修好了就能自愈）");
});

test("最后一档也耗尽时停手：回 unread 而不是 blank，且不再逐张空跑", async () => {
  const { chain, seen } = chainWith({
    GeneralAccurateOCR: [{ code: "ResourceUnavailable.ResourcePackageRunOut" }],
    GeneralBasicOCR: [{ code: "ResourceUnavailable.ResourcePackageRunOut" }],
  });
  assert.deepEqual(await chain.recognize({ image: IMAGE, mime: "image/jpeg" }), { kind: "unread" }, "额度耗尽 ≠ 这张图没字");
  assert.deepEqual(seen, ["GeneralAccurateOCR", "GeneralBasicOCR"]);
  seen.length = 0;
  assert.deepEqual(await chain.recognize({ image: IMAGE, mime: "image/jpeg" }), { kind: "unread" });
  assert.deepEqual(seen, [], "两档都空了，额度恢复前不该再对剩余照片逐张空跑");
});

test("跨月回到首选档 —— 免费额度在那天重新发放", async () => {
  let now = Date.parse("2026-10-31T23:00:00+08:00");
  const { chain } = chainWith(
    {
      GeneralAccurateOCR: [
        { code: "ResourceUnavailable.ResourcePackageRunOut" },
        { text: "新月份的正文" },
      ],
      GeneralBasicOCR: [{ text: "十月的兜底" }],
    },
    { now: () => now },
  );

  await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  assert.equal(chain.currentAction(), "GeneralBasicOCR", "十月额度用尽，落到 Basic");

  now = Date.parse("2026-11-01T00:30:00+08:00");
  const result = await chain.recognize({ image: IMAGE, mime: "image/jpeg" });
  assert.deepEqual(result, { kind: "text", text: "新月份的正文", engine: "GeneralAccurateOCR" }, "11 月额度已重置，回到高精度");
  assert.equal(chain.currentAction(), "GeneralAccurateOCR");
  assert.ok(chain.events.some((event) => event.includes("重置")), "复位要留下记录");
});

test("额度复位点是北京时间下月 1 号零点", () => {
  assert.equal(
    new Date(nextAllowanceReset(Date.parse("2026-10-16T02:00:00+08:00"))).toISOString(),
    "2026-10-31T16:00:00.000Z",
  );
  assert.equal(
    new Date(nextAllowanceReset(Date.parse("2026-12-20T10:00:00+08:00"))).toISOString(),
    "2026-12-31T16:00:00.000Z",
    "跨年也要落在 1 月 1 号零点（北京时间）",
  );
});
