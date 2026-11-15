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


import { buildVideoSequenceGraph } from "../timeline-transitions.mjs";

test("builds a frame-accurate video crossfade with cumulative xfade offset", () => {
  const result = buildVideoSequenceGraph([
    { label: "v0", duration: 5, transitionToNext: { type: "crossfade", fadeFrames: 24 } },
    { label: "v1", duration: 4 }
  ], 24);
  assert.equal(result.label, "vseq1");
  assert.equal(result.duration, 8);
  assert.equal(result.filter, "[v0][v1]xfade=transition=fade:duration=1.000000:offset=4.000000[vseq1]");
});

test("chains hard cuts, gaps and crossfades without losing cumulative duration", () => {
  const result = buildVideoSequenceGraph([
    { label: "v0", duration: 5, transitionToNext: { type: "crossfade", fadeFrames: 12 } },
    { label: "gap0", duration: 2 },
    { label: "v1", duration: 4 }
  ], 24);
  assert.equal(result.duration, 10.5);
  assert.match(result.filter, /xfade=transition=fade:duration=0.500000:offset=4.500000/);
  assert.match(result.filter, /concat=n=2:v=1:a=0/);
});

test("rejects invalid crossfade frame lengths and unsafe labels", () => {
  assert.throws(() => buildVideoSequenceGraph([
    { label: "v0", duration: 1, transitionToNext: { type: "crossfade", fadeFrames: 48 } },
    { label: "v1", duration: 1 }
  ], 24), /fit both adjacent clips/);
  assert.throws(() => buildVideoSequenceGraph([{ label: "[bad]", duration: 1 }], 24), /safe labels/);
});
