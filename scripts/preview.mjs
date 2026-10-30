#!/usr/bin/env node
// 双击启动器的引擎（由仓库根目录的「启动预览.cmd」调用）。
//
// 目标是「双击一下，页面上线」，中间不需要人判断：
//   1. 3011/5199 都健康、而且确实是我们自己在管 → 只开浏览器，不重复起服务；
//   2. 端口上还有半死不活的残留（只有一个端口应答、或应答了却没有管它的窗口）
//      → 自动收掉，再起一个新的；
//   3. 端口空着 → 直接起；
//   4. 就绪后自动打开 http://127.0.0.1:5199/ ，并把窗口留在原地当「停止按钮」。
//
// 两种模式，双击哪个就是哪种：
//   启动预览.cmd        本机全功能（管理员页在），只开给 127.0.0.1，不用登录。
//   启动局域网预览.cmd   同一个 5199，但绑 0.0.0.0 + 强制登录密码，手机同 Wi-Fi 能开。
//                       代价是管理员页关闭（API 无法区分「手机」和「本机经 Vite 代理」，
//                       见 apps/api/src/config.ts:206 的那条限制）。
//
// 带 `--lan` 就是局域网模式；再加 `--plan` 只打印计划、不碰端口（验收用）。
//
// ⚠️ 3011/5199 上跑的是仓库自带的 data/ —— 主人自己的正式记录。
//    这个启动器只负责把服务打开/换新，不做任何数据清理或重置。
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import {
  FIREWALL_RULE_NAME,
  lanLaunchEnv,
  lanPreviewUrls,
  readEnvFile,
  resolveLanPassword,
  preferredLanAddresses,
} from "./lib/lan-preview.mjs";

const root = resolve(import.meta.dirname, "..");
const acceptServe = resolve(root, ".review", "accept-serve.mjs");
const stopScript = resolve(root, ".review", "stop-accept-serve.mjs");
const runDir = resolve(root, ".review", "run");
const pidFile = resolve(runDir, "serve-pids.json");
// accept-serve 只记自己的 pid；但「有没有窗口能关掉它」取决于本进程是否活着。
// 所以另记一份 preview.mjs 自己的 pid，双击时用它判断要不要接管。
const previewPidFile = resolve(runDir, "preview.pid");
const previewUrl = "http://127.0.0.1:5199/";
const webPort = 5199;
const READY_TIMEOUT_MS = 90_000;
// `--lan`：绑 0.0.0.0 并强制登录，手机同 Wi-Fi 能开；`--plan`：只报告，不碰端口。
const lanMode = process.argv.includes("--lan");
const planOnly = process.argv.includes("--plan");

// 双击时窗口可能一闪就没了（启动失败、或已有实例），控制台里的话谁也读不到。
// 所以把本进程的每一行输出同时写进 launch.log —— 出问题直接看这个文件。
const launchLog = resolve(runDir, "launch.log");
try {
  writeFileSync(launchLog, `\n==== ${new Date().toISOString()} preview.mjs pid ${process.pid} ====\n`, "utf8");
} catch { /* 日志写不了也要继续跑 */ }
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    try { appendFileSync(launchLog, typeof chunk === "string" ? chunk : String(chunk)); } catch { /* ignore */ }
    return write(chunk, ...rest);
  };
}


const targets = {
  api: { label: "API", port: 3011, path: "/api/health" },
  web: { label: "Web", port: 5199, path: "/" },
};

