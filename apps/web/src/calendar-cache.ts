import { useEffect, useRef, useState } from "react";
import type { CalendarPresentation } from "@lifeos/core";
import { apiRequest } from "./api";

/** Memory belongs to this authenticated session. Immutable thumbnail bytes use the browser's disk cache. */
export function useCalendarPresentations(scope: string, dates: readonly string[], today: string, generation: number, hideDemo: boolean, enabled: boolean, onError: (error: unknown, fallback: string) => string): { days: ReadonlyMap<string, CalendarPresentation>; error: string | null } {
  const owner = `${scope}:${hideDemo}:${today}:${generation}`;
  const cache = useRef({ owner, days: new Map<string, CalendarPresentation>(), windows: new Set<string>() });
  const [, redraw] = useState(0);
  const [errorState, setError] = useState<{ owner: string; message: string } | null>(null);
  if (cache.current.owner !== owner) cache.current = { owner, days: new Map(), windows: new Set() };
  const from = dates[0], to = dates[dates.length - 1];
  useEffect(() => {
    if (!enabled || from === undefined || to === undefined) return;
    const controller = new AbortController();
    const target = cache.current;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const params = new URLSearchParams({ from, to, hideDemo: hideDemo ? "1" : "0" });
        const payload = await apiRequest<{ items: CalendarPresentation[] }>(`/api/calendar/days?${params}`, { signal: controller.signal });
        if (controller.signal.aborted || cache.current !== target) return;
        for (const date of dates) target.days.delete(date);
        for (const item of payload.items) target.days.set(item.date, item);
        while (target.days.size > 420) { target.days.delete(target.days.keys().next().value!); target.windows.clear(); }
        target.windows.add(from + ":" + to);
        setError(null);
        redraw(n => n + 1);
        const pending = payload.items.flatMap(item => item.retryAfter === undefined ? [] : [item.retryAfter]);
        if (pending.length > 0) retry = setTimeout(() => void read(), Math.max(1000, Math.min(...pending) - Date.now()));
      } catch (error) { if (!controller.signal.aborted && cache.current === target) setError({ owner, message: onError(error, "日历照片读取失败，请重试") }); }
    };
    const windowKey = from + ":" + to;
    const cachedRetry = dates.flatMap(date => { const item = target.days.get(date); return item?.retryAfter === undefined ? [] : [item.retryAfter]; });
    if (!target.windows.has(windowKey)) void read();
    else if (cachedRetry.length > 0) retry = setTimeout(() => void read(), Math.max(0, Math.min(...cachedRetry) - Date.now()));
    // Another device may have edited history while this tab was in the background.
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => { controller.abort(); clearTimeout(retry); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, [enabled, owner, from, to, hideDemo, onError]);
  return { days: cache.current.days, error: errorState?.owner === owner ? errorState.message : null };
}
