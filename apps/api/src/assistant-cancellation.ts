import { HttpError } from "./http-kit.js";

export function assertAssistantActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HttpError(499, "turn_cancelled", "已停止回答");
}

/** Also bounds providers that fail to honour fetch's signal. Late work is fenced before writes. */
export async function cancellableAssistant<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    assertAssistantActive(signal);
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new HttpError(499, "turn_cancelled", "已停止回答"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
