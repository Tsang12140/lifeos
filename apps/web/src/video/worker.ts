import { compressVideo } from './compress.js';
import { VIDEO_POLICY, VideoPreparationError } from './policy.js';
// One worker per conversion. Cancellation terminates this worker, releasing codec and buffer memory.
globalThis.addEventListener('message', async (event: MessageEvent) => {
  try {
    const result = await compressVideo(event.data.file, value => globalThis.postMessage({ type: 'progress', value }), event.data.policy ?? VIDEO_POLICY);
    (globalThis.postMessage as (message: unknown, transfer: Transferable[]) => void)({ type: 'done', ...result }, [result.bytes]);
  } catch (error) {
    // Anything that is not one of our own, already-worded failures is a library or codec error in
    // English. The owner gets a plain sentence; the detail stays in the console for us.
    if (!(error instanceof VideoPreparationError)) console.error("video conversion failed", error);
    globalThis.postMessage({
      type: 'error',
      code: error instanceof VideoPreparationError ? error.code : 'conversion_failed',
      message: error instanceof VideoPreparationError ? error.message : '视频处理失败，请重试或换一段视频',
    });
  }
});
