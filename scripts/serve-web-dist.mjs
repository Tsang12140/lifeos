#!/usr/bin/env node
// accept-serve.mjs 在局域网模式下用它替代 Vite dev server（同一个 5199）。
//
//   LIFEOS_WEB_DIST  apps/web/dist（默认就是仓库里那份）
//   LIFEOS_WEB_PORT  5199
//   LIFEOS_WEB_HOST  0.0.0.0
//   LIFEOS_PORT      3011  ← /api 转给它
//
// 单独一个进程而不是在 accept-serve 里直接 listen：这样它和 API 一样被写进
// serve-pids.json、日志各归各的，停止脚本不用认识第二种形态。
import { resolve } from "node:path";
import { startWebDistServer } from "./lib/lan-static-server.mjs";

const root = resolve(import.meta.dirname, "..");
const distDir = resolve(process.env.LIFEOS_WEB_DIST ?? resolve(root, "apps", "web", "dist"));

startWebDistServer({
  distDir,
  host: process.env.LIFEOS_WEB_HOST ?? "127.0.0.1",
  port: Number(process.env.LIFEOS_WEB_PORT ?? 5199),
  apiHost: "127.0.0.1",
  apiPort: Number(process.env.LIFEOS_PORT ?? 3011),
  log: (line) => console.error(line),
});
