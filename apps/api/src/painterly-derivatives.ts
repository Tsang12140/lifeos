import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StorageReference } from "@lifeos/core";
import sharp from "sharp";

/** Bump whenever the painterly rendering changes; old files then age out naturally. */
export const PAINTERLY_STYLE_VERSION = "week-card-painterly-v1";
export const PAINTERLY_BASE_WIDTH = 640;
export const PAINTERLY_BASE_HEIGHT = 230;
export const PAINTERLY_STRENGTH = 180;
export const PAINTERLY_BAND_COUNTS = [1, 2, 3, 4] as const;
export type PainterlyBandCount = (typeof PAINTERLY_BAND_COUNTS)[number];

export interface PainterlyDerivativeOptions {
  readonly sourceVersion: string;
  readonly bands: PainterlyBandCount;
  readonly rotation: number;
}

export interface PainterlyDerivativeCache {
  /** A content-addressed hit does not need to open or download the original. */
  cached(reference: StorageReference, options: PainterlyDerivativeOptions): string | null;
  ensure(reference: StorageReference, sourceFile: string, options: PainterlyDerivativeOptions): Promise<string>;
  ensureFromSource(
    reference: StorageReference,
    options: PainterlyDerivativeOptions,
    loadSource: () => Promise<{ readonly file: string; readonly dispose?: () => void }>,
  ): Promise<string>;
}

/**
 * Durable server-side card artwork. Originals remain in the asset store; these
 * regenerable WebP files live beside, but outside, the ordinary thumbnail cache.
 */
export function createPainterlyDerivativeCache(dataDirectory: string): PainterlyDerivativeCache {
  const directory = resolve(dataDirectory, "derived", "painterly");
  const pending = new Map<string, Promise<string>>();
  let tail: Promise<unknown> = Promise.resolve();

  return {
    cached(reference, options) {
      const key = painterlyKey(reference, undefined, options);
      if (key === null) return null;
      const { width, height } = painterlyDimensions(options.bands);
      const target = resolve(directory, `${key}-${width}x${height}-${PAINTERLY_STRENGTH}-${PAINTERLY_STYLE_VERSION}.webp`);
      return existsSync(target) ? target : null;
    },
    async ensure(reference, sourceFile, options) {
      const key = painterlyKey(reference, sourceFile, options);
      if (key === null) throw new Error("A source file is required for a painterly cache key without a content hash");
      return queue(key, options, async () => ({ file: sourceFile }));
    },
    async ensureFromSource(reference, options, loadSource) {
      const key = painterlyKey(reference, undefined, options);
      if (key === null) throw new Error("A content hash is required to merge painterly source downloads");
      return queue(key, options, loadSource);
    },
  };

  function queue(
    key: string,
    options: PainterlyDerivativeOptions,
    loadSource: () => Promise<{ readonly file: string; readonly dispose?: () => void }>,
  ): Promise<string> {
    const { width, height } = painterlyDimensions(options.bands);
    const target = resolve(directory, `${key}-${width}x${height}-${PAINTERLY_STRENGTH}-${PAINTERLY_STYLE_VERSION}.webp`);
    if (existsSync(target)) return Promise.resolve(target);
    const running = pending.get(target);
    if (running !== undefined) return running;
    const job = tail.catch(() => undefined).then(async () => {
      if (existsSync(target)) return target;
      const source = await loadSource();
      try { return await derivePainterly(source.file, target, options, width, height); }
      finally { source.dispose?.(); }
    }).finally(() => pending.delete(target));
    tail = job;
    pending.set(target, job);
    return job;
  }
}

export function painterlyDimensions(bands: PainterlyBandCount): { readonly width: number; readonly height: number } {
  return { width: Math.round(PAINTERLY_BASE_WIDTH / bands), height: PAINTERLY_BASE_HEIGHT };
}

