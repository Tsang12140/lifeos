let current: () => string | undefined = () => undefined;
/** Root supplies the active account/card only; never persist a second permission. */
export function configurePrivateAiAccess(read: () => string | undefined) { current = read; }
export function privateAiAccessHeader(): string | undefined { return current(); }
