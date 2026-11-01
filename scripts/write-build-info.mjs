/**
 * Writes `apps/api/dist/build-info.json` right after `tsc`, so the running API can
 * say which commit it was compiled from. `dist/` is gitignored, so this file never
 * travels through git — it is produced by the same build that produced the code,
 * which is exactly the guarantee needed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "./lib/build-info.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(ROOT, "apps/api/dist/build-info.json");
const info = readBuildInfo();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: ${info.version}${info.commit === null ? "" : ` · ${info.commit}`}${info.dirty ? " +dirty" : ""}`);
