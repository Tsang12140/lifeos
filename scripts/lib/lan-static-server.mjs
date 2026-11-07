// 局域网预览的 Web 端：直接发 apps/web/dist，不再跑 Vite dev server。
//
// 为什么换：dev server 在手机上要拉 ~197 个模块、11MB（每个 .tsx 各发一次请求），
// 同一份源码生产构建是 3 个请求、约 0.5MB。手机白屏的一半时间花在等这些模块上，
// 而本机回环是 900ms、手机 Wi-Fi 上是十几秒 —— 差距全在请求数上。
//
// 这里只做三件事：发静态文件、给 SPA 做回退、把 /api 转给 3011。
// 刻意不做目录列表、不做 Range、不做自动压缩以外的任何转换：它不是通用服务器，
// 是「把构建产物端出去」的最小实现，越少越好审。
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// 只有文本类值得压。图片/字体/视频本身已经压过，再 gzip 一遍是纯浪费 CPU。
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".txt", ".map"]);

/**
 * @param {{distDir: string, host: string, port: number, apiHost: string, apiPort: number, log?: (line: string) => void}} options
 */
export function startWebDistServer({ distDir, host, port, apiHost, apiPort, log = () => {} }) {
  // 压缩结果的缓存。同一个文件第二次请求时直接从内存拿，不重复压。
  // 键里带 mtime 与大小，重新构建后自然失效，不需要手动清。
  const compressed = new Map();

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://placeholder").pathname;

    // 先转发，再谈方法限制。写反了会把登录、上传、导入全部挡成 405 ——
    // 静态文件只发 GET/HEAD，API 可什么方法都有。
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      proxyToApi(request, response, { apiHost, apiPort, log });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }

    const file = resolveFile(distDir, pathname);
    if (file !== null && sendFile(request, response, file, pathname, compressed)) return;

    // 带扩展名却找不到 —— 是真的没有，别拿首页糊过去，否则 404 会被当成 200。
    if (extname(pathname) !== "") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    const index = resolve(distDir, "index.html");
    if (!sendFile(request, response, index, "/", compressed)) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end(`没有可用的构建产物：${distDir}\n先跑一次 vite build。`);
    }
  });

  // 手机切后台再回来时常留下半死的连接；不处理会在控制台刷 stack。
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  server.listen(port, host, () => {
    log(`web(dist) 已就绪：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/  ← ${distDir}`);
  });
  return server;
}

function resolveFile(distDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    return null; // 畸形的百分号编码
  }
  if (decoded.split("/").includes("..")) return null;
  if (decoded === "") return resolve(distDir, "index.html");

  const full = resolve(distDir, decoded);
  if (!full.startsWith(distDir + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function sendFile(request, response, file, pathname, compressed) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": cacheControl(pathname),
    etag,
    "last-modified": stat.mtime.toUTCString(),
  };

  // 304 只回头：带哈希的资源在浏览器里已经是对的，没必要再传一遍。
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return true;
  }

  const body = compressedBody(file, stat, request, compressed);
  if (body !== null) {
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
  }
  headers["content-length"] = String(body === null ? stat.size : body.length);
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  if (body !== null) response.end(body);
  else createReadStream(file).pipe(response);
  return true;
}

function compressedBody(file, stat, request, cache) {
  if (!/\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) return null;
  const ext = extname(file).toLowerCase();
  if (!COMPRESSIBLE.has(ext)) return null;
  // 太小的文件压完反而更大，而多一个头、多一次解压不划算。
  if (stat.size < 1400) return null;

  const key = `${file}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // 压缩是同步的，用同步读更直接；构建产物最大的那个也就几 MB。
  const body = gzipSync(readFileSync(file));
  // 别让它无限长：这个进程一般只活到预览关掉，几十个条目足够。
  if (cache.size > 64) cache.clear();
  cache.set(key, body);
  return body;
}

function cacheControl(pathname) {
  // 带哈希的构建产物永不变化，可以放心长期缓存；其余每次都要回来问一下。
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname === "/" || pathname.endsWith(".html") || pathname === "/sw.js") return "no-cache";
  return "public, max-age=86400";
}

function proxyToApi(request, response, { apiHost, apiPort, log }) {
  const upstream = httpRequest(
    {
      host: apiHost,
      port: apiPort,
      method: request.method,
      path: request.url,
      // 刻意保留浏览器发来的 Host（Vite 代理是 changeOrigin:false，行为要一致）。
      headers: { ...request.headers, host: request.headers.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", (error) => {
    log(`/api 转发失败：${String(error.code ?? error.message)}`);
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: "预览的 API 没有应答", detail: String(error.code ?? error.message) }));
  });

  // 请求体原样转发（上传照片、导入备份都靠它）；流式响应同样靠 pipe，不缓冲。
  request.pipe(upstream);
}
