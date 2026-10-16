/**
 * Driving a photo-text pass from the settings panel.
 *
 * A whole library takes long enough that one request to read all of it is a request
 * that can be cut off, so the pass is run in slices and the panel counts along. The
 * loop is lifted out of the component because its stopping rules are the part that
 * can actually be wrong: a slice that makes no progress while work remains means the
 * recogniser is refusing, and a loop that ignores that either spins forever or hammers
 * a closed door. Neither is visible in a screenshot.
 */

/** Photos asked for per request. Small enough that a slice returns promptly. */
export const PHOTO_TEXT_SLICE_SIZE = 10;

/** A backstop, not a plan: the panel must never loop without end on a broken server. */
export const PHOTO_TEXT_MAX_SLICES = 60;

/** The fields the loop reads off a run's report. */
export interface PhotoTextSliceResult {
  readonly described: number;
  readonly noDescription: number;
  readonly remaining: number;
}

export interface PhotoTextRunOutcome {
  /** Photos the pass actually settled this run — written, or marked wordless. */
  readonly read: number;
  /** True when the pass stopped with work left because a slice moved nothing. */
  readonly stalled: boolean;
  readonly slices: number;
}

/**
 * Run slices until there is nothing left or nothing is moving.
 *
 * `moved === 0` counts a photo with no words in it (an empty marker) as progress: it is
 * an answer, and the next slice will not be asked about that picture again. What is
 * *not* progress is a slice that settles nothing at all while photos remain — that is a
 * refused request, and repeating it changes nothing, so the loop stops and says so.
 */
export async function runPhotoTextSlices(
  runSlice: (limit: number) => Promise<PhotoTextSliceResult>,
  onProgress?: (read: number) => void,
): Promise<PhotoTextRunOutcome> {
  let read = 0;
  for (let slice = 0; slice < PHOTO_TEXT_MAX_SLICES; slice += 1) {
    const result = await runSlice(PHOTO_TEXT_SLICE_SIZE);
    const moved = result.described + result.noDescription;
    read += moved;
    onProgress?.(read);
    if (result.remaining === 0) return { read, stalled: false, slices: slice + 1 };
    if (moved === 0) return { read, stalled: true, slices: slice + 1 };
  }
  return { read, stalled: true, slices: PHOTO_TEXT_MAX_SLICES };
}
