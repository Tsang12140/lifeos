import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createDualBackup,
  createLocalBackup,
  downloadSnapshotObject,
  pruneBackups,
  testS3Backup,
  uploadS3Backup,
} from "./backup.js";
import { publicBackupConfig, saveRuntimeBackupConfig } from "./backup-config.js";
import {
  BACKUP_RETENTION_LIMITS,
  DEFAULT_BACKUP_RETENTION,
  buildBackupRetentionView,
  describeBackupRetention,
  type BackupRetention,
} from "./backup-retention.js";
import { BACKUP_TIME_ZONE, publicNextBackupAt } from "./backup-scheduler.js";
import { SnapshotUnavailableError, readSnapshot } from "./backup-timeline.js";
import type { ApiConfig } from "./config.js";
import type { BackupRun, BackupSchedule, SqliteRecordRepository } from "./repository.js";
import { HttpError, backupHttpError, setJson } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import {
  booleanField,
  boundedIntegerField,
  hasOnlyKeys,
  jsonObject,
  parseDateQuery,
  stringField,
} from "./field-validate.js";
import { safeId } from "./record-builders.js";
import { shanghaiDateKey } from "./asset-static.js";
import type { RouteContext, RouteHandler } from "./route-context.js";

export function backupRunDate(run: { readonly startedAt: string }): string {
  return shanghaiDateKey(new Date(run.startedAt));
}

export function latestDualBackup(runs: readonly BackupRun[]): {
  readonly batchId: string;
  readonly status: "success" | "partial" | "local_only" | "failed";
  readonly local: BackupRun;
  readonly s3: BackupRun;
} | null {
  const local = runs.find((run) => run.batchId !== undefined && run.provider === "local");
  if (local?.batchId === undefined) return null;
  const s3 = runs.find((run) => run.batchId === local.batchId && run.provider === "s3");
  if (s3 === undefined) return null;
  const status = local.status === "failed"
    ? "failed"
    : s3.status === "success"
      ? "success"
      : s3.status === "skipped"
        ? "local_only"
        : "partial";
  return { batchId: local.batchId, status, local, s3 };
}

/**
 * Shapes the retention state for the settings UI: the policy in plain language,
 * one row per backup with its verdict and the reason behind it, and when the
 * cleanup will next run. Cleanup happens after each backup, so "next cleanup" is
 * simply the next scheduled backup.
 */
export function backupRetentionPayload(repository: SqliteRecordRepository, config: ApiConfig, schedule: BackupSchedule) {
  const policy = repository.getBackupRetention();
  // The whole history: a truncated list would hide older snapshots from the plan.
  const runs = repository.listAllBackupRuns();
  const view = buildBackupRetentionView(runs, policy, new Date());
  return {
    policy,
    limits: BACKUP_RETENTION_LIMITS,
    defaults: DEFAULT_BACKUP_RETENTION,
    described: describeBackupRetention(policy),
    cleanupTrigger: "每次备份完成后自动清理",
    // Cleaned snapshots are moved into LifeOS's own recycle bin first, because
    // the bucket has versioning off — a plain S3 DELETE would be permanent.
    cleanupScope: { local: true, remote: true, recycleBin: { local: true, remote: true } },
    cleanupScheduled: schedule.enabled,
    nextCleanupAt: publicNextBackupAt(schedule),
    localDirectory: config.backupDirectory ?? null,
    entries: view.entries,
    summary: view.summary,
    trashed: view.trashed,
    connectionTestCount: view.connectionTestCount,
    connectionTestBytes: view.connectionTestBytes,
  };
}

