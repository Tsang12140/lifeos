import { shanghaiDateKey } from "./backup-scheduler.js";

/**
 * Grandfather-father-son retention. Backups are whole SQLite snapshots rather
 * than deltas, so the only lever on growth is which snapshots survive: keep one
 * per day for a short window, one per week for longer, one per month longer
 * still, and drop the rest.
 */
export interface BackupRetention {
  /** Number of days (including today) that get a daily snapshot. */
  readonly dailyDays: number;
  /** Number of weeks (including this one) that get a weekly snapshot. */
  readonly weeklyWeeks: number;
  /** Number of months (including this one) that get a monthly snapshot. */
  readonly monthlyMonths: number;
  /**
   * How long a cleaned snapshot stays retrievable in LifeOS's own recycle bin
   * before it is deleted for real. The bucket has no versioning, so this is the
   * only thing standing between "cleaned" and "gone".
   */
  readonly trashDays: number;
}

export const DEFAULT_BACKUP_RETENTION: BackupRetention = { dailyDays: 7, weeklyWeeks: 8, monthlyMonths: 12, trashDays: 30 };

export const BACKUP_RETENTION_LIMITS = {
  dailyDays: { min: 1, max: 365 },
  weeklyWeeks: { min: 0, max: 260 },
  monthlyMonths: { min: 0, max: 120 },
  trashDays: { min: 1, max: 365 },
} as const;

export function assertValidBackupRetention(value: BackupRetention): void {
  for (const [key, limit] of Object.entries(BACKUP_RETENTION_LIMITS) as readonly (readonly [keyof BackupRetention, { min: number; max: number }])[]) {
    const amount = value[key];
    if (!Number.isInteger(amount) || amount < limit.min || amount > limit.max) {
      throw new Error(`保留策略 ${key} 必须是 ${limit.min} 到 ${limit.max} 之间的整数`);
    }
  }
  if (value.dailyDays < 1) throw new Error("日备至少保留 1 天");
}

type CalendarParts = { readonly year: number; readonly month: number; readonly day: number };

const TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 86_400_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Calendar date in Asia/Shanghai. The zone has no DST, so plain UTC maths on
 *  these parts is exact — no local-timezone leakage. */
