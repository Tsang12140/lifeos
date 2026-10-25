import { scopedKey } from './storage-scope.ts';

export const PRIVACY_DAY_MS = 24 * 60 * 60 * 1000;
export type PrivacyAccess = number | 'always' | null;
export function parsePrivacyAccess(raw: string | null, now = Date.now()): PrivacyAccess {
  if (raw === 'always') return 'always';
  if (!raw || !/^\d{13}$/.test(raw)) return null;
  const expires = Number(raw);
  return expires > now ? expires : null;
}
export const privacyAccessKey = (kind: 'display' | 'ai', scope: string) => scopedKey(`lifeos.privacy.access.v2:${encodeURIComponent(scope)}:${kind}`);
export const privateAccessUntil = (value: PrivacyAccess, now = Date.now()): string | undefined => value === 'always' ? 'always' : value !== null && value > now ? new Date(value).toISOString() : undefined;
