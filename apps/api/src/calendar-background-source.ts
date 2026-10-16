import { createHash } from "node:crypto";
import { win32 } from "node:path";
import type { Asset } from "@lifeos/core";

/** Only Windows paths are case-insensitive; tenant paths on Linux remain distinct. */
export function backgroundNamespace(value: string, platform: string = process.platform): string {
  return platform === "win32" ? win32.normalize(value).toLowerCase() : value;
}

/** Revalidate pre-fix manifests against the old spelling without discarding their artwork. */
export function legacyBackgroundNamespaces(value: string, platform: string = process.platform): readonly string[] {
  return [...new Set([value, ...(platform === "win32" && /^[a-z]:/i.test(value)
    ? [value.replace(/^[a-z]/i, c => c.toUpperCase()), value.replace(/^[a-z]/i, c => c.toLowerCase())] : [])])];
}

export function backgroundSourceVersion(asset: Asset, fallback: string): string {
  const content = asset.storageRefs.find(ref => ref.contentHash)?.contentHash;
  return content ? createHash("sha256").update(JSON.stringify(["background-photo-v1", asset.id, content.algorithm, content.value])).digest("hex") : fallback;
}
