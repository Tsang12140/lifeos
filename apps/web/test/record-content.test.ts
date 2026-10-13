import test from "node:test";
import assert from "node:assert/strict";
import type { Asset, AssetLink } from "@lifeos/core";
import { hasSavableRecordContent } from "../src/record-content.ts";

test("journal content allows completed photos but not blank, missing, remote or non-photo uploads", () => {
  const photo = { id: "photo", kind: "photo", storageRefs: [{ sourceId: "local", path: "photo.png" }] } as unknown as Asset;
  const refs: AssetLink[] = [{ assetId: photo.id, role: "photo" }];
  assert.equal(hasSavableRecordContent("journal", "", refs, [photo]), true);
  assert.equal(hasSavableRecordContent("journal", " \n", refs, [photo]), true);
  assert.equal(hasSavableRecordContent("journal", "", [], [photo]), false);
  assert.equal(hasSavableRecordContent("journal", "", refs, []), false);
  assert.equal(hasSavableRecordContent("journal", "", refs, [{ ...photo, storageRefs: [] }]), false);
  assert.equal(hasSavableRecordContent("journal", "", refs, [{ ...photo, kind: "video" }]), false);
  for (const kind of ["task", "note", "event"] as const) assert.equal(hasSavableRecordContent(kind, "", refs, [photo]), false);
  assert.equal(hasSavableRecordContent("task", "需要办理的事", [], []), true);
});
