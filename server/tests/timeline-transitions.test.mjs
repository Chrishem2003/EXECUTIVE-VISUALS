import test from "node:test";
import assert from "node:assert/strict";
import { buildClipFadeFilters } from "../timeline-transitions.mjs";

test("builds video fade-in and fade-out filters from clip metadata", () => {
  assert.deepEqual(buildClipFadeFilters({ metadata: { fadeInSeconds: 0.5, fadeOutSeconds: 1 } }, 4, "video"), [
    "fade=t=in:st=0:d=0.500000",
    "fade=t=out:st=3.000000:d=1.000000"
  ]);
});

test("builds audio fades from clip metadata", () => {
  assert.deepEqual(buildClipFadeFilters({ metadata: { fadeInSeconds: 0.25, fadeOutSeconds: 0.25 } }, 1, "audio"), [
    "afade=t=in:st=0:d=0.250000",
    "afade=t=out:st=0.750000:d=0.250000"
  ]);
});

test("clips fade-out to the duration remaining after fade-in", () => {
  assert.deepEqual(buildClipFadeFilters({ metadata: { fadeInSeconds: 0.8, fadeOutSeconds: 0.8 } }, 1, "video"), [
    "fade=t=in:st=0:d=0.800000",
    "fade=t=out:st=0.800000:d=0.200000"
  ]);
});

test("ignores invalid or non-positive fade metadata", () => {
  assert.deepEqual(buildClipFadeFilters({ metadata: { fadeInSeconds: -1, fadeOutSeconds: "invalid" } }, 2, "video"), []);
  assert.deepEqual(buildClipFadeFilters({}, 0, "video"), []);
});

test("rejects unsupported media kinds", () => {
  assert.throws(() => buildClipFadeFilters({}, 2, "caption"), /Unsupported clip fade media kind/);
});
