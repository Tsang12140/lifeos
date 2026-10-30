import {
  ALL_FORMATS, BlobSource, CanvasSink, CanvasSource, EncodedAudioPacketSource, EncodedPacketSink,
  Input, Mp4OutputFormat, Output, Quality, StreamTarget, canEncodeVideo,
} from 'mediabunny';
import { CappedOutput, VIDEO_POLICY, VideoPreparationError, planVideo, validateInputSize, type Policy } from './policy.js';

/**
 * The second video path, used only for HDR (which is what an iPhone records by default).
 *
 * The plain transcode in `compress.ts` hands decoded frames straight to the encoder. That is
 * fine for SDR, and wrong for HDR: the encoder keeps PQ/HLG sample values while the MP4 claims
 * BT.709, so the clip plays back washed out. Here every decoded frame makes a round trip through
 * a 2D canvas first, where the browser performs the colour conversion plus tone mapping into
 * sRGB. Only then does it get encoded as ordinary H.264.
 *
 * Audio is copied as encoded packets instead of being decoded and re-encoded. That keeps the
 * original sound untouched and, more importantly, removes the need for `AudioEncoder`, which
 * Safari only gained in 26 — an iPhone on 17/18 can tone-map video but cannot encode AAC.
 */
const MESSAGES = {
  decoder: '这台设备不能解码这个视频。iPhone 默认的 HEVC 请用 Safari 打开 LifeOS 再传；或在 iPhone 的「设置 > 相机 > 格式」选「最兼容」后重新拍。',
  encoder: '这台设备不能生成 H.264 视频，请换一台设备或更新系统后再试',
  audio: '这段视频的声音不是 AAC 编码，浏览器里暂时无法转换。请先在相册或剪辑 App 里导出为 MP4 再试。',
  canvas: '当前浏览器无法创建视频画布，请换用 Safari 或 Chrome 再试',
};

export async function compressToneMappedVideo(file: File, onProgress: (value: number) => void, policy: Policy = VIDEO_POLICY) {
  validateInputSize(file.size, policy);
  const started = performance.now();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output: Output | undefined;
  try {
    const videos = await input.getVideoTracks(), audios = await input.getAudioTracks();
    if (videos.length !== 1 || audios.length > 1) throw new VideoPreparationError('unsupported_tracks', '请选择单画面、最多一条音轨的视频');
    const video = videos[0]!, audio = audios[0];
    const [width, height, duration, stats, hdr] = await Promise.all([
      video.getDisplayWidth(), video.getDisplayHeight(), input.computeDuration(), video.computeFrameRateMetrics(), video.hasHighDynamicRange(),
    ]);
    const original = { width, height, duration, frameRate: stats.bestGuessFrameRate, hdr, audio: !!audio, bytes: file.size };
    const plan = planVideo(original, policy);
    if (!await video.canDecode()) throw new VideoPreparationError('decoder_unavailable', MESSAGES.decoder);
    if (!await canEncodeVideo('avc', { width: plan.width, height: plan.height, frameRate: plan.frameRate, quality: new Quality({ bitrate: policy.videoBitrate }) })) {
      throw new VideoPreparationError('encoder_unavailable', MESSAGES.encoder);
    }
    const audioCodec = audio ? await audio.getCodec() : null;
    if (audio && (audioCodec !== 'aac' || !await audio.canDecode())) throw new VideoPreparationError('audio_codec_unsupported', MESSAGES.audio);

    const canvas = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(plan.width, plan.height);
    const context = canvas?.getContext("2d", { alpha: false }) ?? null;
    if (canvas === null || context === null) throw new VideoPreparationError('canvas_unavailable', MESSAGES.canvas);

    const buffer = new CappedOutput(policy.maxOutputBytes);
    const target = new StreamTarget(new WritableStream({ write: chunk => buffer.write(chunk.position, chunk.data) }), { chunked: true, chunkSize: 1024 * 1024 });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target });
    const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: policy.videoBitrate }), keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: plan.frameRate });
    const audioSource = audio ? new EncodedAudioPacketSource('aac') : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    // Audio packets run alongside the frames: the muxer interleaves by timestamp, so waiting for
    // the whole video first would deadlock it while it waits for the audio track to catch up.
    const copyAudio = (async () => {
      if (!audio || !audioSource) return;
      const config = await audio.getDecoderConfig();
      let first = true;
      for await (const packet of new EncodedPacketSink(audio).packets()) {
        await audioSource.add(packet, first && config ? { decoderConfig: config } : undefined);
        first = false;
      }
    })();

    const sink = new CanvasSink(video, { width: plan.width, height: plan.height, fit: 'contain' });
    const step = 1 / plan.frameRate;
    let nextAt = 0;
    try {
      for await (const frame of sink.canvases()) {
        // A 60 fps clip is capped to the plan's frame rate; encoding every source frame would
        // spend bitrate on frames the plan already decided to drop.
        if (frame.timestamp + 1e-6 < nextAt) continue;
        context.drawImage(frame.canvas, 0, 0, plan.width, plan.height);
        await source.add(frame.timestamp, frame.duration);
        nextAt = frame.timestamp + step;
        if (duration > 0) onProgress(Math.min(0.98, Math.max(0, frame.timestamp / duration)));
      }
      await copyAudio;
    } catch (error) {
      void copyAudio.catch(() => undefined);
      throw error;
    }
    await output.finalize();
    onProgress(1);
    const bytes = buffer.finish();
    if (!bytes.byteLength) throw new VideoPreparationError('empty_output', '没有生成有效视频');

    const check = new Input({ source: new BlobSource(new Blob([bytes], { type: 'video/mp4' })), formats: ALL_FORMATS });
    try {
      const resultVideo = await check.getPrimaryVideoTrack(), resultAudio = await check.getAudioTracks();
      if (!resultVideo || await resultVideo.getCodec() !== 'avc' || !!resultAudio.length !== !!audio
        || (resultAudio[0] && await resultAudio[0].getCodec() !== 'aac')) throw new VideoPreparationError('invalid_output', '输出视频或音轨校验失败');
      const resultWidth = await resultVideo.getDisplayWidth(), resultHeight = await resultVideo.getDisplayHeight(), resultDuration = await check.computeDuration();
      if (resultWidth !== plan.width || resultHeight !== plan.height || Math.abs(resultDuration - duration) > 0.5) throw new VideoPreparationError('invalid_output', '输出尺寸或时长校验失败');
      const outputFrameRate = await resultVideo.computeFrameRateMetrics({ targetPacketCount: Infinity });
      if (outputFrameRate.maxFrameRate > policy.maxFrameRate + 0.1) throw new VideoPreparationError('invalid_output', '输出帧率超过限制');
      return {
        bytes,
        report: {
          original,
          output: {
            width: resultWidth, height: resultHeight, duration: resultDuration,
            frameRate: outputFrameRate.bestGuessFrameRate, maxFrameRate: outputFrameRate.maxFrameRate,
            bytes: bytes.byteLength, videoCodec: 'avc', audioCodec: audio ? 'aac' : null, container: 'fragmented-mp4',
          },
          elapsedMs: performance.now() - started,
          savedPercent: (1 - bytes.byteLength / file.size) * 100,
          toneMapped: true,
        },
      };
    } finally { check.dispose(); }
  } finally {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    input.dispose();
  }
}