function painterlyKey(reference: StorageReference, sourceFile: string | undefined, options: PainterlyDerivativeOptions): string | null {
  const { width, height } = painterlyDimensions(options.bands);
  let sourceIdentity: string;
  if (reference.contentHash !== undefined) sourceIdentity = `${reference.contentHash.algorithm}:${reference.contentHash.value}`;
  else {
    if (sourceFile === undefined) return null;
    sourceIdentity = (() => {
      const stat = statSync(sourceFile);
      return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    })();
  }
  return digest(JSON.stringify([
    reference.sourceId,
    reference.sourceRef,
    sourceIdentity,
    options.sourceVersion,
    options.rotation,
    options.bands,
    width,
    height,
    PAINTERLY_STRENGTH,
    PAINTERLY_STYLE_VERSION,
  ]));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomSource() {
  let seed = 0x6d2b79f5;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_296;
  };
}

function rgb(values: readonly number[]): string {
  return `rgb(${values[0]} ${values[1]} ${values[2]})`;
}

/**
 * Ports the approved Demo's color-sampled, directional broken-brush strokes to
 * SVG compositing so the API can persist one deterministic WebP per cache key.
 * The 640×230 geometry, xorshift sequence, luma-guided direction, quantized
 * color patches, bristle marks, low-resolution underpainting, and grain match
 * `apps/web/week-card-paint-renderer.js`; `bands` selects a bounded cover crop
 * while brush scale stays tied to the 230px card height.
 */
