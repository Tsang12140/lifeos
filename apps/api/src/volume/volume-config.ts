import { isAbsolute, relative, resolve } from "node:path";

/**
 * The whole volume module is optional and removable. Nothing here touches
 * `ApiConfig`: a missing `LIFEOS_VOLUME_ROOT` simply means the feature is off,
 * which keeps the main project unaware that this directory exists.
 */
export interface VolumeConfig {
  /**
   * Absolute path to the shared folder. A mapped drive (`Z:\lifeos-assets`) is
   * the supported form — same idea as pointing a chat app's storage folder at a
   * drive letter. Caveat recorded in `docs/收藏模块-设计方案.md`: a drive letter
   * belongs to the interactive user session, so the process must keep starting
   * the way the owner starts it today (`启动预览.cmd`). Started as a Windows
   * service or a "run whether user is logged on" task, the mapping is invisible
   * and the volume reads as offline.
   */
  readonly root: string;
  /** Covers and thumbnails live on local disk; the volume may disappear at any moment. */
  readonly cacheDirectory: string;
}

export function readVolumeConfig(): VolumeConfig | null {
  const root = process.env.LIFEOS_VOLUME_ROOT?.trim();
  if (root === undefined || root === "") return null;
  const dataDirectory = process.env.LIFEOS_DATA_DIR?.trim() || "data";
  const cache = process.env.LIFEOS_VOLUME_CACHE?.trim();
  return {
    root: resolve(root),
    cacheDirectory: resolve(cache === undefined || cache === "" ? resolve(dataDirectory, "volume-cache") : cache),
  };
}

/**
 * True only for a relative path that stays inside the volume root.
 *
 * Deliberately implemented without `realpath`: on SMB a stale mount turns
 * `realpathSync` into a multi-second main-thread stall (see
 * `apps/api/src/asset-static.ts:156`, which the volume module never calls).
 * The threat here is request data escaping the root, not symlink traversal by
 * a local attacker, so containment after `resolve` is the right check.
 */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  if (relativePath.length === 0 || relativePath.includes("\0")) return null;
  if (isAbsolute(relativePath)) return null;
  const base = resolve(root);
  const target = resolve(base, relativePath);
  const rest = relative(base, target);
  if (rest.length === 0 || rest.startsWith("..") || isAbsolute(rest)) return null;
  return target;
}

/**
 * `"Z:\\"` when the root sits on a drive letter, `null` for a UNC path.
 *
 * Used only to explain a failure: "the drive is not mapped" and "the folder was
 * renamed" both surface as `ENOENT`, and they call for completely different
 * actions from the owner.
 */
export function driveRootOf(root: string): string | null {
  const match = /^([A-Za-z]):[\\/]/.exec(root);
  const letter = match?.[1];
  return letter === undefined ? null : `${letter.toUpperCase()}:\\`;
}
