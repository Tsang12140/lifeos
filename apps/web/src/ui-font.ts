export const SYSTEM_UI_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const WINDOWS_UI_FONT = '"LifeOS MiSans", "MiSans", ' + SYSTEM_UI_FONT;

/** Only Windows gets a preferred local font; other platforms choose their own UI face. */
export function automaticUiFont(platform: string, userAgent: string): string {
  return /^Win/i.test(platform) || /Windows/i.test(userAgent) ? WINDOWS_UI_FONT : SYSTEM_UI_FONT;
}

export function deviceUiFont(): string {
  if (typeof navigator === "undefined") return SYSTEM_UI_FONT;
  const hints = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = hints.userAgentData?.platform || navigator.platform;
  return automaticUiFont(platform, hints.userAgentData?.platform ? "" : navigator.userAgent);
}
