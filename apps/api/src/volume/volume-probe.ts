import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { driveRootOf } from "./volume-config.js";

/**
 * Probing an external volume is not the same problem as reading a local disk.
 *
 * A stale SMB mount blocks inside the kernel for tens of seconds, and Node
 * cannot cancel `fs.promises.stat` — the promise rejects but the libuv thread
 * stays busy. The default pool has four threads, so a handful of concurrent
 * probes would stall every other file operation in the API. Hence:
 *
 *   - one probe in flight per root (single-flight), never per request;
 *   - a hard 1.5s deadline so a hang degrades into "offline" instead of a wait;
 *   - a short cache when online, an exponentially growing one when offline,
 *     so a dead mount cannot leak one thread every few seconds.
 */
export type VolumeState = "online" | "offline";

export interface VolumeProbe {
  readonly state: VolumeState;
  readonly root: string;
  readonly checkedAt: number;
  /** Round trip of the root `stat`; `null` when the probe never completed. */
  readonly latencyMs: number | null;
  /** Plain-language reason, shown as-is in the UI. */
  readonly reason?: string;
}

const PROBE_TIMEOUT_MS = 1_500;
const ONLINE_TTL_MS = 5_000;
const OFFLINE_TTL_MS = 15_000;
const OFFLINE_TTL_MAX_MS = 120_000;

interface Slot {
  result: VolumeProbe | null;
  pending: Promise<VolumeProbe> | null;
  failures: number;
}

const slots = new Map<string, Slot>();

function slotFor(root: string): Slot {
  const existing = slots.get(root);
  if (existing !== undefined) return existing;
  const created: Slot = { result: null, pending: null, failures: 0 };
  slots.set(root, created);
  return created;
}

function cacheTtl(slot: Slot): number {
  if (slot.result === null) return 0;
  if (slot.result.state === "online") return ONLINE_TTL_MS;
  return Math.min(OFFLINE_TTL_MS * 2 ** Math.max(0, slot.failures - 1), OFFLINE_TTL_MAX_MS);
}

function messageOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  switch (code) {
    case "ENOENT":
      return "找不到这个路径：共享没连上，或者文件夹被改名了";
    case "EACCES":
    case "EPERM":
      return "没有访问权限，可能需要重新登录这个共享";
    case "EBUSY":
      return "设备忙";
    case "ETIMEDOUT":
    case "ENETUNREACH":
    case "EHOSTDOWN":
      return "网络不通，硬盘可能已断开";
    default:
      break;
  }
  if (error instanceof Error && error.message === "volume_probe_timeout") {
    return "超过 1.5 秒没有响应，硬盘可能在休眠或已经断开";
  }
  return code === "" ? "无法访问" : code;
}

/** The promise is not cancellable; we only stop *waiting* for it. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error("volume_probe_timeout")), ms);
    work.then(
      (value) => { clearTimeout(timer); settle(value); },
      (error) => { clearTimeout(timer); fail(error); },
    );
  });
}

/**
 * Explains an `ENOENT` on the root.
 *
 * Both "the drive letter is not mapped" and "the folder was renamed" produce
 * `ENOENT`, and they need opposite fixes, so the drive root gets its own probe.
 * It only ever runs on the failure path (cached for 15s+ after), and it is
 * bounded by the same deadline as the main probe.
 */
async function describeMissingRoot(root: string): Promise<string> {
  const drive = driveRootOf(root);
  if (drive === null) return "找不到这个路径：共享没连上，或者文件夹被改名了";
  try {
    await withDeadline(stat(drive), PROBE_TIMEOUT_MS);
  } catch {
    return `盘符 ${drive} 没有挂上（共享断开了，或者这个盘符还没映射）`;
  }
  const folder = basename(root);
  if (folder === "") return `盘符 ${drive} 在，但这个文件夹不存在`;
  return `盘符 ${drive} 在，但里面的“${folder}”文件夹找不到（可能被改名或删了）`;
}

async function runProbe(root: string, slot: Slot): Promise<VolumeProbe> {
  const started = performance.now();
  try {
    await withDeadline(stat(root), PROBE_TIMEOUT_MS);
    slot.failures = 0;
    slot.result = { state: "online", root, checkedAt: Date.now(), latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    slot.failures += 1;
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    const reason = code === "ENOENT" ? await describeMissingRoot(root) : messageOf(error);
    slot.result = { state: "offline", root, checkedAt: Date.now(), latencyMs: null, reason };
  }
  return slot.result;
}

export function probeVolume(root: string): Promise<VolumeProbe> {
  const slot = slotFor(root);
  const cached = slot.result;
  if (cached !== null && Date.now() - cached.checkedAt < cacheTtl(slot)) return Promise.resolve(cached);
  if (slot.pending !== null) return slot.pending;
  const pending = runProbe(root, slot).finally(() => { slot.pending = null; });
  slot.pending = pending;
  return pending;
}

/** Drops the cached answer so the next call probes again (used by an explicit refresh). */
export function forgetVolume(root: string): void {
  slots.delete(root);
}