function calendarParts(value: Date): CalendarParts {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function asUtc(parts: CalendarParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function fromUtc(timestamp: number): CalendarParts {
  const date = new Date(timestamp);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function dayKey(parts: CalendarParts): string {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
}

function monthKey(parts: CalendarParts): string {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}`;
}

/** Key of the Monday that starts the week containing `parts`. */
function weekKey(parts: CalendarParts): string {
  const timestamp = asUtc(parts);
  const weekday = new Date(timestamp).getUTCDay();
  return dayKey(fromUtc(timestamp - ((weekday + 6) % 7) * DAY_MS));
}

function shiftDays(parts: CalendarParts, days: number): CalendarParts {
  return fromUtc(asUtc(parts) + days * DAY_MS);
}

function shiftMonths(parts: CalendarParts, months: number): CalendarParts {
  const zeroBased = parts.year * 12 + (parts.month - 1) + months;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1, day: parts.day };
}

export type RetentionTier = "daily" | "weekly" | "monthly" | "newest" | "none";

export interface RetentionVerdict {
  readonly tier: RetentionTier;
  readonly keep: boolean;
  readonly reason: string;
}

export interface RetentionSubject {
  /** Instant the snapshot was taken; drives which calendar buckets it falls in. */
  readonly startedAt: string;
  /** Connection-test objects are not backups and never earn a slot. */
  readonly isConnectionTest?: boolean;
}

/**
 * Pure planner: given the snapshots (newest first is not required, order does
 * not matter) decide which survive and why. Defaults to keeping everything when
 * the policy is wide open, and always keeps the newest snapshot so a bad policy
 * can never empty the archive.
 */
export function planBackupRetention<T extends RetentionSubject>(
  subjects: readonly T[],
  policy: BackupRetention,
  now: Date,
): readonly (T & RetentionVerdict)[] {
  assertValidBackupRetention(policy);
  const today = calendarParts(now);
  const dailyCutoff = dayKey(shiftDays(today, -(policy.dailyDays - 1)));
  const weeklyCutoff = policy.weeklyWeeks === 0 ? null : weekKey(shiftDays(today, -((policy.weeklyWeeks - 1) * 7)));
  const monthlyCutoff = policy.monthlyMonths === 0 ? null : monthKey(shiftMonths(today, -(policy.monthlyMonths - 1)));

  const ordered = subjects
    .map((subject, index) => ({ subject, index, timestamp: Date.parse(subject.startedAt) }))
    .sort((left, right) => (right.timestamp - left.timestamp) || (left.index - right.index));

  const usedDays = new Set<string>();
  const usedWeeks = new Set<string>();
  const usedMonths = new Set<string>();
  const verdicts = new Map<number, RetentionVerdict>();

  for (const [position, entry] of ordered.entries()) {
    const parts = calendarParts(new Date(entry.timestamp));
    const day = dayKey(parts);
    const week = weekKey(parts);
    const month = monthKey(parts);
    const inDaily = day >= dailyCutoff;
    const inWeekly = weeklyCutoff !== null && week >= weeklyCutoff;
    const inMonthly = monthlyCutoff !== null && month >= monthlyCutoff;

    let verdict: RetentionVerdict;
    if (entry.subject.isConnectionTest === true) {
      // Not a backup: it is never kept, and it must not consume the day's slot
      // either — otherwise a connection test uploaded after the day's real
      // backup would push that backup out of the archive.
      verdict = { tier: "none", keep: false, reason: "连接测试文件，不属于备份" };
    } else {
      if (inDaily && !usedDays.has(day)) {
        verdict = { tier: "daily", keep: true, reason: `日备：${policy.dailyDays} 天内该日最新一份` };
      } else if (inWeekly && !usedWeeks.has(week)) {
        verdict = { tier: "weekly", keep: true, reason: `周备：${policy.weeklyWeeks} 周内该周最新一份` };
      } else if (inMonthly && !usedMonths.has(month)) {
        verdict = { tier: "monthly", keep: true, reason: `月备：${policy.monthlyMonths} 个月内该月最新一份` };
      } else if (position === 0) {
        // Safety net: however tight the policy, the archive never empties.
        verdict = { tier: "newest", keep: true, reason: "最新一份，始终保留" };
      } else {
        verdict = { tier: "none", keep: false, reason: "已被更粗粒度的保留档覆盖，超出保留期" };
      }
      usedDays.add(day);
      usedWeeks.add(week);
      usedMonths.add(month);
    }
    verdicts.set(entry.index, verdict);
  }

  return subjects.map((subject, index) => ({ ...subject, ...verdicts.get(index)! }));
}

export interface RetentionSummary {
  readonly keepCount: number;
  readonly deleteCount: number;
  readonly keepBytes: number;
  readonly deleteBytes: number;
}

export function summarizeRetention(subjects: readonly { readonly keep: boolean; readonly sizeBytes?: number | undefined }[]): RetentionSummary {
  let keepCount = 0;
  let deleteCount = 0;
  let keepBytes = 0;
  let deleteBytes = 0;
  for (const subject of subjects) {
    const size = subject.sizeBytes ?? 0;
    if (subject.keep) {
      keepCount += 1;
      keepBytes += size;
    } else {
      deleteCount += 1;
      deleteBytes += size;
    }
  }
  return { keepCount, deleteCount, keepBytes, deleteBytes };
}

/** Plain-language description used by the settings UI. */
export function describeBackupRetention(policy: BackupRetention): readonly string[] {
  return [
    `每天留 1 份，保留最近 ${policy.dailyDays} 天`,
    policy.weeklyWeeks === 0 ? "不额外保留周备" : `每周留 1 份，保留最近 ${policy.weeklyWeeks} 周`,
    policy.monthlyMonths === 0 ? "不额外保留月备" : `每月留 1 份，保留最近 ${policy.monthlyMonths} 个月`,
    `超出以上范围的备份会在下一次备份完成后移入回收站，保留 ${policy.trashDays} 天后才真正删除`,
  ];
}

/** The Shanghai day a snapshot belongs to, for grouping in the UI. */
export function backupDayKey(startedAt: string): string {
  return shanghaiDateKey(new Date(startedAt));
}

/**
 * How far back the widest retention window reaches, in days. Used only to sweep
 * files the history does not know about, so it stays conservative.
 */
export function retentionHorizonDays(policy: BackupRetention): number {
  return Math.max(policy.dailyDays, policy.weeklyWeeks * 7, policy.monthlyMonths * 31, 1);
}

/** Structural shape of a `backup_runs` row, kept generic to avoid an import cycle. */
export interface RetentionRunInput {
  readonly provider: string;
  readonly kind: string;
  readonly status: string;
  readonly fileName?: string;
  readonly location?: string;
  readonly sizeBytes?: number;
  readonly startedAt: string;
  readonly prunedAt?: string;
  readonly trashLocation?: string;
}

export interface TrashedBackupEntry {
  readonly fileName: string;
  readonly prunedAt: string;
  readonly provider: string;
  readonly trashLocation?: string;
  readonly sizeBytes?: number;
}

export interface BackupRetentionEntry {
  readonly fileName: string;
  readonly startedAt: string;
  readonly sizeBytes?: number;
  readonly location?: string;
  readonly keep: boolean;
  readonly tier: RetentionTier;
  readonly reason: string;
  /** Where the surviving copies live, so the UI can say which side has it. */
  readonly local: boolean;
  readonly remote: boolean;
}

export interface BackupRetentionView {
  readonly entries: readonly BackupRetentionEntry[];
  readonly summary: RetentionSummary;
  /** Connection-test uploads are not backups; they are counted, not listed. */
  readonly connectionTestCount: number;
  readonly connectionTestBytes: number;
  /** Snapshots that retention already moved to the recycle bin, newest first. */
  readonly trashed: readonly TrashedBackupEntry[];
}

/**
 * Joins the local and remote halves of each backup into one row, because a dual
 * backup writes one artifact to both places under the same file name. A snapshot
 * survives when either side's plan keeps it, so a disagreement never drops data.
 *
 * Already-trashed snapshots are excluded from the plan — they are gone from the
 * live set — and reported separately so the ledger stays visible.
 */
export function buildBackupRetentionView(runs: readonly RetentionRunInput[], policy: BackupRetention, now: Date): BackupRetentionView {
  const live = runs.filter((run) => run.prunedAt === undefined);
  const usable = live.filter((run) => run.status === "success" && typeof run.fileName === "string" && run.fileName.length > 0 && run.kind !== "test");
  const connectionTests = live.filter((run) => run.status === "success" && run.kind === "test");
  const trashed: TrashedBackupEntry[] = runs
    .filter((run) => run.prunedAt !== undefined && typeof run.fileName === "string")
    .map((run) => ({
      fileName: run.fileName as string,
      prunedAt: run.prunedAt as string,
      provider: run.provider,
      ...(run.trashLocation === undefined ? {} : { trashLocation: run.trashLocation }),
      ...(run.sizeBytes === undefined ? {} : { sizeBytes: run.sizeBytes }),
    }))
    .sort((left, right) => Date.parse(right.prunedAt) - Date.parse(left.prunedAt));

  const planFor = (provider: string) => {
    const subset = usable.filter((run) => run.provider === provider).map((run) => ({ startedAt: run.startedAt, fileName: run.fileName as string }));
    const planned = planBackupRetention(subset, policy, now);
    return new Map(planned.map((entry) => [entry.fileName, entry]));
  };
  const localPlan = planFor("local");
  const remotePlan = planFor("s3");

  const fileNames = new Set<string>();
  for (const run of usable) fileNames.add(run.fileName as string);

  const entries: BackupRetentionEntry[] = [];
  for (const fileName of fileNames) {
    const source = usable.find((run) => run.fileName === fileName)!;
    const localVerdict = localPlan.get(fileName);
    const remoteVerdict = remotePlan.get(fileName);
    const verdict = remoteVerdict ?? localVerdict;
    if (verdict === undefined) continue;
    const local = localVerdict !== undefined;
    const remote = remoteVerdict !== undefined;
    entries.push({
      fileName,
      startedAt: source.startedAt,
      ...(source.sizeBytes === undefined ? {} : { sizeBytes: source.sizeBytes }),
      ...(source.provider === "s3" && source.location !== undefined ? { location: source.location } : {}),
      keep: (remoteVerdict?.keep ?? false) || (localVerdict?.keep ?? false),
      tier: verdict.tier,
      reason: verdict.reason,
      local,
      remote,
    });
  }
  entries.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));

  return {
    entries,
    summary: summarizeRetention(entries.map((entry) => ({ keep: entry.keep, ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }) }))),
    connectionTestCount: connectionTests.length,
    connectionTestBytes: connectionTests.reduce((total, run) => total + (run.sizeBytes ?? 0), 0),
    trashed,
  };
}
