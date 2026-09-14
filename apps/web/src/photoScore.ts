/**
 * Picking the "most substantial" photo of a day without any AI service.
 *
 * Each candidate is decoded once into a tiny 64x64 bitmap and measured on
 * four pixel statistics, plus one free metadata signal:
 *
 * - edge density   — mean gradient magnitude; busy scenes (people, tables,
 *                    streets) score high, blank walls and sky score low.
 * - contrast       — luminance spread; flat, washed shots score low.
 * - colourfulness  — mean saturation; grey scenes score low.
 * - exposure fit   — how far the mean luminance sits from a sane mid-tone.
 * - story weight   — the owning record's text length and entity refs, a
 *                    zero-cost proxy for "this photo belongs to a fuller day".
 *
 * All deterministic, all client-side, no API key. Scores are cached per URL
 * and deduplicated while in flight, because the same photo may back several
 * views in one session.
 */

const SCORE_CACHE = new Map<string, number>();
const IN_FLIGHT = new Map<string, Promise<number>>();

/** Free story signal: fuller records are likelier to hold the fuller photo. */
export function storyWeight(textLength: number, refCount: number): number {
  const text = Math.min(Math.max(textLength, 0) / 120, 1);
  const refs = Math.min(Math.max(refCount, 0) / 3, 1);
  return text * 0.5 + refs * 0.4;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Pixel statistics over a 64x64 RGBA frame. */
function pixelScore(data: Uint8ClampedArray): number {
  const size = data.length / 4;
  const luma = new Float32Array(size);
  const sat = new Float32Array(size);
  let lumaSum = 0;
  let satSum = 0;
  for (let pixel = 0; pixel < size; pixel += 1) {
    const at = pixel * 4;
    const red = data[at] / 255;
    const green = data[at + 1] / 255;
    const blue = data[at + 2] / 255;
    const brightest = Math.max(red, green, blue);
    const darkest = Math.min(red, green, blue);
    const light = 0.299 * red + 0.587 * green + 0.114 * blue;
    luma[pixel] = light;
    sat[pixel] = brightest === 0 ? 0 : (brightest - darkest) / brightest;
    lumaSum += light;
    satSum += sat[pixel];
  }
  const lumaMean = lumaSum / size;
  const satMean = satSum / size;

  let variance = 0;
  for (let pixel = 0; pixel < size; pixel += 1) {
    const offset = luma[pixel] - lumaMean;
    variance += offset * offset;
  }
  const lumaDev = Math.sqrt(variance / size);

  // Sobel-lite: mean absolute neighbour difference across the frame.
  let edges = 0;
  let edgeCount = 0;
  for (let y = 1; y < 63; y += 1) {
    for (let x = 1; x < 63; x += 1) {
      const at = y * 64 + x;
      const dx = Math.abs(luma[at + 1] - luma[at - 1]);
      const dy = Math.abs(luma[at + 64] - luma[at - 64]);
      edges += dx + dy;
      edgeCount += 1;
    }
  }
  const edgeMean = edgeCount === 0 ? 0 : edges / edgeCount;

  const edgeTerm = clamp01(edgeMean / 0.16);
  const contrastTerm = clamp01(lumaDev / 0.24);
  const colourTerm = clamp01(satMean / 0.42);
  const exposureFit = clamp01(1 - Math.abs(lumaMean - 0.48) * 2.1);
  return (edgeTerm + contrastTerm * 0.8 + colourTerm * 0.6) * (0.35 + 0.65 * exposureFit);
}

async function measure(url: string): Promise<number> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`photo fetch ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64, resizeQuality: "low" });
  const canvas = new OffscreenCanvas(64, 64);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, 64, 64);
  bitmap.close();
  const frame = context.getImageData(0, 0, 64, 64);
  return pixelScore(frame.data);
}

/**
 * Content score for one photo; higher is more substantial. Resolves to -1
 * when the photo cannot be measured, so callers fall back to their default
 * pick instead of blocking the view.
 */
export function scorePhoto(url: string): Promise<number> {
  const cached = SCORE_CACHE.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = IN_FLIGHT.get(url);
  if (running !== undefined) return running;
  const scored = measure(url)
    .then((score) => {
      SCORE_CACHE.set(url, score);
      return score;
    })
    .catch(() => -1)
    .finally(() => IN_FLIGHT.delete(url));
  IN_FLIGHT.set(url, scored);
  return scored;
}

export function peekScore(url: string): number | undefined {
  return SCORE_CACHE.get(url);
}
