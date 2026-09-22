import type { IncomingMessage } from "node:http";
import { HttpError } from "./http-kit.js";

export async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, "invalid_content_length", "Invalid Content-Length");
    if (length > limit) throw new HttpError(413, "body_too_large", "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "body_too_large", "Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
export function requireJsonContentType(req: IncomingMessage, allowEmpty = false): void {
  const contentType = req.headers["content-type"];
  if (allowEmpty && contentType === undefined) return;
  if (contentType === undefined || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new HttpError(415, "unsupported_media_type", "Write requests require application/json");
  }
}
export async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const raw = await readRawBody(req, limit);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}
