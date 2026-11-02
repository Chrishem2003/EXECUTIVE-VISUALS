import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, rational } from "../../src/core/timeline.ts";
import { assessSourceMediaEvidence } from "../../src/core/source-media-evidence.ts";

function fixture(kind = "video") {
  let timeline = createTimeline("project", "timeline", "Test");
  timeline = addTrack(timeline, { id: "track", name: "Track", kind, enabled: true, locked: false, clips: [] });
  timeline = addClip(timeline, "track", {
    id: "clip", assetId: "asset", name: "Source", sourceRange: { start: rational(0, 24), duration: rational(48, 24) },
    timelineStart: rational(0, 24), duration: rational(48, 24), enabled: true,
  });
  return timeline;
}
const videoAsset = (probe = { format: { duration: "10" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] }) => ({ id: "asset", size: 1000, metadata: { probe } });

test("does not pass an empty timeline or missing source evidence", () => {
  const empty = assessSourceMediaEvidence(createTimeline("project", "empty"), []);
  assert.equal(empty.status, "not_run");
  const missing = assessSourceMediaEvidence(fixture(), []);
  assert.equal(missing.status, "blocked");
  assert.equal(missing.counts.missing, 1);
  assert.equal(missing.findings[0].code, "SOURCE_ASSET_MISSING");
});

test("unprobed assets remain not-run rather than being treated as clean", () => {
  const report = assessSourceMediaEvidence(fixture(), [{ id: "asset", size: 1000, metadata: {} }]);
  assert.equal(report.status, "not_run");
  assert.equal(report.counts.probed, 0);
  assert.equal(report.findings[0].code, "SOURCE_PROBE_NOT_RUN");
});

test("valid probe, expected stream and in-bounds trim pass", () => {
  const report = assessSourceMediaEvidence(fixture(), [videoAsset()]);
  assert.equal(report.status, "passed");
  assert.equal(report.counts.probed, 1);
  assert.match(report.summary, /valid probe/);
});

test("invalid or empty probe evidence blocks source readiness", () => {
  const report = assessSourceMediaEvidence(fixture(), [videoAsset({ format: { duration: "0" }, streams: [] })]);
  assert.equal(report.status, "blocked");
  assert.ok(report.findings.some(item => item.code === "SOURCE_PROBE_INVALID"));
});

test("source ranges beyond the probed duration are blocked", () => {
  const timeline = fixture();
  timeline.tracks[0].clips[0].sourceRange = { start: rational(9, 1), duration: rational(2, 1) };
  timeline.tracks[0].clips[0].duration = rational(2, 1);
  const report = assessSourceMediaEvidence(timeline, [videoAsset()]);
  assert.equal(report.status, "blocked");
  assert.ok(report.findings.some(item => item.code === "SOURCE_RANGE_OUT_OF_BOUNDS"));
});

test("audio tracks require an audio stream", () => {
  const report = assessSourceMediaEvidence(fixture("audio"), [videoAsset()]);
  assert.equal(report.status, "blocked");
  assert.ok(report.findings.some(item => item.code === "SOURCE_STREAM_MISMATCH"));
});

test("multiple clips sharing one source are all checked against the same probe", () => {
  const timeline = fixture();
  const second = { ...timeline.tracks[0].clips[0], id: "clip-2", timelineStart: rational(48, 24), sourceRange: { start: rational(9, 1), duration: rational(2, 1) }, duration: rational(2, 1) };
  timeline.tracks[0].clips.push(second);
  const report = assessSourceMediaEvidence(timeline, [videoAsset()]);
  assert.equal(report.counts.referenced, 1);
  assert.equal(report.counts.probed, 1);
  assert.ok(report.findings.some(item => item.clipId === "clip-2" && item.code === "SOURCE_RANGE_OUT_OF_BOUNDS"));
});
