import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readBuildInfo } from "../../scripts/lib/build-info.mjs";

const apiOrigin = process.env.LIFEOS_API_ORIGIN ?? `http://127.0.0.1:${process.env.LIFEOS_PORT ?? "3001"}`;

// Captured once, when this config loads, so the bundle can name the code it
// contains. Read at runtime instead and it would describe the server, not what
// the browser is running — telling those two apart is the whole point when a
// stale cache is suspected.
//
// A virtual module rather than `define`: Vite's define plugin skips client code
// in dev (`vite:define` returns early when consumer === "client" && !isBuild),
// so a define-only stamp arrives as `undefined` on 5199 — the port people
// actually look at. A resolved module behaves the same in both modes.
const buildInfo = readBuildInfo();

function buildInfoModule(): Plugin {
  const id = "virtual:lifeos-build";
  const resolved = `\0${id}`;
  return {
    name: "lifeos-build-info",
    resolveId(source) { return source === id ? resolved : null; },
    load(source) { return source === resolved ? `export default ${JSON.stringify(buildInfo)};` : null; },
  };
}

export default defineConfig({
  plugins: [react(), buildInfoModule()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
});
