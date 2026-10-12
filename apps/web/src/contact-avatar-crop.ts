/** Crop and preview share viewport units, so dragging stays exact at any screen width. */
export function avatarCrop(imageWidth: number, imageHeight: number, zoom: number, offsetX: number, offsetY: number) {
  const scale = Math.max(1 / imageWidth, 1 / imageHeight) * Math.max(1, Math.min(3, zoom));
  const width = imageWidth * scale, height = imageHeight * scale;
  const x = Math.max(-(width - 1) / 2, Math.min((width - 1) / 2, offsetX));
  const y = Math.max(-(height - 1) / 2, Math.min((height - 1) / 2, offsetY));
  return { width, height, x, y, sx: (width / 2 - .5 - x) / scale, sy: (height / 2 - .5 - y) / scale, size: 1 / scale };
}
