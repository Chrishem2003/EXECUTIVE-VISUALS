import test from "node:test";
import assert from "node:assert/strict";
import { createDeliveryManifest, verifyDeliveryManifest } from "../delivery-manifest.mjs";
import { createRenderManifest } from "../render-manifest.mjs";

const renderManifest = createRenderManifest({
  timeline: { tracks: [] }, assets: new Map(), timelineRevision: 4,
  output: { width: 1920, height: 1080, codec: "h264" }
});
const input = {
  timelineId: "timeline-1", timelineRevision: 4, outputAsset: "published-asset-9",
  sha256: "a".repeat(64), byteSize: 1024, mediaType: "video/mp4",
  profileId: "youtube-1080p", deliveryReport: { status: "passed", findings: [] },
  renderManifest, createdAt: "2026-11-02T09:00:00.000Z"
};

test("creates deterministic, verifiable delivery evidence", () => {
  const first = createDeliveryManifest(input);
  const second = createDeliveryManifest(input);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.outputAsset, "published-asset-9");
  assert.equal(verifyDeliveryManifest(first), true);
});

test("detects changes to published asset evidence and report", () => {
  const manifest = createDeliveryManifest(input);
  assert.equal(verifyDeliveryManifest({ ...manifest, outputAsset: "other-asset" }), false);
  assert.equal(verifyDeliveryManifest({ ...manifest, deliveryReport: { status: "needs-attention" } }), false);
  assert.equal(verifyDeliveryManifest({ ...manifest, sha256: "b".repeat(64) }), false);
});

test("rejects incomplete or unsafe output evidence", () => {
  for (const patch of [
    { timelineId: "" }, { timelineRevision: 0 }, { outputAsset: "" },
    { sha256: "not-a-checksum" }, { byteSize: 0 }, { mediaType: "video" },
    { profileId: "" }, { renderManifest: { schemaVersion: 1 } },
    { createdAt: "not-a-date" }, { deliveryReport: [] }
  ]) assert.throws(() => createDeliveryManifest({ ...input, ...patch }));
});

test("rejects a modified fingerprint", () => {
  const manifest = createDeliveryManifest(input);
  assert.equal(verifyDeliveryManifest({ ...manifest, fingerprint: "0".repeat(64) }), false);
});
