export { PHOTO_ANALYSIS_VERSION, PHONE_SCREEN_SIZES, analyzePhotoPixels, coverFromAnalysis, photoSourceScore, storyWeight, screenConfidence, type PhotoAnalysis, type PhotoCover, type PhotoHints } from "@lifeos/core";
import { analyzePhotoPixels, coverFromAnalysis, type PhotoAnalysis, type PhotoCover, type PhotoHints } from "@lifeos/core";
const SAMPLE_EDGE = 192, CACHE_LIMIT = 512;
const CACHE = new Map<string, { analysis: PhotoAnalysis | null; retryAt: number }>();
const IN_FLIGHT = new Map<string, Promise<PhotoAnalysis | null>>();
let active = 0;
const waiting: (() => void)[] = [];

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
