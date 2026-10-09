import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { Timeline, TimelineItem, groupRecords } from "./timeline";
import { ErrorState, LoadingState } from "./timeline-states";
import { displayDate, shortDate } from "./time";

type RecordFeedProps = ComponentProps<typeof Timeline> & {
  today: string;
  jumpVersion: number;
  onBackfill: (date: string) => void;
};

function EarlierDivider() {
  const id = useId();
  const arm = (side: string) => <svg className={side === "right" ? "is-mirrored" : undefined} viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id={`${id}-${side}`} gradientUnits="userSpaceOnUse" x1="0" y1="22" x2="200" y2="22">
      <stop offset="0" stopColor="#7c8797" stopOpacity=".2" /><stop offset=".5" stopColor="#7c8797" stopOpacity=".65" /><stop offset="1" stopColor="#7c8797" stopOpacity=".85" />
    </linearGradient></defs>
    <path d="M1 22 H195" fill="none" stroke={`url(#${id}-${side})`} strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
  </svg>;
  return <div className="earlier-divider" role="separator" aria-label="今天与更早的记录">{arm("left")}<span>更早</span>{arm("right")}</div>;
}

export function RecordFeed(props: RecordFeedProps) {
  const { records, today, selectedDate, jumpVersion, dataCurrent, loading, refreshing, error, onRetry, onBackfill, interactionDisabled } = props;
  const root = useRef<HTMLElement>(null);
  const lastJump = useRef<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState(14);
  const groups = useMemo(() => groupRecords(records ?? [], today).filter(group => group.date <= today), [records, today]);
  const todayRecords = groups.find(group => group.date === today)?.records ?? [];
  const history = useMemo(() => {
    const earlier = groups.filter(group => group.date < today);
    // An empty day remains a real navigation destination, without fabricating a record.
    if (selectedDate < today && !earlier.some(group => group.date === selectedDate)) earlier.push({ date: selectedDate, records: [] });
    return earlier.sort((a, b) => b.date.localeCompare(a.date));
  }, [groups, selectedDate, today]);
  const targetIndex = history.findIndex(group => group.date === selectedDate);
  const shownHistory = history.slice(0, Math.max(historyLimit, targetIndex + 1));

  useEffect(() => {
    if (!dataCurrent || loading || error || records === null) return;
    const key = `${selectedDate}:${jumpVersion}`;
    if (lastJump.current === key) return;
    lastJump.current = key;
    // Default entry stays at the composer. Explicit date navigation scrolls into history.
    if (selectedDate === today && jumpVersion === 0) return;
    if (selectedDate === today) { window.scrollTo({ top: 0, behavior: "instant" }); return; }
    const target = [...(root.current?.querySelectorAll<HTMLElement>("[data-feed-date]") ?? [])].find(node => node.dataset.feedDate === selectedDate);
    target?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [selectedDate, jumpVersion, today, dataCurrent, loading, error, records]);

  const items = (dayRecords: typeof todayRecords) => dayRecords.map(record => <TimelineItem {...props} key={record.id} record={record} />);
  const ready = records !== null;
  return <section className="timeline-section record-feed" data-view="today" ref={root} aria-labelledby="record-feed-title" aria-busy={refreshing || !dataCurrent ? "true" : undefined}>
    <div className="section-heading"><div className="record-feed-heading"><h2 id="record-feed-title">今天</h2><span>{shortDate(today)}</span></div>{todayRecords.length ? <span className="record-count">{todayRecords.length} 条</span> : null}</div>
    {loading && records === null ? <LoadingState /> : null}
    {error ? <ErrorState message={error} onRetry={onRetry} /> : null}
    {records !== null && !error && (refreshing || !dataCurrent) ? <div className="timeline-refresh-state" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /><span>正在更新记录…</span></div> : null}
    {ready ? <>
      <div className={`timeline-list record-feed-today ${interactionDisabled ? "is-stale" : ""}`} data-feed-date={today}>
        <div className="timeline-group">{todayRecords.length ? items(todayRecords) : <p className="record-feed-empty">今天还没有记录</p>}</div>
      </div>
      {history.length ? <><EarlierDivider /><div className={`timeline-list record-feed-history ${interactionDisabled ? "is-stale" : ""}`}>
        {shownHistory.map(group => <div className="timeline-group" key={group.date} data-feed-date={group.date}>
          <div className="record-feed-day-heading"><h3 className="timeline-group-title">{group.date.slice(0, 4) !== today.slice(0, 4) ? `${group.date.slice(0, 4)}年` : ""}{displayDate(group.date)}</h3><button className="record-feed-backfill" type="button" disabled={interactionDisabled} onClick={() => onBackfill(group.date)} aria-label={`补记${group.date}`}>补记这一天</button></div>
          {group.records.length ? items(group.records) : <p className="record-feed-empty">这一天还没有记录</p>}
        </div>)}
      </div>{shownHistory.length < history.length ? <div className="record-feed-more"><button className="secondary-button" type="button" onClick={() => setHistoryLimit(shownHistory.length + 14)}>查看更多</button></div> : null}</> : null}
    </> : null}
  </section>;
}
