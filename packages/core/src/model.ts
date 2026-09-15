export type RecordId = string;
export type EntityId = string;
export type AssetId = string;

export type RecordKind = "journal" | "task" | "event" | "note";
export type EntityKind = "person" | "project" | "place" | "topic" | "movie";
export type AssetKind = "photo" | "audio" | "file";
export type AssetRole = "photo" | "recording" | "attachment";

/**
 * An instant includes an offset or Z. The original wall-clock zone, when
 * known, is kept separately because an instant alone cannot recover it.
 */
export interface InstantTime {
  readonly kind: "instant";
  readonly value: string;
  readonly originalTimeZone?: string;
}

/** A calendar date without an implied midnight or UTC conversion. */
export interface DateOnlyTime {
  readonly kind: "date";
  readonly value: string;
  readonly originalTimeZone?: string;
}

/** A source wall-clock timestamp whose timezone is unknown or unresolved. */
export interface LocalDateTime {
  readonly kind: "local";
  /** The source timestamp is preserved verbatim until an adapter can resolve it. */
  readonly value: string;
  readonly originalTimeZone?: string;
}

export type LifeTime = InstantTime | DateOnlyTime | LocalDateTime;

export interface RecordBody {
  /** The first captured user content. It is never replaced by editing. */
  readonly original: string;
  /** User-maintained content derived from, but separate from, original. */
  readonly edited?: string;
  /** Raw transcripts are tied to their source audio and provider. */
  readonly transcriptRaw?: readonly RawTranscript[];
}

export interface RawTranscript {
  readonly assetId: AssetId;
  readonly text: string;
  readonly provider: string;
  readonly model?: string;
  readonly generatedAt: InstantTime;
}

export interface EntityRef {
  readonly entityType: EntityKind;
  readonly entityId: EntityId;
  readonly label?: string;
}

/** How two people in the log know each other. All kinds read the same way from either side. */
export type RelationKind = "colleague" | "friend" | "partner" | "family";

export const RELATION_KINDS: readonly RelationKind[] = ["colleague", "friend", "partner", "family"];

export interface EntityRelation {
  readonly kind: RelationKind;
  /** The other entity. The edge is symmetric: both sides store it. */
  readonly entityId: EntityId;
  readonly note?: string;
}

export interface EntityBase {
  readonly id: EntityId;
  readonly name: string;
  /** Other names the same person, place, project, topic or movie is called by. */
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly relations?: readonly EntityRelation[];
  readonly createdAt?: InstantTime;
}

/**
 * The part a place plays in this life, not the place itself: 爸妈家 and a
 * rented flat are both "home", and two employers are both "work". Roles are
 * not unique — several places may carry the same role at once.
 */
export type PlaceRole = "home" | "work" | "other";
export const PLACE_ROLES: readonly PlaceRole[] = ["home", "work", "other"];

/**
 * When a place was current. Precision is calendar months (`YYYY-MM`) —
 * exact days are write friction without payoff. A missing `until` means
 * "still current"; a missing `from` means "since before the log began".
 */
export interface PlacePeriod {
  readonly from?: string;
  readonly until?: string;
}

export interface Person extends EntityBase {
  readonly type: "person";
}

export interface Project extends EntityBase {
  readonly type: "project";
}

export interface Place extends EntityBase {
  readonly type: "place";
  readonly role?: PlaceRole;
  readonly period?: PlacePeriod;
  /** Optional detailed street address; never required for a place. */
  readonly address?: string;
}

export interface Topic extends EntityBase {
  readonly type: "topic";
}

/** IDs returned by movie databases. TMDb and Douban currently arrive as
 * numbers from some clients and strings from imports, so both are accepted
 * and preserved; adapters compare their string form when de-duplicating. */
export interface MovieExternalIds {
  readonly tmdb?: number | string;
  readonly imdb?: string;
  readonly douban?: number | string;
}

/** A movie is an ordinary entity so timeline records can reference it. */
export interface Movie extends EntityBase {
  readonly type: "movie";
  /** Optional original-language title; `name` remains the display title. */
  readonly originalTitle?: string;
  readonly releaseYear?: number;
  /** Public poster URL, normally derived from TMDb's image host. */
  readonly posterUrl?: string;
  readonly overview?: string;
  readonly externalIds?: MovieExternalIds;
  readonly doubanRating?: number;
  readonly personalRating?: number;
  readonly personalReview?: string;
  /** Calendar date on which the owner watched the movie. */
  readonly watchedAt?: string;
}

