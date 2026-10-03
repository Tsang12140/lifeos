import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PoolUsage {
  readonly consumer: string;
  readonly storage_used: number;
  readonly storage_limit: number;
  readonly storage_free: number;
  readonly traffic_month: string;
  readonly traffic_used: number;
  readonly traffic_limit: number;
  readonly traffic_free: number;
}

export type PoolOperation = "usage" | "put" | "download" | "delete";
export const POOL_SOURCE_ID = "lifeos-pool";

export class StoragePoolError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status = 503,
    public readonly pendingKey?: string,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = "StoragePoolError";
  }
}

interface WorkerSuccess<T> { readonly ok: true; readonly result: T; }
interface WorkerFailure { readonly ok: false; readonly error: { readonly code: string; readonly pendingKey?: string }; }
type WorkerResponse<T> = WorkerSuccess<T> | WorkerFailure;

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.LIFEOS_STORAGE_POOL_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function workerScriptPath(env: NodeJS.ProcessEnv): string {
  const configured = env.LIFEOS_POOL_WORKER_PATH?.trim();
  if (configured) return resolve(configured);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../php/pool-consumer-worker.php"),
    resolve(moduleDirectory, "../../php/pool-consumer-worker.php"),
    resolve(process.cwd(), "apps/api/php/pool-consumer-worker.php"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function validUsage(value: unknown): value is PoolUsage {
  if (value === null || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.consumer === "string" &&
    Number.isSafeInteger(usage.storage_used) && Number.isSafeInteger(usage.storage_limit) &&
    Number.isSafeInteger(usage.storage_free) && typeof usage.traffic_month === "string" &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(usage.traffic_month) && Number.isSafeInteger(usage.traffic_used) &&
    Number.isSafeInteger(usage.traffic_limit) && Number.isSafeInteger(usage.traffic_free) &&
    [usage.storage_used, usage.storage_limit, usage.storage_free, usage.traffic_used, usage.traffic_limit, usage.traffic_free].every((entry) => Number(entry) >= 0);
}

export class PoolConsumerBridge {
  readonly #env: NodeJS.ProcessEnv;
  readonly #enabled: boolean;
  readonly #consumer: string;
  readonly #phpBinary: string;
  readonly #workerPath: string;

  public constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
    this.#enabled = isEnabled(env);
    this.#consumer = env.LIFEOS_POOL_CONSUMER?.trim() || "2";
    this.#phpBinary = env.LIFEOS_POOL_PHP_BINARY?.trim() || "php";
    this.#workerPath = workerScriptPath(env);
  }

  public get enabled(): boolean { return this.#enabled; }
  public get consumer(): string { return this.#consumer; }

  public async usage(): Promise<PoolUsage> {
    const result = await this.#invoke<PoolUsage>({ op: "usage" }, 30_000);
    if (!validUsage(result) || result.consumer !== this.#consumer) {
      throw new StoragePoolError("pool_usage_invalid", "存储池用量暂时无法验证");
    }
    return result;
  }

  public putFile(path: string, name: string, mime: string): Promise<{ readonly key: string }> {
    return this.#invoke<{ readonly key: string }>({ op: "put", path, name, mime }, 180_000).then((result) => {
      if (typeof result?.key !== "string" || result.key.length === 0) throw new StoragePoolError("pool_upload_invalid_response", "存储池上传状态待核对", 503, undefined, true);
      return result;
    });
  }

  public downloadToFile(key: string, path: string): Promise<{ readonly month: string; readonly bytes: number }> {
    return this.#invoke<{ readonly month: string; readonly bytes: number }>({ op: "download", key, path }, 1_800_000).then((result) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result?.month ?? "") || !Number.isSafeInteger(result?.bytes) || Number(result?.bytes) < 0) {
        throw new StoragePoolError("pool_download_invalid_response", "存储池下载已完成但计量状态待核对", 503, undefined, true);
      }
      return result;
    });
  }

  public delete(key: string): Promise<{ readonly deleted: true }> {
    return this.#invoke<{ readonly deleted: true }>({ op: "delete", key }, 180_000).then((result) => {
      if (result?.deleted !== true) throw new StoragePoolError("pool_delete_invalid_response", "存储池删除状态待核对", 503, undefined, true);
      return result;
    });
  }

  async #invoke<T>(input: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!this.#enabled) throw new StoragePoolError("storage_pool_disabled", "存储池接入尚未启用");
    const workerPath = this.#workerPath;
    if (!existsSync(workerPath)) throw new StoragePoolError("pool_worker_missing", "存储池 PHP 适配器不可用");

    return await new Promise<T>((resolvePromise, rejectPromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(this.#phpBinary, [workerPath], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // Do not pass the LifeOS environment wholesale. PHP only receives the
        // executable search path and the project ID; storage.php stays on disk.
        env: {
          ...(this.#env.PATH ? { PATH: this.#env.PATH } : {}),
          ...(this.#env.SYSTEMROOT ? { SYSTEMROOT: this.#env.SYSTEMROOT } : {}),
          ...(this.#env.TMP ? { TMP: this.#env.TMP } : {}),
          ...(this.#env.TEMP ? { TEMP: this.#env.TEMP } : {}),
          ...(this.#env.TMPDIR ? { TMPDIR: this.#env.TMPDIR } : {}),
          LIFEOS_POOL_CONSUMER: this.#consumer,
        },
      });
      const finishError = (error: StoragePoolError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      };
      const timer = setTimeout(() => {
        child.kill();
        finishError(new StoragePoolError("pool_worker_timeout", "存储池操作超时，操作状态待核对", 503, undefined, input.op !== "usage"));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > 1_048_576) {
          child.kill();
          finishError(new StoragePoolError("pool_worker_output_limit", "存储池适配器返回内容过大", 503, undefined, input.op !== "usage"));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
      });
      child.stdin.on("error", () => finishError(new StoragePoolError("pool_worker_pipe_failed", "存储池适配器未能接收请求，操作状态待核对", 503, undefined, input.op !== "usage")));
      child.on("error", () => finishError(new StoragePoolError("pool_worker_unavailable", "本机 PHP CLI 或存储池适配器不可用", 503, undefined, input.op !== "usage")));
      child.on("close", (code) => {
        if (settled) return;
        clearTimeout(timer);
        let response: WorkerResponse<T>;
        try { response = JSON.parse(stdout.trim()) as WorkerResponse<T>; }
        catch {
          settled = true;
          // stderr is intentionally not included: PHP diagnostics can contain
          // private filesystem paths and must never enter API logs or replies.
          rejectPromise(new StoragePoolError("pool_worker_invalid_response", code === 0 ? "存储池适配器响应无效" : "存储池操作失败", 503, undefined, input.op !== "usage"));
          return;
        }
        settled = true;
        if (!response.ok) {
          const errorCode = response.error?.code || "pool_operation_failed";
          const status = errorCode === "quota_exceeded" ? 409 : errorCode === "download_rejected" ? 404 : errorCode === "download_failed_refunded" ? 502 : 503;
          const uncertain = input.op !== "usage" && !["quota_exceeded", "download_rejected", "download_failed_refunded", "invalid_request", "invalid_temp_file", "unsupported_operation", "invalid_consumer_id", "consumer_mismatch", "consumer_layer_outdated", "private_storage_unavailable", "consumer_layer_unavailable"].includes(errorCode);
          rejectPromise(new StoragePoolError(errorCode, errorCode === "quota_exceeded" ? "项目存储池额度不足" : "存储池操作失败", status, response.error?.pendingKey, uncertain));
          return;
        }
        resolvePromise(response.result);
      });
      try { child.stdin.end(JSON.stringify(input)); }
      catch { finishError(new StoragePoolError("pool_worker_pipe_failed", "存储池适配器未能接收请求，操作状态待核对", 503, undefined, input.op !== "usage")); }
    });
  }
}

export function createPoolConsumerBridge(env: NodeJS.ProcessEnv = process.env): PoolConsumerBridge {
  return new PoolConsumerBridge(env);
}
