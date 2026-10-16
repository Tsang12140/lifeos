import { useLayoutEffect, useRef, useState } from "react";

export interface PresentedPhoto {
  readonly request: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** Keep the decoded resource alive through the React commit that displays it. */
  readonly image: HTMLImageElement;
}

/** Prepare only the requested photo; the previous decoded pixels remain visible meanwhile. */
export function usePhotoPresentation(url: string, attempt: number, enabled: boolean, onFailure: () => void) {
  const request = `${attempt}:${url}`;
  const wanted = useRef<string | null>(request);
  wanted.current = enabled ? request : null;
  const failure = useRef(onFailure); failure.current = onFailure;
  const [photo, setPhoto] = useState<PresentedPhoto | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!enabled || photo?.request === request) return;
    let cancelled = false;
    const image = new Image();
    const current = () => !cancelled && wanted.current === request;
    const reject = () => {
      if (!current()) return;
      setFailed(request); failure.current();
    };
    const accept = () => {
      if (!current()) return;
      if (!image.naturalWidth || !image.naturalHeight) { reject(); return; }
      setPhoto({ request, url, width: image.naturalWidth, height: image.naturalHeight, image });
      setFailed(null);
    };
    image.src = url;
    // A load event alone does not guarantee pixels are ready for the next paint.
    if (typeof image.decode === "function") void image.decode().then(accept, reject);
    else {
      image.onload = accept; image.onerror = reject;
      if (image.complete) { if (image.naturalWidth) accept(); else reject(); }
    }
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [request, enabled]);

  const status = photo?.request === request ? "loaded" : failed === request ? "error" : "loading";
  return { photo, status } as const;
}
