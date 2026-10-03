import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoragePoolStore } from "../src/storage-pool-store.js";
import { PoolConsumerBridge, StoragePoolError } from "../src/storage-pool.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lifeos-storage-pool-test-"));
  const databasePath = join(directory, "lifeos.sqlite");
  const store = new StoragePoolStore(databasePath);
  return {
    directory,
    databasePath,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("storage pool quota reads do not create account rows; saves enforce allocation and can recover after project shrink", () => {
  const state = fixture();
  try {
    assert.deepEqual(state.store.usage("known-account", "2026-10"), {
      storageLimitBytes: 0, trafficLimitBytes: 0, storageUsedBytes: 0, storageReservedBytes: 0,
      trafficUsedBytes: 0, trafficReservedBytes: 0,
    });
    const db = new DatabaseSync(state.databasePath, { readOnly: true });
    try {
      const count = db.prepare("SELECT COUNT(*) AS count FROM storage_pool_user_quotas").get() as { count: number };
      assert.equal(Number(count.count), 0, "a read-only usage lookup must not create a ghost user allocation");
    } finally { db.close(); }

    state.store.saveQuota("a", { storageLimitBytes: 70, trafficLimitBytes: 60 }, 100, 100);
    state.store.saveQuota("b", { storageLimitBytes: 30, trafficLimitBytes: 40 }, 100, 100);
    assert.throws(() => state.store.saveQuota("b", { storageLimitBytes: 31, trafficLimitBytes: 40 }, 100, 100), /超过 LifeOS 当前项目额度/);
    // The upstream project limit can shrink below committed allocations. Each
    // pure reduction remains possible until the total allocation fits again.
    state.store.saveQuota("a", { storageLimitBytes: 50, trafficLimitBytes: 40 }, 60, 50);
    state.store.saveQuota("b", { storageLimitBytes: 10, trafficLimitBytes: 10 }, 60, 50);
    assert.equal(state.store.totals(["a", "b"], "2026-10").storageLimitBytes, 60);
    assert.equal(state.store.totals(["a", "b"], "2026-10").trafficLimitBytes, 50);
  } finally { state.close(); }
});

test("upload reservations serialize project and user capacity and retain pending object keys", async () => {
  const state = fixture();
  try {
    state.store.saveQuota("a", { storageLimitBytes: 200, trafficLimitBytes: 0 }, 200, 100);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => state.store.reserveUpload("a", "asset-a", 120, 120)),
      Promise.resolve().then(() => state.store.reserveUpload("a", "asset-b", 120, 120)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const attemptId = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<string>).value;
    state.store.keepPendingUpload(attemptId, "lifeos/test/object-a");
    state.store.keepPendingUpload(attemptId);
    const object = state.store.poolObject("a", "asset-a", "lifeos/test/object-a");
    assert.equal(object?.state, "pending");
    assert.equal(object?.objectKey, "lifeos/test/object-a");
    assert.equal(state.store.totals(["a"], "2026-10").storageReservedBytes, 120);
    state.store.completeUpload(attemptId, "lifeos/test/object-a");
    assert.equal(state.store.poolObject("a", "asset-a", "lifeos/test/object-a")?.state, "ready");
    assert.equal(state.store.poolObject("b", "asset-a", "lifeos/test/object-a"), null, "another account cannot resolve this key");
    assert.equal(state.store.totals(["a"], "2026-10").storageUsedBytes, 120);
  } finally { state.close(); }
});

test("download reservations cover a UTC month boundary, refund confirmed failures, and charge the month PoolConsumer returned", () => {
  const state = fixture();
  try {
    state.store.saveQuota("a", { storageLimitBytes: 100, trafficLimitBytes: 100 }, 100, 100);
    const upload = state.store.reserveUpload("a", "asset-a", 30, 100);
    state.store.completeUpload(upload, "lifeos/test/object-a");

    const failed = state.store.reserveDownload("a", "asset-a", "lifeos/test/object-a", "2026-10", 100);
    assert.equal(state.store.usage("a", "2026-11").trafficReservedBytes, 30, "an in-flight request is reserved in both possible UTC months");
    state.store.refundDownload(failed.id);
    assert.equal(state.store.usage("a", "2026-10").trafficReservedBytes, 0);
    assert.equal(state.store.usage("a", "2026-11").trafficReservedBytes, 0);

    const chargedAcrossBoundary = state.store.reserveDownload("a", "asset-a", "lifeos/test/object-a", "2026-10", 100);
    state.store.finishDownload(chargedAcrossBoundary.id, "2026-11", chargedAcrossBoundary.bytes);
    assert.equal(state.store.usage("a", "2026-10").trafficUsedBytes, 0);
    assert.equal(state.store.usage("a", "2026-11").trafficUsedBytes, 30);
    assert.equal(state.store.usage("a", "2026-11").trafficReservedBytes, 0);
    assert.equal(state.store.projectAccounted("2026-11").trafficBytes, 30);

    const pending = state.store.reserveDownload("a", "asset-a", "lifeos/test/object-a", "2026-11", 100);
    state.store.markDownloadUncertain(pending.id);
    assert.equal(state.store.downloadIssues().length, 1);
    assert.equal(state.store.projectAccounted("2026-11").trafficBytes, 60);
  } finally { state.close(); }
});

test("delete accounting falls only after PoolConsumer success is recorded", () => {
  const state = fixture();
  try {
    state.store.saveQuota("a", { storageLimitBytes: 100, trafficLimitBytes: 100 }, 100, 100);
    const attemptId = state.store.reserveUpload("a", "asset-a", 45, 100);
    state.store.completeUpload(attemptId, "lifeos/test/object-a");
    const deleting = state.store.beginDelete("a", "asset-a", "lifeos/test/object-a");
    assert.equal(deleting?.state, "deleting");
    assert.equal(state.store.usage("a", "2026-10").storageUsedBytes, 45);
    assert.equal(state.store.objectIssues()[0]?.state, "deleting");
    state.store.finishDelete(attemptId);
    assert.equal(state.store.usage("a", "2026-10").storageUsedBytes, 0);
    assert.equal(state.store.usage("a", "2026-10").trafficUsedBytes, 0);
  } finally { state.close(); }
});

test("disabled bridge is fail-closed without spawning a worker", async () => {
  const bridge = new PoolConsumerBridge({ LIFEOS_STORAGE_POOL_ENABLED: "0" });
  await assert.rejects(bridge.usage(), (error: unknown) => error instanceof StoragePoolError && error.code === "storage_pool_disabled");
});
