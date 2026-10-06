import type { PhotoMetadata } from "@lifeos/core";

/** Pure, bounded cover analysis. Same 1200px URL as the rendered image, no AI/OCR. */
export const PHOTO_ANALYSIS_VERSION = 2;
const SAMPLE_EDGE = 192;
const CACHE_LIMIT = 512;
const CACHE = new Map<string, { analysis: PhotoAnalysis | null; retryAt: number }>();
const IN_FLIGHT = new Map<string, Promise<PhotoAnalysis | null>>();
let active = 0;
const waiting: (() => void)[] = [];

/** Deduplicated short/long screen sizes, not a device whitelist or sales ranking.
 * Apple official specs: XR/11 through 18 Pro/PM, mini/Plus/SE/e/Air.
 * Domestic official specs: Huawei, Honor, vivo, OPPO and Redmi China versions.
 * https://support.apple.com/en-us/108044
 * https://www.mi.com/prod/redmi-k80/specs
 * https://www.mi.com/prod/redmi-k90/specs
 * https://www.mi.com/prod/redmi-note-14-pro/specs
 * Rechecked 2026-10-06; native panel size is only weak screenshot evidence.
 */
export const PHONE_SCREEN_SIZES: readonly (readonly [number, number])[] = [
  [750, 1334], [828, 1792], [1080, 2340], [1125, 2436], [1170, 2532],
  [1179, 2556], [1206, 2622], [1242, 2688], [1284, 2778], [1290, 2796],
  [1320, 2868], [1260, 2736],
  // A3x; Y300i; Honor Play60 Plus; Y37/Play50; Redmi 14R.
  [720, 1604], [720, 1608], [720, 1610], [720, 1612], [720, 1640],
  // Note14 Pro overseas 4G; Honor X60/A5 Pro; nova13/15; X50; Honor300; Xiaomi15; Reno16/X300; Mate70.
  [1080, 2400], [1080, 2412], [1084, 2412], [1200, 2652], [1200, 2664], [1200, 2670], [1216, 2640], [1216, 2688],
  // Note13/14 Pro, Turbo4/K70 Ultra; Xiaomi17; 70X/X60 Pro; Reno13/FindX9.
  [1220, 2712], [1220, 2656], [1224, 2700], [1256, 2760],
  // S20/Y600 Pro; S60; Pura70 Pro; Mate80; Xiaomi11/K60/K70/K80(+Pro).
  [1260, 2800], [1260, 2750], [1260, 2844], [1280, 2832], [1440, 3200],
  // K90, K90 PM, Turbo5, K80 Ultra/Turbo4 Pro/Turbo5 Max/Note15 Pro, Note15.
  [1156, 2510], [1200, 2608], [1268, 2756], [1280, 2772], [1080, 2392],
];
const SCREEN_KEYS = new Set(PHONE_SCREEN_SIZES.map(([w, h]) => `${w}:${h}`));

export interface PhotoHints {
  readonly originalName?: string;
  readonly photoMetadata?: PhotoMetadata;
}
export interface PhotoAnalysis {
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  readonly textLikelihood: number;
  readonly attention: Float32Array;
  readonly attentionTotal: number;
}
export interface PhotoCover {
  readonly score: number;
  readonly quality: number;
  readonly source: number;
  readonly textPenalty: number;
  readonly cropScore: number;
  readonly position: string;
  readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}
const clamp = (v: number, low = 0, high = 1): number => Math.max(low, Math.min(high, v));

/** Story is only a tie-breaker; it cannot rescue a text-heavy image. */
export function storyWeight(textLength: number, refCount: number): number {
  return clamp(textLength / 120) * 0.5 + clamp(refCount / 3) * 0.4;
}

export function screenConfidence(width: number, height: number, native = true): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  const short = Math.min(width, height), long = Math.max(width, height);
  if (SCREEN_KEYS.has(`${short}:${long}`)) return native ? 0.85 : 0.45;
  const ratio = long / short;
  // A camera's 16:9 mode overlaps older phone screens; never a strong hint.
  if (Math.abs(ratio - 16 / 9) < 0.012) return 0.08;
  return PHONE_SCREEN_SIZES.some(([w, h]) => Math.abs(ratio - h / w) < 0.012) ? 0.2 : 0;
}

export function photoSourceScore(hints: PhotoHints, width: number, height: number): number {
  const meta = hints.photoMetadata;
  const w = meta?.width ?? width, h = meta?.height ?? height;
  const ratio = Math.max(w, h) / Math.max(1, Math.min(w, h));
  const name = hints.originalName ?? "";
  const screenshotName = /screenshot|screen[ _-]?shot|截[屏图]|屏幕快照/i.test(name);
  const cameraName = /^(?:IMG|DSC|DSCF|PXL)[_-]/i.test(name);
  const screenshot = Math.max(screenshotName ? 1 : 0, screenConfidence(w, h, meta !== undefined));
  const camera = meta?.cameraEvidence === "capture" ? 7 : meta?.cameraEvidence === "device" ? 3 : 0;
  const cameraRatio = Math.abs(ratio - 4 / 3) < 0.02 || Math.abs(ratio - 3 / 2) < 0.02 ? 1 : 0;
  // Correlated filename, ratio and metadata votes share one small budget.
  return clamp(camera + cameraRatio + (cameraName ? 1 : 0) - screenshot * 4, -4, 10);
}