export type Entity = Person | Project | Place | Topic | Movie;

export interface AssetLink {
  readonly assetId: AssetId;
  readonly role: AssetRole;
  readonly label?: string;
}

export interface ContentHash {
  readonly algorithm: string;
  readonly value: string;
}

export type StorageLink =
  | { readonly kind: "url"; readonly value: string }
  | { readonly kind: "export-path"; readonly value: string };

export interface StorageReference {
  /** Stable identifier for the source or storage adapter. */
  readonly sourceId: string;
  /** Source-specific identifier or path; it can be replaced without changing assetId. */
  readonly sourceRef: string;
  /** Optional explicit link that has been verified safe for Markdown export. */
  readonly link?: StorageLink;
  readonly contentHash?: ContentHash;
  readonly mediaType?: string;
}

export interface Asset {
  readonly id: AssetId;
  readonly kind: AssetKind;
  readonly mediaType?: string;
  readonly originalName?: string;
  readonly sizeBytes?: number;
  readonly createdAt?: InstantTime;
  /**
   * The last time this asset was put to use — currently only set when a
   * content-hash match reuses an upload instead of storing the bytes again.
   *
   * It exists because the orphan collector needs an anchor: re-dropping the
   * same photo restarts its grace period, so a photo dropped on day six is not
   * collected on day seven. Absent means "never reused since upload", and the
   * collector falls back to `createdAt`.
   */
  readonly lastUsedAt?: InstantTime;
  readonly storageRefs: readonly StorageReference[];
}

/** A weather snapshot pinned to a record, either from the day's archive or a live capture. */
export type WeatherCaptureMode = "daily" | "realtime";

export interface WeatherAttachment {
  readonly mode: WeatherCaptureMode;
  readonly locationId: string;
  readonly city: string;
  readonly text: string;
  readonly icon: string;
  readonly temperature?: string;
  readonly tempMin?: string;
  readonly tempMax?: string;
  readonly windDir?: string;
  readonly windScale?: string;
  readonly capturedAt: InstantTime;
}

/**
 * An optional, private calendar overlay. It deliberately models a few stable
 * facts instead of copying a health app's entire schema: a confirmed period
 * boundary and an intimacy marker are enough for the calendar to derive its
 * moon shapes and non-medical cycle estimate.
 */
export type CycleIntimacyEventKind = "intimacy" | "period_start" | "period_end";
export const CYCLE_INTIMACY_EVENT_KINDS: readonly CycleIntimacyEventKind[] = ["intimacy", "period_start", "period_end"];

export interface CycleIntimacyModuleConfig {
  readonly enabled: boolean;
  /** Days from one confirmed period start to the next estimated start. */
  readonly cycleLength: number;
  /** The expected duration used only until an explicit end is recorded. */
  readonly periodLength: number;
  /** A private baseline when no confirmed period start has been recorded yet. */
  readonly anchorStart?: string;
}

export interface CycleIntimacyEvent {
  readonly id: string;
  /** Calendar date in the owner's chosen timezone; never an implicit UTC midnight. */
  readonly date: string;
  readonly kind: CycleIntimacyEventKind;
}

export interface CycleIntimacyModuleData {
  readonly config: CycleIntimacyModuleConfig;
  readonly events: readonly CycleIntimacyEvent[];
}

export type AIDerivedKind =
  | "classification"
  | "summary"
  | "entity-link"
  | "event-link"
  | "retrieval-hint";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AIDerivedData {
  readonly id: string;
  readonly kind: AIDerivedKind;
  readonly value: JsonValue;
  readonly provider: string;
  readonly model: string;
  readonly generatedAt: InstantTime;
  /** The original record that was supplied to the provider. */
  readonly sourceRecordId: RecordId;
  /** A revision ID or content hash for the input used by the provider. */
  readonly sourceRevision: string;
  readonly confidence?: number;
}

