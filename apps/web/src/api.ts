import type {
  Asset,
  AssetKind,
  AssetLink,
  AssetRole,
  CycleIntimacyModuleData,
  DaySummary,
  Entity,
  EntityKind,
  EntityRef,
  EntityRelation,
  LifeTime,
  NoteDetails,
  RecordKind,
  RelationKind,
  StorageReference,
  TimelineRecord,
  WeatherAttachment,
} from "@lifeos/core";

/** Response shared by the calendar's private cycle panel and its settings view. */
export type CycleModuleResponse = CycleIntimacyModuleData;
import { logApiFailure } from "./diagnostics";
import type { WeatherConfigStatus, WeatherProfile } from "./weather";

export type RecordView = TimelineRecord & { readonly revision: number };
export type TaskRecordView = Extract<RecordView, { readonly kind: "task" }>;

export interface RecordsResponse {
  readonly items: readonly RecordView[];
}

export interface EntitiesResponse {
  readonly items: readonly Entity[];
}

export interface AssetsResponse {
  readonly items: readonly Asset[];
}

/**
 * A day's summary is derived data: `status` says whether it is a reading of the
 * day or the offline fallback, and `sourceRevision` is what the cache keys on.
 */
export interface SummariesResponse {
  readonly items: readonly DaySummary[];
  readonly provider: string;
  readonly model?: string;
  readonly ai: boolean;
}

export interface AuthState {
  readonly required: boolean;
  readonly authenticated: boolean;
}

export interface AiStatus {
  readonly preset: "quick" | "reflect" | "review" | "custom";
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly keyConfigured: boolean;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly thinking: boolean;
  readonly reasoningEffort: "low" | "high" | "max" | null;
  readonly keySource?: "env" | "file" | "none";
}

export interface AssistantReply {
  readonly reply: string;
  readonly mode: "ai" | "rules";
  readonly provider: string;
  readonly model?: string;
}

export interface BackupRun {
  readonly id: number;
  readonly provider: "local" | "s3";
  readonly kind: "manual" | "scheduled" | "test";
  readonly status: "success" | "failed" | "skipped";
  readonly batchId?: string;
  readonly fileName?: string;
  readonly location?: string;
  readonly sizeBytes?: number;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface BackupSchedule {
  readonly enabled: boolean;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: "Asia/Shanghai";
  readonly nextRunAt: string | null;
  readonly lastRunAt?: string;
}

export type DualBackupStatus = "success" | "partial" | "local_only" | "failed";

export interface DualBackupSummary {
  readonly batchId: string;
  readonly status: DualBackupStatus;
  readonly local: BackupRun;
  readonly s3: BackupRun;
}

export interface BackupStatus {
  readonly localDirectory: string | null;
  readonly s3: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly prefix: string;
    readonly forcePathStyle: boolean;
    readonly keySource?: "env" | "file" | "none";
    /**
     * "file" means the endpoint is a local directory, so nothing is uploaded
     * over the network. The settings UI must never present that as cloud backup.
     */
    readonly transport?: "http" | "file";
    readonly warning?: string;
  };
  readonly schedule: BackupSchedule;
  readonly lastDualBackup: DualBackupSummary | null;
  readonly runs: readonly BackupRun[];
  readonly retention?: { readonly policy: BackupRetentionPolicy; readonly described: readonly string[] };
}

export interface BackupRetentionPolicy {
  readonly dailyDays: number;
  readonly weeklyWeeks: number;
  readonly monthlyMonths: number;
  readonly trashDays: number;
}

export interface TrashedBackupEntry {
  /**
   * The server-side run id. A dual backup writes one row per provider, so both
   * `fileName` and `fileName + prunedAt` are shared by the pair — only the id is
   * unique, which is what a React list key needs.
   *
   * Optional because the web and the API build separately: a preview pointed at
   * an API built before this field existed receives entries without it (observed
   * on the 3011 preview). Callers must still derive a unique key, so the id is
   * the first choice rather than the only one.
   */
  readonly id?: number;
  readonly fileName: string;
  readonly prunedAt: string;
  readonly provider: string;
  readonly trashLocation?: string;
  readonly sizeBytes?: number;
}

export type RetentionTier = "daily" | "weekly" | "monthly" | "newest" | "none";

export interface BackupRetentionEntry {
  readonly fileName: string;
  readonly startedAt: string;
  readonly sizeBytes?: number;
  readonly location?: string;
  readonly keep: boolean;
  readonly tier: RetentionTier;
  readonly reason: string;
  readonly local: boolean;
  readonly remote: boolean;
}

export interface BackupRetentionView {
  readonly policy: BackupRetentionPolicy;
  readonly limits: {
    readonly dailyDays: { readonly min: number; readonly max: number };
    readonly weeklyWeeks: { readonly min: number; readonly max: number };
    readonly monthlyMonths: { readonly min: number; readonly max: number };
    readonly trashDays: { readonly min: number; readonly max: number };
  };
  readonly defaults: BackupRetentionPolicy;
  readonly described: readonly string[];
  readonly cleanupTrigger: string;
  readonly cleanupScope: { readonly local: boolean; readonly remote: boolean; readonly recycleBin: { readonly local: boolean; readonly remote: boolean } };
  readonly cleanupScheduled: boolean;
  readonly nextCleanupAt: string | null;
  readonly localDirectory: string | null;
  readonly entries: readonly BackupRetentionEntry[];
  readonly summary: { readonly keepCount: number; readonly deleteCount: number; readonly keepBytes: number; readonly deleteBytes: number };
  readonly trashed: readonly TrashedBackupEntry[];
  readonly connectionTestCount: number;
  readonly connectionTestBytes: number;
}

