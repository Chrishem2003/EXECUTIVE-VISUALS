import test from "node:test";
import assert from "node:assert/strict";
import { validateUpscaleBenchmarkRecord, summarizeUpscaleBenchmarks, sha256Hex } from "../upscale-benchmark.mjs";

const digest = char => char.repeat(64);
const validRecord = overrides => ({
  fixtureId: "portrait-detail-01",
  fixtureCategory: "portrait",
  model: "realesrgan-x4plus",
  modelVersion: "pinned-local-build",
  binarySha256: digest("a"),
  modelFilesSha256: digest("b"),
  inputSha256: digest("c"),
  outputSha256: digest("d"),
  inputWidth: 320,
  inputHeight: 240,
  outputWidth: 1280,
  outputHeight: 960,
  scale: 4,
  durationMs: 1200,
  executionStatus: "passed",
  qualityReview: "not_reviewed",
  timestamp: "2026-11-02T00:00:00.000Z",
  qualityReviewer: "qa-reviewer-01",
  qualityReviewedAt: "2026-11-03T00:00:00.000Z",
  qualityReviewNotes: "Compared source and output at native and 100 percent zoom; no unacceptable artifacts found.",
  qualityReviewArtifactPath: "reviews/benchmark-review.txt",
  qualityReviewArtifactSha256: digest("e"),
  requestedTile: 128,
  tile: 128,
  tileFallbackUsed: false,
  tileAttempts: [128],
  metrics: { psnr: 31.2, ssim: 0.91 },
  ...overrides
});

test("validates pinned inputs, outputs, dimensions and execution metadata", () => {
  assert.deepEqual(validateUpscaleBenchmarkRecord(validRecord()), { valid: true, issues: [] });
});

test("rejects missing hashes, malformed digests and unsupported scales", () => {
  const record = validRecord({ inputSha256: "not-a-hash", outputSha256: "", scale: 8, fixtureCategory: "unknown" });
  const result = validateUpscaleBenchmarkRecord(record);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("inputSha256")));
  assert.ok(result.issues.some(issue => issue.includes("outputSha256")));
  assert.ok(result.issues.some(issue => issue.includes("scale")));
  assert.ok(result.issues.some(issue => issue.includes("fixtureCategory")));
});

test("does not equate successful model execution with verified visual quality", () => {
  const summary = summarizeUpscaleBenchmarks([validRecord()]);
  assert.equal(summary.execution.passed, 1);
  assert.equal(summary.quality.pendingReview, 1);
  assert.equal(summary.qualityVerified, false);
});

test("quality verification requires human review and all representative fixture categories", () => {
  const categories = ["portrait", "fine_texture", "text", "animation", "low_light_noisy"];
  const approved = categories.map((fixtureCategory, index) => validRecord({ fixtureId: `fixture-${index + 1}`, fixtureCategory, qualityReview: "reviewed_pass" }));
  const summary = summarizeUpscaleBenchmarks(approved);
  assert.equal(summary.qualityVerified, true);
  assert.deepEqual(summary.categoryCoverage.missing, []);
  assert.equal(summarizeUpscaleBenchmarks([approved[0]]).qualityVerified, false);
  assert.deepEqual(summarizeUpscaleBenchmarks([approved[0]]).categoryCoverage.missing, categories.slice(1));
  assert.equal(summarizeUpscaleBenchmarks([...approved, validRecord({ fixtureId: "unreviewed", fixtureCategory: "text", qualityReview: "not_reviewed" })]).qualityVerified, false);
  assert.equal(summarizeUpscaleBenchmarks([...approved, validRecord({ fixtureId: "rejected", fixtureCategory: "low_light_noisy", qualityReview: "reviewed_fail" })]).qualityVerified, false);
});

test("invalid records are excluded and prevent a clean quality-verification result", () => {
  const summary = summarizeUpscaleBenchmarks([validRecord({ qualityReview: "reviewed_pass" }), validRecord({ fixtureId: "broken", scale: 0 })]);
  assert.equal(summary.validRecordCount, 1);
  assert.equal(summary.invalidRecords.length, 1);
  assert.equal(summary.qualityVerified, false);
});

test("reports execution failures separately from quality review", () => {
  const summary = summarizeUpscaleBenchmarks([validRecord({ executionStatus: "failed", qualityReview: "not_reviewed" })]);
  assert.equal(summary.execution.failed, 1);
  assert.equal(summary.qualityVerified, false);
});

test("computes SHA-256 digests for benchmark artifact bytes", () => {
  assert.equal(sha256Hex(Buffer.from("executive-visuals")), "6d7f71b4525dd39653fa7aa39b7bd5a13c2c4cece8b15b499bb6429906ffea8c");
});


test("rejects successful outputs that do not match the declared upscale factor", () => {
  const result = validateUpscaleBenchmarkRecord(validRecord({ outputWidth: 1279 }));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("exactly match the declared scale")));
});

test("duplicate fixture IDs invalidate the benchmark summary", () => {
  const first = validRecord({ qualityReview: "reviewed_pass" });
  const duplicate = validRecord({ qualityReview: "reviewed_pass" });
  const summary = summarizeUpscaleBenchmarks([first, duplicate]);
  assert.equal(summary.validRecordCount, 1);
  assert.equal(summary.invalidRecords.length, 1);
  assert.ok(summary.invalidRecords[0].issues.some(issue => issue.includes("must be unique")));
  assert.equal(summary.qualityVerified, false);
});