export interface TimelineRecordBase {
  readonly id: RecordId;
  readonly body: RecordBody;
  /** When true, the record is hidden from calendar views and masked on the timeline. */
  readonly isPrivate?: boolean;
  /** Internal marker for the removable records that ship with the workspace. */
  readonly isDemo?: boolean;
  /** The record was entered later for an earlier calendar day. */
  readonly isBackfill?: boolean;
  /** Time at which LifeOS captured the record. */
  readonly createdAt: InstantTime;
  readonly updatedAt?: InstantTime;
  /** Time at which the represented event happened, if known. */
  readonly occurredAt?: LifeTime;
  /** An optional weather snapshot deliberately attached to this record. */
  readonly weather?: WeatherAttachment;
  readonly entityRefs: readonly EntityRef[];
  readonly relatedRecordIds: readonly RecordId[];
  readonly assetRefs: readonly AssetLink[];
  readonly aiDerived: readonly AIDerivedData[];
}

export interface JournalRecord extends TimelineRecordBase {
  readonly kind: "journal";
}

export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

export interface TaskDetails {
  readonly status: TaskStatus;
  /** Future plan/deadline; deliberately separate from occurredAt. */
  readonly dueAt?: LifeTime;
}

export interface TaskRecord extends TimelineRecordBase {
  readonly kind: "task";
  readonly task: TaskDetails;
}

export interface EventRecord extends TimelineRecordBase {
  readonly kind: "event";
}

export interface NoteRecord extends TimelineRecordBase {
  readonly kind: "note";
}

