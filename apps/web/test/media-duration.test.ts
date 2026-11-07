import test from "node:test";
import assert from "node:assert/strict";
import { formatMediaDuration } from "../src/media-duration.ts";

test("a clip's badge is minutes and seconds, both two digits", () => {
  assert.equal(formatMediaDuration(89), "01:29");
  assert.equal(formatMediaDuration(13.87), "00:13");
  assert.equal(formatMediaDuration(1.43), "00:01");
  assert.equal(formatMediaDuration(600), "10:00");
  assert.equal(formatMediaDuration(0), "00:00");
});

test("an hour keeps its own digit instead of running the minutes past 59", () => {
  assert.equal(formatMediaDuration(3600), "1:00:00");
  assert.equal(formatMediaDuration(3725), "1:02:05");
});

test("no duration means no badge — better silent than claiming 00:00", () => {
  assert.equal(formatMediaDuration(undefined), null);
  assert.equal(formatMediaDuration(Number.NaN), null);
  assert.equal(formatMediaDuration(-1), null);
});
