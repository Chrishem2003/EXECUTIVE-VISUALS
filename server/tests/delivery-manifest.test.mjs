import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createDeliveryManifest, verifyDeliveryManifest, createDeliveryPackage, verifyDeliveryPackage } from "../delivery-manifest.mjs";
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


test("creates a verifiable delivery package bound to the master and review history", () => {
  const receipt = createDeliveryManifest(input);
  const master = { assetId: receipt.outputAsset, filename: "master.mp4", mediaType: receipt.mediaType, byteSize: receipt.byteSize, sha256: receipt.sha256, downloadUrl: "https://storage.example.test/master?token=short", downloadUrlExpiresInSeconds: 300 };
  const deliveryPackage = createDeliveryPackage({ jobId: "job-1", projectId: "project-1", timelineId: receipt.timelineId, timelineRevision: receipt.timelineRevision, master, deliveryReceipt: receipt, renderManifest: receipt.renderManifest, deliveryReport: receipt.deliveryReport, qualityReport: { status: "review", counts: { errors: 0, warnings: 1 }, findings: [{ code: "TEMPORAL_LUMA_FLICKER", severity: "warning", message: "Possible luminance flicker", startSeconds: 1, endSeconds: 2 }], limitations: ["Bounded temporal sample"] }, reviewHistory: [{ id: 1, schemaVersion: 1, decision: "approved", fingerprint: receipt.fingerprint, timelineId: receipt.timelineId, timelineRevision: receipt.timelineRevision, outputAsset: receipt.outputAsset, reviewerId: "reviewer-1", note: "Reviewed master output.", reviewedAt: "2026-11-02T08:59:00.000Z", createdAt: "2026-11-02T08:59:01.000Z" }], generatedAt: "2026-11-02T09:00:00.000Z" });
  assert.equal(verifyDeliveryPackage(deliveryPackage), true);
  assert.equal(verifyDeliveryPackage(JSON.parse(JSON.stringify(deliveryPackage))), true);
  assert.equal(deliveryPackage.packageFingerprint.length, 64);
  assert.equal(deliveryPackage.master.assetId, receipt.outputAsset);
  assert.equal(deliveryPackage.qualityReport.findings[0].code, "TEMPORAL_LUMA_FLICKER");
  assert.equal(verifyDeliveryPackage({ ...deliveryPackage, qualityReport: { ...deliveryPackage.qualityReport, findings: [] } }), false);
});
test("rejects tampered package fields and evidence from another receipt", () => {
  const receipt = createDeliveryManifest(input);
  const master = { assetId: receipt.outputAsset, filename: "master.mp4", mediaType: receipt.mediaType, byteSize: receipt.byteSize, sha256: receipt.sha256, downloadUrl: "https://storage.example.test/master?token=short", downloadUrlExpiresInSeconds: 300 };
  const deliveryPackage = createDeliveryPackage({ jobId: "job-1", projectId: "project-1", timelineId: receipt.timelineId, timelineRevision: receipt.timelineRevision, master, deliveryReceipt: receipt, renderManifest: receipt.renderManifest, deliveryReport: receipt.deliveryReport, generatedAt: "2026-11-02T09:00:00.000Z" });
  assert.equal(verifyDeliveryPackage({ ...deliveryPackage, master: { ...master, sha256: "b".repeat(64) } }), false);
  assert.equal(verifyDeliveryPackage({ ...deliveryPackage, packageFingerprint: "0".repeat(64) }), false);
  assert.equal(verifyDeliveryPackage({ ...deliveryPackage, qualityReport: { ...deliveryPackage.qualityReport, findings: [] } }), false);
  assert.throws(() => createDeliveryPackage({ jobId: "job-1", projectId: "project-1", timelineId: receipt.timelineId, timelineRevision: receipt.timelineRevision, master: { ...master, downloadUrl: "http://insecure.example/master" }, deliveryReceipt: receipt, renderManifest: receipt.renderManifest, deliveryReport: receipt.deliveryReport }));
});

test("rejects a modified fingerprint", () => {
  const manifest = createDeliveryManifest(input);
  assert.equal(verifyDeliveryManifest({ ...manifest, fingerprint: "0".repeat(64) }), false);
});


