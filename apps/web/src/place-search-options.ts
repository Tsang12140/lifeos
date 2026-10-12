export interface DevicePoint { latitude: number; longitude: number; accuracy: number; timestamp: number }
let lastPoint: DevicePoint | null = null;

export function rememberDevicePoint(coords: Pick<GeolocationCoordinates, "latitude" | "longitude" | "accuracy">, timestamp = Date.now()): void {
  if ([coords.latitude, coords.longitude, coords.accuracy, timestamp].every(Number.isFinite) && Math.abs(coords.latitude) <= 90 && Math.abs(coords.longitude) <= 180 && coords.accuracy >= 0) lastPoint = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, timestamp };
}

/** Coordinates remain in memory. City/IP estimates are never used for metre labels. */
export async function placeSearchPoint(): Promise<DevicePoint | null> {
  const fresh = () => lastPoint && Date.now() - lastPoint.timestamp >= 0 && Date.now() - lastPoint.timestamp < 60_000 && lastPoint.accuracy <= 1000 ? lastPoint : null;
  if (fresh()) return fresh();
  if (!window.isSecureContext || !navigator.geolocation) return null;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 3500);
    try { navigator.geolocation.getCurrentPosition(position => {
      clearTimeout(timer); rememberDevicePoint(position.coords, position.timestamp);
      resolve(fresh());
    }, () => { clearTimeout(timer); resolve(null); }, { enableHighAccuracy: true, maximumAge: 60_000, timeout: 3500 }); }
    catch { clearTimeout(timer); resolve(null); }
  });
}

export function recommendedPlaceCities(weather: string, recent: readonly string[], frequent: readonly string[]): string[] {
  return [...new Set([weather, ...recent, ...frequent].map(name => name.trim().replace(/市$/u, "")).filter(Boolean))].slice(0, 3);
}

export function placeDistanceLabel(distance: number | undefined, accuracy: number): string | undefined {
  if (distance === undefined || !Number.isFinite(distance) || distance < 0 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1000) return undefined;
  if (distance < Math.max(10, accuracy)) return "附近";
  const step = Math.max(10, Math.ceil(accuracy / 10) * 10);
  const rounded = Math.round(distance / step) * step;
  return rounded < 1000 ? `约 ${rounded} 米` : `约 ${(rounded / 1000).toFixed(1)} 公里`;
}