/** Text requires neutral glyph runs + repeated rows + flat background. */
export function analyzePhotoPixels(data: Uint8ClampedArray, width: number, height: number): PhotoAnalysis {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > SAMPLE_EDGE || height > SAMPLE_EDGE || data.length !== width * height * 4) throw new Error("Invalid photo sample");
  const count = width * height;
  const luma = new Float32Array(count), saturation = new Float32Array(count);
  const rowNeutral = new Float32Array(height), histogram = new Uint32Array(16);
  let sum = 0, colour = 0;
  for (let i = 0; i < count; i += 1) {
    const a = data[i * 4 + 3] / 255;
    const r = data[i * 4] / 255 * a + 1 - a, g = data[i * 4 + 1] / 255 * a + 1 - a, b = data[i * 4 + 2] / 255 * a + 1 - a;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const light = 0.299 * r + 0.587 * g + 0.114 * b, sat = max === 0 ? 0 : (max - min) / max;
    luma[i] = light; saturation[i] = sat;
    rowNeutral[Math.floor(i / width)] += sat < 0.18 ? 1 : 0;
    histogram[Math.min(15, Math.floor(light * 16))] += 1;
    sum += light; colour += sat;
  }
  const mean = sum / count;
  let variance = 0, edges = 0, flat = 0, samples = 0;
  const rowRuns = new Uint16Array(height), rowRules = new Uint16Array(height), weight = new Float32Array(count);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const dx = Math.abs(luma[i + 1] - luma[i - 1]), dy = Math.abs(luma[i + width] - luma[i - width]), gradient = dx + dy;
      variance += (luma[i] - mean) ** 2; edges += gradient;
      if (gradient < 0.035) flat += 1;
      if (dx > 0.13 && saturation[i] < 0.18) rowRuns[y] += 1;
      if (dy > 0.16) rowRules[y] += 1;
      // Colour and local texture provide attention, not object recognition.
      weight[i] = saturation[i] * 0.6 + clamp(gradient / 0.5) * 0.4;
      samples += 1;
    }
  }
  let bands = 0, ruleBands = 0, inBand = false, inRule = false;
  const bandStarts: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    const textRow = rowRuns[y] >= Math.max(5, width * 0.1) && rowNeutral[y] / width > 0.75;
    const ruleRow = rowRules[y] / width > 0.6;
    if (textRow && !inBand) { bands += 1; bandStarts.push(y); }
    if (ruleRow && !inRule) ruleBands += 1;
    inBand = textRow; inRule = ruleRow;
  }
  const gaps = bandStarts.slice(1).map((y, i) => y - bandStarts[i]);
  const gapMean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const gapDev = Math.sqrt(gaps.reduce((a, b) => a + (b - gapMean) ** 2, 0) / Math.max(1, gaps.length));
  const regular = gaps.length >= 3 ? clamp(1 - gapDev / Math.max(1, gapMean)) : 0;
  const dominant = Math.max(...histogram) / count;
  const background = clamp((flat / Math.max(1, samples) - 0.12) / 0.5) * clamp((dominant - 0.15) / 0.4);
  const repetition = clamp((bands - 2) / 6) * (0.6 + 0.4 * regular), rules = clamp((ruleBands - 2) / 5) * 0.75;
  const textLikelihood = clamp(Math.max(repetition, rules) * background);
  const exposure = clamp(1 - Math.abs(mean - 0.48) * 1.6);
  const quality = 60 * (clamp(Math.sqrt(variance / Math.max(1, samples)) / 0.23) * 0.35 + clamp(colour / count / 0.42) * 0.3 + clamp(edges / Math.max(1, samples) / 0.16) * 0.2 + exposure * 0.15);
  // Retain a compact 32x32 integral map (~4 KB/photo), discard RGBA and large arrays.
  const grid = new Float32Array(32 ** 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x, gx = Math.min(31, Math.floor(x / width * 32)), gy = Math.min(31, Math.floor(y / height * 32));
      grid[gy * 32 + gx] += weight[i] * (1 - textLikelihood * (saturation[i] < 0.18 ? 0.85 : 0));
    }
  }
  const attention = new Float32Array(33 ** 2);
  for (let y = 1; y <= 32; y += 1) {
    for (let x = 1; x <= 32; x += 1) attention[y * 33 + x] = grid[(y - 1) * 32 + x - 1] + attention[(y - 1) * 33 + x] + attention[y * 33 + x - 1] - attention[(y - 1) * 33 + x - 1];
  }
  return { width, height, quality, textLikelihood, attention, attentionTotal: attention[attention.length - 1] };
}

