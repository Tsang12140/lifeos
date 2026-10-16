import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRuntimeAiConfig } from "./ai-config.js";
import type { ApiConfig } from "./config.js";

/**
 * The two things this library can do with a picture, and the owner's permission for each.
 *
 * They are separate switches because they are separate bargains. **Reading the words**
 * (`ocr`) spends a service's monthly allowance, of which a thousand are free; **naming
 * what the picture is** (`caption`) spends model tokens on every single picture, forever.
 * An owner can reasonably want one and not the other — and switching one off must not
 * quietly switch the other off with it.
 *
 * The switch is *permission*, not capability. Whether the machine could do it is a
 * different question, answered from the credentials, and the panel shows both: a feature
 * that is on but has no key is not the same as one the owner turned off, and only one of
 * those two is fixed by finding a key.
 *
 * Off means off for this library: nothing is sent, nothing is filed, no timer is armed.
 * What it does *not* mean is amnesia — entries already read stay where they are, because
 * throwing away search results the owner paid for is not what "stop reading" says.
 */

/** A capability, coarser than a pass: three caption variants share one switch. */
export type PhotoTextCapability = "caption" | "ocr";
export const PHOTO_TEXT_CAPABILITIES: readonly PhotoTextCapability[] = ["caption", "ocr"];

/** Values as they are stored. Only booleans, so this file needs no encryption. */
interface StoredPhotoTextConfig {
  readonly caption: boolean;
  readonly ocr: boolean;
}

export interface RuntimePhotoTextConfig {
  readonly caption: boolean;
  readonly ocr: boolean;
  readonly source: "default" | "file";
}

/**
 * Why a capability is not usable, when it is not.
 *
 *   · `ready`         — allowed, and the machine has what it needs.
 *   · `switched-off`  — the owner turned it off. The credential, if any, is irrelevant.
 *   · `no-credential` — allowed, but this machine cannot do it. Fixable by configuration,
 *                       which is the only reason the two cases are told apart.
 */
export type PhotoTextState = "ready" | "switched-off" | "no-credential";

export interface PhotoTextCapabilityStatus {
  /** The owner's switch. */
  readonly enabled: boolean;
  /** This machine holds what the capability needs to run at all. */
  readonly credentials: boolean;
  readonly state: PhotoTextState;
  /** Allowed *and* able — the only combination under which work happens. */
  readonly available: boolean;
}

export interface PhotoTextStatus {
  readonly caption: PhotoTextCapabilityStatus;
  readonly ocr: PhotoTextCapabilityStatus;
}

function configPath(config: ApiConfig): string {
  return join(config.dataDirectory, "photo-text-config.json");
}

/**
 * The stored switches, or nothing at all when they cannot be had.
 *
 * Every failure mode — a missing directory, an unreadable file, half-written JSON, a value
 * that is not a boolean — collapses to `undefined`, which the caller reads as "both on".
 * Reading this file happens on the save path (the trigger asks before arming), so it must
 * never be able to throw: a malformed settings file would otherwise fail a diary save that
 * has nothing to do with photos. Failing towards "on" is also the safer direction — an
 * owner who cannot switch a feature off will say so, whereas one whose photos silently
 * stop being read has no way to find out.
 */
function readStored(config: ApiConfig): StoredPhotoTextConfig | undefined {
  try {
    const path = configPath(config);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredPhotoTextConfig>;
    if (typeof value.caption !== "boolean" || typeof value.ocr !== "boolean") return undefined;
    return { caption: value.caption, ocr: value.ocr };
  } catch {
    return undefined;
  }
}

/**
 * Both on unless a file says otherwise — and a file that cannot be read says nothing.
 *
 * This direction matters: the feature existed before the switches did, so "no file" has to
 * keep meaning exactly what it meant yesterday, or every existing library would silently
 * stop reading its photos the moment this shipped.
 */
export function readRuntimePhotoTextConfig(config: ApiConfig): RuntimePhotoTextConfig {
  const stored = readStored(config);
  if (stored === undefined) return { caption: true, ocr: true, source: "default" };
  return { caption: stored.caption, ocr: stored.ocr, source: "file" };
}

/** Whether the owner has allowed this capability. Says nothing about credentials. */
export function isPhotoTextCapabilityEnabled(config: ApiConfig, capability: PhotoTextCapability): boolean {
  return readRuntimePhotoTextConfig(config)[capability];
}

/** Does this machine hold what the capability needs? Read from live configuration, never cached. */
function hasCredentials(config: ApiConfig, capability: PhotoTextCapability): boolean {
  if (capability === "ocr") return config.tencentOcr !== undefined;
  const ai = readRuntimeAiConfig(config);
  // Both halves count: a key with the AI module switched off cannot place a call, and a
  // module that is on without a key has nothing to place a call with.
  return ai.enabled && ai.apiKey !== undefined;
}

function statusOf(config: ApiConfig, capability: PhotoTextCapability, runtime: RuntimePhotoTextConfig): PhotoTextCapabilityStatus {
  const enabled = runtime[capability];
  const credentials = hasCredentials(config, capability);
  // Order matters: an owner who turned it off should read "off", not "no key" — the second
  // would send her looking for a credential to fix something she stopped on purpose.
  const state: PhotoTextState = !enabled ? "switched-off" : credentials ? "ready" : "no-credential";
  return { enabled, credentials, state, available: enabled && credentials };
}

/** Both switches and both readiness answers, in one round trip for the settings panel. */
export function photoTextStatus(config: ApiConfig): PhotoTextStatus {
  const runtime = readRuntimePhotoTextConfig(config);
  return {
    caption: statusOf(config, "caption", runtime),
    ocr: statusOf(config, "ocr", runtime),
  };
}

/**
 * Writes the switches. An omitted field keeps its current value, so toggling one switch
 * never disturbs the other — the panel saves them independently.
 */
export function saveRuntimePhotoTextConfig(config: ApiConfig, input: { readonly caption?: boolean; readonly ocr?: boolean }): PhotoTextStatus {
  const current = readRuntimePhotoTextConfig(config);
  const stored: StoredPhotoTextConfig = {
    caption: input.caption ?? current.caption,
    ocr: input.ocr ?? current.ocr,
  };
  mkdirSync(config.dataDirectory, { recursive: true });
  writeFileSync(configPath(config), `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return photoTextStatus(config);
}
