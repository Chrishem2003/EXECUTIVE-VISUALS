import test from "node:test";
import assert from "node:assert/strict";
import { validateUpscaleBenchmarkRecord, summarizeUpscaleBenchmarks, sha256Hex } from "../upscale-benchmark.mjs";

const digest = char => char.repeat(64);
const validRecord = overrides => ({
  fixtureId: "portrait-detail-01",
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
  const record = validRecord({ inputSha256: "not-a-hash", outputSha256: "", scale: 8 });
  const result = validateUpscaleBenchmarkRecord(record);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.includes("inputSha256")));
  assert.ok(result.issues.some(issue => issue.includes("outputSha256")));
  assert.ok(result.issues.some(issue => issue.includes("scale")));
});

test("does not equate successful model execution with verified visual quality", () => {
  const summary = summarizeUpscaleBenchmarks([validRecord()]);
  assert.equal(summary.execution.passed, 1);
  assert.equal(summary.quality.pendingReview, 1);
  assert.equal(summary.qualityVerified, false);
});

test("quality verification requires every valid record to pass human review", () => {
  const approved = validRecord({ qualityReview: "reviewed_pass" });
  const summary = summarizeUpscaleBenchmarks([approved]);
  assert.equal(summary.qualityVerified, true);
  assert.equal(summarizeUpscaleBenchmarks([approved, validRecord({ fixtureId: "text-detail-02", qualityReview: "not_reviewed" })]).qualityVerified, false);
  assert.equal(summarizeUpscaleBenchmarks([approved, validRecord({ fixtureId: "noisy-detail-03", qualityReview: "reviewed_fail" })]).qualityVerified, false);
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
  assert.equal(sha256Hex(Buffer.from("executive-visuals")), "f7b3e44b21c63b2f5f7c4f6e39d2d8f0f09c8ec1c9d9c2d4");
});
