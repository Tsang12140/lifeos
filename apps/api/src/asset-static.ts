import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { WriteStream } from "node:fs";
import type { Asset, StorageReference } from "@lifeos/core";
import type { ApiConfig } from "./config.js";
import type { SqliteRecordRepository } from "./repository.js";
import { HttpError } from "./http-kit.js";

export function shanghaiDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
}


export const SERVABLE_ASSET_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".heic",
  ".mp3", ".m4a", ".aac", ".ogg", ".wav",
  ".mp4", ".webm",
]);

/**
 * What a thumbnail can actually be built from. Narrower than what can be served:
 * HEIC is excluded because sharp's prebuilt libvips ships without libheif's HEIC
 * decoder, and a 500 on the timeline is worse than a large-but-working image.
 * Everything else here is a raster format libvips reads, GIF included — the first
 * frame is what a still thumbnail of an animation should be anyway.
 */
export const THUMBNAILABLE_ASSET_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

/**
 * One JSONL line per request, written to logs/api-YYYY-MM-DD.log next to the
 * data directory. Errors carry the reason; everything else is just
 * method/path/status/duration, so the file stays small and greppable.
 */
export const requestLog = (() => {
  const logDir = process.env.LIFEOS_LOG_DIR ?? resolve(process.env.LIFEOS_DATA_DIR ?? process.cwd(), "..", "logs");
  let cachedDate = "";
  let stream: WriteStream | undefined;
  return (status: number, method: string, path: string, startedAt: number, error?: string) => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (stream === undefined || cachedDate !== day) {
        mkdirSync(logDir, { recursive: true });
        stream = createWriteStream(resolve(logDir, `api-${day}.log`), { flags: "a" });
        cachedDate = day;
      }
      const line: Record<string, unknown> = {
        at: new Date().toISOString(),
        method,
        path,
        status,
        ms: Date.now() - startedAt,
      };
      if (error !== undefined) line.error = error;
      stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      // Logging must never take the API down with it.
    }
  };
})();

export const ASSET_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * Accepted photo types for uploads. The declared media type picks the stored
 * extension; a sniff of the leading bytes then has to agree with it, so a text
 * file renamed to `.jpg` never reaches the disk. HEIC is deliberately absent:
 * browsers cannot render it, and a thumbnail nobody can see is worse than a
 * clear rejection.
 */
export const ASSET_UPLOAD_FORMATS: Readonly<Record<string, { readonly extension: string; readonly matches: (bytes: Buffer) => boolean }>> = {
  "image/jpeg": { extension: ".jpg", matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/png": { extension: ".png", matches: (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { extension: ".webp", matches: (bytes) => bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP" },
  "image/gif": { extension: ".gif", matches: (bytes) => bytes.length >= 6 && (bytes.toString("latin1", 0, 6) === "GIF87a" || bytes.toString("latin1", 0, 6) === "GIF89a") },
  "image/avif": { extension: ".avif", matches: (bytes) => bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp" && (bytes.toString("latin1", 8, 12) === "avif" || bytes.toString("latin1", 8, 12) === "avis") },
};

/** `image/jpeg; charset=binary` still means `image/jpeg`. */
export function baseMediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Keeps the name a person recognises, minus anything that could steer a path.
 * The stored file is named by its content hash; this is metadata for display only.
 */
export function uploadOriginalName(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "").trim();
  return cleaned.length === 0 ? undefined : Array.from(cleaned).slice(0, 120).join("");
}

/**
 * Writes one dropped photo under `<assetRoot>/uploads/YYYY/MM/`, dated in
 * Shanghai so a photo taken late at night lands in the folder its owner
 * expects. The file name is the picture's own sha256 — the same digest the
 * asset row carries — which is what makes the path content-addressed: the same
 * bytes can only ever land at one path, so "do I already have this picture?"
 * is answered by the name rather than by a scan. Nothing from the request
 * reaches the path, so a hostile original name is still harmless.
 *
 * A file already sitting at the target path is left untouched. The caller
 * checks the asset table for this digest first, so an existing file means the
 * same bytes written by an earlier run that died before its row landed:
 * rewriting it gains nothing, and `wx` would report that as a collision.
 * Only files written from here on are named this way — the rows already in the
 * database keep their UUID paths, and nothing moves them.
 */
export function storeUploadedPhoto(root: string, bytes: Buffer, format: { readonly extension: string }, digest: string): string {
  const day = shanghaiDateKey(new Date());
  const relativeDirectory = `uploads/${day.slice(0, 4)}/${day.slice(5, 7)}`;
  const directory = resolve(root, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  const fileName = `${digest}${format.extension}`;
  const target = resolve(directory, fileName);
  if (!existsSync(target)) {
    // `wx` refuses to overwrite: a racing writer must not be able to eat a photo,
    // and losing that race is the same "the bytes are already there" answer.
    try {
      writeFileSync(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
  }
  return `${relativeDirectory}/${fileName}`;
}

/**
 * Resolves an asset reference inside the configured asset root. Both sides are
 * realpath'd first so a symlink cannot walk out of the root, and only media
 * files are served at all. The original is read in place; LifeOS never copies it.
 */
export function resolveLocalAsset(root: string, sourceRef: string): { file: string; mediaType: string } {
  if (sourceRef.includes("\0")) throw new HttpError(400, "invalid_reference", "Invalid asset reference");
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    throw new HttpError(404, "asset_root_missing", "LIFEOS_ASSET_ROOT does not exist");
  }
  let realFile: string;
  try {
    realFile = realpathSync(resolve(realRoot, sourceRef));
  } catch {
    throw new HttpError(404, "asset_file_missing", "The referenced original is not available");
  }
  const relativePath = relative(realRoot, realFile);
  if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new HttpError(403, "asset_outside_root", "Asset reference points outside LIFEOS_ASSET_ROOT");
  }
  const extension = extname(realFile).toLowerCase();
  if (!SERVABLE_ASSET_EXTENSIONS.has(extension)) {
    throw new HttpError(415, "unsupported_asset_type", "Only image, audio and video originals can be served");
  }
  if (!statSync(realFile).isFile()) throw new HttpError(404, "asset_file_missing", "The referenced original is not available");
  return { file: realFile, mediaType: ASSET_MEDIA_TYPES[extension] ?? "application/octet-stream" };
}

/**
 * The local original behind an asset id, or the reason there is none. Both the
 * content route and the thumbnail route need exactly this chain, and the errors are
 * the same either way: no root configured, no local reference, file gone.
 */
export function resolveAssetOriginal(config: ApiConfig, repository: SqliteRecordRepository, id: string): { readonly reference: StorageReference; readonly file: string; readonly mediaType: string } {
  const asset = repository.findAssetById(id);
  if (asset === null) throw new HttpError(404, "not_found", "Asset not found");
  if (config.assetRoot === undefined) {
    throw new HttpError(404, "asset_root_not_configured", "Set LIFEOS_ASSET_ROOT to serve local originals");
  }
  const reference = asset.storageRefs.find((ref) => ref.sourceId === "local");
  if (reference === undefined) throw new HttpError(404, "not_a_local_asset", "Asset has no local reference");
  return { reference, ...resolveLocalAsset(config.assetRoot, reference.sourceRef) };
}