export const handleBackupRoutes: RouteHandler = async (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> => {
  const { config, repository, backupScheduler } = ctx;
  if (pathname === "/api/backup/status" && req.method === "GET") {
    const s3 = publicBackupConfig(config);
    const schedule = backupScheduler.schedule;
    const runs = repository.listBackupRuns(100);
    const scheduledRuns = runs.filter((run) => run.kind === "scheduled");
    const latestScheduled = scheduledRuns[0];
    setJson(res, 200, {
      // Acceptance tooling must inspect the paths actually used by this API.
      // localDirectory is only the backup destination and may be overridden.
      dataDirectory: config.dataDirectory,
      databasePath: config.databasePath,
      assetRoot: config.assetRoot ?? null,
      localDirectory: config.backupDirectory ?? null,
      s3,
      schedule: {
        ...schedule,
        timeZone: BACKUP_TIME_ZONE,
        nextRunAt: publicNextBackupAt(schedule),
        ...(latestScheduled?.finishedAt === undefined ? {} : { lastRunAt: latestScheduled.finishedAt }),
      },
      lastDualBackup: latestDualBackup(runs),
      retention: { policy: repository.getBackupRetention(), described: describeBackupRetention(repository.getBackupRetention()) },
      runs,
    });
    return true;
  }
  if (pathname === "/api/backup/retention" && req.method === "GET") {
    setJson(res, 200, backupRetentionPayload(repository, config, backupScheduler.schedule));
    return true;
  }
  if (pathname === "/api/backup/retention" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["dailyDays", "weeklyWeeks", "monthlyMonths", "trashDays"]);
    try {
      const policy: BackupRetention = {
        dailyDays: boundedIntegerField(input.dailyDays, "dailyDays", BACKUP_RETENTION_LIMITS.dailyDays.min, BACKUP_RETENTION_LIMITS.dailyDays.max),
        weeklyWeeks: boundedIntegerField(input.weeklyWeeks, "weeklyWeeks", BACKUP_RETENTION_LIMITS.weeklyWeeks.min, BACKUP_RETENTION_LIMITS.weeklyWeeks.max),
        monthlyMonths: boundedIntegerField(input.monthlyMonths, "monthlyMonths", BACKUP_RETENTION_LIMITS.monthlyMonths.min, BACKUP_RETENTION_LIMITS.monthlyMonths.max),
        trashDays: boundedIntegerField(input.trashDays, "trashDays", BACKUP_RETENTION_LIMITS.trashDays.min, BACKUP_RETENTION_LIMITS.trashDays.max),
      };
      repository.saveBackupRetention(policy);
      setJson(res, 200, backupRetentionPayload(repository, config, backupScheduler.schedule));
    } catch (error) {
      throw new HttpError(400, "invalid_backup_retention", error instanceof Error ? error.message : "保留策略无效");
    }
    return true;
  }
  // The time machine: reads one point in time without altering it. The snapshot
  // is copied into a scratch directory under the data directory and opened
  // read-only, so this route can look at the owner's real backup set but has no
  // way to write to it.
  if (pathname === "/api/backup/snapshot" && req.method === "GET") {
    const fileName = (url.searchParams.get("fileName") ?? "").trim();
    try {
      setJson(res, 200, await readSnapshot(config, fileName, repository));
    } catch (error) {
      if (!(error instanceof SnapshotUnavailableError)) throw error;
      // The mapping lives here, not in the read layer, because these are HTTP
      // answers: a point that vanished between listing and clicking is a 404
      // rather than a 500, and an unreachable object store is a 502 so the view
      // can blame the copy instead of the request.
      const mapping = error.reason === "invalid-name"
        ? { status: 400, code: "invalid_snapshot_name" }
        : error.reason === "missing"
          ? { status: 404, code: "snapshot_missing" }
          : error.reason === "transport"
            ? { status: 502, code: "snapshot_unavailable" }
            : { status: 500, code: "snapshot_unreadable" };
      throw new HttpError(mapping.status, mapping.code, error.message);
    }
    return true;
  }
  if (pathname === "/api/backup/runs" && req.method === "GET") {
    const from = parseDateQuery(url.searchParams.get("from"), "from");
    const to = parseDateQuery(url.searchParams.get("to"), "to");
    if ((from === undefined) !== (to === undefined)) throw new HttpError(400, "invalid_range", "from and to must be provided together");
    if (from !== undefined && to !== undefined) {
      if (from > to) throw new HttpError(400, "invalid_range", "from must not be after to");
      const start = Date.parse(`${from}T00:00:00Z`);
      const end = Date.parse(`${to}T00:00:00Z`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || (end - start) / 86_400_000 > 400) {
        throw new HttpError(400, "invalid_range", "备份日历最多查询 400 天");
      }
    }
    const allRuns = repository.listBackupRuns(1000);
    const items = from === undefined || to === undefined
      ? allRuns
      : allRuns.filter((run) => {
          const day = backupRunDate(run);
          return day >= from && day <= to;
        });
    setJson(res, 200, { items });
    return true;
  }
  if (pathname === "/api/backup/config" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["enabled", "endpoint", "region", "bucket", "prefix", "forcePathStyle", "accessKeyId", "secretAccessKey"]);
    try {
      const status = saveRuntimeBackupConfig(config, {
        enabled: booleanField(input.enabled, "enabled"),
        endpoint: stringField(input.endpoint, "endpoint", { nonEmpty: true }),
        region: stringField(input.region, "region", { nonEmpty: true }),
        bucket: stringField(input.bucket, "bucket", { nonEmpty: true }),
        prefix: stringField(input.prefix ?? "product-backup/lifeos", "prefix"),
        forcePathStyle: booleanField(input.forcePathStyle, "forcePathStyle"),
        ...(input.accessKeyId === undefined ? {} : { accessKeyId: stringField(input.accessKeyId, "accessKeyId") }),
        ...(input.secretAccessKey === undefined ? {} : { secretAccessKey: stringField(input.secretAccessKey, "secretAccessKey") }),
      });
      setJson(res, 200, { ok: true, s3: status });
    } catch (error) {
      throw new HttpError(400, "invalid_backup_config", error instanceof Error ? error.message : "对象存储配置无效");
    }
    return true;
  }
  if (pathname === "/api/backup/schedule" && req.method === "GET") {
    const schedule = backupScheduler.schedule;
    setJson(res, 200, { ...schedule, timeZone: BACKUP_TIME_ZONE, nextRunAt: publicNextBackupAt(schedule) });
    return true;
  }
  if (pathname === "/api/backup/schedule" && req.method === "POST") {
    requireJsonContentType(req, true);
    const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
    hasOnlyKeys(input, ["enabled", "hour", "minute"]);
    const schedule = {
      enabled: booleanField(input.enabled, "enabled"),
      hour: boundedIntegerField(input.hour, "hour", 0, 23),
      minute: boundedIntegerField(input.minute, "minute", 0, 59),
    } as const;
    try {
      repository.saveBackupSchedule(schedule);
      backupScheduler.update(schedule);
    } catch (error) {
      throw new HttpError(400, "invalid_backup_schedule", error instanceof Error ? error.message : "备份排程无效");
    }
    setJson(res, 200, { ...schedule, timeZone: BACKUP_TIME_ZONE, nextRunAt: publicNextBackupAt(schedule) });
    return true;
  }
  if (pathname === "/api/backup/dual" && req.method === "POST") {
    requireJsonContentType(req, true);
    try {
      const result = await createDualBackup(config, repository, "manual");
      const status = result.status === "failed" ? 502 : 201;
      setJson(res, status, { ok: result.status !== "failed", provider: "dual", ...result });
    } catch (error) {
      throw backupHttpError(error);
    }
    return true;
  }
  if (pathname === "/api/backup/local" && req.method === "POST") {
    requireJsonContentType(req, true);
    try {
      const artifact = await createLocalBackup(config, repository);
      const pruned = await pruneBackups(config, repository);
      setJson(res, 201, { ok: true, provider: "local", fileName: artifact.filename, location: artifact.path, sizeBytes: artifact.sizeBytes, pruned: pruned.trashedLocal + pruned.purgedLocal, prune: pruned });
    } catch (error) {
      throw backupHttpError(error);
    }
    return true;
  }
  if (pathname === "/api/backup/s3" && req.method === "POST") {
    requireJsonContentType(req, true);
    try {
      const result = await uploadS3Backup(config, repository);
      setJson(res, 201, { ok: true, provider: "s3", fileName: result.filename, location: result.location, sizeBytes: result.sizeBytes });
    } catch (error) {
      throw backupHttpError(error);
    }
    return true;
  }
  if (pathname === "/api/backup/s3/test" && req.method === "POST") {
    requireJsonContentType(req, true);
    try {
      const result = await testS3Backup(config, repository);
      setJson(res, 200, { ok: true, location: result.location, transport: result.transport, ...(result.transport === "file" ? { warning: "当前对象存储 Endpoint 是本机目录（file://），连接测试只写入了本机文件，不能证明可以联网上传。" } : {}) });
    } catch (error) {
      throw backupHttpError(error);
    }
    return true;
  }

  return false;
};
