import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyInstanceBackup } from "./instance-backup.mjs";

const MANIFEST = "lifeos-instance-manifest.json";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 100_000;

function hmac(key, value) { return createHmac("sha256", key).update(value).digest(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function encoded(value) { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase()); }
function within(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function safeRelative(value) {
  return typeof value === "string" && value !== "" && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0"));
}
function validateManifest(value) {
  if (value?.version !== 1 || !Array.isArray(value.files) || value.files.length > MAX_FILES) throw new Error("整站备份清单版本或文件数量无效");
  const names = new Set();
  for (const file of value.files) {
    if (!safeRelative(file?.path) || names.has(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) throw new Error("整站备份清单含不安全或重复文件");
    names.add(file.path);
  }
  if (!names.has("lifeos.sqlite")) throw new Error("整站备份缺少 owner 数据库");
  return value;
}
function configOf(input, allowInsecureLocal = false) {
  if (!input?.enabled || !input.accessKeyId || !input.secretAccessKey || !input.bucket || !input.region) throw new Error("整站异地备份需要已启用且带完整密钥的对象存储配置");
  const endpoint = new URL(input.endpoint);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(allowInsecureLocal && local && endpoint.protocol === "http:")) throw new Error("整站备份只允许 HTTPS 对象存储");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("对象存储地址不安全");
  const prefix = input.prefix.replace(/^\/+|\/+$/g, "");
  if (!safeRelative(prefix) || !safeRelative(input.bucket) || input.bucket.includes("/")) throw new Error("对象存储 Bucket 或路径不安全");
  return { ...input, endpoint, prefix };
}
function remoteKeys(config, hash) {
  return config.prefix + "/instance-v1/objects/" + hash;
}
function manifestPrefix(config) { return config.prefix + "/instance-v1/manifests/"; }
function objectUrl(config, key) {
  const segments = key.split("/").map(encoded).join("/");
  const path = config.endpoint.pathname.replace(/\/$/, "");
  if (config.forcePathStyle) return new URL(config.endpoint.protocol + "//" + config.endpoint.host + path + "/" + encoded(config.bucket) + "/" + segments);
  return new URL(config.endpoint.protocol + "//" + config.bucket + "." + config.endpoint.host + path + "/" + segments);
}
function signingKey(secret, day, region) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, day), region), "s3"), "aws4_request");
}
async function request(config, method, key, { file, bytes, hash, size, ifAbsent = false } = {}) {
  const url = objectUrl(config, key);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = now.slice(0, 8);
  const payloadHash = hash ?? sha256(bytes ?? "");
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": now,
    ...(file || bytes ? { "content-length": String(size ?? bytes.length), "x-amz-meta-sha256": payloadHash } : {}),
    ...(ifAbsent ? { "if-none-match": "*" } : {}),
  };
  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((name) => name + ":" + String(headers[name]).trim() + "\n").join("");
  const canonicalPath = url.pathname.split("/").map((part) => encoded(decodeURIComponent(part))).join("/");
  const canonical = [method, canonicalPath, "", canonicalHeaders, headerNames.join(";"), payloadHash].join("\n");
  const scope = day + "/" + config.region + "/s3/aws4_request";
  const signature = createHmac("sha256", signingKey(config.secretAccessKey, day, config.region))
    .update(["AWS4-HMAC-SHA256", now, scope, sha256(canonical)].join("\n")).digest("hex");
  headers.authorization = "AWS4-HMAC-SHA256 Credential=" + config.accessKeyId + "/" + scope
    + ", SignedHeaders=" + headerNames.join(";") + ", Signature=" + signature;
  const options = { method, headers, signal: AbortSignal.timeout(120_000) };
  if (file) { options.body = Readable.toWeb(createReadStream(file)); options.duplex = "half"; }
  if (bytes) options.body = new Uint8Array(bytes);
  return fetch(url, options);
}
async function checked(response, action) {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  throw new Error(action + "失败：HTTP " + response.status + " " + body.slice(0, 180));
}
async function headMatches(config, key, file) {
  const response = await request(config, "HEAD", key);
  if (response.status === 404) return false;
  await checked(response, "检查异地对象");
  if (Number(response.headers.get("content-length")) !== file.sizeBytes
    || response.headers.get("x-amz-meta-sha256") !== file.sha256) throw new Error("异地同名对象与本地快照不一致，拒绝覆盖：" + key);
  return true;
}
async function fileHash(path) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); sizeBytes += chunk.length; }
  return { sha256: hash.digest("hex"), sizeBytes };
}
async function boundedBody(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_MANIFEST_BYTES) throw new Error("异地备份清单过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function assertPrivateDestination(config) {
  const key = config.prefix + "/instance-v1/objects/probe-" + randomUUID();
  const bytes = Buffer.from("lifeos-private-backup-probe-" + randomUUID());
  await checked(await request(config, "PUT", key, { bytes, ifAbsent: true }), "检查异地备份权限");
  try {
    const anonymous = await fetch(objectUrl(config, key), { signal: AbortSignal.timeout(15_000) });
    if (anonymous.ok) throw new Error("对象存储允许匿名读取，拒绝上传账号库和照片");
    if (![401, 403, 404].includes(anonymous.status)) throw new Error("无法确认对象存储是否私有：HTTP " + anonymous.status);
  } finally {
    await checked(await request(config, "DELETE", key), "清理私有性探针");
  }
}

