/** An authenticated caller's explicit, request-scoped opt-in. UI visibility is unrelated. */
export function allowsPrivateAiAccess(value: unknown, now = Date.now()): boolean {
  if (value === 'always') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const expires = Date.parse(value);
  return Number.isFinite(expires) && expires > now && expires <= now + 86_400_000 + 60_000;
}