export type WeatherStatus = WeatherConfigStatus;

export interface WeatherProfilesResponse {
  readonly items: readonly WeatherProfile[];
  readonly activeProfileId: string | null;
  readonly status: WeatherStatus;
}

/**
 * Movie is an optional module, so its shape lives at the web/API boundary
 * until the core model grows the corresponding EntityKind.  Keeping the
 * provider fields optional also lets old records render without a migration.
 */
export interface MovieExternalIds {
  readonly tmdb?: string;
  readonly imdb?: string;
  readonly douban?: string;
}

export interface MovieEntity {
  readonly id: string;
  readonly type: "movie";
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly originalTitle?: string;
  readonly releaseYear?: number;
  readonly posterUrl?: string;
  readonly overview?: string;
  readonly externalIds?: MovieExternalIds;
  readonly doubanRating?: number;
  readonly personalRating?: number;
  readonly personalReview?: string;
  readonly watchedAt?: string;
}

export interface MovieEntityRef {
  readonly entityType: "movie";
  readonly entityId: string;
  readonly label?: string;
}

export interface MovieModuleStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly keyConfigured: boolean;
  readonly connected: boolean;
  readonly provider?: string;
  readonly message?: string;
}

export interface MovieResolveCandidate extends Partial<MovieEntity> {
  readonly id: string;
  readonly name: string;
}

export interface MovieResolveResponse {
  readonly items?: readonly MovieResolveCandidate[];
  readonly candidates?: readonly MovieResolveCandidate[];
  readonly results?: readonly MovieResolveCandidate[];
  readonly query?: string;
}

export interface MovieModulePayload {
  readonly status?: MovieModuleStatus;
  readonly config?: Partial<MovieModuleStatus> & { readonly enabled?: boolean };
  readonly enabled?: boolean;
  readonly configured?: boolean;
  readonly keyConfigured?: boolean;
  readonly hasKey?: boolean;
  readonly connected?: boolean;
  readonly provider?: string;
  readonly source?: string;
  readonly apiBaseUrl?: string;
  readonly message?: string;
}

export interface WeatherCurrentResponse {
  readonly weather: WeatherAttachment;
  readonly location: {
    readonly id: string;
    readonly name: string;
    readonly adm2: string;
    readonly adm1: string;
  };
}

export interface WeatherArchiveItem {
  readonly date: string;
  readonly locationKey: string;
  readonly locationId: string;
  readonly city: string;
  readonly value: unknown;
  readonly capturedAt: string;
  readonly archived: boolean;
}

export interface WeatherArchiveResponse {
  readonly from: string;
  readonly to: string;
  readonly timeZone: "Asia/Shanghai";
  readonly items: readonly WeatherArchiveItem[];
}

export interface RecordWritePayload {
  readonly kind?: RecordKind;
  readonly content?: string;
  readonly occurredAt?: LifeTime | null;
  readonly dueAt?: LifeTime | null;
  readonly isPrivate?: boolean;
  readonly isDemo?: boolean;
  readonly isBackfill?: boolean;
  readonly weather?: WeatherAttachment | null;
  readonly note?: NoteDetails | null;
  readonly status?: "todo" | "in_progress" | "done" | "cancelled";
  readonly entityRefs?: readonly EntityRef[];
  readonly relatedRecordIds?: readonly string[];
  readonly assetRefs?: readonly AssetLink[];
  readonly revision?: number;
}

export interface EntityWritePayload {
  readonly id?: string;
  readonly type?: EntityKind;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly address?: string;
}

export interface AssetWritePayload {
  readonly id?: string;
  readonly kind?: AssetKind;
  readonly storageRefs?: readonly StorageReference[];
  readonly originalName?: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
}

export interface RelationWritePayload {
  readonly kind?: RelationKind;
  readonly targetId?: string;
  readonly note?: string;
}

export type { Asset, AssetKind, AssetLink, AssetRole, Entity, EntityKind, EntityRef, EntityRelation, RelationKind };

export type ApiError = Error & { readonly status?: number };

function createApiError(message: string, status?: number): ApiError {
  const error = new Error(message) as ApiError;
  if (status !== undefined) {
    Object.defineProperty(error, "status", { value: status, enumerable: true });
  }
  return error;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const payload = (await response.json()) as { message?: unknown; error?: unknown };
      if (typeof payload.message === "string" && payload.message.trim()) {
        message = payload.message;
      } else if (typeof payload.error === "string" && payload.error.trim()) {
        message = payload.error;
      }
    } catch {
      // A non-JSON response still receives a useful status message.
    }
    logApiFailure(`${init.method ?? "GET"} ${path}`, response.status, message);
    throw createApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
