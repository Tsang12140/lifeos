import test from "node:test";
import assert from "node:assert/strict";
import type { Asset } from "@lifeos/core";
import type { RecordView } from "../src/api.ts";
import { diaryPhotoOccurrences } from "../src/photo-gallery-model.ts";

const photo = (id: string, purpose?: "avatar"): Asset => ({
  id,
  kind: "photo",
  ...(purpose ? { purpose } : {}),
  storageRefs: [{ sourceId: "local", sourceRef: `${id}.jpg` }],
} as Asset);

const journal = (id: string, day: string, assetRefs: RecordView["assetRefs"], nature?: "dream"): RecordView => ({
  id,
  kind: "journal",
  body: { text: id, ...(nature ? { nature } : {}) },
  createdAt: { kind: "instant", value: `${day}T12:00:00Z` },
  entityRefs: [],
  relatedRecordIds: [],
  assetRefs,
  aiDerived: [],
  revision: 1,
} as RecordView);

test("diary photo occurrences are scoped, date-ordered and preserve each record owner", () => {
  const records = [
    journal("new", "2026-10-21", [{ assetId: "shared", role: "photo" }, { assetId: "video", role: "video" }]),
    journal("dream", "2026-10-22", [{ assetId: "shared", role: "photo" }], "dream"),
    { ...journal("task", "2026-10-22", [{ assetId: "shared", role: "photo" }]), kind: "task" } as RecordView,
    journal("old", "2026-09-30", [{ assetId: "shared", role: "photo" }, { assetId: "avatar", role: "photo" }, { assetId: "remote", role: "photo" }, { assetId: "missing", role: "photo" }]),
  ];
  const assets = [photo("shared"), { ...photo("video"), kind: "video" }, photo("avatar", "avatar"), { ...photo("remote"), storageRefs: [{ sourceId: "remote", sourceRef: "https://example.test/photo.jpg" }] } as Asset];
  const occurrences = diaryPhotoOccurrences(records, assets, new Set(["old"]));
  // A clip filed in a diary is gallery material too, so the record that carries one
  // contributes two items — and the deleted record still contributes none.
  assert.deepEqual(occurrences.map((item) => [item.record.id, item.assetId, item.kind]), [
    ["new", "shared", "photo"],
    ["new", "video", "video"],
  ]);

  const sharedTwice = diaryPhotoOccurrences([records[0], records[3]], assets);
  assert.deepEqual(sharedTwice.map((item) => [item.assetId, item.record.id, item.monthKey]), [
    ["shared", "new", "2026-10"],
    ["video", "new", "2026-10"],
    ["shared", "old", "2026-09"],
  ]);
});

test("a clip is kept only when the app owns the file, and only in a real diary", () => {
  const records = [
    journal("kept", "2026-10-20", [{ assetId: "local-clip", role: "video" }]),
    journal("remote-clip", "2026-10-20", [{ assetId: "remote-clip", role: "video" }]),
    journal("dream-clip", "2026-10-20", [{ assetId: "local-clip", role: "video" }], "dream"),
  ];
  const assets = [
    { ...photo("local-clip"), kind: "video" } as Asset,
    { ...photo("remote-clip"), kind: "video", storageRefs: [{ sourceId: "remote", sourceRef: "https://example.test/clip.mp4" }] } as Asset,
  ];
  assert.deepEqual(diaryPhotoOccurrences(records, assets).map((item) => [item.record.id, item.kind]), [["kept", "video"]]);
});

test("date order wins over input order and same-day attachment order stays stable", () => {
  const records = [
    journal("older", "2026-10-01", [{ assetId: "a", role: "photo" }]),
    journal("newer", "2026-10-03", [{ assetId: "b", role: "photo" }, { assetId: "c", role: "photo" }]),
  ];
  const items = diaryPhotoOccurrences(records, [photo("a"), photo("b"), photo("c")]);
  assert.deepEqual(items.map((item) => item.assetId), ["b", "c", "a"]);
});
