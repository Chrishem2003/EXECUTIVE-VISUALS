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
