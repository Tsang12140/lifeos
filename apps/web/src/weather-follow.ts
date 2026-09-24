import { useEffect } from "react";
import { apiRequest } from "./api";
import type { WeatherConfigStatus } from "./weather";

const FOLLOW_KEY_PREFIX = "lifeos.weather.follow-location.";
const FOLLOW_CHANGED = "lifeos-weather-follow-changed";
const MIN_LOCATION_INTERVAL_MS = 15 * 60 * 1000;
const MIN_MOVEMENT_DEGREES_SQUARED = 0.0064; // Roughly eight kilometres; the server resolves a city, not a street.

export function weatherFollowEnabled(tenantId: string): boolean {
  try { return window.localStorage.getItem(`${FOLLOW_KEY_PREFIX}${tenantId}`) === "1"; }
  catch { return false; }
}

export function setWeatherFollowEnabled(tenantId: string, enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(`${FOLLOW_KEY_PREFIX}${tenantId}`, "1");
    else window.localStorage.removeItem(`${FOLLOW_KEY_PREFIX}${tenantId}`);
  } catch { /* Storage may be unavailable; the manual city remains usable. */ }
  window.dispatchEvent(new Event(FOLLOW_CHANGED));
}

function currentCoordinates(): Promise<{ latitude: number; longitude: number }> {
  if (!window.isSecureContext || !navigator.geolocation) {
    return Promise.reject(new Error("当前位置需要 HTTPS 和浏览器定位支持；也可以手动选择城市。"));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      (error) => reject(new Error(error.code === 1 ? "定位权限未开启；可以手动选择城市。" : "暂时无法获取位置；可以手动选择城市。")),
      { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 12_000 },
    );
  });
}

export async function locateWeatherDevice(): Promise<WeatherConfigStatus> {
  const coordinates = await currentCoordinates();
  return apiRequest<WeatherConfigStatus>("/api/weather/device/locate", { method: "POST", body: JSON.stringify(coordinates) });
}

/**
 * Location is requested only after the person enabled follow mode. While the
 * page is visible, moving to a different area updates its device city; a
 * foreground return also checks again. Raw coordinates never enter storage.
 */
export function useWeatherAutoFollow(tenantId: string | undefined, onLocationChanged: () => void): void {
  useEffect(() => {
    if (!tenantId) return;
    let active = true;
    let watchId: number | null = null;
    let busy = false;
    let lastSentAt = 0;
    let lastPosition: { latitude: number; longitude: number } | null = null;
    const shouldFollow = () => weatherFollowEnabled(tenantId);
    const send = async (latitude: number, longitude: number) => {
      if (!active || !shouldFollow() || busy) return;
      const now = Date.now();
      const moved = lastPosition === null || (latitude - lastPosition.latitude) ** 2 + (longitude - lastPosition.longitude) ** 2 >= MIN_MOVEMENT_DEGREES_SQUARED;
      if (!moved && now - lastSentAt < MIN_LOCATION_INTERVAL_MS) return;
      busy = true;
      try {
        await apiRequest<WeatherConfigStatus>("/api/weather/device/locate", { method: "POST", body: JSON.stringify({ latitude, longitude }) });
        if (!active) return;
        lastPosition = { latitude, longitude };
        lastSentAt = Date.now();
        onLocationChanged();
      } catch { /* Keep the last city; a later foreground check may succeed. */ }
      finally { busy = false; }
    };
    const stop = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    };
    const start = () => {
      stop();
      if (!shouldFollow() || document.visibilityState !== "visible" || !window.isSecureContext || !navigator.geolocation) return;
      watchId = navigator.geolocation.watchPosition(
        ({ coords }) => { void send(coords.latitude, coords.longitude); },
        () => { /* Permission may expire; manual city remains available. */ },
        { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 12_000 },
      );
    };
    const onVisibility = () => { if (document.visibilityState === "visible") start(); else stop(); };
    window.addEventListener(FOLLOW_CHANGED, start);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", start);
    start();
    return () => {
      active = false;
      stop();
      window.removeEventListener(FOLLOW_CHANGED, start);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", start);
    };
  }, [tenantId, onLocationChanged]);
}
