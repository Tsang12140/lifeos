import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

// Versioned framing, fixed crypto parameters, authenticated header. No executable archive paths.
const MAGIC = Buffer.from("LIFEOS01");
const HEADER_BYTES = 36;
const TAG_BYTES = 16;
export const ARCHIVE_MAX_BYTES = 20 * 1024 ** 3;
export const MANIFEST_MAX_BYTES = 32 * 1024 ** 2;

async function key(password: string, salt: Buffer): Promise<Buffer> {
  if (password.length < 10 || password.length > 1024) throw new Error("密码长度需为 10–1024 个字符");
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }, (error, derived) => error ? reject(error) : resolve(derived)));
}

export async function encryptArchive(parts: AsyncIterable<Buffer>, destination: string, password: string, signal?: AbortSignal): Promise<void> {
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const secret = await key(password, salt);
  const cipher = createCipheriv("aes-256-gcm", secret, iv, { authTagLength: TAG_BYTES });
  secret.fill(0);
  cipher.setAAD(header);
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  try {
    await pipeline((async function* () { yield header; for await (const part of parts) yield cipher.update(part); yield cipher.final(); yield cipher.getAuthTag(); })(), output, { signal });
  } catch (error) { await unlink(destination).catch(() => {}); throw error; }
}

/** All decrypted bytes remain private staging until the final authentication tag succeeds. */
export async function decryptArchive(source: string, destination: string, password: string, signal?: AbortSignal): Promise<void> {
  const size = (await stat(source)).size;
  if (size < HEADER_BYTES + TAG_BYTES + 4 || size > ARCHIVE_MAX_BYTES) throw new Error("加密包大小无效或超过 20 GB");
  const file = await open(source, "r");
  let header: Buffer, tag: Buffer;
  try {
    header = Buffer.alloc(HEADER_BYTES); tag = Buffer.alloc(TAG_BYTES);
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, tag.length, size - TAG_BYTES);
  } finally { await file.close(); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error("不支持的完整加密包格式");
  const secret = await key(password, header.subarray(8, 24));
  const decipher = createDecipheriv("aes-256-gcm", secret, header.subarray(24), { authTagLength: TAG_BYTES });
  secret.fill(0); decipher.setAAD(header); decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(source, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
  } catch { await unlink(destination).catch(() => {}); throw new Error("密码不正确，或加密包已损坏"); }
}