export function coverFromAnalysis(analysis: PhotoAnalysis, hints: PhotoHints = {}, aspect = 1): PhotoCover {
  const ratio = analysis.width / analysis.height;
  const target = Number.isFinite(aspect) && aspect > 0 ? clamp(aspect, 0.2, 5) : 1;
  const cw = ratio > target ? target / ratio : 1, ch = ratio > target ? 1 : ratio / target;
  const mass = (x: number, y: number): number => {
    const x0 = Math.round(x * 32), y0 = Math.round(y * 32), x1 = Math.min(32, Math.round((x + cw) * 32)), y1 = Math.min(32, Math.round((y + ch) * 32));
    const p = analysis.attention;
    return Math.max(0, p[y1 * 33 + x1] - p[y0 * 33 + x1] - p[y1 * 33 + x0] + p[y0 * 33 + x0]);
  };
  // Keep top-biased framing unless attention gives a clear improvement.
  let x = (1 - cw) * 0.5, y = (1 - ch) * 0.2, kept = mass(x, y);
  const baseline = kept;
  for (let step = 0; step <= 8; step += 1) {
    const nx = cw < 1 ? (1 - cw) * step / 8 : 0, ny = ch < 1 ? (1 - ch) * step / 8 : 0;
    const candidate = mass(nx, ny);
    if (candidate > kept + analysis.attentionTotal * 0.0001) { x = nx; y = ny; kept = candidate; }
  }
  if (kept - baseline < analysis.attentionTotal * 0.04) { x = (1 - cw) * 0.5; y = (1 - ch) * 0.2; kept = baseline; }
  const retention = analysis.attentionTotal > 0.1 ? clamp(kept / analysis.attentionTotal) : cw * ch;
  const cropScore = 30 * retention, source = photoSourceScore(hints, analysis.width, analysis.height), textPenalty = 60 * analysis.textLikelihood;
  const position = `${cw < 0.999 ? Math.round(x / (1 - cw) * 100) : 50}% ${ch < 0.999 ? Math.round(y / (1 - ch) * 100) : 20}%`;
  return { score: analysis.quality + cropScore + source - textPenalty, quality: analysis.quality, source, textPenalty, cropScore, position, crop: { x, y, width: cw, height: ch } };
}

async function measure(url: string): Promise<PhotoAnalysis> {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  let bitmap: ImageBitmap | undefined;
  try {
    const response = await fetch(url, { cache: "force-cache", signal: controller.signal });
    if (!response.ok) throw new Error(`photo fetch ${response.status}`);
    const blob = await response.blob();
    // Width-only resize preserves aspect; final canvas is at most 192px on either axis.
    bitmap = await createImageBitmap(blob, { resizeWidth: SAMPLE_EDGE, resizeQuality: "low" });
    const scale = Math.min(1, SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(2, Math.round(bitmap.width * scale)), height = Math.max(2, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (context === null) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0, width, height);
    return analyzePhotoPixels(context.getImageData(0, 0, width, height).data, width, height);
  } finally {
    bitmap?.close(); clearTimeout(timeout);
    const next = waiting.shift();
    if (next !== undefined) next();
    else active -= 1;
  }
}

function cachedAnalysis(url: string, retry = false): PhotoAnalysis | null | undefined {
  const cached = CACHE.get(url);
  if (cached === undefined) return undefined;
  if (retry && cached.analysis === null && cached.retryAt <= Date.now()) { CACHE.delete(url); return undefined; }
  CACHE.delete(url); CACHE.set(url, cached);
  return cached.analysis;
}

export function scorePhoto(url: string, hints: PhotoHints = {}, aspect = 1): Promise<number> {
  const cached = cachedAnalysis(url, true);
  if (cached !== undefined) return Promise.resolve(cached === null ? -1 : coverFromAnalysis(cached, hints, aspect).score);
  let running = IN_FLIGHT.get(url);
  if (running === undefined) {
    running = measure(url).catch(() => null).then((analysis) => {
      CACHE.set(url, { analysis, retryAt: analysis === null ? Date.now() + 30_000 : Infinity });
      while (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value!);
      return analysis;
    }).finally(() => IN_FLIGHT.delete(url));
    IN_FLIGHT.set(url, running);
  }
  return running.then((analysis) => analysis === null ? -1 : coverFromAnalysis(analysis, hints, aspect).score);
}

export function peekCover(url: string, hints: PhotoHints = {}, aspect = 1): PhotoCover | undefined {
  const analysis = cachedAnalysis(url);
  return analysis == null ? undefined : coverFromAnalysis(analysis, hints, aspect);
}
export function peekScore(url: string, hints: PhotoHints = {}, aspect = 1): number | undefined {
  const analysis = cachedAnalysis(url);
  return analysis === undefined ? undefined : analysis === null ? -1 : coverFromAnalysis(analysis, hints, aspect).score;
}
