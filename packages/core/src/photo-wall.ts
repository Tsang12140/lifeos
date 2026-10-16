// The entire monthly photo wall is shelved until the owner explicitly revives it.
// This does not affect photos within individual calendar dates.
export const PHOTO_WALL_ENABLED = false;

export interface PhotoWallPreferences {
  layout: "rows" | "masonry" | "scattered";
  veil: number;
  shadow: number;
  border: number;
  gap: number;
  tilt: number;
  seed: number;
}
export const PHOTO_WALL_MIN_PHOTOS = 9;
export const PHOTO_WALL_PHOTOS_PER_TIER = 6;
export function photoWallPhotoTier(count: number): number {
  return Number.isSafeInteger(count) && count >= PHOTO_WALL_MIN_PHOTOS
    ? PHOTO_WALL_MIN_PHOTOS + Math.floor((count - PHOTO_WALL_MIN_PHOTOS) / PHOTO_WALL_PHOTOS_PER_TIER) * PHOTO_WALL_PHOTOS_PER_TIER : 0;
}
export const PHOTO_WALL_DEFAULTS: Readonly<PhotoWallPreferences> = Object.freeze({
  layout: "rows", veil: 96, shadow: 60, border: 0, gap: 0, tilt: 0, seed: 1,
});
export const PHOTO_WALL_LIMITS = { veil: [0, 100], shadow: [0, 60], border: [0, 16], gap: [0, 32], tilt: [0, 8], seed: [1, 9999] } as const;
export function photoWallPreferences(input: unknown): PhotoWallPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("照片墙参数格式不正确");
  const value = input as Record<string, unknown>;
  // Old saved settings included a photo cap. Discard it while retaining the user's appearance settings.
  if (Object.keys(value).some(key => key !== "maxPhotos" && !Object.hasOwn(PHOTO_WALL_DEFAULTS, key))) throw Error("包含不支持的照片墙参数");
  if (typeof value.layout !== "string" || !["rows", "masonry", "scattered"].includes(value.layout)) throw Error("照片墙排法不正确");
  for (const [key, [min, max]] of Object.entries(PHOTO_WALL_LIMITS)) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max ||
      (key === "tilt" ? number * 2 % 1 !== 0 : !Number.isSafeInteger(number))) throw Error("照片墙参数超出允许范围");
  }
  return Object.fromEntries(Object.keys(PHOTO_WALL_DEFAULTS).map(key => [key, value[key]])) as unknown as PhotoWallPreferences;
}
export interface PhotoWallPhoto { width: number; height: number }
export interface PhotoWallCell { index: number; x: number; y: number; w: number; h: number; angle: number }
function fit(cells: PhotoWallCell[], width: number, height: number, margin: number): PhotoWallCell[] {
  const right = Math.max(...cells.map(c => c.x + c.w)), bottom = Math.max(...cells.map(c => c.y + c.h));
  const scale = Math.min((width - 2 * margin) / right, (height - 2 * margin) / bottom);
  const dx = (width - right * scale) / 2, dy = (height - bottom * scale) / 2;
  return cells.map(c => ({ ...c, x: dx + c.x * scale, y: dy + c.y * scale, w: c.w * scale, h: c.h * scale }));
}
function masonry(photos: PhotoWallPhoto[], width: number, height: number, gap: number): PhotoWallCell[] {
  let best: PhotoWallCell[] = [], score = -1;
  const order = photos.map((photo, index) => ({ photo, index })).sort((a, b) => b.photo.height / b.photo.width - a.photo.height / a.photo.width);
  for (let columns = 2; columns <= Math.min(10, photos.length); columns++) {
    const columnWidth = (width - (columns - 1) * gap) / columns, bottoms = Array<number>(columns).fill(0);
    if (columnWidth <= 0) continue;
    const cells = order.map(({ photo, index }) => {
      const column = bottoms.indexOf(Math.min(...bottoms));
      const cell = { index, x: column * (columnWidth + gap), y: bottoms[column]!, w: columnWidth, h: columnWidth * photo.height / photo.width, angle: 0 };
      bottoms[column]! += cell.h + gap; return cell;
    });
    const fitted = fit(cells, width, height, 26), coverage = fitted.reduce((sum, c) => sum + c.w * c.h, 0);
    if (coverage > score) { best = cells; score = coverage; }
  }
  return best;
}
function rows(photos: PhotoWallPhoto[], width: number, height: number, gap: number): PhotoWallCell[] {
  const count = photos.length, weight = photos.reduce((sum, p) => sum + p.width / p.height, 0);
  const rowCount = Math.max(Math.ceil(count / 7), Math.min(Math.floor(count / 2), Math.round(Math.sqrt(weight * height / width)))), target = height / rowCount;
  const ratios = photos.map(p => p.width / p.height), sums = [0]; for (const r of ratios) sums.push(sums.at(-1)! + r);
  const dp = Array.from({ length: rowCount + 1 }, () => Array<number>(count + 1).fill(Infinity)), parent = dp.map(row => row.map(() => -1)); dp[0]![0] = 0;
  for (let row = 1; row <= rowCount; row++) for (let end = 2; end <= count; end++) for (let start = Math.max(0, end - 7); start <= end - 2; start++) {
    const h = (width - (end - start - 1) * gap) / (sums[end]! - sums[start]!);
    const cost = dp[row - 1]![start]! + (h - target) ** 2;
    if (h > 0 && cost < dp[row]![end]!) { dp[row]![end] = cost; parent[row]![end] = start; }
  }
  const groups: number[][] = []; let end = count;
  for (let row = rowCount; row > 0; row--) { const start = parent[row]![end]!; groups.unshift([start, end]); end = start; }
  const cells: PhotoWallCell[] = []; let y = 0;
  for (const [start, end] of groups) {
    const h = (width - (end! - start! - 1) * gap) / (sums[end!]! - sums[start!]!); let x = 0;
    for (let i = start!; i < end!; i++) { const w = h * ratios[i]!; cells.push({ index: i, x, y, w, h, angle: 0 }); x += w + gap; }
    y += h + gap;
  }
  return cells;
}
/** One reusable strip; its dimensions never depend on the document's scroll height. */
export function photoWallLayout(photos: PhotoWallPhoto[], preferences: PhotoWallPreferences) {
  const width = 1600, height = 1040, gap = preferences.gap + 2 * preferences.border;
  if (photos.length < 2 || photos.some(p => !Number.isFinite(p.width / p.height) || p.width <= 0 || p.height <= 0)) throw Error("照片尺寸不可用");
  const raw = preferences.layout === "rows" ? rows(photos, width, height, gap) : masonry(photos, width, height, gap);
  const placed = preferences.layout === "rows" ? raw : fit(raw, width, height, preferences.layout === "scattered" ? 84 : 26);
  const naturalHeight = preferences.layout === "rows" ? Math.ceil(Math.max(...placed.map(c => c.y + c.h)) + preferences.border) : height;
  // Bound both dimensions even for a month of exceptionally tall screenshots.
  const scale = Math.min(1, 1600 / naturalHeight);
  const cells = placed.map((cell, i) => ({ ...cell, x: cell.x * scale, y: cell.y * scale, w: cell.w * scale, h: cell.h * scale,
    angle: preferences.layout === "scattered" ? Math.sin((i + 1) * 7.17 + preferences.seed) * preferences.tilt : 0 }));
  return { width: Math.ceil(width * scale), height: Math.ceil(naturalHeight * scale), border: preferences.border * scale, cells };
}