test("rejects SSIM values outside their valid upper bound", () => {
  const result = validateUpscaleBenchmarkRecord(validRecord({ metrics: { ssim: 1.01 } }));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("ssim must not exceed 1")));
});


test("rejects fractional pixel dimensions", () => {
  const result = validateUpscaleBenchmarkRecord(validRecord({ inputWidth: 320.5 }));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("integer pixel dimension")));
});

test("enforces normalized metric ranges and accepts absent optional metrics", () => {
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ metrics: { psnr: 0, ssim: 0, lpips: 1 } })).valid, true);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ metrics: { ssim: -0.1 } })).valid, false);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ metrics: {} })).valid, true);
});

test("reviewed quality requires reviewer, timestamp, notes and a hashed review artifact", () => {
  const incomplete = validRecord({ qualityReview: "reviewed_pass", qualityReviewer: "", qualityReviewNotes: "ok", qualityReviewArtifactSha256: "invalid" });
  const result = validateUpscaleBenchmarkRecord(incomplete);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("qualityReviewer")));
  assert.ok(result.issues.some(issue => issue.includes("qualityReviewNotes")));
  assert.ok(result.issues.some(issue => issue.includes("qualityReviewArtifactSha256")));
});

test("LPIPS is constrained to its normalized zero-to-one range", () => {
  const result = validateUpscaleBenchmarkRecord(validRecord({ metrics: { lpips: 1.01 } }));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("metrics.lpips must not exceed 1")));
});

test("summary fails closed for a non-array input", () => {
  const summary = summarizeUpscaleBenchmarks(null);
  assert.equal(summary.recordCount, 0);
  assert.equal(summary.qualityVerified, false);
  assert.equal(summary.validRecordCount, 0);
});


test("rejects benchmark summaries that mix model versions or executable/model artifacts", () => {
  const categories = ["portrait", "fine_texture", "text", "animation", "low_light_noisy"];
  const approved = categories.map((fixtureCategory, index) => validRecord({ fixtureId: `consistent-${index}`, fixtureCategory, qualityReview: "reviewed_pass" }));
  const mixedVersion = approved.map(record => ({ ...record }));
  mixedVersion[4].modelVersion = "different-pinned-model-version";
  const versionSummary = summarizeUpscaleBenchmarks(mixedVersion);
  assert.equal(versionSummary.qualityVerified, false);
  assert.equal(versionSummary.invalidRecords.length, 1);
  assert.match(versionSummary.invalidRecords[0].issues.join(" "), /same model and pinned executable\/model artifacts/);

  const mixedWeights = approved.map(record => ({ ...record }));
  mixedWeights[3].modelFilesSha256 = digest("f");
  const weightsSummary = summarizeUpscaleBenchmarks(mixedWeights);
  assert.equal(weightsSummary.qualityVerified, false);
  assert.equal(weightsSummary.invalidRecords.length, 1);
});


test("rejects multiple distinct fixtures for the same required category", () => {
  const categories = ["portrait", "fine_texture", "text", "animation", "low_light_noisy"];
  const approved = categories.map((fixtureCategory, index) => validRecord({
    fixtureId: `category-${index}`,
    fixtureCategory,
    qualityReview: "reviewed_pass"
  }));
  const extraPortrait = validRecord({
    fixtureId: "category-portrait-extra",
    fixtureCategory: "portrait",
    qualityReview: "reviewed_pass"
  });
  const summary = summarizeUpscaleBenchmarks([...approved, extraPortrait]);
  assert.equal(summary.qualityVerified, false);
  assert.equal(summary.validRecordCount, 5);
  assert.equal(summary.invalidRecords.length, 1);
  assert.match(summary.invalidRecords[0].issues.join(" "), /exactly one fixture record/);
});


test("reviewed quality requires a non-trivial reviewer identifier", () => {
  const result = validateUpscaleBenchmarkRecord(validRecord({ qualityReview: "reviewed_pass", qualityReviewer: "a" }));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("qualityReviewer must contain at least 2 characters")));
});

test("validates deterministic tile settings and fallback attempts", () => {
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ requestedTile: 0, tile: 256, tileFallbackUsed: true, tileAttempts: [0, 256] })).valid, true);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ tile: 24 })).valid, false);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ tileAttempts: [0, 24] })).valid, false);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ requestedTile: 128, tile: 256, tileFallbackUsed: false, tileAttempts: [128, 256] })).valid, false);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ requestedTile: 0, tile: 256, tileFallbackUsed: true, tileAttempts: [0, 256] })).valid, true);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ requestedTile: 128, tile: 256, tileFallbackUsed: true, tileAttempts: [256] })).valid, false);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ requestedTile: 128, tile: 256, tileFallbackUsed: true, tileAttempts: [128] })).valid, false);
  assert.equal(validateUpscaleBenchmarkRecord(validRecord({ requestedTile: 128, tile: 128, tileFallbackUsed: false, tileAttempts: [256, 128] })).valid, false);
});
