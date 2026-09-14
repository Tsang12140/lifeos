import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.LIFEOS_API_ORIGIN ?? `http://127.0.0.1:${process.env.LIFEOS_PORT ?? "3001"}`;

export default defineConfig({
  plugins: [react()],
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
