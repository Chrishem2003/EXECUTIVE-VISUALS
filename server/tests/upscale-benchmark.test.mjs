import test from "node:test";
import assert from "node:assert/strict";
import { validateUpscaleBenchmarkRecord, summarizeUpscaleBenchmarks, compareUpscaleBenchmarkCandidates, sha256Hex, buildUpscaleBenchmarkRecordFromAsset } from "../upscale-benchmark.mjs";

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

test("summary fails closed for a non-array input", () => {
  const summary = summarizeUpscaleBenchmarks(null);
  assert.equal(summary.recordCount, 0);
  assert.equal(summary.qualityVerified, false);
  assert.equal(summary.validRecordCount, 0);
});


test("compares pinned model builds but recommends only fully human-reviewed quality candidates", () => {
  const categories = ["portrait", "fine_texture", "text", "animation", "low_light_noisy"];
  const approved = categories.map((fixtureCategory, index) => validRecord({
    fixtureId: "approved-" + index, fixtureCategory, qualityReview: "reviewed_pass",
    durationMs: 1800 - index * 100, metrics: { psnr: 30 + index, ssim: 0.9 + index * 0.01 }
  }));
  const unreviewed = categories.map((fixtureCategory, index) => validRecord({
    fixtureId: "unreviewed-" + index, fixtureCategory, model: "candidate-b",
    qualityReview: "not_reviewed", durationMs: 400
  }));
  const report = compareUpscaleBenchmarkCandidates([...approved, ...unreviewed]);
  assert.equal(report.candidateCount, 2);
  assert.equal(report.recommended.model, "realesrgan-x4plus");
  const waiting = report.candidates.find(candidate => candidate.model === "candidate-b");
  assert.equal(waiting.qualityVerified, false);
  assert.deepEqual(waiting.missingCategories, categories);
  assert.equal(report.recommended.metrics.ssimMedian, 0.92);
});

test("does not recommend a model when all candidates have incomplete or rejected quality review", () => {
  const report = compareUpscaleBenchmarkCandidates([
    validRecord({ qualityReview: "reviewed_fail" }),
    validRecord({ fixtureId: "pending", fixtureCategory: "text", qualityReview: "not_reviewed" })
  ]);
  assert.equal(report.recommended, null);
});

test("candidate comparison excludes malformed benchmark records", () => {
  const report = compareUpscaleBenchmarkCandidates([
    validRecord({ qualityReview: "reviewed_pass" }),
    validRecord({ fixtureId: "bad", inputSha256: "invalid" })
  ]);
  assert.equal(report.invalidRecords.length, 1);
  assert.equal(report.candidateCount, 1);
  assert.equal(report.recommended, null);
});


test("candidate comparison rejects duplicate fixture evidence for the same pinned model build", () => {
  const duplicateFixture = validRecord({ qualityReview: "reviewed_pass" });
  const report = compareUpscaleBenchmarkCandidates([
    duplicateFixture,
    { ...duplicateFixture, durationMs: 900 }
  ]);
  assert.equal(report.invalidRecords.length, 1);
  assert.equal(report.candidates[0].qualityVerified, false);
  assert.equal(report.recommended, null);
});


test("creates benchmark evidence from a persisted AI-upscale derivative and its provenance", () => {
  const sourceHash=digest("c"),outputHash=digest("d");
  const asset={
    id:"derived-asset",mediaType:"image/png",sha256:outputHash,derivativeOf:"source-asset",
    createdAt:"2026-11-02T12:00:00.000Z",
    metadata:{processing:{
      schemaVersion:1,sourceAssetId:"source-asset",inputSha256:sourceHash,outputSha256:outputHash,
      model:"realesrgan-x4plus",modelVersion:digest("a")+":"+digest("b"),
      binarySha256:digest("a"),modelFilesSha256:digest("b"),
      sourceWidth:320,sourceHeight:240,width:1280,height:960,scale:4,durationMs:1250,
      dimensionsVerified:true,decoderVerified:true,qualityReview:"not_reviewed"
    }}
  };
  const record=buildUpscaleBenchmarkRecordFromAsset({
    outputAsset:asset,fixtureId:"portrait-01",fixtureCategory:"portrait"
  });
  assert.equal(validateUpscaleBenchmarkRecord(record).valid,true);
  assert.equal(record.inputSha256,sourceHash);
  assert.equal(record.outputSha256,outputHash);
  assert.equal(record.executionStatus,"passed");
  assert.equal(record.qualityReview,"not_reviewed");
  assert.equal(record.timestamp,asset.createdAt);
});

test("refuses benchmark evidence if the stored derivative hash or parent lineage disagrees", () => {
  const asset={
    mediaType:"image/png",sha256:digest("e"),derivativeOf:"different-source",
    metadata:{processing:{
      sourceAssetId:"source-asset",inputSha256:digest("c"),outputSha256:digest("d"),
      model:"realesrgan-x4plus",modelVersion:"build",binarySha256:digest("a"),modelFilesSha256:digest("b"),
      sourceWidth:320,sourceHeight:240,width:1280,height:960,scale:4,durationMs:1250,
      dimensionsVerified:true,decoderVerified:true,qualityReview:"not_reviewed"
    }}
  };
  assert.throws(()=>buildUpscaleBenchmarkRecordFromAsset({
    outputAsset:asset,fixtureId:"portrait-02",fixtureCategory:"portrait"
  }),error=>error.code==="UPSCALE_BENCHMARK_EVIDENCE_INVALID"&&error.issues.length>=2);
});
