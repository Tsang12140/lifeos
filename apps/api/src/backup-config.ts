import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiConfig, BackupS3Config } from "./config.js";

export interface RuntimeBackupConfig {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly source: "env" | "file" | "none";
}

interface StoredBackupConfig {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  readonly encryptedAccessKeyId?: string;
  readonly accessKeyIdIv?: string;
  readonly accessKeyIdTag?: string;
  readonly encryptedSecretAccessKey?: string;
  readonly secretAccessKeyIv?: string;
  readonly secretAccessKeyTag?: string;
}

function configPath(config: ApiConfig): string {
  return join(config.dataDirectory, "backup-config.json");
}

function encryptionKey(config: ApiConfig): Buffer {
  const secret = process.env.LIFEOS_BACKUP_CONFIG_SECRET?.trim() || process.env.LIFEOS_PASSWORD || `lifeos-local-backup:${config.dataDirectory}`;
  return scryptSync(secret, "lifeos-backup-config-v1", 32);
}

function encrypt(config: ApiConfig, value: string): { encrypted: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { encrypted: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(config: ApiConfig, encrypted: string | undefined, iv: string | undefined, tag: string | undefined): string | undefined {
  if (!encrypted || !iv || !tag) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function readStored(config: ApiConfig): StoredBackupConfig | undefined {
  const path = configPath(config);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredBackupConfig>;
    if (typeof value.enabled !== "boolean" || typeof value.endpoint !== "string" || typeof value.region !== "string" || typeof value.bucket !== "string" || typeof value.prefix !== "string" || typeof value.forcePathStyle !== "boolean") return undefined;
    return value as StoredBackupConfig;
  } catch {
    return undefined;
  }
}

export function normalizeBackupEndpoint(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("对象存储 Endpoint 不能为空");
  if (/^https?\/\//i.test(value) || /^https?:\/(?!\/)/i.test(value)) throw new Error("对象存储 Endpoint 无效，请检查 https:// 是否完整");
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol === "file:") {
    if (url.search || url.hash) throw new Error("本地对象存储 Endpoint 格式不正确");
    return url.toString();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("对象存储 Endpoint 仅支持 http、https 或 file");
  if (!url.hostname || url.username || url.password || url.search || url.hash) throw new Error("对象存储 Endpoint 格式不正确");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function normalizeBucket(value: string): string {
  const bucket = value.trim();
  if (!bucket || bucket.includes("/") || bucket.includes("\\") || bucket === "." || bucket === "..") throw new Error("对象存储 Bucket 不能为空且不能包含路径");
  return bucket;
}

function normalizePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "") || "backups/db";
  if (prefix.split("/").some((part) => part === "." || part === ".." || part.includes("\\"))) throw new Error("对象存储路径不安全");
  return prefix;
}

function storedRuntime(config: ApiConfig, stored: StoredBackupConfig): RuntimeBackupConfig {
  const accessKeyId = decrypt(config, stored.encryptedAccessKeyId, stored.accessKeyIdIv, stored.accessKeyIdTag);
  const secretAccessKey = decrypt(config, stored.encryptedSecretAccessKey, stored.secretAccessKeyIv, stored.secretAccessKeyTag);
  return {
    enabled: stored.enabled,
    endpoint: normalizeBackupEndpoint(stored.endpoint),
    region: stored.region.trim(),
    bucket: normalizeBucket(stored.bucket),
    prefix: normalizePrefix(stored.prefix),
    forcePathStyle: stored.forcePathStyle,
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
    source: "file",
  };
}

export function readRuntimeBackupConfig(config: ApiConfig): RuntimeBackupConfig | undefined {
  const stored = readStored(config);
  if (stored !== undefined) return storedRuntime(config, stored);
  if (config.backupS3 === undefined) return undefined;
  return { ...config.backupS3, source: "env" };
}

export function resolvedBackupS3(config: ApiConfig): BackupS3Config | undefined {
  const runtime = readRuntimeBackupConfig(config);
  if (runtime === undefined || !runtime.accessKeyId || !runtime.secretAccessKey) return undefined;
  return {
    enabled: runtime.enabled,
    endpoint: runtime.endpoint,
    region: runtime.region,
    bucket: runtime.bucket,
    prefix: runtime.prefix,
    forcePathStyle: runtime.forcePathStyle,
    accessKeyId: runtime.accessKeyId,
    secretAccessKey: runtime.secretAccessKey,
  };
}

export function publicBackupConfig(config: ApiConfig): { readonly configured: boolean; readonly enabled: boolean; readonly endpoint: string; readonly region: string; readonly bucket: string; readonly prefix: string; readonly forcePathStyle: boolean; readonly keySource: RuntimeBackupConfig["source"] } {
  const runtime = readRuntimeBackupConfig(config);
  if (runtime === undefined) return { configured: false, enabled: false, endpoint: "https://s3.bitiful.net", region: "cn-east-1", bucket: "cdnb", prefix: "product-backup/lifeos", forcePathStyle: false, keySource: "none" };
  return { configured: Boolean(runtime.accessKeyId && runtime.secretAccessKey), enabled: runtime.enabled, endpoint: runtime.endpoint, region: runtime.region, bucket: runtime.bucket, prefix: runtime.prefix, forcePathStyle: runtime.forcePathStyle, keySource: runtime.source };
}

export function saveRuntimeBackupConfig(config: ApiConfig, input: { readonly enabled: boolean; readonly endpoint: string; readonly region: string; readonly bucket: string; readonly prefix: string; readonly forcePathStyle: boolean; readonly accessKeyId?: string; readonly secretAccessKey?: string }): ReturnType<typeof publicBackupConfig> {
  const current = readRuntimeBackupConfig(config);
  const endpoint = normalizeBackupEndpoint(input.endpoint);
  const region = input.region.trim();
  if (!region) throw new Error("对象存储 Region 不能为空");
  const bucket = normalizeBucket(input.bucket);
  const prefix = normalizePrefix(input.prefix);
  const sameProvider = current !== undefined && normalizeBackupEndpoint(current.endpoint) === endpoint && current.region === region && current.bucket === bucket;
  const accessKeyId = input.accessKeyId?.trim() || (sameProvider ? current?.accessKeyId : undefined);
  const secretAccessKey = input.secretAccessKey?.trim() || (sameProvider ? current?.secretAccessKey : undefined);
  if (input.enabled && (!accessKeyId || !secretAccessKey)) throw new Error("启用对象存储前，请填写 Access Key 和 Secret Key");
  const encryptedAccess = accessKeyId ? encrypt(config, accessKeyId) : undefined;
  const encryptedSecret = secretAccessKey ? encrypt(config, secretAccessKey) : undefined;
  const stored: StoredBackupConfig = {
    enabled: input.enabled,
    endpoint,
    region,
    bucket,
    prefix,
    forcePathStyle: input.forcePathStyle,
    ...(encryptedAccess ? { encryptedAccessKeyId: encryptedAccess.encrypted, accessKeyIdIv: encryptedAccess.iv, accessKeyIdTag: encryptedAccess.tag } : {}),
    ...(encryptedSecret ? { encryptedSecretAccessKey: encryptedSecret.encrypted, secretAccessKeyIv: encryptedSecret.iv, secretAccessKeyTag: encryptedSecret.tag } : {}),
  };
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(configPath(config), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return publicBackupConfig(config);
}
