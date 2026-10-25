import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppView } from "./app-types";

const address = () => `${location.pathname}${location.search}${location.hash}`;
export function assistantSourceView(): AppView | null {
  const source = history.state?.assistantSource;
  return location.hash === "#assistant" && ["today", "dreams", "calendar", "tasks", "notes", "entities", "timemachine", "settings"].includes(source) ? source : null;
}
/** A mobile destination with browser Back support; the underlying editor stays mounted. */
export function useAssistantNavigation() {
  const [open, setOpen] = useState(() => location.hash === "#assistant");
  const wasOpen = useRef(open), position = useRef(0), restore = useRef(true);
  const enter = useCallback((source?: AppView) => {
    if (location.hash !== "#assistant") {
      position.current = window.scrollY;
      history.pushState({ ...history.state, assistantReturn: address(), assistantSource: source }, "", `${location.pathname}${location.search}#assistant`);
    }
    restore.current = true; setOpen(true);
  }, []);
  const leave = useCallback((restorePosition = true) => {
    restore.current = restorePosition;
    if (location.hash === "#assistant") {
      const previous = history.state?.assistantReturn;
      const url = typeof previous === "string" ? new URL(previous, location.href) : null;
      history.replaceState(null, "", url?.origin === location.origin ? url.href : `${location.pathname}${location.search}`);
    }
    setOpen(false);
  }, []);
  useEffect(() => {
    const sync = () => setOpen(location.hash === "#assistant");
    window.addEventListener("popstate", sync); window.addEventListener("hashchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("hashchange", sync); };
  }, []);
  useLayoutEffect(() => {
    let frame = 0;
    if (wasOpen.current && !open && restore.current) frame = requestAnimationFrame(() => window.scrollTo({ top: position.current, behavior: "instant" }));
    wasOpen.current = open;
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return { open, enter, leave };
}
