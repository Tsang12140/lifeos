import test from "node:test";
import assert from "node:assert/strict";
import { analyzePhotoPixels, coverFromAnalysis, peekCover, peekScore, photoSourceScore, scorePhoto, screenConfidence, PHONE_SCREEN_SIZES } from "../src/photoScore.ts";

function pixels(kind: "text" | "dark-text" | "food" | "mono" | "bottom" | "blank", width = 96, height = 192): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let rgb = [190, 190, 190];
    if (kind === "text" || kind === "dark-text") {
      const glyph = x > 5 && x < width - 6 && y > 12 && y < height - 12 && y % 10 < 4 && x % 6 < 3 && (x + y) % 7 !== 0;
      const value = kind === "text" ? (glyph ? 25 : 245) : (glyph ? 230 : 25);
      rgb = [value, value, value];
    } else if (kind === "food" || kind === "bottom") {
      const cy = kind === "bottom" ? height * 0.8 : height * 0.5;
      const inside = ((x - width * 0.5) / (width * 0.37)) ** 2 + ((y - cy) / (height * 0.14)) ** 2 < 1;
      if (inside) rgb = [210 + (x * 7 + y * 11) % 40, 65 + (x * 3 + y * 5) % 75, 20 + (x + y) % 35];
    } else if (kind === "mono") {
      const value = 80 + x / width * 70 + y / height * 65 + Math.sin(x / 8 + y / 13) * 25;
      rgb = [value, value, value];
    }
    const i = (y * width + x) * 4;
    data.set([...rgb, 255], i);
  }
  return data;
}
const analysis = (kind: Parameters<typeof pixels>[0]) => analyzePhotoPixels(pixels(kind), 96, 192);

test("light/dark text screenshots lose to food, even with camera EXIF on the screenshot", () => {
  const food = coverFromAnalysis(analysis("food"));
  for (const kind of ["text", "dark-text"] as const) {
    const text = coverFromAnalysis(analysis(kind), { originalName: "Screenshot.png", photoMetadata: { version: 1, width: 1179, height: 2556, cameraEvidence: "capture" } });
    assert.ok(text.textPenalty > 25, `${kind}: ${JSON.stringify(text)}`);
    assert.ok(food.score > text.score + 15, `${kind}: food=${food.score}, text=${text.score}`);
  }
});

test("a beautiful screenshot can beat a blank camera photo; monochrome does not mean text", () => {
  const beautiful = coverFromAnalysis(analysis("food"), { originalName: "Screenshot.png", photoMetadata: { version: 1, width: 1179, height: 2556, cameraEvidence: "none" } });
  const blank = coverFromAnalysis(analysis("blank"), { photoMetadata: { version: 1, width: 4032, height: 3024, cameraEvidence: "capture" } });
  assert.ok(beautiful.score > blank.score + 10);
  assert.equal(analysis("mono").textLikelihood, 0);
  assert.equal(analysis("blank").textLikelihood, 0);
});

test("smart crop retains the lower subject and adapts to the cell aspect", () => {
  const frame = analysis("bottom");
  const square = coverFromAnalysis(frame, {}, 1);
  const tall = coverFromAnalysis(frame, {}, 0.5);
  assert.ok(Number(square.position.split(" ")[1].replace("%", "")) >= 60, square.position);
  assert.ok(square.crop.y + square.crop.height >= 0.93, JSON.stringify(square));
  assert.ok(square.cropScore > 28, "retain almost all subject attention");
  assert.equal(tall.crop.height, 1);
  for (const aspect of [0.3, 0.7, 1, 2, 4, NaN]) {
    const { crop, score } = coverFromAnalysis(frame, {}, aspect);
    assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 1.00001 && crop.y + crop.height <= 1.00001);
    assert.ok(Number.isFinite(score));
  }
  assert.equal(coverFromAnalysis(analysis("blank")).position, "50% 20%");
});

test("phone dimensions normalize rotation, exact hits outweigh ratio and unknowns stay neutral", () => {
  assert.equal(new Set(PHONE_SCREEN_SIZES.map(([w, h]) => `${w}:${h}`)).size, PHONE_SCREEN_SIZES.length);
  for (const [w, h] of PHONE_SCREEN_SIZES) assert.equal(screenConfidence(w, h), screenConfidence(h, w));
  assert.ok(screenConfidence(1179, 2556) > screenConfidence(590, 1278));
  assert.ok(screenConfidence(720, 1640) > screenConfidence(720, 1640, false));
  assert.equal(screenConfidence(4032, 3024), 0);
  assert.equal(screenConfidence(0, 0), 0);
  assert.equal(screenConfidence(NaN, 10), 0);
  assert.ok(screenConfidence(3840, 2160) < 0.1);
  assert.equal(photoSourceScore({}, 1000, 1000), 0);
  assert.equal(photoSourceScore({ originalName: "Screenshot.png" }, 1179, 2556), -4, "matching filename and dimensions are not double-counted");
});

test("transparent pixels composite consistently and invalid samples are rejected", () => {
  const rgba = pixels("blank");
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0;
  const white = new Uint8ClampedArray(rgba.length).fill(255);
  assert.equal(analyzePhotoPixels(rgba, 96, 192).quality, analyzePhotoPixels(white, 96, 192).quality);
  assert.throws(() => analyzePhotoPixels(rgba, 192, 192));
  assert.throws(() => analyzePhotoPixels(new Uint8ClampedArray(4), 1, 1));
});

test("in-flight work is deduplicated, bounded to two and cached across hints/resize", async (t) => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let requests = 0, current = 0, peak = 0, closed = 0;
  replace("fetch", async () => {
    requests += 1; current += 1; peak = Math.max(peak, current);
    await new Promise((resolve) => setTimeout(resolve, 10)); current -= 1;
    return new Response(new Blob(["fixture"]));
  });
  replace("createImageBitmap", async () => ({ width: 96, height: 192, close: () => { closed += 1; } }));
  replace("OffscreenCanvas", class {
    getContext() { return { drawImage() {}, getImageData() { return { data: pixels("bottom") }; } }; }
  });
  try {
    const values = await Promise.all([scorePhoto("/test/cover-a"), scorePhoto("/test/cover-a"), scorePhoto("/test/cover-b"), scorePhoto("/test/cover-c"), scorePhoto("/test/cover-d")]);
    assert.equal(requests, 4); assert.equal(closed, 4); assert.ok(peak <= 2);
    assert.equal(values[0], values[1]);
    const before = peekCover("/test/cover-a", {}, 1)!;
    const after = await scorePhoto("/test/cover-a", { originalName: "Screenshot.png" }, 0.5);
    assert.notEqual(after, before.score); assert.equal(requests, 4);
    replace("fetch", async () => new Response("missing", { status: 404 }));
    assert.equal(await scorePhoto("/test/cover-failed"), -1);
    assert.equal(peekScore("/test/cover-failed"), -1);
    assert.equal(peekCover("/test/cover-failed"), undefined);
    const now = Date.now;
    t.mock.method(Date, "now", () => now() + 31_000);
    assert.equal(peekScore("/test/cover-failed"), -1, "expiry alone cannot unset a settled day's winner");
    replace("fetch", async () => { requests += 1; return new Response(new Blob(["retry"])); });
    assert.ok(await scorePhoto("/test/cover-failed") > 0, "a later explicit batch retries transient failures");
    assert.equal(requests, 5);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
