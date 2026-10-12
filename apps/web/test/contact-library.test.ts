import test from "node:test";
import assert from "node:assert/strict";
import { contactThreshold, selectContacts } from "../src/contact-library.ts";
import type { Entity, ContactActivity } from "@lifeos/core";

const entities: readonly Entity[] = [
  { type: "person", id: "rare", name: "张同学", aliases: ["老张"] },
  { type: "person", id: "important", name: "王朋友", isImportant: true },
  { type: "person", id: "warm", name: "李朋友" },
  { type: "person", id: "hot", name: "陈家人" },
  { type: "person", id: "unused", name: "赵旧识" },
  { type: "place", id: "place", name: "地点" },
];
const activity: readonly ContactActivity[] = [
  { entityId: "rare", score: 0.1, recordCount: 1, lastMentionDate: "2026-01-01" },
  { entityId: "warm", score: 2, recordCount: 3, lastMentionDate: "2026-10-12" },
  { entityId: "hot", score: 8, recordCount: 12, lastMentionDate: "2026-10-12" },
];
const ids = (mode: "common" | "all", query = "", threshold = 2) => selectContacts(entities, activity, mode, query, threshold).map(e => e.id);
test("default gate retains manually important friends and orders everyone by heat", () => {
  assert.deepEqual(ids("common"), ["hot", "warm", "important"]);
  assert.deepEqual(ids("common", "", 3), ["hot", "important"]);
  assert.deepEqual(selectContacts(entities, [], "common", "", 2).map(e => e.id), ["important"]);
  assert.equal(selectContacts(entities.map(e => e.id === "important" ? { ...e, isImportant: false } : e), [], "common", "", 2).length, 0);
});
test("all and search find sunken contacts alphabetically by Chinese pinyin and alias", () => {
  assert.deepEqual(ids("all"), ["hot", "warm", "important", "rare", "unused"]);
  assert.deepEqual(ids("common", "老张"), ["rare"]);
  assert.deepEqual(ids("common", "朋友"), ["warm", "important"]);
  assert.deepEqual(ids("common", "不存在"), []);
  assert.deepEqual(ids("common", "  "), ids("common"));
});
test("invalid or unavailable threshold settings fall back without silently showing everyone", () => {
  for (const value of [null, "", "oops", 0, -1, Infinity, 21]) assert.equal(contactThreshold(value), 2);
  for (const value of ["0.5", 2, "4.5", 20]) assert.equal(contactThreshold(value), Number(value));
});