test("rejects malformed or oversized media quality evidence in delivery packages", () => {
  const receipt = createDeliveryManifest(input);
  const master = { assetId: receipt.outputAsset, filename: "master.mp4", mediaType: receipt.mediaType, byteSize: receipt.byteSize, sha256: receipt.sha256, downloadUrl: "https://storage.example.test/master?token=short", downloadUrlExpiresInSeconds: 300 };
  assert.throws(() => createDeliveryPackage({ jobId: "job-1", projectId: "project-1", timelineId: receipt.timelineId, timelineRevision: receipt.timelineRevision, master, deliveryReceipt: receipt, renderManifest: receipt.renderManifest, deliveryReport: receipt.deliveryReport, qualityReport: { status: "clean", counts: { errors: 0, warnings: 0 }, findings: [], limitations: [] }, generatedAt: "2026-11-02T09:00:00.000Z" }));
});


test("quality report status and counts must match the exact findings", () => {
  const receipt = createDeliveryManifest(input);
  const master = { assetId: receipt.outputAsset, filename: "master.mp4", mediaType: receipt.mediaType, byteSize: receipt.byteSize, sha256: receipt.sha256, downloadUrl: "https://storage.example.test/master?token=short", downloadUrlExpiresInSeconds: 300 };
  const build = qualityReport => createDeliveryPackage({
    jobId: "job-1", projectId: "project-1", timelineId: receipt.timelineId,
    timelineRevision: receipt.timelineRevision, master, deliveryReceipt: receipt,
    renderManifest: receipt.renderManifest, deliveryReport: receipt.deliveryReport,
    qualityReport, generatedAt: "2026-11-02T09:00:00.000Z"
  });
  const warning = { code: "BELOW_HD", severity: "warning", message: "Output is below HD." };
  const error = { code: "INVALID_DURATION", severity: "error", message: "Duration is invalid." };
  assert.throws(() => build({ status: "passed", counts: { errors: 0, warnings: 1 }, findings: [warning], limitations: [] }), /status and counts must agree/);
  assert.throws(() => build({ status: "passed", counts: { errors: 1, warnings: 0 }, findings: [error], limitations: [] }), /status and counts must agree/);
  assert.throws(() => build({ status: "review", counts: { errors: 0, warnings: 0 }, findings: [warning], limitations: [] }), /status and counts must agree/);
  assert.throws(() => build({ status: "needs-attention", counts: { errors: 0, warnings: 1 }, findings: [warning], limitations: [] }), /status and counts must agree/);
  assert.equal(verifyDeliveryPackage(build({ status: "review", counts: { errors: 0, warnings: 1 }, findings: [warning], limitations: [] })), true);
  assert.equal(verifyDeliveryPackage(build({ status: "needs-attention", counts: { errors: 1, warnings: 0 }, findings: [error], limitations: [] })), true);
});
test("rejects a re-fingerprinted receipt with an invalid render manifest", () => {
  const receipt = createDeliveryManifest(input);
  const forged = { ...receipt, renderManifest: { schemaVersion: 1, fingerprint: "f".repeat(64) } };
  const canonical = value => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    return JSON.stringify(value);
  };
  const { fingerprint: ignored, ...evidence } = forged;
  forged.fingerprint = createHash("sha256").update(canonical(evidence)).digest("hex");
  assert.equal(verifyDeliveryManifest(forged), false);
});


test("delivery packages reject incomplete, mismatched or duplicate reviewer decisions", () => {
  const receipt = createDeliveryManifest(input);
  const master = { assetId: receipt.outputAsset, filename: "master.mp4", mediaType: receipt.mediaType, byteSize: receipt.byteSize, sha256: receipt.sha256, downloadUrl: "https://storage.example.test/master?token=short", downloadUrlExpiresInSeconds: 300 };
  const valid = { id: 1, schemaVersion: 1, decision: "approved", fingerprint: receipt.fingerprint, timelineId: receipt.timelineId, timelineRevision: receipt.timelineRevision, outputAsset: receipt.outputAsset, reviewerId: "reviewer-1", note: "Reviewed master output.", reviewedAt: "2026-11-02T08:59:00.000Z", createdAt: "2026-11-02T08:59:01.000Z" };
  const build = reviewHistory => createDeliveryPackage({ jobId: "job-1", projectId: "project-1", timelineId: receipt.timelineId, timelineRevision: receipt.timelineRevision, master, deliveryReceipt: receipt, renderManifest: receipt.renderManifest, deliveryReport: receipt.deliveryReport, reviewHistory, generatedAt: "2026-11-02T09:00:00.000Z" });
  assert.equal(verifyDeliveryPackage(build([valid])), true);
  assert.throws(() => build([{ ...valid, decision: "ship-it" }]));
  assert.throws(() => build([{ ...valid, outputAsset: "other-asset" }]));
  assert.throws(() => build([{ ...valid, reviewedAt: "not-a-date" }]));
  assert.throws(() => build([valid, { ...valid, id: 2 }]));
});
