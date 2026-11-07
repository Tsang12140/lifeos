import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../http-kit.js";
import { withDeadline } from "./volume-probe.js";

/**
 * Why this file exists at all: `apps/api/src/routes-assets.ts` answers with the
 * whole body and declares no `Accept-Ranges` (grep for `Range` / `206` there —
 * zero hits). On a local SSD that is invisible; over SMB an 800MB video would
 * restart from byte zero every time the owner drags the scrubber.
 *
 * The volume module therefore ships its own byte-range server instead of
 * changing the shared one, which is what keeps this module removable.
 */

const STAT_DEADLINE_MS = 1_500;

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function mediaTypeOf(file: string): string | null {
  return MEDIA_TYPES[extname(file).toLowerCase()] ?? null;
}

export type ByteRange = { readonly start: number; readonly end: number };

/** `null` = serve the whole file; `"invalid"` = answer 416. */
export function parseByteRange(header: string | undefined, size: number): ByteRange | "invalid" | null {
  if (header === undefined || header.trim() === "") return null;
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (match === null) return "invalid";
  const parts = match[1]!.split(",");
  if (parts.length !== 1) return "invalid";
  const [rawStart, rawEnd] = parts[0]!.trim().split("-");
  if (rawStart === undefined) return "invalid";

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0 || start >= size) return "invalid";
  const end = rawEnd === undefined || rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isInteger(end) || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

async function pipe(out: ServerResponse, file: string, range: ByteRange | undefined): Promise<void> {
  const stream = createReadStream(file, range === undefined ? {} : { start: range.start, end: range.end });
  // A closed tab or a seek aborts the response; the stream must not outlive it.
  const abandon = () => { stream.destroy(); };
  out.once("close", abandon);
  try {
    await pipeline(stream, out);
  } catch {
    // Client went away mid-transfer. Nothing to report and nothing to retry.
  } finally {
    out.off("close", abandon);
  }
}

/**
 * Sends one file from the volume, honouring `Range`. Assumes the caller has
 * already established that the volume is online; a missing file here really
 * means the file is missing, which is why it answers 404 rather than
 * `volume_offline` (that distinction is made one level up).
 */
export async function sendVolumeFile(absolutePath: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mediaType = mediaTypeOf(absolutePath);
  if (mediaType === null) throw new HttpError(415, "unsupported_media", "这种文件不能直接播放，请用系统播放器打开");

  let info;
  try {
    info = await withDeadline(stat(absolutePath), STAT_DEADLINE_MS);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") throw new HttpError(404, "file_missing", "这个文件不在这块盘上");
    throw new HttpError(503, "volume_slow", "硬盘响应超时，稍后再试");
  }
  if (!info.isFile()) throw new HttpError(404, "file_missing", "这个路径不是文件");

  const size = info.size;
  const range = parseByteRange(req.headers.range, size);
  if (range === "invalid") {
    res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes", "cache-control": "no-store" });
    res.end();
    return;
  }

  const headers: Record<string, string> = {
    "content-type": mediaType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=60",
  };

  if (range === null) {
    res.writeHead(200, { ...headers, "content-length": String(size) });
    if (req.method === "HEAD") { res.end(); return; }
    await pipe(res, absolutePath, undefined);
    return;
  }

  res.writeHead(206, {
    ...headers,
    "content-length": String(range.end - range.start + 1),
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
  });
  if (req.method === "HEAD") { res.end(); return; }
  await pipe(res, absolutePath, range);
}
