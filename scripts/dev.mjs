import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const npmCli = process.env.npm_execpath ?? (process.platform === "win32" ? resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : "npm");
function runNpm(args) {
  return spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit", shell: false });
}

const build = runNpm(["run", "build", "--workspace", "@lifeos/core"]);
if (build.status !== 0) process.exit(build.status ?? 1);
const apiBuild = runNpm(["run", "build", "--workspace", "@lifeos/api"]);
if (apiBuild.status !== 0) process.exit(apiBuild.status ?? 1);

// `.env` holds local settings such as BACKUP_S3_* credentials. Node loads it
// itself; a missing file is fine, so both `npm run dev` and `npm start` read the
// same file and no dotenv dependency is needed.
const envFile = resolve(".env");

const children = [
  spawn(process.execPath, [`--env-file-if-exists=${envFile}`, "apps/api/dist/src/main.js"], { stdio: "inherit", env: process.env }),
  spawn(process.execPath, [
    resolve("node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    ...(process.env.LIFEOS_WEB_PORT === undefined ? [] : ["--port", process.env.LIFEOS_WEB_PORT]),
  ], {
    cwd: resolve("apps/web"),
    stdio: "inherit",
    shell: false,
    env: process.env,
  }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250);
}

for (const child of children) {
  child.once("error", () => shutdown(1));
  child.once("exit", (code) => {
    if (!shuttingDown && code !== 0) shutdown(code ?? 1);
  });
}
process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
