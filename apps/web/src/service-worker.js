// Service Worker：唯一目的是「连不上服务器时，别给一片白」。
//
// 它不缓存业务数据（/api 一律直连），只缓存应用外壳：index.html 与它引用的
// 那几个带哈希的 js/css。连不上时导航回退到缓存里的壳，React 仍然能起来，
// 于是用户看到的是「启动屏 + 连不上」，而不是浏览器的纯白 —— 后者在 iOS
// 主屏 PWA 里连错误文字都不给。
//
// 两个常量由 vite.config.ts 的 lifeosServiceWorker() 在构建时填入：
//   VERSION   由资源清单算出的哈希，改了代码就换缓存桶
//   PRECACHE  ["/", "/assets/index-xxxx.js", ...] —— 壳引用到的全部带哈希资源
// 手写版本号的老路走不通：迟早有一次忘了改，缓存就永远清不掉。
// （占位符只写在下面那两行常量里，注释里不再出现，否则替换会先命中注释。）
//
// ⚠️ 这个文件只在「安全上下文」里生效。http://192.168.x.x:5199（手机局域网）
// 不算安全上下文，iOS 与桌面 Chrome 都不会注册它 —— 那道门只能靠 HTTPS 打开。

const VERSION = "__LIFEOS_SW_VERSION__";
const PRECACHE = __LIFEOS_SW_PRECACHE__;
const CACHE = `lifeos-shell-${VERSION}`;

// 服务器「连得上但不回话」时（电脑睡眠、Wi-Fi 掉到 2 格），干等可能几十秒。
// 超过这个时间先拿缓存里的壳顶上，用户至少知道发生了什么。
const NAVIGATION_TIMEOUT = 5000;

const OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LifeOS · 连不上</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;padding:32px;box-sizing:border-box;
       background:#eef2f7;color:#18243d;
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:22em;text-align:center}
  h1{margin:0 0 12px;font-size:1.15rem;font-weight:650}
  p{margin:0 0 8px;color:#5d6b82;font-size:.92rem}
  button{margin-top:16px;min-height:40px;padding:0 20px;border:0;border-radius:10px;
         background:#2f6df6;color:#fff;font:inherit;font-size:.92rem}
</style></head>
<body><div class="box">
  <h1>连不上 LifeOS</h1>
  <p>这台设备现在打不开电脑上的预览服务。</p>
  <p>确认电脑没睡眠、预览窗口还开着，然后重试。</p>
  <button onclick="location.reload()">重试</button>
</div></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `cache: "reload"`：绕开 HTTP 缓存，装进来的必须是这次构建的产物，
    // 否则会把上一个版本的东西再存一遍。
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // 只留当前这个桶：旧版本留下的哈希资源没有任何引用，留着只会占空间。
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 数据永远走网络：缓存一条旧日记比打不开更糟。
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  event.respondWith(asset(request));
});

async function navigate(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT);
    if (response !== null && response.ok) {
      // 覆盖缓存里的壳：下次离线打开就是这个版本。
      await cache.put("/", response.clone());
      return response;
    }
    if (response !== null) return response;
  } catch { /* 断网、DNS 失败、超时 —— 都走缓存 */ }

  const cached = await cache.match("/");
  if (cached !== undefined) return cached;
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function asset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  // 带哈希的资源内容不会变，缓存了就永远是它；其余（字体、图标）也一样，
  // 名字里没有哈希但改动极少，靠版本桶换新。
  if (cached !== undefined) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