async function derivePainterly(sourceFile: string, target: string, options: PainterlyDerivativeOptions, width: number, height: number): Promise<string> {
  const { rotation } = options;
  const strength = PAINTERLY_STRENGTH;
  const amount = Math.max(0, Math.min(2.5, strength / 100));
  const extra = Math.max(0, amount - 1);
  const scale = height / PAINTERLY_BASE_HEIGHT;

  // Match the normal thumbnail path: first apply EXIF orientation, then the
  // saved display rotation. The resulting card source is centered and covered.
  const pixels = await readCoverPixels(sourceFile, width, height, rotation);

  const baseWidth = Math.max(1, Math.round(Math.round(80 / (1 + extra * 1.2)) * scale * width / PAINTERLY_BASE_WIDTH));
  const baseHeight = Math.max(1, Math.round(Math.max(8, Math.round(baseWidth * PAINTERLY_BASE_HEIGHT / PAINTERLY_BASE_WIDTH)) * scale));
  const base = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .resize(baseWidth, baseHeight, { fit: "fill", kernel: "linear" })
    .resize(width, height, { fit: "fill", kernel: "linear" })
    .png()
    .toBuffer();

  const random = randomSource();
  const at = (x: number, y: number) => 4 * (Math.min(height - 1, Math.max(0, y | 0)) * width + Math.min(width - 1, Math.max(0, x | 0)));
  const luma = (i: number) => pixels[i]! * 0.299 + pixels[i + 1]! * 0.587 + pixels[i + 2]! * 0.114;
  const strokes: string[] = [];
  const baseSteps = [18 + amount * 9, 9 + amount * 7, 5 + amount * 5];
  const layerAlphas = [0.82, 0.76, 0.62];

  for (let layer = 0; layer < 3; layer++) {
    const step = baseSteps[layer]! * scale;
    for (let y = -step; y < height + step; y += step) {
      for (let x = -step; x < width + step; x += step) {
        const px = x + (random() - 0.5) * step;
        const py = y + (random() - 0.5) * step;
        const i = at(px, py);
        const gx = luma(at(px + 3 * scale, py)) - luma(at(px - 3 * scale, py));
        const gy = luma(at(px, py + 3 * scale)) - luma(at(px, py - 3 * scale));
        const angle = Math.atan2(gy, gx) + Math.PI / 2 + (random() - 0.5) * 1.1;
        const length = step * (1.3 + random()) * (1 + extra * 0.7);
        const thick = step * (0.42 + random() * 0.32) * (1 + extra * 0.25);
        const c = Math.cos(angle), s = Math.sin(angle);
        const shift = (random() - 0.5) * 16 * (1 + extra * 0.8);
        const sampleColor = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
        if (extra) {
          sampleColor.fill(0);
          const radius = (3 + extra * 7) * scale;
          for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) {
            const q = at(px + ox * radius, py + oy * radius);
            for (let k = 0; k < 3; k++) sampleColor[k]! += pixels[q + k]! / 9;
          }
        }
        const mean = (sampleColor[0]! + sampleColor[1]! + sampleColor[2]!) / 3;
        const quantize = extra ? 6 + extra * 14 : 1;
        const color = sampleColor.map(v => Math.round(Math.max(0, Math.min(255, Math.round((v * 0.9 + mean * 0.1 + shift) / quantize) * quantize))));
        const transform = `matrix(${c} ${s} ${-s} ${c} ${px} ${py})`;
        const d = `M ${-length * 0.5} ${-thick * 0.25} L ${-length * 0.31} ${-thick * 0.52} L ${length * 0.22} ${-thick * 0.42} L ${length * 0.48} ${-thick * 0.15} L ${length * 0.37} ${thick * 0.43} L ${-length * 0.38} ${thick * 0.51} Z`;
        strokes.push(`<path d="${d}" transform="${transform}" fill="${rgb(color)}" fill-opacity="${layerAlphas[layer]}"/>`);
        if (random() > 0.36) {
          const bristle = rgb(color.map(v => Math.min(255, v + 38)));
          strokes.push(`<path d="M ${-length * 0.4} ${thick * 0.1} L ${length * 0.24} ${thick * 0.04}" transform="${transform}" fill="none" stroke="${bristle}" stroke-opacity="${0.12 + amount * 0.1}" stroke-width="${(0.45 + random() * 0.65) * scale}"/>`);
        }
      }
    }
  }

  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${strokes.join("")}</svg>`);
  const painted = await sharp(base).composite([{ input: svg }]).ensureAlpha().raw().toBuffer();
  // Strength is fixed at 180, where the Demo's light-end source restoration
  // has zero opacity. CanvasImageData semantics preserve its seeded grain.
  const grainPixels = new Uint8ClampedArray(painted.buffer, painted.byteOffset, painted.byteLength);
  for (let p = 0; p < grainPixels.length; p += 4) {
    const noise = (random() - 0.5) * (4 + amount * 7);
    grainPixels[p] = grainPixels[p]! + noise;
    grainPixels[p + 1] = grainPixels[p + 1]! + noise;
    grainPixels[p + 2] = grainPixels[p + 2]! + noise;
  }

  mkdirSync(dirname(target), { recursive: true });
  const encoded = await sharp(Buffer.from(grainPixels.buffer, grainPixels.byteOffset, grainPixels.byteLength), {
    raw: { width, height, channels: 4 },
  }).webp({ quality: 83 }).toBuffer();
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    writeFileSync(temporary, encoded, { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    // Another API process may have won the same deterministic cache race.
    if (!existsSync(target)) throw error;
  }
  return target;
}

async function readCoverPixels(sourceFile: string, width: number, height: number, rotation: number): Promise<Buffer> {
  let oriented = await sharp(sourceFile, { failOn: "none", limitInputPixels: 80_000_000 }).rotate().toBuffer();
  if (rotation !== 0) oriented = await sharp(oriented, { failOn: "none", limitInputPixels: 80_000_000 }).rotate(rotation).toBuffer();
  const metadata = await sharp(oriented, { failOn: "none", limitInputPixels: 80_000_000 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Photo dimensions are unavailable");
  const scale = Math.max(width / metadata.width, height / metadata.height);
  const resizedWidth = Math.max(width, Math.ceil(metadata.width * scale));
  const resizedHeight = Math.max(height, Math.ceil(metadata.height * scale));
  const left = Math.round((resizedWidth - width) / 2);
  // Week-card CSS uses object-position: center 20%; preserve that cover anchor
  // when the source itself has to be cropped into the output band's shape.
  const top = Math.round((resizedHeight - height) * 0.2);
  return sharp(oriented, { failOn: "none", limitInputPixels: 80_000_000 })
    .resize(resizedWidth, resizedHeight, { fit: "fill", withoutEnlargement: false })
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer();
}
