/** Shared limits for browser compression and API validation. Originals never leave the browser. */
export const VIDEO_LIMITS = Object.freeze({
  maxInputBytes: 200 * 1024 * 1024,
  maxDurationSeconds: 180,
  maxOutputBytes: 50 * 1024 * 1024,
  maxLongEdge: 1920,
  maxShortEdge: 1080,
  maxFrameRate: 30,
  videoBitrate: 2_000_000,
  audioBitrate: 96_000,
  maxLocalBytes: 1024 * 1024 * 1024,
});
