import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StorageReference } from "@lifeos/core";
import sharp from "sharp";

/**
 * Derived thumbnails — the "regenerable derived data" `docs/requirements.md` asks
 * LifeOS to keep beside a photo's stable reference, and the answer to a concrete bill.
 * The timeline grid draws a photo about 130 CSS px wide, and until now that square
 * pulled the whole original: this machine's library averages 3.9 MB a picture, so one
 * nine-photo record cost roughly 35 MB to paint nine 130px squares. The same picture
 * files are also behind the week-card and calendar backgrounds and the composer tray.
 *
 * Three rules shape this module:
 *   * it is keyed by what the original *is*, so two identical photos share one
 *     thumbnail and deleting the whole directory is always safe — the next request
 *     that needs a picture simply builds it again;
 *   * it lives under the data directory, not the asset root. The asset root is the
 *     owner's photo library (a NAS share, or `pic-test/` in the preview) and a cache
 *     has no business appearing inside it;
 *   * it never writes to the originals. The collector owns `uploads/`, this owns
 *     `derived/`, and neither can reach the other's paths.
 */

/**
 * The two widths the client actually asks for: 400 covers the timeline grid and the
 * composer tray even on a 3x screen, 1200 covers a week-card or calendar background.
 * A `?w=` that is neither is refused rather than rounded down, so a stray value cannot
 * quietly fill the cache with a size nothing will ever request again.
 */
export const THUMBNAIL_WIDTHS = [400, 1200] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];
export const DEFAULT_THUMBNAIL_WIDTH: ThumbnailWidth = 400;
export const THUMBNAIL_FORMAT = "webp";
/** 80 is the knee of the curve for photographs: visually lossless here, tiny on disk. */
const THUMBNAIL_QUALITY = 80;
/** Everything this module writes matches this, and only this is ever deleted by `clear`. */
const THUMBNAIL_FILE_PATTERN = /^[0-9a-f]{64}-\d+\.webp$/;

export function parseThumbnailWidth(raw: string | null): ThumbnailWidth | null {
  if (raw === null || raw === "") return DEFAULT_THUMBNAIL_WIDTH;
  const parsed = Number(raw);
  return (THUMBNAIL_WIDTHS as readonly number[]).includes(parsed) ? (parsed as ThumbnailWidth) : null;
}

export function thumbnailDirectory(dataDirectory: string): string {
  return resolve(dataDirectory, "derived", "thumbs");
}

/**
 * The key a thumbnail is filed under, always hashed again before it reaches a file
 * name. Uploads carry the sha256 LifeOS computed from the bytes it received, and that
 * value is what lets two identical photos share one thumbnail; a hand-registered
 * reference may carry no hash at all, and then the file's own identity stands in —
 * folding size and mtime in means replacing that file invalidates its thumbnails
 * instead of serving the previous picture forever. Re-hashing whatever comes back
 * keeps a database value from ever steering a path.
 */
export function thumbnailKey(reference: StorageReference, sourceFile: string): string {
  const hash = reference.contentHash;
  if (hash !== undefined) return digest(`${hash.algorithm}:${hash.value}`);
  const info = statSync(sourceFile);
  return digest(`${reference.sourceRef}\u0000${info.size}\u0000${info.mtimeMs}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ThumbnailStats {
  readonly directory: string;
  readonly count: number;
  readonly bytes: number;
}

export interface ThumbnailCache {
  /** The file holding `width` px of `sourceFile`, derived on first use. */
  ensure(reference: StorageReference, sourceFile: string, width: ThumbnailWidth): Promise<string>;
  stats(): ThumbnailStats;
  /** Deletes every derived thumbnail. Never a loss: the next request rebuilds. */
  clear(): { readonly removed: number; readonly freedBytes: number };
}

export function createThumbnailCache(dataDirectory: string): ThumbnailCache {
  const directory = thumbnailDirectory(dataDirectory);
  // A nine-square grid fires nine requests at once, and the browser asks for the two
  // widths of one background separately; without this map each arrival would decode
  // the same original again.
  const pending = new Map<string, Promise<string>>();

  return {
    async ensure(reference, sourceFile, width) {
      const target = resolve(directory, `${thumbnailKey(reference, sourceFile)}-${width}.${THUMBNAIL_FORMAT}`);
      if (existsSync(target)) return target;
      const running = pending.get(target);
      if (running !== undefined) return running;
      const job = derive(sourceFile, target, width).finally(() => pending.delete(target));
      pending.set(target, job);
      return job;
    },
    stats() {
      let count = 0;
      let bytes = 0;
      for (const name of listThumbnailFiles(directory)) {
        count += 1;
        bytes += statSync(resolve(directory, name)).size;
      }
      return { directory, count, bytes };
    },
    clear() {
      let removed = 0;
      let freedBytes = 0;
      // Only files this module wrote are ever deleted: the pattern is checked rather
      // than trusting the directory to hold nothing else.
      for (const name of listThumbnailFiles(directory)) {
        const file = resolve(directory, name);
        freedBytes += statSync(file).size;
        rmSync(file, { force: true });
        removed += 1;
      }
      return { removed, freedBytes };
    },
  };
}

function listThumbnailFiles(directory: string): readonly string[] {
  try {
    return readdirSync(directory).filter((name) => THUMBNAIL_FILE_PATTERN.test(name));
  } catch {
    // No cache yet is the normal first-run state, not a failure.
    return [];
  }
}

async function derive(sourceFile: string, target: string, width: ThumbnailWidth): Promise<string> {
  mkdirSync(dirname(target), { recursive: true });
  // Encode to a buffer, then write under a unique name and rename inside one directory:
  // a request that arrives mid-write sees either nothing or a complete thumbnail, never
  // a half-encoded one. `toBuffer` also sidesteps `toFile`'s habit of inferring the
  // output format from the extension, which a temporary name would not carry.
  const bytes = await sharp(sourceFile, { failOn: "none" })
    // The browser paints the original upright from its EXIF orientation tag, so a
    // thumbnail that skipped this would show up sideways next to a straight original.
    .rotate()
    // Never enlarge: a 200px photo blown up to 400 is softness with nothing gained.
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}
