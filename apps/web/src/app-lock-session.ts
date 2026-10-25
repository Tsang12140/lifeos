import type { AppLockTarget } from '@lifeos/core';
let token: string | undefined;
let unlock: ((targets: readonly AppLockTarget[]) => Promise<boolean>) | undefined;
export const appUnlockToken = () => token;
export function setAppUnlockToken(value: string | undefined) { token = value; }
export function configureAppUnlock(handler: typeof unlock) { unlock = handler; }
export const requestAppUnlock = (targets: readonly AppLockTarget[]) => unlock?.(targets) ?? Promise.resolve(false);
