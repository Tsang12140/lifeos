import { useLayoutEffect, useRef, useState } from "react";
import type { Asset } from "@lifeos/core";
import { assetThumbUrl } from "./asset-urls";
import "./contact-avatar.css";

/** Measure the whole inline run, including the photos, before choosing an ellipsis. */
export function TaskSummaryText({ text, photos, disabled, onOpen, onPhoto }: {
  text: string; photos: readonly Asset[]; disabled: boolean;
  onOpen: () => void; onPhoto: (index: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState({ text, value: text });
  const shown = clipped.text !== text ? text : clipped.value;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let lastMetrics = "";
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (!width) return;
      const style = getComputedStyle(element);
      const metrics = `${width}:${style.font}:${style.letterSpacing}:${style.lineHeight}`;
      if (metrics === lastMetrics) return;
      lastMetrics = metrics;
      const probe = element.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, { position: "absolute", visibility: "hidden", width: `${width}px`, pointerEvents: "none", margin: "0" });
      // Images already have fixed geometry; measuring must not initiate image requests.
      probe.querySelectorAll("img").forEach(image => image.removeAttribute("src"));
      element.parentElement!.append(probe);
      let value = text;
      try {
        const copy = probe.querySelector(".task-summary-copy")!;
        const limit = parseFloat(style.lineHeight) * 2 + 0.5;
        const fits = (candidate: string) => { copy.textContent = candidate; return probe.getBoundingClientRect().height <= limit; };
        if (!fits(text)) {
          const characters = Array.from(text);
          let low = 0, high = characters.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(characters.slice(0, middle).join("").trimEnd() + "…")) low = middle;
            else high = middle - 1;
          }
          value = characters.slice(0, low).join("").trimEnd() + "…";
        }
      } finally { probe.remove(); }
      setClipped(current => current.text === text && current.value === value ? current : { text, value });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const fontLoaded = () => { lastMetrics = ""; measure(); };
    document.fonts.addEventListener("loadingdone", fontLoaded);
    return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", fontLoaded); };
  }, [text, photos.length]);

  return <div className="task-summary-content" ref={root}>
    <a className="task-summary-open" role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={`定位任务正文：${text}`} onClick={() => { if (!disabled) onOpen(); }} onKeyDown={event => { if (!disabled && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }}><span className="task-summary-copy">{shown}</span></a>
    {photos.length ? <>{"\u00a0"}<span className="task-summary-photos">{photos.slice(0, 3).map((asset, index) => <button key={asset.id} className="task-summary-photo" type="button" disabled={disabled} aria-label={`查看任务照片 ${index + 1}，共 ${photos.length} 张`} onClick={() => onPhoto(index)}><img src={assetThumbUrl(asset.id, 400)} alt="" loading="lazy" decoding="async" /></button>)}</span></> : null}
  </div>;
}