export type TimelineRecord = JournalRecord | TaskRecord | EventRecord | NoteRecord;
export type TimelineEvent = EventRecord;
/** Convenience alias for callers that use Event as the domain name. */
export type Event = EventRecord;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;
const YEAR_MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** A name starting with a mention marker could never be summoned by that marker. */
const ENTITY_NAME_MARKER_PATTERN = /^[@#]/;

type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, name: string): UnknownRecord {
  if (!isObject(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function nonEmptyStringValue(value: unknown, name: string): string {
  const string = stringValue(value, name);
  if (string.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return string;
}

function optionalStringValue(value: unknown, name: string): void {
  if (value !== undefined) {
    stringValue(value, name);
  }
}

function requireNonEmpty(value: string, name: string): string {
  return nonEmptyStringValue(value, name);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validateCalendarParts(
  yearText: string,
  monthText: string,
  dayText: string,
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined,
  offset: string | undefined,
  name: string,
): void {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`Invalid ${name}: calendar date is out of range`);
  }
  if (hourText === undefined) {
    return;
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid ${name}: time is out of range`);
  }
  if (offset !== undefined && offset !== "Z") {
    const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (offsetMatch === null || Number(offsetMatch[2]) > 23 || Number(offsetMatch[3]) > 59) {
      throw new Error(`Invalid ${name}: timezone offset is out of range`);
    }
  }
}

function validateDateOnlyString(value: string, name: string): void {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  validateCalendarParts(match[1]!, match[2]!, match[3]!, undefined, undefined, undefined, undefined, name);
}

function validateDateTimeString(value: string, name: string, expectedZone: "offset" | "none"): void {
  const match = DATE_TIME_PATTERN.exec(value);
  if (match === null || (expectedZone === "offset" && match[8] === undefined) || (expectedZone === "none" && match[8] !== undefined)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  validateCalendarParts(match[1]!, match[2]!, match[3]!, match[4]!, match[5]!, match[6], match[8], name);
}

export function createInstant(value: string, originalTimeZone?: string): InstantTime {
  validateDateTimeString(value, "instant", "offset");
  return originalTimeZone === undefined
    ? { kind: "instant", value }
    : { kind: "instant", value, originalTimeZone: requireNonEmpty(originalTimeZone, "originalTimeZone") };
}

export function createDateOnly(value: string, originalTimeZone?: string): DateOnlyTime {
  validateDateOnlyString(value, "date-only value");
  return originalTimeZone === undefined
    ? { kind: "date", value }
    : { kind: "date", value, originalTimeZone: requireNonEmpty(originalTimeZone, "originalTimeZone") };
}

export function createLocalDateTime(value: string, originalTimeZone?: string): LocalDateTime {
  validateDateTimeString(value, "local date-time value", "none");
  return originalTimeZone === undefined
    ? { kind: "local", value }
    : { kind: "local", value, originalTimeZone: requireNonEmpty(originalTimeZone, "originalTimeZone") };
}

export function assertValidInstantTime(value: unknown, name = "instant"): asserts value is InstantTime {
  const instant = objectValue(value, name);
  if (instant.kind !== "instant") {
    throw new Error(`${name} must be an instant`);
  }
  const instantValue = stringValue(instant.value, `${name}.value`);
  optionalStringValue(instant.originalTimeZone, `${name}.originalTimeZone`);
  createInstant(instantValue, instant.originalTimeZone as string | undefined);
}

export function assertValidLifeTime(value: unknown, name = "time"): asserts value is LifeTime {
  const time = objectValue(value, name);
  if (time.kind === "instant") {
    assertValidInstantTime(time, name);
    return;
  }
  if (time.kind === "date") {
    const dateValue = stringValue(time.value, `${name}.value`);
    optionalStringValue(time.originalTimeZone, `${name}.originalTimeZone`);
    createDateOnly(dateValue, time.originalTimeZone as string | undefined);
    return;
  }
  if (time.kind === "local") {
    const localValue = stringValue(time.value, `${name}.value`);
    optionalStringValue(time.originalTimeZone, `${name}.originalTimeZone`);
    createLocalDateTime(localValue, time.originalTimeZone as string | undefined);
    return;
  }
  throw new Error(`${name} has an unknown time kind`);
}

function arrayValue(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${name} has an unsupported value`);
  }
  return value as T;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function validateEntityRef(value: unknown, name: string): void {
  const ref = objectValue(value, name);
  enumValue(ref.entityType, ["person", "project", "place", "topic", "movie"], `${name}.entityType`);
  nonEmptyStringValue(ref.entityId, `${name}.entityId`);
  optionalStringValue(ref.label, `${name}.label`);
}

/** Validates one entity reference. Exported so adapters reuse the same rule. */
export function assertValidEntityRef(value: unknown, name = "entityRef"): asserts value is EntityRef {
  validateEntityRef(value, name);
}

function validateAssetLink(value: unknown, name: string): void {
  const ref = objectValue(value, name);
  nonEmptyStringValue(ref.assetId, `${name}.assetId`);
  enumValue(ref.role, ["photo", "recording", "attachment"], `${name}.role`);
  optionalStringValue(ref.label, `${name}.label`);
}

/** Validates one record-to-asset link. Exported so adapters reuse the same rule. */
export function assertValidAssetLink(value: unknown, name = "assetRef"): asserts value is AssetLink {
  validateAssetLink(value, name);
}

function validateTranscript(value: unknown, index: number): void {
  const transcript = objectValue(value, `record.body.transcriptRaw[${index}]`);
  nonEmptyStringValue(transcript.assetId, `record.body.transcriptRaw[${index}].assetId`);
  stringValue(transcript.text, `record.body.transcriptRaw[${index}].text`);
  nonEmptyStringValue(transcript.provider, `record.body.transcriptRaw[${index}].provider`);
  optionalStringValue(transcript.model, `record.body.transcriptRaw[${index}].model`);
  assertValidInstantTime(transcript.generatedAt, `record.body.transcriptRaw[${index}].generatedAt`);
}

function validateAIDerived(value: unknown, index: number): void {
  const derived = objectValue(value, `record.aiDerived[${index}]`);
  nonEmptyStringValue(derived.id, `record.aiDerived[${index}].id`);
  enumValue(
    derived.kind,
    ["classification", "summary", "entity-link", "event-link", "retrieval-hint"],
    `record.aiDerived[${index}].kind`,
  );
  if (!isJsonValue(derived.value)) {
    throw new Error(`record.aiDerived[${index}].value must be JSON-compatible`);
  }
  nonEmptyStringValue(derived.provider, `record.aiDerived[${index}].provider`);
  nonEmptyStringValue(derived.model, `record.aiDerived[${index}].model`);
  assertValidInstantTime(derived.generatedAt, `record.aiDerived[${index}].generatedAt`);
  nonEmptyStringValue(derived.sourceRecordId, `record.aiDerived[${index}].sourceRecordId`);
  nonEmptyStringValue(derived.sourceRevision, `record.aiDerived[${index}].sourceRevision`);
  if (
    derived.confidence !== undefined &&
    (typeof derived.confidence !== "number" ||
      !Number.isFinite(derived.confidence) ||
      derived.confidence < 0 ||
      derived.confidence > 1)
  ) {
    throw new Error(`record.aiDerived[${index}].confidence must be between 0 and 1`);
  }
}

function validateWeatherAttachment(value: unknown): void {
  const weather = objectValue(value, "record.weather");
  enumValue(weather.mode, ["daily", "realtime"], "record.weather.mode");
  nonEmptyStringValue(weather.locationId, "record.weather.locationId");
  nonEmptyStringValue(weather.city, "record.weather.city");
  nonEmptyStringValue(weather.text, "record.weather.text");
  nonEmptyStringValue(weather.icon, "record.weather.icon");
  optionalStringValue(weather.temperature, "record.weather.temperature");
  optionalStringValue(weather.tempMin, "record.weather.tempMin");
  optionalStringValue(weather.tempMax, "record.weather.tempMax");
  optionalStringValue(weather.windDir, "record.weather.windDir");
  optionalStringValue(weather.windScale, "record.weather.windScale");
  assertValidInstantTime(weather.capturedAt, "record.weather.capturedAt");
}

export function assertValidWeatherAttachment(value: unknown, name = "record.weather"): asserts value is WeatherAttachment {
  if (name === "record.weather") {
    validateWeatherAttachment(value);
    return;
  }
  const weather = objectValue(value, name);
  enumValue(weather.mode, ["daily", "realtime"], `${name}.mode`);
  nonEmptyStringValue(weather.locationId, `${name}.locationId`);
  nonEmptyStringValue(weather.city, `${name}.city`);
  nonEmptyStringValue(weather.text, `${name}.text`);
  nonEmptyStringValue(weather.icon, `${name}.icon`);
  optionalStringValue(weather.temperature, `${name}.temperature`);
  optionalStringValue(weather.tempMin, `${name}.tempMin`);
  optionalStringValue(weather.tempMax, `${name}.tempMax`);
  optionalStringValue(weather.windDir, `${name}.windDir`);
  optionalStringValue(weather.windScale, `${name}.windScale`);
  assertValidInstantTime(weather.capturedAt, `${name}.capturedAt`);
}

export function assertValidTimelineRecord(value: unknown): asserts value is TimelineRecord {
  const record = objectValue(value, "record");
  nonEmptyStringValue(record.id, "record.id");
  const kind = enumValue(record.kind, ["journal", "task", "event", "note"], "record.kind");
  const body = objectValue(record.body, "record.body");
  stringValue(body.original, "record.body.original");
  optionalStringValue(body.edited, "record.body.edited");
  if (record.isPrivate !== undefined && typeof record.isPrivate !== "boolean") {
    throw new Error("record.isPrivate must be a boolean");
  }
  if (record.isDemo !== undefined && typeof record.isDemo !== "boolean") {
    throw new Error("record.isDemo must be a boolean");
  }
  if (record.isBackfill !== undefined && typeof record.isBackfill !== "boolean") {
    throw new Error("record.isBackfill must be a boolean");
  }
  if (body.transcriptRaw !== undefined) {
    arrayValue(body.transcriptRaw, "record.body.transcriptRaw").forEach(validateTranscript);
  }
  assertValidInstantTime(record.createdAt, "record.createdAt");
  if (record.updatedAt !== undefined) {
    assertValidInstantTime(record.updatedAt, "record.updatedAt");
  }
  if (record.occurredAt !== undefined) {
    assertValidLifeTime(record.occurredAt, "record.occurredAt");
  }
  if (record.weather !== undefined) {
    validateWeatherAttachment(record.weather);
  }
  arrayValue(record.entityRefs, "record.entityRefs").forEach((value, index) => {
    validateEntityRef(value, `record.entityRefs[${index}]`);
  });
  arrayValue(record.relatedRecordIds, "record.relatedRecordIds").forEach((id, index) => {
    nonEmptyStringValue(id, `record.relatedRecordIds[${index}]`);
  });
  arrayValue(record.assetRefs, "record.assetRefs").forEach((value, index) => {
    validateAssetLink(value, `record.assetRefs[${index}]`);
  });
  arrayValue(record.aiDerived, "record.aiDerived").forEach(validateAIDerived);
  if (kind === "task") {
    const task = objectValue(record.task, "record.task");
    enumValue(task.status, ["todo", "in_progress", "done", "cancelled"], "record.task.status");
    if (task.dueAt !== undefined) {
      assertValidLifeTime(task.dueAt, "record.task.dueAt");
    }
  }
}

function validateRelation(value: unknown, name: string): void {
  const relation = objectValue(value, name);
  enumValue(relation.kind, RELATION_KINDS, `${name}.kind`);
  nonEmptyStringValue(relation.entityId, `${name}.entityId`);
  optionalStringValue(relation.note, `${name}.note`);
}

function validateMovieScore(value: unknown, name: string, halfStep: boolean): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error(`${name} must be between 0 and 10`);
  }
  if (halfStep && !Number.isInteger(value * 2)) {
    throw new Error(`${name} must use 0.5 increments`);
  }
}

function validateMovieExternalIds(value: unknown, name: string): void {
  const ids = objectValue(value, name);
  for (const key of Object.keys(ids)) {
    if (!["tmdb", "imdb", "douban"].includes(key)) throw new Error(`${name}.${key} is not supported`);
  }
  if (ids.tmdb !== undefined) {
    const tmdb = ids.tmdb;
    const validNumber = typeof tmdb === "number" && Number.isSafeInteger(tmdb) && tmdb > 0;
    const validString = typeof tmdb === "string" && /^\d+$/.test(tmdb) && Number.isSafeInteger(Number(tmdb)) && Number(tmdb) > 0;
    if (!validNumber && !validString) throw new Error(`${name}.tmdb must be a positive integer`);
  }
  if (ids.imdb !== undefined && (typeof ids.imdb !== "string" || !/^tt\d+$/i.test(ids.imdb))) {
    throw new Error(`${name}.imdb must be an IMDb id such as tt1234567`);
  }
  if (ids.douban !== undefined) {
    const douban = ids.douban;
    const validNumber = typeof douban === "number" && Number.isSafeInteger(douban) && douban > 0;
    const validString = typeof douban === "string" && ((/^\d+$/.test(douban) && Number.isSafeInteger(Number(douban)) && Number(douban) > 0) || /^https?:\/\/(?:www\.)?(?:movie\.)?douban\.com\/subject\/\d+\/?$/i.test(douban));
    if (!validNumber && !validString) throw new Error(`${name}.douban must be a positive integer`);
  }
}

function validateMovieFields(entity: UnknownRecord): void {
  optionalStringValue(entity.originalTitle, "entity.originalTitle");
  if (entity.releaseYear !== undefined && (!Number.isSafeInteger(entity.releaseYear) || (entity.releaseYear as number) < 1 || (entity.releaseYear as number) > 9999)) {
    throw new Error("entity.releaseYear must be an integer between 1 and 9999");
  }
  optionalStringValue(entity.posterUrl, "entity.posterUrl");
  optionalStringValue(entity.overview, "entity.overview");
  if (entity.externalIds !== undefined) validateMovieExternalIds(entity.externalIds, "entity.externalIds");
  if (entity.doubanRating !== undefined) validateMovieScore(entity.doubanRating, "entity.doubanRating", false);
  if (entity.personalRating !== undefined) validateMovieScore(entity.personalRating, "entity.personalRating", true);
  optionalStringValue(entity.personalReview, "entity.personalReview");
  if (entity.watchedAt !== undefined) {
    validateDateOnlyString(stringValue(entity.watchedAt, "entity.watchedAt"), "entity.watchedAt");
  }
}

/** Validates one entity-to-entity relation. Exported so adapters reuse the same rule. */
export function assertValidEntityRelation(value: unknown, name = "relation"): asserts value is EntityRelation {
  validateRelation(value, name);
}

export function assertValidEntity(value: unknown): asserts value is Entity {
  const entity = objectValue(value, "entity");
  enumValue(entity.type, ["person", "project", "place", "topic", "movie"], "entity.type");
  nonEmptyStringValue(entity.id, "entity.id");
  const entityName = stringValue(entity.name, "entity.name");
  if (entityName.trim().length === 0) {
    throw new Error("entity.name must not be empty");
  }
  if (ENTITY_NAME_MARKER_PATTERN.test(entityName)) {
    throw new Error("entity.name must not contain @ or #");
  }
  if (entity.aliases !== undefined) {
    arrayValue(entity.aliases, "entity.aliases").forEach((alias, index) => {
      const aliasText = stringValue(alias, `entity.aliases[${index}]`);
      if (aliasText.trim().length === 0) {
        throw new Error(`entity.aliases[${index}] must not be empty`);
      }
      if (ENTITY_NAME_MARKER_PATTERN.test(aliasText)) {
        throw new Error(`entity.aliases[${index}] must not contain @ or #`);
      }
    });
  }
  if (entity.role !== undefined) {
    if (entity.type !== "place") {
      throw new Error("entity.role is only allowed on a place");
    }
    enumValue(entity.role, PLACE_ROLES, "entity.role");
  }
  if (entity.period !== undefined) {
    if (entity.type !== "place") {
      throw new Error("entity.period is only allowed on a place");
    }
    const period = objectValue(entity.period, "entity.period");
    const from = period.from === undefined ? undefined : stringValue(period.from, "entity.period.from");
    const until = period.until === undefined ? undefined : stringValue(period.until, "entity.period.until");
    if (from !== undefined && !YEAR_MONTH_PATTERN.test(from)) {
      throw new Error(`entity.period.from must be YYYY-MM: ${from}`);
    }
    if (until !== undefined && !YEAR_MONTH_PATTERN.test(until)) {
      throw new Error(`entity.period.until must be YYYY-MM: ${until}`);
    }
    if (from !== undefined && until !== undefined && from > until) {
      throw new Error("entity.period.from must not be after entity.period.until");
    }
  }
  if (entity.address !== undefined) {
    if (entity.type !== "place") {
      throw new Error("entity.address is only allowed on a place");
    }
    optionalStringValue(entity.address, "entity.address");
  }
  const movieFieldNames = ["originalTitle", "releaseYear", "posterUrl", "overview", "externalIds", "doubanRating", "personalRating", "personalReview", "watchedAt"];
  const carriesMovieFields = movieFieldNames.some((field) => entity[field] !== undefined);
  if (entity.type !== "movie" && carriesMovieFields) {
    throw new Error("movie fields are only allowed on a movie");
  }
  if (entity.type === "movie") validateMovieFields(entity);
  if (entity.relations !== undefined) {
    const seen = new Set<string>();
    arrayValue(entity.relations, "entity.relations").forEach((value, index) => {
      const name = `entity.relations[${index}]`;
      validateRelation(value, name);
      const target = objectValue(value, name).entityId as string;
      if (target === entity.id) throw new Error(`${name} cannot point at its own entity`);
      if (seen.has(target)) throw new Error(`${name} repeats ${target}`);
      seen.add(target);
    });
  }
  optionalStringValue(entity.description, "entity.description");
  if (entity.createdAt !== undefined) {
    assertValidInstantTime(entity.createdAt, "entity.createdAt");
  }
}

function validateStorageLink(value: unknown, name: string): void {
  const link = objectValue(value, name);
  const kind = enumValue(link.kind, ["url", "export-path"], `${name}.kind`);
  const linkValue = nonEmptyStringValue(link.value, `${name}.value`);
  if (/[\u0000-\u001f<>\r\n]/.test(linkValue)) {
    throw new Error(`${name}.value contains unsafe control characters`);
  }
  if (kind === "url" && !/^https?:\/\/[^\s<>]+$/i.test(linkValue)) {
    throw new Error(`${name}.value must be an http(s) URL`);
  }
  if (
    kind === "export-path" &&
    (linkValue.startsWith("/") ||
      linkValue.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(linkValue) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(linkValue) ||
      linkValue.split(/[\\/]/).includes(".."))
  ) {
    throw new Error(`${name}.value must be a relative export path`);
  }
}

export function assertValidAsset(value: unknown): asserts value is Asset {
  const asset = objectValue(value, "asset");
  enumValue(asset.kind, ["photo", "audio", "file"], "asset.kind");
  nonEmptyStringValue(asset.id, "asset.id");
  optionalStringValue(asset.mediaType, "asset.mediaType");
  optionalStringValue(asset.originalName, "asset.originalName");
  if (asset.sizeBytes !== undefined && (typeof asset.sizeBytes !== "number" || !Number.isFinite(asset.sizeBytes) || asset.sizeBytes < 0)) {
    throw new Error("asset.sizeBytes must be a non-negative number");
  }
  if (asset.createdAt !== undefined) {
    assertValidInstantTime(asset.createdAt, "asset.createdAt");
  }
  if (asset.lastUsedAt !== undefined) {
    assertValidInstantTime(asset.lastUsedAt, "asset.lastUsedAt");
  }
  arrayValue(asset.storageRefs, "asset.storageRefs").forEach((value, index) => {
    validateStorageReference(value, `asset.storageRefs[${index}]`);
  });
}

/** Validation shared by the API, export format, and any future calendar clients. */
export function assertValidCycleIntimacyModuleConfig(value: unknown, name = "cycleIntimacy.config"): asserts value is CycleIntimacyModuleConfig {
  const config = objectValue(value, name);
  if (typeof config.enabled !== "boolean") throw new Error(`${name}.enabled must be a boolean`);
  for (const key of ["cycleLength", "periodLength"] as const) {
    const number = config[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number)) throw new Error(`${name}.${key} must be an integer`);
  }
  if ((config.cycleLength as number) < 15 || (config.cycleLength as number) > 90) {
    throw new Error(`${name}.cycleLength must be between 15 and 90 days`);
  }
  if ((config.periodLength as number) < 1 || (config.periodLength as number) > 21) {
    throw new Error(`${name}.periodLength must be between 1 and 21 days`);
  }
  if (config.anchorStart !== undefined) validateDateOnlyString(stringValue(config.anchorStart, `${name}.anchorStart`), `${name}.anchorStart`);
}

