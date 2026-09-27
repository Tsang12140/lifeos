// Isolated browser geometry regression. Never connects to 3011/5199 or data/.
// Run after npm run build: node scripts/test/mobile-geometry.mjs
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const run = mkdtempSync(join(tmpdir(), "lifeos-mobile-geometry-"));
const report = join(root, ".review", "mobile-geometry.txt");
const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
const checks = [];
const children = [];
let socket;
let id = 0;
const pending = new Map();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const check = (ok, label, detail = "") => checks.push((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + detail : ""));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function cdp(method, params = {}) {
  const next = ++id;
  socket.send(JSON.stringify({ id: next, method, params }));
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { pending.delete(next); fail(new Error("CDP timeout: " + method)); }, 15000);
    pending.set(next, (message) => {
      clearTimeout(timer);
      if (message.error) fail(new Error(message.error.message));
      else done(message.result);
    });
  });
}
async function evalPage(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "page evaluation failed");
  return result.result?.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evalPage(expression)) return;
    await sleep(120);
  }
  throw new Error("页面等待超时：" + expression);
}
async function viewport(width) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
  await waitFor("innerWidth === " + width);
  await sleep(120);
}

try {
  if (!chrome) throw new Error("需要 Chrome 或 Edge 才能跑移动端几何验收");
  if (!existsSync(join(root, "apps", "api", "dist", "src", "main.js"))
    || !existsSync(join(root, "apps", "web", "dist", "index.html"))) throw new Error("请先运行 npm run build");
  const apiPort = await freePort();
  const cdpPort = await freePort();
  const base = "http://127.0.0.1:" + apiPort;
  children.push(spawn(process.execPath, [join(root, "apps", "api", "dist", "src", "main.js")], {
    cwd: root, stdio: "ignore", env: {
      ...process.env, LIFEOS_HOST: "127.0.0.1", LIFEOS_PORT: String(apiPort),
      LIFEOS_ACCOUNT_MODE: "0", LIFEOS_PASSWORD: "isolated-mobile-geometry-password",
      LIFEOS_COOKIE_SECURE: "false", LIFEOS_ALLOWED_ORIGINS: base,
      LIFEOS_DATA_DIR: join(run, "data"), LIFEOS_ASSET_ROOT: join(run, "assets"),
      LIFEOS_BACKUP_DIR: join(run, "backups"), LIFEOS_LOG_DIR: join(run, "logs"),
      LIFEOS_WEB_DIR: join(root, "apps", "web", "dist"),
    },
  }));
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(base + "/api/auth")).ok) break; } catch { /* booting */ }
    await sleep(120);
  }
  const login = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "isolated-mobile-geometry-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.match(/lifeos_session=([^;]+)/)?.[1];
  if (!login.ok || !cookie) throw new Error("隔离 API 登录失败：" + login.status);

  children.push(spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-allow-origins=*", "--user-data-dir=" + join(run, "chrome"),
    "--remote-debugging-port=" + cdpPort, "about:blank",
  ], { stdio: "ignore" }));
  let page;
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/list")).json();
      page = list.find((item) => item.type === "page");
      if (page) break;
    } catch { /* booting */ }
    await sleep(120);
  }
  if (!page) throw new Error("Chrome CDP 未就绪");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const done = pending.get(message.id);
    if (done) { pending.delete(message.id); done(message); }
  });
  await once(socket, "open");
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Network.setCookie", { name: "lifeos_session", value: decodeURIComponent(cookie), url: base });
  await cdp("Page.navigate", { url: base });
  await waitFor("Boolean(document.querySelector('.app-shell .composer-input'))");

  for (const width of [320, 360, 390, 430]) {
    await viewport(width);
    const m = await evalPage(`(() => {
      const rect = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } : null; };
      const search = rect('.mobile-search-button');
      const summary = rect('.weather-header-summary');
      const nav = rect('.weather-date-navigation');
      const composer = rect('.composer-entry');
      const save = rect('.composer-inline-save');
      return { width:innerWidth, scroll:document.documentElement.scrollWidth, search, summary, nav, composer, save,
        searchVisible: getComputedStyle(document.querySelector('.mobile-search-button')).display !== 'none' };
    })()`);
    const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    check(m.scroll <= width && m.searchVisible && m.search && m.search.right <= width + 1
      && !overlap(m.search, m.summary) && !overlap(m.search, m.nav),
      width + "px header search remains visible without overlap", JSON.stringify(m));
    check(m.composer && m.save && m.composer.right <= width + 1 && m.save.right <= m.composer.right + 1,
      width + "px composer fits", JSON.stringify({ composer:m.composer, save:m.save }));
  }
  await evalPage(`Array.from(document.querySelectorAll('.mobile-nav-item')).find((item) => item.textContent?.includes('日历'))?.click()`);
  await waitFor("Boolean(document.querySelector('.mode-option'))");
  await evalPage(`Array.from(document.querySelectorAll('.mode-option')).find((item) => item.textContent?.trim() === '月')?.click()`);
  await waitFor("document.querySelectorAll('.month-cell').length === 42");
  for (const width of [320, 360, 390, 430]) {
    await viewport(width);
    const m = await evalPage(`(() => {
      const cells = [...document.querySelectorAll('.month-cell')];
      return { scroll:document.documentElement.scrollWidth,
        count:cells.length,
        square:cells.every((cell) => { const r = cell.getBoundingClientRect(); return Math.abs(r.width-r.height) <= 2; }),
        dates:cells.every((cell) => { const r=cell.getBoundingClientRect(), d=cell.querySelector('.month-day-number')?.getBoundingClientRect(); return d && d.width>0 && d.left>=r.left-1 && d.right<=r.right+1 && d.top>=r.top-1 && d.bottom<=r.bottom+1; }),
        summaries:cells.some((cell) => { const s=cell.querySelector('.month-day-summary'); return s && getComputedStyle(s).display !== 'none'; }) };
    })()`);
    check(m.scroll <= width && m.count === 42 && m.square && m.dates && !m.summaries,
      width + "px calendar tiles square, dates visible, summaries hidden", JSON.stringify(m));
  }
  await viewport(390);
  await evalPage(`Array.from(document.querySelectorAll('.mobile-nav-item')).find((item) => item.textContent?.includes('今天'))?.click()`);
  await waitFor("Boolean(document.querySelector('.composer-input'))");
  await evalPage(`(() => {
    const input = document.querySelector('.composer-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'isolated-draft-probe');
    input.dispatchEvent(new Event('input', { bubbles:true }));
  })()`);
  await waitFor("localStorage.getItem('lifeos.composerDraft.v1.legacy')?.includes('isolated-draft-probe')");
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor("document.querySelector('.composer-input')?.value === 'isolated-draft-probe'");
  check(true, "composer text survives reload in the isolated instance");
  await evalPage(`document.querySelector('.composer-inline-save')?.click()`);
  await waitFor("document.querySelector('.composer-input')?.value === '' && localStorage.getItem('lifeos.composerDraft.v1.legacy') === null");
  check(true, "a successful record save clears the local draft");
} catch (error) {
  check(false, "验收中断", error instanceof Error ? error.stack || error.message : String(error));
} finally {
  try { socket?.close(); } catch { /* already closed */ }
  for (const child of children.reverse()) { try { child.kill(); } catch { /* already exited */ } }
  await sleep(400);
  try { rmSync(run, { recursive: true, force: true }); } catch { /* profile may still be exiting */ }
  mkdirSync(join(root, ".review"), { recursive: true });
  const passed = checks.every((line) => line.startsWith("PASS"));
  writeFileSync(report, checks.join("\n") + "\nRESULT: " + (passed ? "PASS" : "FAIL") + "\n");
  console.log(checks.join("\n"));
  console.log("RESULT: " + (passed ? "PASS" : "FAIL") + "  " + report);
  process.exitCode = passed ? 0 : 1;
}