function probe(target, timeoutMs = 1500, host = "127.0.0.1") {
  return new Promise((done) => {
    const req = http.get(
      { host, port: target.port, path: target.path, timeout: timeoutMs },
      (res) => {
        res.resume();
        done({ ok: true, status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => { req.destroy(); done({ ok: false }); });
    req.on("error", () => done({ ok: false }));
  });
}

// 5199 默认只绑 loopback。LIFEOS_LAN=1 起过才会有局域网地址，所以要真探一次，
// 探不到就别编一个打不开的地址。
async function lanUrl() {
  for (const address of preferredLanAddresses()) {
    if ((await probe(targets.web, 1200, address)).ok) return `http://${address}:5199/`;
  }
  return null;
}

function printLanHint(url) {
  if (url !== null) {
    console.log(`局域网地址（同一 Wi-Fi 下的手机 / 平板）：${url}`);
    console.log("首次打开要登录，密码在 .review/run/lan-password.txt（启动窗口里也打印了）。");
    return;
  }
  console.log("手机 / 平板：双击 启动局域网预览.cmd —— 同一个 5199 会换成局域网可访问（要登录，管理员页关闭）。");
  console.log("现在这个实例只开给本机，带管理员页。");
}

// Windows 防火墙会先于 Vite 挡住手机：这台机器的网络被标成「公用」，而且
// Node 一条入站规则都没有。只报告，不自动改 —— 加规则要 UAC。
function firewallRulePresent() {
  if (process.platform !== "win32") return true;
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
        `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }`],
      { stdio: "ignore", windowsHide: true, timeout: 15_000 },
    );
    return true;
  } catch (error) {
    // 只有明确的「quit 3 = 没这条规则」才算缺；查询本身失败时别乱下结论。
    return error?.status !== 3;
  }
}

function printFirewallAdvice() {
  if (firewallRulePresent()) return;
  console.log("");
  console.log("⚠ 手机大概率还是打不开：Windows 防火墙没有放行这个端口。");
  console.log("  双击一次 允许手机访问.cmd（会弹一次 UAC），之后就不用再管。");
}

function printLanBanner(verified, password) {
  const urls = lanPreviewUrls(webPort);
  console.log("");
  console.log("── 局域网预览模式 ────────────────────────────────────");
  if (verified !== null) {
    console.log(`手机 / 平板（同一 Wi-Fi）：${verified}`);
  } else {
    console.log("手机 / 平板：本机自己都连不上局域网地址，先把服务起稳再看。");
  }
  for (const url of urls.phones) {
    if (`${url}` !== verified) console.log(`                         ${url}`);
  }
  console.log(`本机：${urls.local}`);
  console.log(`登录密码：${password}`);
  console.log("（同一个密码也记在 .review/run/lan-password.txt）");
  console.log("本模式下管理员页关闭；要它就在本机用 启动预览.cmd。");
  printFirewallAdvice();
  console.log("─────────────────────────────────────────────────────");
}

