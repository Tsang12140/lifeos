/**
 * One source of truth for "which build is this?".
 *
 * A hand-maintained version number drifts: it is forgotten on the day it matters,
 * and then the number on screen describes nothing. So the commit hash is the
 * primary identifier — it is generated, it always matches the code, and
 * `git show <hash>` answers everything. `package.json`'s version stays as the
 * human-readable semantic slot, and `dirty` exists because a build made from an
 * uncommitted tree does not correspond to any hash at all.
 *
 * Read by `vite.config.ts` (baked into the bundle) and by
 * `scripts/write-build-info.mjs` (written next to the compiled API).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // No git, no repository, or a git that refuses this directory: the build still
    // has to succeed, it just cannot name itself.
    return "";
  }
}

export function readBuildInfo() {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    if (typeof pkg.version === "string" && pkg.version.length > 0) version = pkg.version;
  } catch {
    /* a missing package.json is not worth failing a build over */
  }
  const commit = git(["rev-parse", "--short", "HEAD"]);
  const committedAt = git(["log", "-1", "--format=%cI"]);
  return {
    version,
    commit: commit || null,
    committedAt: committedAt || null,
    dirty: git(["status", "--porcelain"]).length > 0,
    builtAt: new Date().toISOString(),
  };
}
