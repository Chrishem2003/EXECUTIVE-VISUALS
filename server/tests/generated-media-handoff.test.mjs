import test from "node:test";
import assert from "node:assert/strict";
import { addClip, addTrack, createTimeline, seconds } from "../../src/core/timeline.ts";
import { GeneratedMediaHandoffError, prepareGeneratedMediaHandoff } from "../../src/core/generated-media-handoff.ts";

function fixture(kind = "video", locked = false) {
  const timeline = addTrack(
    createTimeline("project-1", "sequence-1", "Handoff test", { numerator: 24, denominator: 1 }),
    { id: "track-1", name: "Track 1", kind, enabled: true, locked, clips: [] },
  );
  return timeline;
}
const receipt = {
  projectId: "project-1", jobId: "job-1", assetId: "asset-1",
  mediaType: "video/mp4", kind: "video", durationSeconds: 2.5,
  verified: true, readable: true, sha256: "a".repeat(64),
};
const input = (timeline, overrides = {}) => ({
  timeline, receipt: { ...receipt }, targetTrackId: "track-1",
  playheadSeconds: 4, expectedRevision: timeline.revision,
  clipId: "clip-generated-1", ...overrides,
});
const code = (expected) => (error) => error instanceof GeneratedMediaHandoffError && error.code === expected;

test("prepares a verified project-owned generated clip without mutating the timeline", () => {
  const timeline = fixture();
  const result = prepareGeneratedMediaHandoff(input(timeline));
  assert.equal(result.trackId, "track-1");
  assert.equal(result.expectedRevision, timeline.revision);
  assert.equal(result.clip.assetId, "asset-1");
  assert.equal(result.clip.timelineStart.value / result.clip.timelineStart.rate, 4);
  assert.equal(result.clip.metadata.generationJobId, "job-1");
  assert.equal(timeline.tracks[0].clips.length, 0);
});

test("rejects cross-project, unverified and unreadable assets", () => {
  const timeline = fixture();
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline, { receipt: { ...receipt, projectId: "other" } })), code("HANDOFF_PROJECT_MISMATCH"));
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline, { receipt: { ...receipt, verified: false } })), code("HANDOFF_ASSET_NOT_READY"));
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline, { receipt: { ...receipt, readable: false } })), code("HANDOFF_ASSET_NOT_READY"));
});

test("rejects stale revisions, invalid durations, media mismatch and invalid checksums", () => {
  const timeline = fixture();
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline, { expectedRevision: timeline.revision - 1 })), code("HANDOFF_STALE_REVISION"));
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline, { receipt: { ...receipt, durationSeconds: 0 } })), code("HANDOFF_INVALID_DURATION"));
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline, { receipt: { ...receipt, mediaType: "audio/wav" } })), code("HANDOFF_MEDIA_TYPE_MISMATCH"));
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline, { receipt: { ...receipt, sha256: "bad" } })), code("HANDOFF_INVALID_CHECKSUM"));
});

test("rejects locked, incompatible, duplicate and overlapping insertions", () => {
  const locked = fixture("video", true);
  assert.throws(() => prepareGeneratedMediaHandoff(input(locked)), code("HANDOFF_TRACK_LOCKED"));
  const audio = fixture("audio");
  assert.throws(() => prepareGeneratedMediaHandoff(input(audio)), code("HANDOFF_TRACK_INCOMPATIBLE"));
  const timeline = fixture();
  timeline.tracks[0].clips.push({ ...prepareGeneratedMediaHandoff(input(timeline)).clip, id: "clip-generated-1" });
  assert.throws(() => prepareGeneratedMediaHandoff(input(timeline)), code("HANDOFF_DUPLICATE_CLIP"));
  const overlap = fixture();
  overlap.tracks[0].clips.push({ ...prepareGeneratedMediaHandoff(input(overlap)).clip, id: "existing" });
  assert.throws(() => prepareGeneratedMediaHandoff(input(overlap, { playheadSeconds: 4.5 })), code("HANDOFF_OVERLAP"));
});

test("allows image and audio receipts only on compatible tracks", () => {
  const audioTimeline = fixture("audio");
  const audioReceipt = { ...receipt, kind: "audio", mediaType: "audio/wav" };
  assert.equal(prepareGeneratedMediaHandoff(input(audioTimeline, { receipt: audioReceipt })).clip.assetId, "asset-1");
  const imageTimeline = fixture("overlay");
  const imageReceipt = { ...receipt, kind: "image", mediaType: "image/png" };
  assert.equal(prepareGeneratedMediaHandoff(input(imageTimeline, { receipt: imageReceipt })).clip.assetId, "asset-1");
});

test("keeps non-frame-aligned source duration compatible with the core timeline validator", () => {
  const timeline = fixture();
  const prepared = prepareGeneratedMediaHandoff(input(timeline, {
    receipt: { ...receipt, durationSeconds: 2.51 },
  }));
  const inserted = addClip(timeline, prepared.trackId, prepared.clip);
  assert.equal(seconds(inserted.tracks[0].clips[0].duration), 2.51);
});
