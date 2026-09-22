import { randomUUID } from "node:crypto";
import {
  assertValidCycleIntimacyEvent,
  assertValidCycleIntimacyModuleConfig,
  assertValidLifeTime,
  assertValidNoteDetails,
  createDateOnly,
  createInstant,
  CYCLE_INTIMACY_EVENT_KINDS,
  type AssetLink,
  type AssetRole,
  type CycleIntimacyEvent,
  type CycleIntimacyEventKind,
  type CycleIntimacyModuleConfig,
  type EntityKind,
  type EntityRef,
  type LifeTime,
  type NoteDetails,
  type PlacePeriod,
  type PlaceRole,
  type StorageReference,
} from "@lifeos/core";
import { HttpError } from "./http-kit.js";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonObject(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value)) throw new HttpError(400, "invalid_json", `${name} must be an object`);
  return value;
}

export function hasOnlyKeys(value: JsonObject, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HttpError(400, "unknown_field", `Unsupported field: ${key}`);
  }
}

export function stringField(value: unknown, name: string, options: { nonEmpty?: boolean } = {}): string {
  if (typeof value !== "string" || (options.nonEmpty && value.length === 0)) {
    throw new HttpError(400, "invalid_field", `${name} must be ${options.nonEmpty ? "a non-empty string" : "a string"}`);
  }
  return value;
}

export function enumField<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new HttpError(400, "invalid_field", `${name} is invalid`);
  return value as T;
}

export function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_field", `${name} must be a boolean`);
  return value;
}

export function boundedIntegerField(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(400, "invalid_field", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function cycleIntimacyConfig(input: JsonObject): CycleIntimacyModuleConfig {
  hasOnlyKeys(input, ["enabled", "cycleLength", "periodLength", "anchorStart"]);
  const anchorRaw = input.anchorStart;
  const anchorStart = anchorRaw === undefined || anchorRaw === null
    ? undefined
    : parseDateQuery(stringField(anchorRaw, "anchorStart"), "anchorStart");
  const config: CycleIntimacyModuleConfig = {
    enabled: booleanField(input.enabled, "enabled"),
    cycleLength: boundedIntegerField(input.cycleLength, "cycleLength", 15, 90),
    periodLength: boundedIntegerField(input.periodLength, "periodLength", 1, 21),
    ...(anchorStart === undefined ? {} : { anchorStart }),
  };
  return coreValidated("cycle module config", () => {
    assertValidCycleIntimacyModuleConfig(config);
    return config;
  });
}

export function cycleIntimacyEvent(input: JsonObject): CycleIntimacyEvent {
  hasOnlyKeys(input, ["date", "kind"]);
  const date = parseDateQuery(stringField(input.date, "date"), "date");
  if (date === undefined) throw new HttpError(400, "invalid_date", "date is required");
  const event: CycleIntimacyEvent = { id: randomUUID(), date, kind: enumField(input.kind, CYCLE_INTIMACY_EVENT_KINDS, "kind") };
  return coreValidated("cycle module event", () => {
    assertValidCycleIntimacyEvent(event);
    return event;
  });
}

export function revisionField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "invalid_revision", "revision must be a positive integer");
  }
  return value;
}

export function parseLifeTime(value: unknown, name: string): LifeTime {
  try {
    assertValidLifeTime(value, name);
    return value;
  } catch (error) {
    throw new HttpError(400, "invalid_time", error instanceof Error ? error.message : `${name} is invalid`);
  }
}

export function nowInstant(): ReturnType<typeof createInstant> {
  return createInstant(new Date().toISOString());
}




export function coreValidated<T>(name: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new HttpError(400, "invalid_field", `${name}: ${error instanceof Error ? error.message : "invalid value"}`);
  }
}



export function parseDateQuery(value: string | null, name: string): string | undefined {
  if (value === null) return undefined;
  try {
    return createDateOnly(value).value;
  } catch {
    throw new HttpError(400, "invalid_date", `${name} must use YYYY-MM-DD`);
  }
}



export function parseNoteDetails(value: unknown): NoteDetails {
  return coreValidated("note", () => {
    assertValidNoteDetails(value);
    return value;
  });
}

/** Every calendar day in an inclusive range, so a month grid can ask for a range once. */

