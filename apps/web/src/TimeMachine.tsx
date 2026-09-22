import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Cloud, HardDrive, History, RotateCcw } from "lucide-react";
import { apiRequest, type TrashedBackupEntry } from "./api";

const TIME_ZONE = "Asia/Shanghai";
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
/** Above this many snapshots in one day, the tail folds behind a "+N". */
const MAX_POINTS_PER_DAY = 3;

/**
 * How many of a record's photos a diff row spells out before it counts the rest.
 *
 * Three, and then a number. This panel sits beside the axis and is the narrower
 * half of the page, so a row that unrolled a nine-photo post would push every
 * other record off the screen — and the question a diff answers is "which one was
 * that", not "let me look through the album".
 */
const DIFF_PHOTO_LIMIT = 3;

/**
 * One point on the axis. `keep`/`tier`/`reason` come straight from the retention
 * plan, so the badge here can never disagree with what the settings page says
 * about the same snapshot.
 */
interface RetentionEntry {
  readonly fileName: string;
  readonly startedAt: string;
  readonly sizeBytes?: number;
  readonly keep: boolean;
  readonly tier: "daily" | "weekly" | "monthly" | "newest" | "none";
  readonly reason: string;
  readonly local: boolean;
  readonly remote: boolean;
  /** Cleaned into the recycle bin; still readable until the bin ages out. */
  readonly trashed?: boolean;
}

function axisEntryFromTrash(item: TrashedBackupEntry): RetentionEntry {
  return {
    fileName: item.fileName,
    startedAt: item.startedAt,
    ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }),
    keep: false,
    tier: "none",
    reason: "已被保留策略清理（回收站）",
    local: item.provider === "local",
    remote: item.provider !== "local",
    trashed: true,
  };
}

interface SnapshotCounts {
  readonly records: number;
  readonly recordsTrashed: number;
  readonly photos: number;
  readonly people: number;
  readonly entities: number;
  readonly assets: number;
  readonly summaries: number;
}

interface DiffSample {
  readonly id: string;
  readonly kind: string;
  readonly preview: string;
  readonly isPrivate: boolean;
  readonly occurredDay?: string;
  /** Photos of that moment the API can still serve. Absent when there are none. */
  readonly photos?: readonly string[];
  /** Of that moment's photos, how many no longer have a file behind them. */
  readonly photosGone?: number;
  readonly revisions?: { readonly then: number; readonly now: number };
  readonly restorable?: boolean;
}

/**
 * The same URL the timeline's grid asks for, at the same width, so a photo shown
 * in both places costs one download rather than two.
 *
 * 400 is one of the only two widths the API derives; anything else is refused
 * outright rather than rounded, so this number has to stay one of them.
 */
function photoThumbUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/thumbnail?w=400`;
}

interface SnapshotReading {
  readonly fileName: string;
  readonly source: "local" | "remote" | "remote-trashed";
  readonly sizeBytes: number;
  readonly counts: SnapshotCounts;
  readonly diff: {
    readonly gone: { readonly total: number; readonly samples: readonly DiffSample[] };
    readonly changed: { readonly total: number; readonly samples: readonly DiffSample[] };
    readonly added: { readonly total: number; readonly samples: readonly DiffSample[] };
    readonly unchanged: number;
    readonly trashedInSnapshot: number;
    readonly sampleLimit: number;
  };
}

const KIND_LABELS: Record<string, string> = {
  journal: "日记",
  task: "任务",
  event: "事件",
  note: "笔记",
};

const TIER_LABELS: Record<RetentionEntry["tier"], string> = {
  daily: "日备份",
  weekly: "周备份",
  monthly: "月备份",
  newest: "最新",
  none: "已清理",
};

function dayKeyOf(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Reads a calendar date's parts without letting a timezone move the weekday. */
function dayLabel(key: string): { readonly monthDay: string; readonly weekday: string } {
  const [year, month, day] = key.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) return { monthDay: key, weekday: "" };
  return {
    monthDay: `${month}月${day}日`,
    weekday: `周${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? ""}`,
  };
}

function formatBytes(size: number | undefined): string {
  if (size === undefined || size <= 0) return "—";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function countLabel(count: number, unit: string): string {
  return `${count} ${unit}`;
}

/**
 * The 时光机. Reads history, changes nothing.
 *
 * The axis is deliberately a ruler rather than a list: snapshots are not evenly
 * spaced in time, and the gaps between ticks are part of what the owner is trying
 * to see. Every number on the right comes from opening the snapshot itself, never
 * from the live database, so "what it held back then" cannot drift.
 */
export function TimeMachine() {
  const [entries, setEntries] = useState<readonly RetentionEntry[] | null>(null);
  const [recycled, setRecycled] = useState(0);
  const [axisError, setAxisError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reading, setReading] = useState<SnapshotReading | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [readingLoading, setReadingLoading] = useState(false);
  const [expandedDays, setExpandedDays] = useState<ReadonlySet<string>>(new Set<string>());

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{
      readonly entries: readonly RetentionEntry[];
      readonly trashed?: readonly TrashedBackupEntry[];
    }>("/api/backup/retention", { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        // Live points first; cleaned ones stay on the axis so history does not
        // silently vanish when retention tidies the folder. Dedupe by fileName
        // because a dual backup writes local + s3 rows for one file.
        const byFile = new Map<string, RetentionEntry>();
        for (const entry of payload.entries) byFile.set(entry.fileName, entry);
        for (const item of payload.trashed ?? []) {
          if (byFile.has(item.fileName)) continue;
          byFile.set(item.fileName, axisEntryFromTrash(item));
        }
        const merged = [...byFile.values()].sort(
          (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
        );
        setEntries(merged);
        setRecycled(payload.trashed?.length ?? 0);
        setSelected(merged[0]?.fileName ?? null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setAxisError(error instanceof Error ? error.message : "备份列表读取失败");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selected === null) return;
    const controller = new AbortController();
    setReadingLoading(true);
    setReadingError(null);
    apiRequest<SnapshotReading>(`/api/backup/snapshot?fileName=${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) setReading(payload); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setReading(null);
        setReadingError(error instanceof Error ? error.message : "这个时间点暂时读不出来");
      })
      .finally(() => { if (!controller.signal.aborted) setReadingLoading(false); });
    return () => controller.abort();
  }, [selected]);

  const days = useMemo(() => {
    const groups: Array<{ readonly key: string; readonly entries: readonly RetentionEntry[] }> = [];
    for (const entry of entries ?? []) {
      const key = dayKeyOf(entry.startedAt);
      const last = groups[groups.length - 1];
      if (last !== undefined && last.key === key) {
        (last.entries as RetentionEntry[]).push(entry);
      } else {
        groups.push({ key, entries: [entry] });
      }
    }
    return groups;
  }, [entries]);

  const selectedEntry = (entries ?? []).find((entry) => entry.fileName === selected);

  if (axisError !== null) {
    return (
      <section className="time-machine">
        <div className="tm-error" role="alert">
          <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
          <span>{axisError}</span>
        </div>
      </section>
    );
  }

  if (entries === null) {
    return <section className="time-machine"><p className="tm-placeholder">正在读取备份时间轴…</p></section>;
  }

  if (entries.length === 0) {
    return (
      <section className="time-machine">
        <div className="tm-empty">
          <History size={22} strokeWidth={1.7} aria-hidden="true" />
          <strong>还没有任何快照</strong>
          <p>备份跑过一次之后，这里会出现可以回看的刻度。备份入口在「设置 · 备份」。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="time-machine">
      <nav className="tm-axis" aria-label="备份时间轴">
        <p className="tm-axis-caption">
          共 {entries.filter((entry) => entry.trashed !== true).length} 个在库快照
          {/* Retention moves extras to the recycle bin. Those cleaned points stay
              on the axis (dimmed) so the gaps are honest, and remain readable. */}
          {recycled > 0 ? `；另有 ${recycled} 条清理记录在回收站（轴上灰点，30 天内仍可回看）` : ""}
        </p>
        <ol className="tm-days">
          {days.map((day) => {
            const { monthDay, weekday } = dayLabel(day.key);
            const expanded = expandedDays.has(day.key);
            const visible = expanded ? day.entries : day.entries.slice(0, MAX_POINTS_PER_DAY);
            const hidden = day.entries.length - visible.length;
            return (
              <li className="tm-day" key={day.key}>
                <div className="tm-day-head">
                  <span className="tm-day-label">{monthDay}</span>
                  <span className="tm-day-week">{weekday}</span>
                </div>
                <ul className="tm-points">
                  {visible.map((entry) => (
                    <li className={`tm-point ${entry.trashed === true ? "is-trashed" : ""}`} key={entry.fileName}>
                      <button
                        className={`tm-point-button ${entry.fileName === selected ? "is-selected" : ""}`}
                        type="button"
                        aria-current={entry.fileName === selected ? "true" : undefined}
                        onClick={() => setSelected(entry.fileName)}
                      >
                        <span className="tm-point-time">{timeOf(entry.startedAt)}</span>
                        <span className="tm-point-dot" aria-hidden="true" />
                        <span className="tm-point-body">
                          <span className="tm-point-top">
                            <span className="tm-tier">{TIER_LABELS[entry.tier]}</span>
                            <span className="tm-point-size">{formatBytes(entry.sizeBytes)}</span>
                          </span>
                          <span className="tm-point-where">
                            {entry.local ? <HardDrive size={12} strokeWidth={1.9} aria-label="本地有副本" /> : null}
                            {entry.remote ? <Cloud size={12} strokeWidth={1.9} aria-label="对象存储有副本" /> : null}
                            {entry.keep ? <span className="tm-point-keep">保留</span> : <span className="tm-point-drop">将被清理</span>}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {hidden > 0 ? (
                    <li className="tm-point tm-point-more">
                      <button
                        className="tm-more-button"
                        type="button"
                        onClick={() => setExpandedDays((current) => new Set([...current, day.key]))}
                      >
                        还有 {hidden} 个
                      </button>
                    </li>
                  ) : null}
                </ul>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="tm-panel">
        {selectedEntry === undefined ? null : (
          <header className="tm-panel-head">
            <div>
              <h2>{`${dayLabel(dayKeyOf(selectedEntry.startedAt)).monthDay} ${timeOf(selectedEntry.startedAt)}`}</h2>
              <p className="tm-panel-sub">
                {selectedEntry.fileName}
                <span aria-hidden="true"> · </span>
                {selectedEntry.local ? "本地副本" : "仅对象存储"}
                <span aria-hidden="true"> · </span>
                {selectedEntry.reason}
              </p>
            </div>
            <button className="tm-recover-button" type="button" disabled title="选择性捞回在下一版开放">
              <RotateCcw size={15} strokeWidth={1.9} aria-hidden="true" />
              <span>从这个时间点捞回</span>
            </button>
          </header>
        )}

        {readingError !== null ? (
          <div className="tm-error" role="alert">
            <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
            <span>{readingError}</span>
          </div>
        ) : null}

        {readingLoading && reading === null ? <p className="tm-placeholder">正在打开这个时间点…</p> : null}

        {reading !== null ? (
          <>
            <ul className="tm-counts">
              <li><small>记录</small><strong>{reading.counts.records}</strong><em>{reading.counts.recordsTrashed > 0 ? `${reading.counts.recordsTrashed} 条在回收站` : "回收站为空"}</em></li>
              <li><small>照片</small><strong>{reading.counts.photos}</strong><em>共 {countLabel(reading.counts.assets, "个资产")}</em></li>
              <li><small>人物</small><strong>{reading.counts.people}</strong><em>共 {countLabel(reading.counts.entities, "个实体")}</em></li>
              <li><small>摘要</small><strong>{reading.counts.summaries}</strong><em>{reading.counts.summaries > 0 ? "天有摘要" : "还没有摘要"}</em></li>
            </ul>

            <div className="tm-diff">
              <p className="tm-diff-caption">
                和现在比：<b>{reading.diff.gone.total}</b> 条不在了、<b>{reading.diff.changed.total}</b> 条改过、<b>{reading.diff.added.total}</b> 条是后来才有的，{reading.diff.unchanged} 条没动过。
                {reading.diff.trashedInSnapshot > 0 ? `（当时另有 ${reading.diff.trashedInSnapshot} 条已经在回收站）` : ""}
              </p>
              <DiffRow tone="gone" title="不在了" bucket={reading.diff.gone} hint="当时在时间轴上，现在不在" />
              <DiffRow tone="changed" title="改过了" bucket={reading.diff.changed} hint="两条都在，内容变了" />
              <DiffRow tone="added" title="后来才有" bucket={reading.diff.added} hint="当时还没有" />
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

/**
 * A record's photos, capped and counted.
 *
 * The list is what the read layer could still serve for that moment, so an
 * `<img>` here has somewhere to point. A private record renders nothing at all —
 * the mask covers the pictures too, or "what disappeared" becomes a way to look
 * at them.
 */
function DiffPhotos({ sample }: { readonly sample: DiffSample }) {
  const photos = sample.photos ?? [];
  const gone = sample.photosGone ?? 0;
  if (sample.isPrivate || (photos.length === 0 && gone === 0)) return null;
  const shown = photos.slice(0, DIFF_PHOTO_LIMIT);
  const hidden = photos.length - shown.length;
  return (
    <>
      {shown.length === 0 ? null : (
        <span className="tm-diff-photos">
          {shown.map((assetId) => <DiffPhoto key={assetId} assetId={assetId} />)}
          {hidden > 0 ? <span className="tm-diff-photos-rest">还有 {hidden} 张</span> : null}
        </span>
      )}
      {gone > 0 ? <span className="tm-diff-photos-gone">另有 {gone} 张照片已经不在了</span> : null}
    </>
  );
}

/**
 * One square.
 *
 * The read layer names only photos it can still serve, so the error path means a
 * file vanished between the query and the paint. A quiet dashed gap is the honest
 * answer there; better than the icon a browser draws for a broken image, which
 * reads as "this app is broken" rather than "that photo is gone".
 */
function DiffPhoto({ assetId }: { readonly assetId: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return <span className="tm-diff-photo tm-diff-photo-missing" role="img" aria-label="照片已不在" />;
  }
  return (
    <img
      className="tm-diff-photo"
      src={photoThumbUrl(assetId)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setMissing(true)}
    />
  );
}

function DiffRow({
  tone,
  title,
  bucket,
  hint,
}: {
  readonly tone: "gone" | "changed" | "added";
  readonly title: string;
  readonly bucket: { readonly total: number; readonly samples: readonly DiffSample[] };
  readonly hint: string;
}) {
  return (
    <section className={`tm-diff-row tm-diff-${tone}`}>
      <header>
        <span className="tm-diff-title">{title}</span>
        <strong>{bucket.total}</strong>
        <small>{hint}</small>
      </header>
      {bucket.total === 0 ? (
        <p className="tm-diff-none">这一格是空的</p>
      ) : (
        <ul className="tm-diff-items">
          {bucket.samples.map((sample) => (
            <li key={sample.id}>
              {/* A private record is masked on the timeline, so the diff shows no text
                  here either — otherwise "what disappeared" would be a way to read it. */}
              <span className="tm-diff-kind">{KIND_LABELS[sample.kind] ?? "记录"}</span>
              <span className="tm-diff-text">
                {sample.preview.length > 0 ? sample.preview : sample.isPrivate ? "（私密记录，不显示内容）" : "（没有正文）"}
              </span>
              <span className="tm-diff-meta">
                {sample.occurredDay ?? ""}
                {sample.revisions === undefined ? "" : ` · v${sample.revisions.then}→v${sample.revisions.now}`}
                {sample.restorable === true ? " · 回收站里还在" : ""}
              </span>
              <DiffPhotos sample={sample} />
            </li>
          ))}
          {bucket.total > bucket.samples.length ? (
            <li className="tm-diff-rest">还有 {bucket.total - bucket.samples.length} 条没有列出来</li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
