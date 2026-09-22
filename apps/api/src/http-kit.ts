import type { ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function backupHttpError(error: unknown): HttpError {
  return error instanceof HttpError
    ? error
    : new HttpError(502, "backup_failed", error instanceof Error ? error.message : "备份失败");
}

export function setJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function setEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, extraHeaders);
  res.end();
}
