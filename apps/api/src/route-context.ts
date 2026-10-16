import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiConfig } from "./config.js";
import type { SqliteRecordRepository } from "./repository.js";
import type { BackupScheduler } from "./backup-scheduler.js";
import type { WeatherArchiveScheduler } from "./weather-archive-scheduler.js";
import type { PhotoTextTrigger } from "./photo-text-trigger.js";
import type { createThumbnailCache } from "./derived-thumbs.js";
import type { PoolConsumerBridge } from "./storage-pool.js";
import type { StoragePoolStore } from "./storage-pool-store.js";
import type { PoolTransition } from "./pool-transition.js";

export interface PoolPreflight {
  readonly storageFreeBytes: number;
  readonly trafficFreeBytes: number;
  readonly month: string;
}

export type ThumbnailCache = ReturnType<typeof createThumbnailCache>;

import type { CalendarTaskLabels } from "./calendar-task-labels.js";

import type { CalendarDays } from "./calendar-days.js";
import type { CalendarBackgrounds } from "./calendar-backgrounds.js";

export interface RouteContext {
  readonly calendarDays: CalendarDays;
  readonly calendarBackgrounds: CalendarBackgrounds;
  readonly config: ApiConfig;
  readonly repository: SqliteRecordRepository;
  readonly calendarTaskLabels: CalendarTaskLabels;
  readonly backupScheduler: BackupScheduler;
  readonly weatherArchiveScheduler: WeatherArchiveScheduler;
  /**
   * The "an entry was saved" nudge that reads the words off its photos behind the request.
   * A route only ever *notifies* it; the decision of what to read is the pass's own.
   */
  readonly photoTextTrigger: PhotoTextTrigger;
  readonly thumbnails: ThumbnailCache;
  readonly poolBridge: PoolConsumerBridge;
  readonly poolStore: StoragePoolStore | null;
  readonly poolAccountId: string;
  readonly poolAdmin: boolean;
  readonly poolPreflight: () => Promise<PoolPreflight>;
  readonly poolTransition?: PoolTransition | null;
  readonly loginFailures: Map<string, { failures: number; blockedUntil: number; lastFailureAt: number }>;
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
