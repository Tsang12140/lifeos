import test from "node:test";
import assert from "node:assert/strict";
import { uploadRequest } from "../src/upload-request.ts";

class FakeXhr extends EventTarget {
  readonly upload = new EventTarget();
  status = 0;
  responseText = "";
  opened: { method: string; url: string; async: boolean } | null = null;
  readonly headers = new Map<string, string>();
  sent: Document | Blob | null = null;
  aborted = false;

  open(method: string, url: string, async: boolean) { this.opened = { method, url, async }; }
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  send(body: Document | XMLHttpRequestBodyInit | null) { this.sent = body as Blob; }
  abort() { this.aborted = true; this.dispatchEvent(new Event("abort")); }
  progress(loaded: number, total: number) {
    const event = Object.assign(new Event("progress"), { loaded, total, lengthComputable: true });
    this.upload.dispatchEvent(event);
  }
  uploadComplete() { this.upload.dispatchEvent(new Event("load")); }
  respond(status: number, payload: unknown) {
    this.status = status;
    this.responseText = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.dispatchEvent(new Event("load"));
  }
}

function hooks(logs: string[] = []) {
  return {
    createError(message: string, status?: number) {
      const error = new Error(message) as Error & { status?: number };
      if (status !== undefined) error.status = status;
      return error;
    },
    logFailure(request: string, status: number, message: string) { logs.push(`${request} ${status} ${message}`); },
  };
}

test("upload byte progress can reach 100% before the server confirms success", async () => {
  const xhr = new FakeXhr();
  const progress: { loaded: number; total: number }[] = [];
  const body = new Blob(["jpeg bytes"], { type: "image/jpeg" });
  let settled = false;
  const request = uploadRequest<{ id: string }>("/api/assets/uploads?name=photo.jpg", body, {
    contentType: body.type,
    onProgress: (event) => progress.push(event),
  }, hooks(), () => xhr as unknown as XMLHttpRequest).then((value) => { settled = true; return value; });

  assert.deepEqual(xhr.opened, { method: "POST", url: "/api/assets/uploads?name=photo.jpg", async: true });
  assert.equal(xhr.headers.get("Accept"), "application/json");
  assert.equal(xhr.headers.get("Content-Type"), "image/jpeg");
  assert.equal(xhr.sent, body);

  xhr.progress(4, 10);
  xhr.progress(10, 10);
  xhr.uploadComplete();
  await Promise.resolve();
  assert.deepEqual(progress, [{ loaded: 4, total: 10 }, { loaded: 10, total: 10 }, { loaded: body.size, total: body.size }]);
  assert.equal(settled, false, "upload.load only means the request body finished transferring");

  xhr.respond(201, { id: "asset-1" });
  assert.deepEqual(await request, { id: "asset-1" });
  assert.equal(settled, true);
});

test("upload HTTP failure uses API error details and logs the failed request", async () => {
  const xhr = new FakeXhr();
  const logs: string[] = [];
  const request = uploadRequest("/api/assets/uploads?name=bad.jpg", new Blob(["x"], { type: "image/jpeg" }), {}, hooks(logs), () => xhr as unknown as XMLHttpRequest);
  xhr.respond(503, { message: "asset store unavailable" });
  let failure: (Error & { status?: number }) | null = null;
  try { await request; } catch (error) { failure = error as Error & { status?: number }; }
  assert.equal(failure?.message, "asset store unavailable");
  assert.equal(failure?.status, 503);
  assert.deepEqual(logs, ["POST /api/assets/uploads?name=bad.jpg 503 asset store unavailable"]);
});

test("aborting an upload rejects as AbortError without logging a server failure", async () => {
  const xhr = new FakeXhr();
  const logs: string[] = [];
  const controller = new AbortController();
  const request = uploadRequest("/api/assets/uploads?name=cancel.jpg", new Blob(["x"], { type: "image/jpeg" }), { signal: controller.signal }, hooks(logs), () => xhr as unknown as XMLHttpRequest);
  controller.abort();
  let failure: Error | null = null;
  try { await request; } catch (error) { failure = error as Error; }
  assert.equal(xhr.aborted, true);
  assert.equal(failure?.name, "AbortError");
  assert.deepEqual(logs, []);
});
