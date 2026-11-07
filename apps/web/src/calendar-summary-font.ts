import summaryFontUrl from "./assets/calendar-summary-huiwen-e7356421.woff2?url";
import { scopedKey } from "./storage-scope";

/** Huiwen Mincho is loaded as one complete font for the mobile week-summary group. */
export const CALENDAR_SUMMARY_FONT_FAMILY = "LifeOS Calendar Huiwen Summary";

export type CalendarSummaryFontLoadState = "idle" | "loading" | "ready" | "failed";
export type CalendarSummaryFontStateListener = (state: CalendarSummaryFontLoadState) => void;

const FONT_VERSION = "e7356421580e007d116b199d2a52713eba7c4503fe6d0ce3becc691c61b8e168";
const FONT_LIBRARY_DATABASE = scopedKey("lifeos.calendar-summary-font-library.v1");
const FONT_LIBRARY_STORE = "font-assets";

interface StoredFontAsset {
  readonly version: string;
  readonly assetUrl: string;
  readonly bytes: ArrayBuffer;
}

let state: CalendarSummaryFontLoadState = "idle";
let inFlight: Promise<boolean> | null = null;
const listeners = new Set<CalendarSummaryFontStateListener>();

function updateState(next: CalendarSummaryFontLoadState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // A view listener must not interrupt loading or other listeners.
    }
  }
}

/** Subscribe to the one shared load state; a new subscriber receives it immediately. */
export function subscribeCalendarSummaryFontState(
  listener: CalendarSummaryFontStateListener,
): () => void {
  listeners.add(listener);
  try {
    listener(state);
  } catch {
    // A view listener must not interrupt the shared loader.
  }
  return () => listeners.delete(listener);
}

function openFontLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }

    const request = indexedDB.open(FONT_LIBRARY_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FONT_LIBRARY_STORE)) {
        database.createObjectStore(FONT_LIBRARY_STORE);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open font library"));
  });
}

async function readCachedFont(): Promise<ArrayBuffer | null> {
  let database: IDBDatabase;
  try {
    database = await openFontLibrary();
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    let bytes: ArrayBuffer | null = null;
    const finish = (result: ArrayBuffer | null) => {
      if (settled) return;
      settled = true;
      database.close();
      resolve(result);
    };

    try {
      const transaction = database.transaction(FONT_LIBRARY_STORE, "readonly");
      const request = transaction.objectStore(FONT_LIBRARY_STORE).get(FONT_VERSION);
      request.onsuccess = () => {
        const asset = request.result as StoredFontAsset | undefined;
        if (asset?.version === FONT_VERSION && asset.assetUrl === summaryFontUrl && asset.bytes instanceof ArrayBuffer) {
          bytes = asset.bytes;
        }
      };
      request.onerror = () => finish(null);
      transaction.oncomplete = () => finish(bytes);
      transaction.onerror = () => finish(null);
      transaction.onabort = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

async function writeFontToLibrary(bytes: ArrayBuffer): Promise<void> {
  const database = await openFontLibrary();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      database.close();
      if (error) reject(error);
      else resolve();
    };

    try {
      const transaction = database.transaction(FONT_LIBRARY_STORE, "readwrite");
      const asset: StoredFontAsset = { version: FONT_VERSION, assetUrl: summaryFontUrl, bytes };
      transaction.objectStore(FONT_LIBRARY_STORE).put(asset, FONT_VERSION);
      transaction.oncomplete = () => finish();
      transaction.onerror = () => finish(transaction.error ?? new Error("Could not store font"));
      transaction.onabort = () => finish(transaction.error ?? new Error("Font storage was aborted"));
    } catch (error) {
      finish(error);
    }
  });
}

async function removeBrokenFontFromLibrary(): Promise<void> {
  let database: IDBDatabase;
  try {
    database = await openFontLibrary();
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      database.close();
      resolve();
    };

    try {
      const transaction = database.transaction(FONT_LIBRARY_STORE, "readwrite");
      transaction.objectStore(FONT_LIBRARY_STORE).delete(FONT_VERSION);
      transaction.oncomplete = finish;
      transaction.onerror = finish;
      transaction.onabort = finish;
    } catch {
      finish();
    }
  });
}

async function installFont(bytes: ArrayBuffer): Promise<FontFace | null> {
  if (typeof document === "undefined" || typeof FontFace === "undefined" || !document.fonts) return null;
  const face = new FontFace(CALENDAR_SUMMARY_FONT_FAMILY, bytes, { style: "normal", weight: "400" });
  await face.load();
  document.fonts.add(face);
  return face;
}

async function loadCompleteFont(): Promise<boolean> {
  const cached = await readCachedFont();
  if (cached) {
    try {
      if (await installFont(cached)) return true;
    } catch {
      await removeBrokenFontFromLibrary();
    }
  }

  try {
    const response = await fetch(summaryFontUrl, { credentials: "same-origin" });
    if (!response.ok) return false;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) return false;
    const face = await installFont(bytes);
    if (!face) return false;
    try {
      await writeFontToLibrary(bytes);
    } catch {
      // Without the offline copy, keep the UI on its uniform system-font fallback.
      document.fonts.delete(face);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Load and register the entire immutable font once. Rejected or unavailable storage
 * leaves the page usable with its uniform system-font fallback; a later call retries.
 */
export function ensureCalendarSummaryFont(): Promise<boolean> {
  if (state === "ready") return Promise.resolve(true);
  if (inFlight) return inFlight;

  const attempt = loadCompleteFont()
    .then((ready) => {
      updateState(ready ? "ready" : "failed");
      return ready;
    })
    .catch(() => {
      updateState("failed");
      return false;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = attempt;
  updateState("loading");
  return inFlight;
}
