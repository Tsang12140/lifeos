/**
 * Injected by `vite.config.ts` via `define`. The value is baked in at build time,
 * so it describes the bundle the browser is running — not the server it talks to.
 * Telling those two apart is the whole point when a stale cache is suspected.
 */
declare const __LIFEOS_BUILD__: {
  readonly version: string;
  readonly commit: string | null;
  readonly committedAt: string | null;
  readonly dirty: boolean;
  readonly builtAt: string | null;
};
