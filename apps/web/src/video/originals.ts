import { VIDEO_LIMITS } from "@lifeos/core";
import { scopedKey } from "../storage-scope";

type Original = { key: string; scope: string; assetId: string; file: File; savedAt: number };
const database = scopedKey("lifeos-video-originals-v1");
const keyFor = (scope: string, assetId: string) => JSON.stringify([scope, assetId]);
function connect(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("此浏览器无法保存本机原片，请自行保留源文件")); return; }
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("originals", { keyPath: "key" }).createIndex("scope", "scope");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本机原片存储，请检查浏览器空间或隐私模式"));
    request.onblocked = () => reject(new Error("本机原片存储被其他页面占用，请关闭旧页面后重试"));
  });
}
export async function getOriginal(scope: string, assetId: string): Promise<File | null> {
  if (!scope) return null;
  const db = await connect();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("originals", "readonly");
      const request = transaction.objectStore("originals").get(keyFor(scope, assetId));
      transaction.oncomplete = () => resolve((request.result as Original | undefined)?.file ?? null);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
export async function saveOriginal(scope: string, assetId: string, file: File): Promise<void> {
  if (!scope || !assetId) throw new Error("无法识别当前账号，未保存本机原片");
  if (file.size > VIDEO_LIMITS.maxInputBytes) throw new Error("本机原片最多200 MB");
  const db = await connect();
  try {
    await new Promise<void>((resolve, reject) => {
      // One read/write transaction serializes the size check with other tabs.
      const transaction = db.transaction("originals", "readwrite"), store = transaction.objectStore("originals");
      let failure: Error | null = null;
      let bytes = file.size;
      const cursor = store.index("scope").openCursor(IDBKeyRange.only(scope));
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { const value = item.value as Original; if (value.assetId !== assetId) bytes += value.file.size; item.continue(); return; }
        if (bytes > VIDEO_LIMITS.maxLocalBytes) { failure = new Error("此账号的本机原片已达到1 GB，请先清理本机副本"); transaction.abort(); return; }
        store.put({ key: keyFor(scope, assetId), scope, assetId, file, savedAt: Date.now() } satisfies Original);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => { failure ??= new Error("本机空间不足或浏览器拒绝保存，请自行保留原片"); };
      transaction.onabort = () => reject(failure ?? new Error("本机原片保存失败，请自行保留源文件"));
    });
    // Request persistence as a best effort; refusal never claims the copy is permanent.
    void navigator.storage?.persist?.().catch(() => false);
  } finally { db.close(); }
}
export async function removeOriginals(scope: string, assetId?: string): Promise<void> {
  if (!scope) return;
  const db = await connect();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("originals", "readwrite"), store = transaction.objectStore("originals");
      if (assetId) store.delete(keyFor(scope, assetId));
      else {
        const cursor = store.index("scope").openCursor(IDBKeyRange.only(scope));
        cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("本机副本清理失败，请重试"));
      transaction.onabort = () => reject(new Error("本机副本清理失败，请重试"));
    });
  } finally { db.close(); }
}
