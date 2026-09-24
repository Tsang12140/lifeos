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

/**
 * Integration keys a member space borrows from the server instead of bringing
 * its own. Invites are handed out by the owner to people they trust, and the
 * owner's standing instruction is that an invited person never has to go and
 * register their own weather or AI account — so these are inherited.
 *
 * Nothing location-shaped is inherited: a member in another city must not be
 * shown the owner's forecast. They pick their own city, and their device
 * choice lives in their own database.
 */
export interface SharedIntegrations {
  readonly ai?: { readonly apiKey: string; readonly baseUrl: string; readonly model: string };
  readonly weather?: { readonly apiKey: string; readonly host: string };
}

/** Build an isolated runtime config. Client input never participates in any path. */
export function tenantConfigFor(root: ApiConfig, account: AccountIdentity, masterSecret: string, shared?: SharedIntegrations): ApiConfig {
  const dataDirectory = ensureTenantDirectory(root, account.tenantId);
  const {
    password: _rootPassword,
    ownerUsername: _ownerUsername,
    accountMode: _accountMode,
    gatewayAuthenticated: _gatewayAuthenticated,
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
    accountMode: false,
    gatewayAuthenticated: true,
    // Handed down as the env-level fallback, so a member's own saved settings
    // still win and a key they never typed still works.
    ...(shared?.ai === undefined ? {} : { deepseekApiKey: shared.ai.apiKey, deepseekBaseUrl: shared.ai.baseUrl, deepseekModel: shared.ai.model }),
    ...(shared?.weather === undefined ? {} : { qweatherApiKey: shared.weather.apiKey, qweatherHost: shared.weather.host }),
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
