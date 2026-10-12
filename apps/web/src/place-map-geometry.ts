export interface MapCenter { longitude: number; latitude: number }
/** Pixel drag in the map's logical image dimensions (Web Mercator). */
export function shiftMapCenter(center: MapCenter, zoom: number, dx: number, dy: number): MapCenter {
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin(Math.max(-85, Math.min(85, center.latitude)) * Math.PI / 180);
  const y = .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) - dy / scale;
  return { longitude: ((center.longitude - dx / scale * 360 + 540) % 360) - 180, latitude: Math.max(-85, Math.min(85, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI)) };
}
