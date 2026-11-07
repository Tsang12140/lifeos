// LAN preview helpers shared by scripts/preview.mjs and .review/accept-serve.mjs.
//
// The preview is reachable from the local network by default (the owner opens it
// from a phone), so it always carries a login password: the Vite dev server
// proxies /api, and a passwordless LAN port would be an open data endpoint.
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { resolve } from "node:path";

export const LAN_PASSWORD_FILE = "lan-password.txt";

// No 0/o/1/l/i — this password gets typed on a phone.
const PASSWORD_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

// Adapters a phone can never reach: WSL, virtual machines, VPNs, container bridges.
const VIRTUAL_INTERFACE = /^(vEthernet|VMware|VirtualBox|Tailscale|ZeroTier|Hyper-V|docker|br-|utun|wg|tap|tun)/i;

function ipv4Interfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => ({ name, address: entry.address })));
}

/** Non-internal IPv4 addresses of this machine, in no particular order. */
export function lanAddresses() {
  return [...new Set(ipv4Interfaces().map((entry) => entry.address))];
}

/**
 * Addresses worth printing: physical adapters first, private ranges ahead of
 * public ones. A phone on the same Wi-Fi cannot open a WSL or VM adapter address,
 * so those are dropped unless they are all this machine has.
 */
export function preferredLanAddresses() {
  const all = ipv4Interfaces();
  const physical = all.filter((entry) => !VIRTUAL_INTERFACE.test(entry.name));
  const rank = (address) => {
    if (address.startsWith("192.168.")) return 0;
    if (address.startsWith("10.")) return 1;
    if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(address)) return 2;
    return 3;
  };
  return [...new Set((physical.length > 0 ? physical : all).map((entry) => entry.address))]
    .sort((left, right) => rank(left) - rank(right));
}

function originHosts() {
  const hosts = new Set(["127.0.0.1", "localhost"]);
  for (const address of lanAddresses()) hosts.add(address);
  const machine = hostname().trim().toLowerCase();
  // A name with spaces or non-ASCII characters cannot appear in an Origin header.
  if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(machine)) hosts.add(machine);
  return [...hosts];
}

/**
 * Origins the API must accept. Phones reach the dev server by LAN IP, which
 * changes with DHCP, so this is recomputed on every launch.
 */
export function lanOrigins(port, extra = []) {
  const origins = new Set(extra.filter((value) => typeof value === "string" && value !== ""));
  for (const host of originHosts()) origins.add(`http://${host}:${port}`);
  return [...origins];
}

// Windows Firewall blocks the phone long before Vite does: the owner's network
// is classified "Public" and Node has no inbound rule at all, so a 0.0.0.0 bind
// is still unreachable from the phone. `scripts/allow-lan-firewall.ps1` owns this
// exact name; keep the two in sync.
export const FIREWALL_RULE_NAME = "LifeOS LAN preview";

/**
 * Env a preview launcher must hand to accept-serve to open the LAN port.
 * Blank passwords are refused rather than silently starting an open data port.
 * Kept pure so the launcher's mapping can be asserted without binding a port.
 */
export function lanLaunchEnv(password) {
  const value = typeof password === "string" ? password.trim() : "";
  if (value === "") throw new Error("a LAN preview must require a login password");
  return { LIFEOS_LAN: "1", LIFEOS_LAN_PASSWORD: value };
}

/** The URL for this machine plus the ones a phone on the same Wi-Fi can use. */
export function lanPreviewUrls(port) {
  return {
    local: `http://127.0.0.1:${port}/`,
    phones: preferredLanAddresses().map((address) => `http://${address}:${port}/`),
  };
}

/**
 * Proxy variables that have to be in the **child process's environment**, not
 * only in `.env`. Node reads `HTTPS_PROXY` / `NO_PROXY` during bootstrap for
 * `--use-env-proxy`, which runs *before* `--env-file` is applied — so a `.env`
 * only setting never reaches the proxy. Symptom when it breaks: every
 * `POST /api/movie/resolve` answers 502 `movie_tmdb_unavailable`, because
 * api.themoviedb.org is DNS-poisoned on this machine and needs the local proxy.
 * The live environment wins (so a shell can override for one run); `.env` only
 * fills the gaps.
 */
export function proxyLaunchEnv(env = process.env, fileEnv = {}) {
  const picked = {};
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    const value = (env[key] ?? fileEnv[key] ?? "").trim();
    if (value !== "") picked[key] = value;
  }
  return picked;
}

/**
 * `.env` reader for launchers that need one value before spawning the API
 * (accept-serve reads it itself; preview.mjs needs the password up front so it
 * can print it in the window).
 */
export function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const values = {};
  // Strip the BOM: a Notepad/PowerShell-saved .env would otherwise mangle the
  // first key name, and the failure is silent.
  for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    values[match[1]] = match[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return values;
}

/**
 * Password for the LAN preview, in priority order: explicit env vars, `.env`,
 * a password persisted by an earlier launch, or a freshly generated one.
 * Persisting it is what makes "double-click and open it on the phone" work
 * without prompting every time.
 */
export function resolveLanPassword({ env = process.env, fileEnv = {}, directory } = {}) {
  const fromEnv = env.LIFEOS_LAN_PASSWORD?.trim() || env.LIFEOS_PASSWORD?.trim();
  if (fromEnv) return { password: fromEnv, source: "environment" };

  const fromFileEnv = fileEnv.LIFEOS_LAN_PASSWORD?.trim() || fileEnv.LIFEOS_PASSWORD?.trim();
  if (fromFileEnv) return { password: fromFileEnv, source: ".env" };

  const file = resolve(directory, LAN_PASSWORD_FILE);
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
    if (saved !== "") return { password: saved, source: file };
  }

  let password = "";
  for (let index = 0; index < 8; index += 1) password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${password}\n`, "utf8");
  return { password, source: file, generated: true };
}