export function assertValidCycleIntimacyEvent(value: unknown, name = "cycleIntimacy.event"): asserts value is CycleIntimacyEvent {
  const event = objectValue(value, name);
  nonEmptyStringValue(event.id, `${name}.id`);
  validateDateOnlyString(stringValue(event.date, `${name}.date`), `${name}.date`);
  enumValue(event.kind, CYCLE_INTIMACY_EVENT_KINDS, `${name}.kind`);
}

export function assertValidCycleIntimacyModuleData(value: unknown, name = "cycleIntimacy"): asserts value is CycleIntimacyModuleData {
  const module = objectValue(value, name);
  assertValidCycleIntimacyModuleConfig(module.config, `${name}.config`);
  const seenIds = new Set<string>();
  const seenKindsForDay = new Set<string>();
  arrayValue(module.events, `${name}.events`).forEach((event, index) => {
    const eventName = `${name}.events[${index}]`;
    assertValidCycleIntimacyEvent(event, eventName);
    const parsed = objectValue(event, eventName);
    const id = parsed.id as string;
    const dayKind = `${parsed.date as string}:${parsed.kind as string}`;
    if (seenIds.has(id)) throw new Error(`${eventName}.id repeats ${id}`);
    if (seenKindsForDay.has(dayKind)) throw new Error(`${eventName} repeats ${dayKind}`);
    seenIds.add(id);
    seenKindsForDay.add(dayKind);
  });
}

/** Validates one replaceable storage reference. Exported so adapters reuse the same rule. */
export function assertValidStorageReference(value: unknown, name = "storageRef"): asserts value is StorageReference {
  validateStorageReference(value, name);
}

function validateStorageReference(value: unknown, name: string): void {
  const storageRef = objectValue(value, name);
  nonEmptyStringValue(storageRef.sourceId, `${name}.sourceId`);
  nonEmptyStringValue(storageRef.sourceRef, `${name}.sourceRef`);
  if (storageRef.link !== undefined) {
    validateStorageLink(storageRef.link, `${name}.link`);
  }
  if (storageRef.contentHash !== undefined) {
    const contentHash = objectValue(storageRef.contentHash, `${name}.contentHash`);
    nonEmptyStringValue(contentHash.algorithm, `${name}.contentHash.algorithm`);
    nonEmptyStringValue(contentHash.value, `${name}.contentHash.value`);
  }
  optionalStringValue(storageRef.mediaType, `${name}.mediaType`);
}