/** Fail before stopping the live PM2 process if remote credentials or privacy are wrong. */
export async function checkInstanceDestination({ s3, allowInsecureLocal = false }) {
  const config = configOf(s3, allowInsecureLocal);
  await assertPrivateDestination(config);
  return { private: true, bucket: config.bucket, prefix: config.prefix };
}
async function newDirectory(target) {
  if (!target) throw new Error("必须指定一个全新的目标目录");
  const absolute = resolve(target);
  const parent = await realpath(dirname(absolute));
  const next = join(parent, absolute.slice(dirname(absolute).length + 1));
  try { await lstat(next); } catch (error) {
    if (error?.code === "ENOENT") { await mkdir(next, { mode: 0o700 }); return next; }
    throw error;
  }
  throw new Error("目标目录已存在，拒绝覆盖：" + next);
}

/** Upload verified immutable objects first, then publish the manifest last. */
export async function uploadInstanceSnapshot({ snapshot, s3, allowInsecureLocal = false }) {
  const config = configOf(s3, allowInsecureLocal);
  const verified = await verifyInstanceBackup(snapshot);
  const manifestBytes = await readFile(join(verified.snapshot, MANIFEST));
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  await assertPrivateDestination(config);
  let uploaded = 0;
  let reused = 0;
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    const key = remoteKeys(config, file.sha256);
    if (await headMatches(config, key, file)) { reused += 1; continue; }
    const local = join(verified.snapshot, ...file.path.split("/"));
    const current = await fileHash(local);
    if (current.sha256 !== file.sha256 || current.sizeBytes !== file.sizeBytes) throw new Error("上传时本地快照已改变：" + file.path);
    await checked(await request(config, "PUT", key, { file: local, hash: file.sha256, size: file.sizeBytes, ifAbsent: true }), "上传整站文件");
    if (!await headMatches(config, key, file)) throw new Error("上传后异地对象仍不存在：" + key);
    uploaded += 1;
  }
  const identity = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "") + "-" + randomUUID();
  const manifestKey = manifestPrefix(config) + identity + ".json";
  const manifestFile = join(verified.snapshot, MANIFEST);
  const manifestHash = sha256(manifestBytes);
  await checked(await request(config, "PUT", manifestKey, { file: manifestFile, hash: manifestHash, size: manifestBytes.length, ifAbsent: true }), "发布整站备份清单");
  return { manifestKey, fileCount: manifest.files.length, uploaded, reused, bytes: verified.bytes };
}

/** Download to a new directory, verify every byte, then use restoreInstanceBackup. */
export async function downloadInstanceSnapshot({ manifestKey, target, s3, allowInsecureLocal = false }) {
  const config = configOf(s3, allowInsecureLocal);
  if (typeof manifestKey !== "string" || !manifestKey.startsWith(manifestPrefix(config))
    || !/^[^/]+\.json$/.test(manifestKey.slice(manifestPrefix(config).length))) throw new Error("整站清单不属于指定的 LifeOS 前缀");
  const response = await checked(await request(config, "GET", manifestKey), "下载整站备份清单");
  const raw = await boundedBody(response);
  const manifest = validateManifest(JSON.parse(raw.toString("utf8")));
  const output = await newDirectory(target);
  // Incomplete downloads remain visibly incomplete: no manifest is written
  // until all objects hash correctly. Never overwrite or auto-delete a target.
  for (const file of manifest.files) {
    const path = join(output, ...file.path.split("/"));
    if (!within(output, path)) throw new Error("清单路径越界");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const object = await checked(await request(config, "GET", remoteKeys(config, file.sha256)), "下载整站文件");
    if (!object.body) throw new Error("异地文件没有内容：" + file.path);
    await pipeline(Readable.fromWeb(object.body), createWriteStream(path, { flags: "wx", mode: 0o600 }));
    const actual = await fileHash(path);
    if (actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes) throw new Error("异地文件校验失败：" + file.path);
  }
  await writeFile(join(output, MANIFEST), raw, { flag: "wx", mode: 0o600 });
  await verifyInstanceBackup(output);
  return { snapshot: output, fileCount: manifest.files.length };
}
