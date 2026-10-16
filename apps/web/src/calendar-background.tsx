import { useEffect, useRef, useState, type CSSProperties } from "react";
import { apiRequest } from "./api";
import { PHOTO_WALL_ENABLED, PHOTO_WALL_DEFAULTS, photoWallPreferences, type PhotoWallPreferences } from "@lifeos/core";
import "./calendar-background.css";

interface Status { imageUrl: string | null; version: string | null; valid: boolean }
interface Snapshot { key: string; imageUrl: string | null; version: string | null }
export const BACKGROUND_DEFAULT_VEIL = PHOTO_WALL_DEFAULTS.veil;
export const BACKGROUND_DEFAULT_BLUR = 0;

/** A mounted month owns its background snapshot. Revalidation stages changes for the next entry. */
interface CalendarBackgroundProps {
  scope: string; month: string; hideDemo: boolean; generation: number; enabled: boolean; viewing?: boolean;
}
export function CalendarBackground(props: CalendarBackgroundProps) {
  return PHOTO_WALL_ENABLED ? <ActiveCalendarBackground {...props} /> : null;
}
function ActiveCalendarBackground({ scope, month, hideDemo, generation, enabled, viewing = enabled }: CalendarBackgroundProps) {
  const key = `${scope}:${hideDemo}:${month}`;
  const entry = useRef<{ key: string; snapshot: Snapshot | null }>({ key: "", snapshot: null });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [appearance, setAppearance] = useState<{ scope: string; value: PhotoWallPreferences } | null>(null);
  const [preview, setPreview] = useState<{ veil: number; blur: number; imageUrl?: string | null }>({ veil: BACKGROUND_DEFAULT_VEIL, blur: BACKGROUND_DEFAULT_BLUR });
  const testing = new URLSearchParams(window.location.search).get("calendarBackgroundPreview") === "1";
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let revision = 0;
    const load = async () => {
      const requested = ++revision;
      try {
        const value = photoWallPreferences(await apiRequest("/api/calendar/background/settings", { signal: controller.signal }));
        if (!controller.signal.aborted && requested === revision) setAppearance({ scope, value });
      } catch { /* Saved appearance is optional; the chosen defaults remain usable. */ }
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.scope !== scope) return;
      try { const value = photoWallPreferences(detail.preferences); revision++; setAppearance({ scope, value }); } catch { /* Ignore unrelated/malformed events. */ }
    };
    void load();
    window.addEventListener("lifeos:background-settings", changed);
    window.addEventListener("focus", load);
    return () => { controller.abort(); window.removeEventListener("lifeos:background-settings", changed); window.removeEventListener("focus", load); };
  }, [scope, enabled]);

  useEffect(() => {
    if (!enabled) { entry.current = { key: "", snapshot: null }; setSnapshot(null); return; }
    // Choose once at entry; HTTP caching reuses bytes without swapping an old memory snapshot later.
    const visit: { key: string; snapshot: Snapshot | null } = { key, snapshot: null };
    entry.current = visit;
    setSnapshot(null);
    const controller = new AbortController();
    const check = async () => {
      try {
        const params = new URLSearchParams({ month, hideDemo: hideDemo ? "1" : "0" });
        const sample = testing && previewRef.current.imageUrl ? new URL(previewRef.current.imageUrl, window.location.origin) : null;
        const viewedVersion = sample?.searchParams.get("month") === month ? sample.searchParams.get("v") : visit.snapshot?.version;
        if (viewedVersion) params.set("v", viewedVersion);
        const status = await apiRequest<Status>(`/api/calendar/background?${params}`, { signal: controller.signal });
        if (controller.signal.aborted || entry.current !== visit) return;
        const next = { key, imageUrl: status.imageUrl, version: status.version };
        if (!status.valid) {
          visit.snapshot = { key, imageUrl: null, version: null }; setSnapshot(visit.snapshot);
          setPreview(current => ({ ...current, imageUrl: undefined }));
        }
        else if (visit.snapshot === null) { visit.snapshot = next; setSnapshot(next); }
      } catch { /* Optional artwork never interrupts a calendar or displays a spinner/toast. */ }
    };
    void check();
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    const refresh = () => void check();
    const generated = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.scope !== scope || data.month !== month || data.hideDemo !== hideDemo || entry.current !== visit) return;
      // Only an explicit manual action can replace this entry's snapshot.
      visit.snapshot = { key, imageUrl: data.imageUrl, version: data.version };
      setPreview(current => ({ ...current, imageUrl: undefined }));
      setSnapshot(visit.snapshot);
    };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    window.addEventListener("lifeos:background-revalidate", refresh);
    window.addEventListener("lifeos:background-generated", generated);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); window.removeEventListener("lifeos:background-revalidate", refresh); window.removeEventListener("lifeos:background-generated", generated); };
  }, [enabled, key, month, hideDemo]);
  useEffect(() => { if (enabled && preview.imageUrl) window.dispatchEvent(new Event("lifeos:background-revalidate")); }, [enabled, preview.imageUrl]);

  const checkedGeneration = useRef(generation);
  useEffect(() => {
    if (enabled && checkedGeneration.current !== generation) window.dispatchEvent(new Event("lifeos:background-revalidate"));
    checkedGeneration.current = generation;
  }, [generation, enabled]);
  useEffect(() => {
    if (!viewing) return;
    const token = crypto.randomUUID();
    const send = (active: boolean) => {
      void fetch("/api/calendar/background/viewing", { method: "POST", credentials: "same-origin", keepalive: true,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, active }) }).catch(() => {});
    };
    const visible = () => send(document.visibilityState === "visible");
    const hide = () => send(false);
    visible();
    const timer = window.setInterval(visible, 25_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", hide); send(false); };
  }, [viewing, scope]);

  useEffect(() => {
    if (!testing) return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "lifeos-background-preview") return;
      const data = event.data;
      const image = typeof data.imageUrl === "string" && data.imageUrl.startsWith("/api/calendar/background/image?") ? data.imageUrl : undefined;
      setPreview({ veil: Number.isFinite(data.veil) ? Math.max(0, Math.min(100, data.veil)) : BACKGROUND_DEFAULT_VEIL,
        blur: Number.isFinite(data.blur) ? Math.max(0, Math.min(12, data.blur)) : BACKGROUND_DEFAULT_BLUR,
        ...(image ? { imageUrl: image } : {}) });
    };
    window.addEventListener("message", listener);
    window.parent.postMessage({ type: "lifeos-background-preview-ready" }, window.location.origin);
    return () => window.removeEventListener("message", listener);
  }, [testing]);

  const previewImage = testing && preview.imageUrl && new URL(preview.imageUrl, window.location.origin).searchParams.get("month") === month ? preview.imageUrl : null;
  const imageUrl = enabled ? (previewImage || (snapshot?.key === key ? snapshot.imageUrl : null)) : null;
  if (!imageUrl) return null;
  const preferences = appearance?.scope === scope ? appearance.value : PHOTO_WALL_DEFAULTS;
  const style = { "--calendar-background-veil": String((testing ? preview.veil : preferences.veil) / 100),
    "--calendar-background-blur": `${testing ? preview.blur : BACKGROUND_DEFAULT_BLUR}px` } as CSSProperties;
  return <div key={imageUrl} className="calendar-month-backdrop" data-month={month} style={style} aria-hidden="true">
    <div className="calendar-month-backdrop-image" data-src={imageUrl} style={{ backgroundImage: `url("${imageUrl}")` }} />
    <div className="calendar-month-backdrop-veil" />
  </div>;
}
