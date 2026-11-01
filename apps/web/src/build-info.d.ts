/**
 * The bundle's own build stamp, supplied by the `lifeos-build-info` plugin in
 * `vite.config.ts` and captured when the config loads. It therefore describes
 * the code the browser is running, not the server it talks to — telling those
 * two apart is the whole point when a stale cache is suspected.
 *
 * A module rather than a `define` global because Vite's define plugin skips
 * client code in dev, which would leave the stamp `undefined` on 5199.
 */
declare module "virtual:lifeos-build" {
  const build: {
    readonly version: string;
    readonly commit: string | null;
    readonly committedAt: string | null;
    readonly dirty: boolean;
    readonly builtAt: string | null;
  };
  export default build;
}
