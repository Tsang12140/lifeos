export interface ApiUploadProgress {
  readonly loaded: number;
  readonly total: number;
}

export interface UploadRequestOptions {
  readonly contentType?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ApiUploadProgress) => void;
}

export interface UploadRequestHooks {
  readonly createError: (message: string, status?: number) => Error;
  readonly logFailure: (request: string, status: number, message: string) => void;
}

/**
 * XHR transport kept separate so byte progress and response completion can be
 * tested without mounting the app or changing the upload API route.
 */
export function uploadRequest<T>(
  path: string,
  body: Blob,
  options: UploadRequestOptions,
  hooks: UploadRequestHooks,
  makeRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = makeRequest();
    let settled = false;
    const abortError = (): Error => typeof DOMException === "undefined"
      ? Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
      : new DOMException("The operation was aborted", "AbortError");
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abortFromSignal);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const reportProgress = (loaded: number, total: number) => {
      const safeTotal = Math.max(0, total || body.size);
      options.onProgress?.({ loaded: Math.min(Math.max(0, loaded), safeTotal), total: safeTotal });
    };
    const abortFromSignal = () => xhr.abort();
    const responseError = (status: number, raw: string): string => {
      let message = `请求失败（${status}）`;
      try {
        const payload = JSON.parse(raw) as { message?: unknown; error?: unknown };
        if (typeof payload.message === "string" && payload.message.trim()) message = payload.message;
        else if (typeof payload.error === "string" && payload.error.trim()) message = payload.error;
      } catch {
        // A non-JSON error still receives a useful status message.
      }
      return message;
    };

    if (options.signal?.aborted) {
      finish(abortError());
      return;
    }

    // Upload listeners must be registered before send. This event only means
    // the body finished transferring; the HTTP response still decides success.
    xhr.upload.addEventListener("progress", (event) => {
      reportProgress(event.loaded, event.lengthComputable ? event.total : body.size);
    });
    xhr.upload.addEventListener("load", () => reportProgress(body.size, body.size));
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = responseError(xhr.status, xhr.responseText);
        hooks.logFailure(`POST ${path}`, xhr.status, message);
        finish(hooks.createError(message, xhr.status));
        return;
      }
      if (xhr.status === 204) {
        finish(undefined, undefined as T);
        return;
      }
      try {
        finish(undefined, JSON.parse(xhr.responseText) as T);
      } catch {
        finish(hooks.createError("上传响应无法读取", xhr.status));
      }
    });
    xhr.addEventListener("error", () => {
      const message = "无法连接 LifeOS API";
      hooks.logFailure(`POST ${path}`, xhr.status, message);
      finish(hooks.createError(message, xhr.status));
    });
    xhr.addEventListener("timeout", () => {
      const message = "照片上传超时，请重试";
      hooks.logFailure(`POST ${path}`, xhr.status, message);
      finish(hooks.createError(message, xhr.status));
    });
    xhr.addEventListener("abort", () => finish(abortError()));
    options.signal?.addEventListener("abort", abortFromSignal, { once: true });

    try {
      xhr.open("POST", path, true);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("Content-Type", options.contentType || body.type || "application/octet-stream");
      xhr.send(body);
    } catch (error) {
      finish(error instanceof Error ? error : hooks.createError("照片上传失败"));
    }
  });
}
