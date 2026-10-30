import { ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, Quality, StreamTarget, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { CappedOutput, VIDEO_POLICY, VideoPreparationError, planVideo, validateInputSize, type Policy } from './policy.js';
import { compressToneMappedVideo } from './tone-map.js';

/**
 * HDR is what an iPhone records unless the owner switches the camera to "Most Compatible".
 * Those files cannot use the direct transcode below (see `tone-map.ts`), so they are routed
 * to the canvas path before any of the SDR assumptions are applied. A file that cannot be
 * inspected at all falls through, so the normal path still produces its own precise error.
 */
async function needsToneMapping(file: File): Promise<boolean> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = (await input.getVideoTracks())[0];
    return video ? await video.hasHighDynamicRange() : false;
  } catch { return false; }
  finally { input.dispose(); }
}

export async function compressVideo(file: File, onProgress: (value: number) => void, policy: Policy = VIDEO_POLICY) {
  validateInputSize(file.size, policy);
  if (await needsToneMapping(file)) return compressToneMappedVideo(file, onProgress, policy);
  const started = performance.now();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let conversion: Conversion | undefined;
  try {
    const videos = await input.getVideoTracks(), audios = await input.getAudioTracks();
    if (videos.length !== 1 || audios.length > 1) throw new VideoPreparationError('unsupported_tracks', '请选择单画面、最多一条音轨的视频');
    const video = videos[0], audio = audios[0];
    const [width, height, duration, stats, hdr] = await Promise.all([
      video.getDisplayWidth(), video.getDisplayHeight(), input.computeDuration(), video.computeFrameRateMetrics(), video.hasHighDynamicRange(),
    ]);
    const original = { width, height, duration, frameRate: stats.bestGuessFrameRate, hdr, audio: !!audio, bytes: file.size };
    const plan = planVideo(original, policy);
    if (!await video.canDecode() || (audio && !await audio.canDecode())) throw new VideoPreparationError('decoder_unavailable', '这台设备不能解码这个视频或音轨。iPhone 默认的 HEVC 请用 Safari 打开 LifeOS 再传；或在 iPhone 的「设置 > 相机 > 格式」选「最兼容」后重新拍。');
    if (!await canEncodeVideo('avc', { width: plan.width, height: plan.height, frameRate: plan.frameRate, quality: new Quality({ bitrate: policy.videoBitrate }) })) {
      throw new VideoPreparationError('encoder_unavailable', '这台设备不能生成所需的 H.264 视频，请换一台设备或更新系统后再试');
    }
    if (audio && !await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, quality: new Quality({ bitrate: policy.audioBitrate }) })) {
      throw new VideoPreparationError('audio_encoder_unavailable', '这台设备的浏览器不能生成 AAC 音轨，已停止处理以保留声音。请换用 Safari 26 或更新版本的浏览器再试');
    }
    const buffer = new CappedOutput(policy.maxOutputBytes);
    const target = new StreamTarget(new WritableStream({ write: chunk => buffer.write(chunk.position, chunk.data) }), { chunked: true, chunkSize: 1024 * 1024 });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target });
    conversion = await Conversion.init({
      input, output,
      video: { width: plan.width, height: plan.height, frameRate: stats.maxFrameRate > policy.maxFrameRate + 0.1 ? policy.maxFrameRate : undefined, fit: 'contain', codec: 'avc', quality: new Quality({ bitrate: policy.videoBitrate }), forceTranscode: true, allowTransformationMetadata: false, keyFrameInterval: 2 },
      audio: { codec: 'aac', quality: new Quality({ bitrate: policy.audioBitrate }), sampleRate: 48000, numberOfChannels: 2 },
      showWarnings: false,
    });
    // isValid alone is insufficient: it can be true with the audio silently discarded.
    if (!conversion.isValid || conversion.discardedTracks.some(t => t.track.type === 'video' || t.track.type === 'audio')) {
      throw new VideoPreparationError('track_discarded', '转换无法完整保留视频和声音，已停止处理');
    }
    conversion.onProgress = value => onProgress(Math.min(0.99, Math.max(0, value)));
    await conversion.execute();
    const bytes = buffer.finish();
    if (!bytes.byteLength) throw new VideoPreparationError('empty_output', '没有生成有效视频');
    const check = new Input({ source: new BlobSource(new Blob([bytes], { type: 'video/mp4' })), formats: ALL_FORMATS });
    try {
      const resultVideo = await check.getPrimaryVideoTrack(), resultAudio = await check.getAudioTracks();
      if (!resultVideo || await resultVideo.getCodec() !== 'avc' || !!resultAudio.length !== !!audio
          || (resultAudio[0] && await resultAudio[0].getCodec() !== 'aac')) throw new VideoPreparationError('invalid_output', '输出视频或音轨校验失败');
      const resultWidth = await resultVideo.getDisplayWidth(), resultHeight = await resultVideo.getDisplayHeight(), resultDuration = await check.computeDuration();
      if (resultWidth !== plan.width || resultHeight !== plan.height || Math.abs(resultDuration - duration) > 0.25) throw new VideoPreparationError('invalid_output', '输出尺寸或时长校验失败');
      const outputFrameRate = await resultVideo.computeFrameRateMetrics({ targetPacketCount: Infinity });
      if (outputFrameRate.maxFrameRate > policy.maxFrameRate + 0.1) throw new VideoPreparationError('invalid_output', '输出帧率超过限制');
      onProgress(1);
      return { bytes, report: { original, output: { width: resultWidth, height: resultHeight, duration: resultDuration, frameRate: outputFrameRate.bestGuessFrameRate, maxFrameRate: outputFrameRate.maxFrameRate, bytes: bytes.byteLength, videoCodec: 'avc', audioCodec: audio ? 'aac' : null, container: 'fragmented-mp4' }, elapsedMs: performance.now() - started, savedPercent: (1 - bytes.byteLength / file.size) * 100 } };
    } finally { check.dispose(); }
  } finally {
    if (conversion && conversion.state !== 'done') await conversion.cancel().catch(() => {});
    input.dispose();
  }
}