// 密码来源：环境变量 > .env > 上次生成的 .review/run/lan-password.txt > 新生成一个。
// 复用同一个密码，才能「双击就开、手机上不用每次改」。
function resolvePassword() {
  return resolveLanPassword({
    env: process.env,
    fileEnv: readEnvFile(resolve(root, ".env")),
    directory: runDir,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  if (process.platform === "win32") {
    // 空的双引号是 `start` 的标题位；没有它会把这个 URL 当窗口标题。
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}

function logTail(name, lines = 12) {
  const file = resolve(runDir, `${name}.log`);
  if (!existsSync(file)) return "";
  try {
    const all = readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function banner(text) {
  console.log(`\n${text}\n`);
}

// 谁在 3011/5199 上听着 —— 不依赖 HTTP 是否应答，半死进程也能找出来。
function listeningPids() {
  if (process.platform !== "win32") return [];
  try {
    const raw = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    const pids = new Set();
    for (const line of raw.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const match = /:(3011|5199)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
      if (match !== null) pids.add(Number(match[2]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// accept-serve 启动时把 launcher 的 pid 写进 serve-pids.json。
// 这个 pid 还活着，才说明「端口上的服务有人管、关窗口能停」。
function launcherPid() {
  if (!existsSync(pidFile)) return null;
  try {
    const saved = JSON.parse(readFileSync(pidFile, "utf8").replace(/^\uFEFF/, ""));
    return Number.isInteger(saved?.parent) ? saved.parent : null;
  } catch {
    return null;
  }
}

// 真正决定「有没有窗口能关」的是本进程（preview.mjs）还在不在。
// 只看 accept-serve 会误判：父进程被强杀后它照样活着，但已经没有窗口了。
function previewManaged() {
  if (!existsSync(previewPidFile)) return false;
  try {
    const pid = Number(readFileSync(previewPidFile, "utf8").trim());
    return Number.isInteger(pid) && pid !== process.pid && pidAlive(pid);
  } catch {
    return false;
  }
}

function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

// 把 3011/5199 上的旧东西全部收掉，等到端口真空才返回。
// 只碰这两个端口 —— 主人自己的 3001 和其它项目的进程不能受牵连。
async function clearLeftovers() {
  const found = listeningPids();
  if (found.length === 0) {
    rmSync(pidFile, { force: true });
    return true;
  }
  banner(`3011/5199 上还有旧进程（pid ${found.join("、")}），先停掉再起新的。`);

  // 首选项目自己的停止脚本：它按 pid 文件从 launcher 杀整棵树，比逐个杀监听者干净。
  if (existsSync(stopScript)) {
    try {
      process.stdout.write(execFileSync(process.execPath, [stopScript], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      }));
    } catch (error) {
      if (error?.stdout) process.stdout.write(String(error.stdout));
    }
  }

  // 兜底：pid 文件丢了或过期时，直接杀还在监听的进程。
  for (const pid of listeningPids()) {
    if (killTree(pid)) console.log(`已结束残留进程 pid ${pid}`);
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (listeningPids().length === 0) {
      rmSync(pidFile, { force: true });
      console.log("端口已清空。\n");
      return true;
    }
    await sleep(400);
  }
  return listeningPids().length === 0;
}

if (!existsSync(acceptServe)) {
  console.error(`找不到预览启动器：${acceptServe}`);
  console.error("这个文件在 .review/ 里，可能是被误删或被 git 清理过。");
  process.exit(1);
}

const before = await Promise.all([probe(targets.api), probe(targets.web)]);
const healthy = before.every((r) => r.ok);
const managed = previewManaged();
const leftover = listeningPids();
const existingLan = healthy ? await lanUrl() : null;

if (planOnly) {
  // 只报告、不动端口：验收用它证明「--lan 到底会做什么」，不必先杀掉主人的实例。
  const password = lanMode ? resolvePassword() : null;
  const env = lanMode ? { ...lanLaunchEnv(password.password), LIFEOS_LAN_PASSWORD: "<redacted>" } : { LIFEOS_LAN: "0" };
  console.log(JSON.stringify({
    mode: lanMode ? "lan" : "local",
    ports: { api: targets.api.port, web: webPort },
    running: healthy,
    managed,
    runningLanUrl: existingLan,
    env,
    passwordSource: password?.source ?? null,
    passwordLength: password?.password.length ?? 0,
    urls: lanPreviewUrls(webPort),
    adminPage: lanMode ? "off" : "on",
    firewallRulePresent: firewallRulePresent(),
    wouldRestart: healthy && lanMode && existingLan === null,
  }, null, 2));
  process.exit(0);
}

if (healthy && managed) {
  const alreadyLan = existingLan !== null;
  if (lanMode && !alreadyLan) {
    banner("当前实例只开给本机（管理员页开着）。现在换成局域网模式 —— 会重启一次，之后手机就能开 5199。");
  } else {
    banner(`预览已经在运行，直接打开：${previewUrl}`);
    if (lanMode) printLanBanner(existingLan, resolvePassword().password);
    else printLanHint(existingLan);
    console.log("要换成新实例的话：关掉那个预览窗口，再双击本文件。");
    console.log("窗口 3 秒后自动关闭，页面已经在浏览器里了。\n");
    openBrowser(previewUrl);
    await sleep(3000);
    process.exit(0);
  }
}

if (healthy && !managed) {
  console.log("\n3011/5199 上有服务在应答，但找不到管着它的窗口（上次大概被强杀了）。");
  console.log("先收掉它，再起一个你能用窗口关掉的实例。");
}

if (!healthy && leftover.length > 0) {
  const up = before
    .map((r, i) => (r.ok ? `${Object.values(targets)[i].label} ${Object.values(targets)[i].port}` : null))
    .filter(Boolean);
  console.log(`\n只有 ${up.join("、")} 还活着，另一半已经没了 —— 典型的半死状态。`);
}

// 走到这里只有两种可能：端口上留着不该留的东西，或者端口是空的。
// 前一种先清干净再起，省得主人自己跑停止脚本。
if (healthy || leftover.length > 0) {
  const cleared = await clearLeftovers();
  if (!cleared) {
    console.error("端口还是被占着，没能清掉。看看是谁：");
    console.error("    netstat -ano | findstr :3011");
    process.exit(1);
  }
}

banner(`正在启动 LifeOS 预览（API 3011 / Web 5199，${lanMode ? "局域网可访问" : "仅本机"}）…`);
console.log("首次启动或刚改过后端代码时，等十几秒是正常的。\n");

try { writeFileSync(previewPidFile, String(process.pid), "utf8"); } catch { /* 没有它只是少一层接管判断 */ }

// 局域网模式必须带登录密码（Vite 的代理会把 5199 直接变成 API 的入口）；
// 本机模式显式写 0，免得环境里残留的 LIFEOS_LAN=1 把端口悄悄开出去。
const lanPassword = lanMode ? resolvePassword() : null;
const childEnv = { ...process.env, ...(lanMode ? lanLaunchEnv(lanPassword.password) : { LIFEOS_LAN: "0" }) };
const child = spawn(process.execPath, [acceptServe], { cwd: root, stdio: "inherit", env: childEnv });

let childExited = false;
let childCode = null;
child.once("exit", (code) => {
  childExited = true;
  childCode = code;
});
child.once("error", (error) => {
  childExited = true;
  console.error(`启动失败：${String(error)}`);
});

const startedAt = Date.now();
let ready = false;
while (!childExited && Date.now() - startedAt < READY_TIMEOUT_MS) {
  const [api, web] = await Promise.all([probe(targets.api), probe(targets.web)]);
  if (api.ok && web.ok) {
    ready = true;
    break;
  }
  await sleep(700);
}

if (ready) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  banner(`✓ 预览已就绪（${seconds}s）${lanMode ? " · 局域网模式" : ""}：${previewUrl}`);
  if (lanMode) printLanBanner(await lanUrl(), lanPassword.password);
  else printLanHint(await lanUrl());
  console.log("浏览器会自动打开；没弹出就手动点上面的地址。");
  console.log("");
  console.log("这个窗口 = 停止按钮：关掉窗口（或按 Ctrl+C）预览就停了。");
  console.log("3011/5199 上是你自己的正式资料，不是测试数据。\n");
  openBrowser(previewUrl);
} else if (childExited) {
  console.error(`\n预览进程退出了（exit ${childCode}）。最近的日志：\n`);
  const apiLog = logTail("api");
  const webLog = logTail("web");
  if (apiLog) console.error(`--- api.log ---\n${apiLog}\n`);
  if (webLog) console.error(`--- web.log ---\n${webLog}\n`);
  process.exit(typeof childCode === "number" && childCode !== 0 ? childCode : 1);
} else {
  console.error(`\n等了 ${READY_TIMEOUT_MS / 1000}s 端口还没应答。服务进程还在，日志尾部：\n`);
  const apiLog = logTail("api");
  const webLog = logTail("web");
  if (apiLog) console.error(`--- api.log ---\n${apiLog}\n`);
  if (webLog) console.error(`--- web.log ---\n${webLog}\n`);
  console.error(`完整日志在：${runDir}`);
}

// Ctrl+C 会同时发给本进程和 accept-serve（同一控制台）。这里只负责体面退出，
// 真正的子进程树由 accept-serve 自己的 SIGINT 处理收掉。
process.on("SIGINT", () => setTimeout(() => process.exit(0), 600));
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 600));

// 本进程被外部强杀（沙箱、任务管理器、IDE 重启）时，accept-serve 会变成孤儿：
// 3011/5199 还占着，却再没有窗口能关掉它。2026-10-19 实测过一次（沙箱拦了
// 一个系统字体读取，父进程被杀，服务独自活了 5 小时）。所以退出时顺手收掉它。
process.on("exit", () => {
  if (child.exitCode === null && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已经不在了，没什么可收的。
    }
  }
  // 只删自己那份 pid 记录，别把下一个实例的抹掉。
  try {
    if (readFileSync(previewPidFile, "utf8").trim() === String(process.pid)) {
      rmSync(previewPidFile, { force: true });
    }
  } catch {
    // 文件本来就不在。
  }
});

await new Promise((done) => {
  if (childExited) done();
  else child.once("exit", done);
});
process.exit(typeof childCode === "number" ? childCode : 0);
