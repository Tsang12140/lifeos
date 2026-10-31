import test from "node:test";
import assert from "node:assert/strict";
import type { Asset } from "@lifeos/core";
import { photoCaptures, photoTimeInput, suggestPhotoTime, PHOTO_TIME_MAX_SPAN_MINUTES } from "../src/photo-time.ts";

const asset = (id: string, capturedAt?: string, kind: "photo" | "video" = "photo"): Asset => ({
  id,
  kind,
  ...(capturedAt === undefined ? {} : {
    photoMetadata: { version: 1 as const, width: 100, height: 100, cameraEvidence: "capture" as const, detailsVersion: 1 as const, details: { capturedAt } },
  }),
});

const capture = (assetId: string, capturedAt: string) => ({ assetId, capturedAt });

test("EXIF text becomes an input value, and impossible clocks are rejected", () => {
  assert.equal(photoTimeInput("2026:10:28 19:58:03"), "2026-10-28T19:58");
  assert.equal(photoTimeInput("  2026:10:28 07:01:00  "), "2026-10-28T07:01");
  assert.equal(photoTimeInput("2026-10-28 19:58:03"), undefined);
  assert.equal(photoTimeInput("2026:13:28 19:58:03"), undefined);
  assert.equal(photoTimeInput("2026:10:28 24:58:03"), undefined);
  assert.equal(photoTimeInput(""), undefined);
});

test("three photos shot 07:01-07:20 and posted at 07:22 default to 07:20", () => {
  const suggestion = suggestPhotoTime({
    captures: [capture("a", "2026:10:28 07:01:12"), capture("b", "2026:10:28 07:11:40"), capture("c", "2026:10:28 07:20:05")],
    day: "2026-10-28",
    now: "2026-10-28T07:22",
  });
  assert.deepEqual(suggestion, { value: "2026-10-28T07:20", assetId: "c", count: 3 });
});

test("a photo from another day is not evidence about this day", () => {
  assert.equal(suggestPhotoTime({
    captures: [capture("a", "2026:10:25 19:00:00")],
    day: "2026-10-28",
    now: "2026-10-28T21:00",
  }), undefined);
});

test("backfilling an old day accepts that day's photo — the case a 7-day window would reject", () => {
  const suggestion = suggestPhotoTime({
    captures: [capture("a", "2026:09:28 12:30:00")],
    day: "2026-09-28",
    now: "2026-10-28T21:00",
  });
  assert.deepEqual(suggestion, { value: "2026-09-28T12:30", assetId: "a", count: 1 });
});

test("backfilling an old day ignores a photo taken today", () => {
  assert.equal(suggestPhotoTime({
    captures: [capture("a", "2026:10:28 21:00:00")],
    day: "2026-09-28",
    now: "2026-10-28T21:00",
  }), undefined);
});

test("a day's scattered photos are a collage, not one event", () => {
  assert.equal(suggestPhotoTime({
    captures: [capture("a", "2026:10:28 15:00:00"), capture("b", "2026:10:28 23:00:00")],
    day: "2026-10-28",
    now: "2026-10-28T23:05",
  }), undefined);
});

test("the span limit is inclusive at exactly one hour", () => {
  const at = (now: string, day = "2026-10-28") => suggestPhotoTime({
    captures: [capture("a", "2026:10:28 18:00:00"), capture("b", "2026:10:28 19:00:00")],
    day,
    now,
  });
  assert.equal(PHOTO_TIME_MAX_SPAN_MINUTES, 60);
  assert.equal(at("2026-10-28T19:05")?.value, "2026-10-28T19:00");
  assert.equal(suggestPhotoTime({
    captures: [capture("a", "2026:10:28 18:00:00"), capture("b", "2026:10:28 19:01:00")],
    day: "2026-10-28",
    now: "2026-10-28T19:05",
  }), undefined);
});

test("a stamp later than the clock is dropped instead of moving the entry forward", () => {
  assert.equal(suggestPhotoTime({
    captures: [capture("a", "2026:10:28 23:30:00")],
    day: "2026-10-28",
    now: "2026-10-28T20:00",
  }), undefined);
  assert.deepEqual(suggestPhotoTime({
    captures: [capture("a", "2026:10:28 23:30:00"), capture("b", "2026:10:28 19:40:00")],
    day: "2026-10-28",
    now: "2026-10-28T20:00",
  }), { value: "2026-10-28T19:40", assetId: "b", count: 1 });
});

test("photos without a capture time contribute nothing", () => {
  assert.equal(suggestPhotoTime({
    captures: [capture("a", ""), capture("b", "not a date")],
    day: "2026-10-28",
    now: "2026-10-28T21:00",
  }), undefined);
});

test("only the attached photos that really are photos are read", () => {
  const captures = photoCaptures(
    [asset("p1", "2026:10:28 19:58:03"), asset("p2"), asset("v1", undefined, "video"), asset("p3", "2026:10:28 20:00:00")],
    [{ assetId: "p1", role: "photo" }, { assetId: "p2", role: "photo" }, { assetId: "v1", role: "video" }],
  );
  assert.deepEqual(captures, [{ assetId: "p1", capturedAt: "2026:10:28 19:58:03" }]);
  assert.deepEqual(photoCaptures([asset("p3", "2026:10:28 20:00:00")], []), []);
});
