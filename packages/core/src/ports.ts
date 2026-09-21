import type {
  AIDerivedData,
  Asset,
  AssetId,
  AssetKind,
  EntityKind,
  InstantTime,
  LifeTime,
  RecordId,
  TimelineRecord,
} from "./model.js";
import type { SummarySourceRecord } from "./summary.js";

export interface TimelineQuery {
  readonly from?: LifeTime;
  readonly to?: LifeTime;
  readonly kinds?: readonly TimelineRecord["kind"][];
  readonly entityId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RecordRepository {
  save(record: TimelineRecord): Promise<void>;
  findById(id: RecordId): Promise<TimelineRecord | null>;
  listTimeline(query?: TimelineQuery): Promise<readonly TimelineRecord[]>;
  search(text: string, query?: TimelineQuery): Promise<readonly TimelineRecord[]>;
}

export interface AssetWrite {
  readonly asset: Asset;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface AssetRead {
  readonly assetId: AssetId;
  readonly kind: AssetKind;
  readonly mediaType?: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface AssetStorage {
  put(input: AssetWrite): Promise<Asset>;
  open(asset: Asset): Promise<AssetRead | null>;
}

export interface PhotoSourceItem {
  readonly sourceId: string;
  /** Source-specific stable ID or path. It is not a LifeOS asset ID. */
  readonly sourceRef: string;
  readonly capturedAt?: LifeTime;
  readonly originalName?: string;
  readonly mediaType?: string;
  readonly contentHash?: string;
}

/** Read-only by design: no delete or mutation method belongs on this port. */
export interface PhotoSourceConnector {
  list(cursor?: string): Promise<{
    readonly items: readonly PhotoSourceItem[];
    readonly nextCursor?: string;
  }>;
  get(sourceRef: string): Promise<PhotoSourceItem | null>;
}

export interface AIInput {
  readonly recordId: RecordId;
  readonly sourceRevision: string;
  readonly original: string;
  readonly edited?: string;
  readonly occurredAt?: LifeTime;
}

export interface AIProvider {
  readonly providerId: string;
  derive(input: AIInput): Promise<readonly AIDerivedData[]>;
}

/**
 * A day as a summariser sees it. The day is a calendar day in the caller's zone,
 * not a UTC one, because that is what the month grid draws.
 */
export interface DaySummaryInput {
  readonly date: string;
  readonly records: readonly SummarySourceRecord[];
}

/** What a provider produces for one day; the caller stamps provider, model, and time. */
export interface DaySummaryDraft {
  readonly date: string;
  readonly text: string;
}

/**
 * Day-granularity summarising, which is why it is a port of its own rather than
 * an `AIProvider`: one request covers a whole month, and a provider without
 * credentials simply refuses so the caller can fall back to the offline rule.
 */
export interface DaySummaryProvider {
  readonly providerId: string;
  /**
   * `ai` output is a reading of the day; `rule` is a placeholder. Callers record
   * the difference so a summary is never presented as something it is not.
   */
  readonly kind: "ai" | "rule";
  readonly model?: string;
  /**
   * Which machinery produced a draft: provider kind, model, and prompt. A cached
   * summary is only reused while this still matches, so changing the model or the
   * prompt actually rewrites the text instead of leaving the old wording in place.
   */
  readonly contextKey?: string;
  summarizeDays(days: readonly DaySummaryInput[]): Promise<readonly DaySummaryDraft[]>;
}

export interface SpeechToTextInput {
  readonly assetId: AssetId;
  readonly asset: Asset;
  readonly language?: string;
}

export interface SpeechToTextResult {
  readonly assetId: AssetId;
  readonly text: string;
  readonly provider: string;
  readonly model?: string;
  readonly generatedAt: InstantTime;
}

export interface SpeechToTextProvider {
  readonly providerId: string;
  transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult>;
}

export type ReadOnlyEntityKind = EntityKind;
