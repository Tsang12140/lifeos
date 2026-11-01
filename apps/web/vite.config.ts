import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readBuildInfo } from "../../scripts/lib/build-info.mjs";

const apiOrigin = process.env.LIFEOS_API_ORIGIN ?? `http://127.0.0.1:${process.env.LIFEOS_PORT ?? "3001"}`;

export default defineConfig({
  plugins: [react()],
  // Baked in at build time so the bundle can name itself. Read at runtime instead
  // and it would describe the server, not the code the browser is actually
  // running — telling those two apart is the whole point when a stale cache is
  // suspected.
  define: { __LIFEOS_BUILD__: JSON.stringify(readBuildInfo()) },
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
