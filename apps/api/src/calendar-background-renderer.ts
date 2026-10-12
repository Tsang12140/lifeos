import sharp, { type OverlayOptions } from "sharp";
import { photoWallLayout, type PhotoWallPreferences } from "@lifeos/core";

/** Already-small private derivatives only; no original image reads or browser composition. */
export async function renderCalendarPhotoWall(images: Buffer[], preferences: PhotoWallPreferences, yieldWork: () => Promise<void>): Promise<Buffer> {
  const photos = [];
  for (const image of images) {
    const info = await sharp(image).metadata();
    photos.push({ width: info.width!, height: info.height! }); await yieldWork();
  }
  const { width, height, border, cells } = photoWallLayout(photos, preferences);
  const overlays: OverlayOptions[] = [];
  const rectangles = cells.map(c => `<rect x="${c.x - border}" y="${c.y - border}" width="${c.w + 2 * border}" height="${c.h + 2 * border}" fill="white" transform="rotate(${c.angle} ${c.x + c.w / 2} ${c.y + c.h / 2})"/>`).join("");
  const shadow = preferences.shadow / 100;
  overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#1c1e23" flood-opacity="${shadow}"/></filter></defs><g${shadow ? ' filter="url(#s)"' : ''}>${rectangles}</g></svg>`), left: 0, top: 0 });
  for (const cell of cells) {
    const w = Math.max(1, Math.round(cell.w)), h = Math.max(1, Math.round(cell.h));
    const tile = await sharp(images[cell.index]!).rotate().resize(w, h, { fit: "contain", background: "#ffffff" })
      .extend({ top: Math.round(border), bottom: Math.round(border), left: Math.round(border), right: Math.round(border), background: "#ffffff" })
      .rotate(cell.angle, { background: "#00000000" }).png().toBuffer({ resolveWithObject: true });
    const left = Math.round(cell.x + cell.w / 2 - tile.info.width / 2), top = Math.round(cell.y + cell.h / 2 - tile.info.height / 2);
    const x = Math.max(0, -left), y = Math.max(0, -top), clippedWidth = Math.min(tile.info.width - x, width - Math.max(0, left)), clippedHeight = Math.min(tile.info.height - y, height - Math.max(0, top));
    if (clippedWidth > 0 && clippedHeight > 0) overlays.push({ input: await sharp(tile.data).extract({ left: x, top: y, width: clippedWidth, height: clippedHeight }).toBuffer(), left: Math.max(0, left), top: Math.max(0, top) });
    await yieldWork();
  }
  await yieldWork();
  return sharp({ create: { width, height, channels: 3, background: "#e8e5df" } }).composite(overlays).webp({ quality: 65, effort: 2 }).toBuffer();
}
