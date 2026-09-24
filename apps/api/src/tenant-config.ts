import { createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ApiConfig } from "./config.js";
import type { AccountIdentity } from "./identity-store.js";

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export function tenantDirectoryFor(config: ApiConfig, tenantId: string): string {
  if (!TENANT_ID.test(tenantId)) throw new Error("Invalid tenant identity");
  return resolve(config.dataDirectory, "tenants", tenantId.toLowerCase());
}

export function ensureTenantDirectory(config: ApiConfig, tenantId: string): string {
  const tenantsRoot = resolve(config.dataDirectory, "tenants");
  mkdirSync(tenantsRoot, { recursive: true });
  if (lstatSync(tenantsRoot).isSymbolicLink()) throw new Error("Tenant storage root must not be a symbolic link");
  const tenantDirectory = tenantDirectoryFor(config, tenantId);
  if (existsSync(tenantDirectory) && lstatSync(tenantDirectory).isSymbolicLink()) throw new Error("Tenant storage directory must not be a symbolic link");
  mkdirSync(tenantDirectory, { recursive: true });
  const realRoot = realpathSync(tenantsRoot);
  const realTenant = realpathSync(tenantDirectory);
  if (!isWithin(realRoot, realTenant) || realTenant === realRoot) throw new Error("Tenant storage escaped its storage root");
  for (const child of ["assets", "backups"]) {
    const childPath = join(tenantDirectory, child);
    if (existsSync(childPath) && lstatSync(childPath).isSymbolicLink()) throw new Error(`Tenant ${child} directory must not be a symbolic link`);
    mkdirSync(childPath, { recursive: true });
    if (!isWithin(realTenant, realpathSync(childPath))) throw new Error(`Tenant ${child} directory escaped its storage root`);
  }
  return tenantDirectory;
}

function deriveConfigSecret(masterSecret: string, tenantId: string, module: string): string {
  return createHmac("sha256", masterSecret).update(`lifeos:tenant-config:v1:${tenantId}:${module}`, "utf8").digest("hex");
}

/** Build an isolated runtime config. Client input never participates in any path. */
export function tenantConfigFor(root: ApiConfig, account: AccountIdentity, masterSecret: string): ApiConfig {
  const dataDirectory = ensureTenantDirectory(root, account.tenantId);
  const {
    deepseekApiKey: _deepseekApiKey,
    qweatherApiKey: _qweatherApiKey,
    qweatherLocation: _qweatherLocation,
    qweatherCity: _qweatherCity,
    tmdbApiKey: _tmdbApiKey,
    backupS3: _backupS3,
    ...safeRoot
  } = root;
  return {
    ...safeRoot,
    dataDirectory,
    databasePath: join(dataDirectory, "lifeos.sqlite"),
    assetRoot: join(dataDirectory, "assets"),
    backupDirectory: join(dataDirectory, "backups"),
    tenantConfigSecrets: {
      ai: deriveConfigSecret(masterSecret, account.tenantId, "ai"),
      weather: deriveConfigSecret(masterSecret, account.tenantId, "weather"),
      movie: deriveConfigSecret(masterSecret, account.tenantId, "movie"),
      backup: deriveConfigSecret(masterSecret, account.tenantId, "backup"),
    },
    backupObjectPrefix: `lifeos-spaces/${account.tenantId}`,
  };
}
