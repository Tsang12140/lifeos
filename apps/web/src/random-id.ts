/**
 * `crypto.randomUUID()` is secure-context only, exactly like `crypto.subtle`.
 * A phone opening the app over `http://192.168.x.x:5199` is not a secure
 * context, so a bare call throws `TypeError: crypto.randomUUID is not a
 * function` — and an exception thrown from a React effect unmounts the whole
 * tree, which is indistinguishable from "the page is blank".
 *
 * IDs here are client-side correlation tokens (background-viewing heartbeat,
 * assistant turn ids, plan keys), never security tokens, so a timestamp plus
 * Math.random is an acceptable last resort.
 */
export function randomId(): string {
  const cryptoApi = (globalThis as { readonly crypto?: Crypto }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
