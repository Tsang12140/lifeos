/**
 * Content hashing behind the composer's "the library already has this photo"
 * shortcut.
 *
 * `crypto.subtle` only exists in a secure context: `http://127.0.0.1` and
 * `http://localhost` count, but a plain-HTTP LAN address such as
 * `http://192.168.1.20:3001` does not. So this reports "cannot hash" instead of
 * throwing, and the caller uploads normally. Deduplication is an optimisation,
 * and an optimisation must never be able to break uploading.
 */
export async function sha256Hex(source: Blob): Promise<string | null> {
  const subtle: SubtleCrypto | undefined = (globalThis as { readonly crypto?: Crypto }).crypto?.subtle;
  if (subtle === undefined) return null;
  try {
    const digest = await subtle.digest("SHA-256", await source.arrayBuffer());
    let hex = "";
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
    return hex;
  } catch {
    // A browser that refuses to hash is a browser that simply uploads.
    return null;
  }
}
