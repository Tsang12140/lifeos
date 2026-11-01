import { readFileSync } from "node:fs";

/**
 * What the running API was built from.
 *
 * `dist/build-info.json` is written by `scripts/write-build-info.mjs` in the same
 * build step as the code, so it cannot describe a different tree. When the API is
 * started straight from source (no build), the file is absent and this falls back
 * to `package.json` plus an explicit `LIFEOS_BUILD_COMMIT`, rather than inventing a
 * hash it does not know.
 */
export interface BuildInfo {
  readonly version: string;
  readonly commit: string | null;
  readonly committedAt: string | null;
  readonly dirty: boolean;
  readonly builtAt: string | null;
}

function readJson(url: URL): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildInfo(): BuildInfo {
  // Compiled: dist/src/build-info.js → dist/build-info.json
  const generated = readJson(new URL("../build-info.json", import.meta.url));
  // Compiled: dist/src/ → apps/api/package.json; from source: src/ → apps/api/package.json
  const pkg = readJson(new URL("../../package.json", import.meta.url));
  return {
    version: text(generated?.version) ?? text(pkg?.version) ?? "0.0.0",
    commit: text(generated?.commit) ?? text(process.env.LIFEOS_BUILD_COMMIT),
    committedAt: text(generated?.committedAt),
    dirty: generated?.dirty === true,
    builtAt: text(generated?.builtAt),
  };
}
