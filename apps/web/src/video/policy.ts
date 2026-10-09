import { VIDEO_LIMITS } from "@lifeos/core";
export const VIDEO_POLICY = VIDEO_LIMITS;
export type Policy = typeof VIDEO_POLICY;
export class VideoPreparationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function validateInputSize(size: number, policy: Policy): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new VideoPreparationError('empty_input', '请选择非空的视频文件');
  if (size > policy.maxInputBytes) throw new VideoPreparationError('input_too_large', '原片超过200 MB，请先裁剪视频');
}
export function planVideo(meta: { width: number; height: number; duration: number; frameRate: number; hdr: boolean }, policy: Policy) {
  if (![meta.width, meta.height, meta.duration, meta.frameRate].every(n => Number.isFinite(n) && n > 0)
      || meta.width < 2 || meta.height < 2) throw new VideoPreparationError('invalid_metadata', '无法可靠读取视频尺寸、时长或帧率');
  if (meta.duration > policy.maxDurationSeconds) throw new VideoPreparationError('duration_too_long', '视频超过3分钟，请先裁剪视频');
  // HDR needs an explicitly verified tone-mapping path. Never silently wash out iPhone footage.
  if (meta.hdr) throw new VideoPreparationError('hdr_needs_validation', '暂不支持HDR视频，请先在相册中导出普通色彩版本');
  const scale = Math.min(1, policy.maxLongEdge / Math.max(meta.width, meta.height), policy.maxShortEdge / Math.min(meta.width, meta.height));
  return {
    width: Math.max(2, Math.floor(meta.width * scale / 2) * 2),
    height: Math.max(2, Math.floor(meta.height * scale / 2) * 2),
    frameRate: Math.min(meta.frameRate, policy.maxFrameRate),
  };
}

/** Random-access MP4 writes, capped before allocating. At most output cap plus final assembly,
 * excluding codec/frame/library memory. Does not load the original file into an ArrayBuffer. */
export class CappedOutput {
  private readonly blocks = new Map<number, Uint8Array<ArrayBuffer>>();
  private readonly blockSize = 64 * 1024;
  private length = 0;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  write(position: number, bytes: Uint8Array): void {
    const end = position + bytes.byteLength;
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(end) || end > this.limit) {
      throw new VideoPreparationError('output_too_large', '压缩结果超过大小限制，请缩短视频');
    }
    for (let offset = 0; offset < bytes.length;) {
      const absolute = position + offset, index = Math.floor(absolute / this.blockSize), inner = absolute % this.blockSize;
      let block = this.blocks.get(index);
      if (!block) { block = new Uint8Array(Math.min(this.blockSize, this.limit - index * this.blockSize)); this.blocks.set(index, block); }
      const count = Math.min(bytes.length - offset, block.length - inner);
      block.set(bytes.subarray(offset, offset + count), inner); offset += count;
    }
    this.length = Math.max(this.length, end);
  }
  finish(): ArrayBuffer {
    const result = new Uint8Array(this.length);
    for (const [index, block] of this.blocks) result.set(block.subarray(0, Math.min(block.length, this.length - index * this.blockSize)), index * this.blockSize);
    this.blocks.clear();
    return result.buffer;
  }
}
