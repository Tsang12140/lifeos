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
