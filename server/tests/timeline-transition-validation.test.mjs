import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, validateTimeline } from "../../src/core/timeline.ts";

function timelineWithTransition(type) {
  const timeline = createTimeline("project", "timeline", "Transition validation", { numerator: 24, denominator: 1 });
  timeline.tracks = [{
    id: "video",
    name: "Video 1",
    kind: "video",
    enabled: true,
    locked: false,
    clips: [
      {
        id: "outgoing", assetId: "asset-a", name: "Outgoing",
        sourceRange: { start: { value: 0, rate: 24 }, duration: { value: 120, rate: 24 } },
        timelineStart: { value: 0, rate: 24 }, duration: { value: 120, rate: 24 },
        enabled: true, transitionToNext: { type, fadeFrames: 24 }
      },
      {
        id: "incoming", assetId: "asset-b", name: "Incoming",
        sourceRange: { start: { value: 0, rate: 24 }, duration: { value: 96, rate: 24 } },
        timelineStart: { value: 96, rate: 24 }, duration: { value: 96, rate: 24 },
        enabled: true
      }
    ]
  }];
  return timeline;
}

test("timeline validation accepts supported wipe and slide transitions with exact frame overlap", () => {
  for (const type of ["wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "slideup", "slidedown"]) {
    const result = validateTimeline(timelineWithTransition(type));
    assert.equal(result.valid, true, type + ": " + result.issues.map(issue => issue.message).join("; "));
  }
});

test("timeline validation rejects unknown transition names and mismatched overlap", () => {
  const unsupported = validateTimeline(timelineWithTransition("shell-command"));
  assert.equal(unsupported.valid, false);
  assert.ok(unsupported.issues.some(issue => issue.code === "invalid_transition"));
  const mismatch = timelineWithTransition("wipeleft");
  mismatch.tracks[0].clips[1].timelineStart.value = 95;
  const result = validateTimeline(mismatch);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.code === "crossfade_overlap_mismatch"));
});
