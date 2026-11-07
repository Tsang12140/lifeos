import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// 生成 sw.js：把「这次构建都有哪些文件」写进 Service Worker，而不是让它自己
// 猜。缓存桶的名字由资源清单哈希得出，改一次代码就换一次桶 —— 手写版本号的
// 方案迟早会漏改一次，然后用户的离线壳永远停在旧版本。
//
// 只在 build 里跑：dev 下注册 Service Worker 会把 Vite 的模块缓存住，改代码
// 不生效，排查起来极其费时。
function lifeosServiceWorker(): Plugin {
  return {
    name: "lifeos-service-worker",
    apply: "build",
    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (outDir === undefined) return;
      // 只预缓存「壳」：index.html 里明确引用的那些 js/css。按 assets/ 通配
      // 抓会把 597KB 的 worker 和 8MB 的字体一起塞进首装，而它们大多一次都
      // 用不上 —— 那些走运行时缓存，用到了才存。
      const index = bundle["index.html"];
      const indexSource = index !== undefined && index.type === "asset" ? String(index.source) : "";
      const referenced = new Set(
        [...indexSource.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((match) => match[1]),
      );
      const assets = [...referenced].sort().map((file) => `/${file}`);
      const version = createHash("sha256").update([...assets, indexSource].join("\n")).digest("hex").slice(0, 10);
      const template = readFileSync(fileURLToPath(new URL("./src/service-worker.js", import.meta.url)), "utf8");
      writeFileSync(
        resolve(outDir, "sw.js"),
        template
          // 全局替换：只在第一处生效的话，注释里先出现一次就会把真正的常量漏掉
          // —— 那个 bug 的结果是浏览器拿到一个写着字面占位符的 Service Worker。
          .replaceAll("__LIFEOS_SW_VERSION__", version)
          .replace("__LIFEOS_SW_PRECACHE__", JSON.stringify(["/", ...assets])),
        "utf8",
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfoModule(), lifeosServiceWorker()],
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
