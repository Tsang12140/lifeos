import { VIDEO_POLICY, VideoPreparationError, validateInputSize, type Policy } from './policy.js';
import type { compressVideo } from './compress.js';
type Result = Awaited<ReturnType<typeof compressVideo>>;
export function compressInWorker(file: File, options: { signal?: AbortSignal; onProgress?: (value: number) => void; policy?: Policy; timeoutMs?: number } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const policy = options.policy ?? VIDEO_POLICY;
    try { validateInputSize(file.size, policy); } catch (error) { reject(error); return; }
    if (options.signal?.aborted) { reject(new DOMException('已取消视频处理', 'AbortError')); return; }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException('已取消视频处理', 'AbortError')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new VideoPreparationError('timeout', '处理超时，请缩短视频后再试')); }, options.timeoutMs ?? 600_000);
    worker.onmessage = event => {
      if (event.data.type === 'progress') options.onProgress?.(event.data.value);
      else if (event.data.type === 'done') { cleanup(); resolve({ bytes: event.data.bytes, report: event.data.report }); }
      else if (event.data.type === 'error') { cleanup(); reject(new VideoPreparationError(event.data.code, event.data.message)); }
    };
    worker.onerror = event => { cleanup(); reject(new VideoPreparationError('worker_failed', event.message || '视频处理线程无法运行')); };
    worker.postMessage({ file, policy });
  });
}
