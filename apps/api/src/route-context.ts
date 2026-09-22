import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiConfig } from "./config.js";
import type { SqliteRecordRepository } from "./repository.js";
import type { BackupScheduler } from "./backup-scheduler.js";
import type { WeatherArchiveScheduler } from "./weather-archive-scheduler.js";
import type { createThumbnailCache } from "./derived-thumbs.js";

export type ThumbnailCache = ReturnType<typeof createThumbnailCache>;

export interface RouteContext {
  readonly config: ApiConfig;
  readonly repository: SqliteRecordRepository;
  readonly backupScheduler: BackupScheduler;
  readonly weatherArchiveScheduler: WeatherArchiveScheduler;
  readonly thumbnails: ThumbnailCache;
  readonly loginFailures: Map<string, { failures: number; blockedUntil: number }>;
  readonly authenticated: (req: IncomingMessage) => boolean;
  readonly requireAuth: (req: IncomingMessage) => void;
  readonly checkRequestSecurity: (req: IncomingMessage) => void;
}

export type RouteHandler = (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
) => Promise<boolean>;
