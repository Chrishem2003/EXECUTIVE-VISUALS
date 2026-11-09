import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/i;
const STATUSES = new Set(["passed", "failed", "skipped"]);
const QUALITY_STATES = new Set(["not_reviewed", "reviewed_pass", "reviewed_fail"]);
export const REQUIRED_UPSCALE_FIXTURE_CATEGORIES = Object.freeze(["portrait", "fine_texture", "text", "animation", "low_light_noisy"]);
const FIXTURE_CATEGORIES = new Set(REQUIRED_UPSCALE_FIXTURE_CATEGORIES);

export function validateUpscaleBenchmarkRecord(record) {
  const issues = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { valid: false, issues: ["record must be an object"] };
  }
  for (const key of ["fixtureId", "fixtureCategory", "model", "modelVersion", "binarySha256", "modelFilesSha256", "inputSha256", "outputSha256"]) {
    if (typeof record[key] !== "string" || !record[key].trim()) issues.push(key + " is required");
  }
  if (typeof record.fixtureCategory === "string" && !FIXTURE_CATEGORIES.has(record.fixtureCategory)) issues.push("fixtureCategory is unsupported");
  for (const key of ["binarySha256", "modelFilesSha256", "inputSha256", "outputSha256"]) {
    if (typeof record[key] === "string" && !SHA256.test(record[key])) issues.push(key + " must be a SHA-256 hex digest");
  }
  for (const key of ["inputWidth", "inputHeight", "outputWidth", "outputHeight", "scale", "durationMs"]) {
    if (!Number.isFinite(record[key]) || record[key] <= 0) issues.push(key + " must be a positive number");
  }
  for (const key of ["inputWidth", "inputHeight", "outputWidth", "outputHeight"]) {
    if (!Number.isInteger(record[key])) issues.push(key + " must be an integer pixel dimension");
  }
  if (!Number.isInteger(record.scale) || ![2, 3, 4].includes(record.scale)) issues.push("scale must be 2, 3, or 4");
  if (!Number.isInteger(record.durationMs)) issues.push("durationMs must be an integer");
  if (!STATUSES.has(record.executionStatus)) issues.push("executionStatus is invalid");
  if (!QUALITY_STATES.has(record.qualityReview)) issues.push("qualityReview is invalid");
  if (!record.timestamp || !Number.isFinite(Date.parse(record.timestamp))) issues.push("timestamp must be a valid date");
  if (record.qualityReview === "reviewed_pass" || record.qualityReview === "reviewed_fail") {
    if (typeof record.qualityReviewer !== "string" || !record.qualityReviewer.trim()) issues.push("qualityReviewer is required for reviewed records");
    if (!record.qualityReviewedAt || !Number.isFinite(Date.parse(record.qualityReviewedAt))) issues.push("qualityReviewedAt must be a valid date for reviewed records");
    if (typeof record.qualityReviewNotes !== "string" || record.qualityReviewNotes.trim().length < 20) issues.push("qualityReviewNotes must contain at least 20 characters");
    if (typeof record.qualityReviewArtifactSha256 !== "string" || !SHA256.test(record.qualityReviewArtifactSha256)) issues.push("qualityReviewArtifactSha256 must be a SHA-256 digest");
  }
  if (record.metrics !== undefined) {
    if (!record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) issues.push("metrics must be an object");
    else {
      for (const key of ["psnr", "ssim", "lpips"]) {
        const value = record.metrics[key];
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          issues.push("metrics." + key + " must be a non-negative number");
        }
      }
      if (record.metrics.ssim !== undefined && Number.isFinite(record.metrics.ssim) && record.metrics.ssim > 1) {
        issues.push("metrics.ssim must not exceed 1");
      }
      if (record.metrics.lpips !== undefined && Number.isFinite(record.metrics.lpips) && record.metrics.lpips > 1) {
        issues.push("metrics.lpips must not exceed 1");
      }
    }
  }
  if (record.executionStatus === "passed" && record.outputWidth < record.inputWidth) issues.push("passed output width is smaller than input width");
  if (record.executionStatus === "passed" && record.outputHeight < record.inputHeight) issues.push("passed output height is smaller than input height");
  if (record.executionStatus === "passed" && Number.isFinite(record.inputWidth) && Number.isFinite(record.inputHeight) &&
      Number.isInteger(record.scale) && [2, 3, 4].includes(record.scale) &&
      (record.outputWidth !== record.inputWidth * record.scale || record.outputHeight !== record.inputHeight * record.scale)) {
    issues.push("passed output dimensions must exactly match the declared scale");
  }
  return { valid: issues.length === 0, issues };
}

export function summarizeUpscaleBenchmarks(records) {
  if (!Array.isArray(records)) records = [];
  const validRecords = [];
  const invalidRecords = [];
  const seenFixtureIds = new Set();
  const identityKeys = ["model", "modelVersion", "binarySha256", "modelFilesSha256"];
  let benchmarkIdentity = null;
  for (const record of records) {
    const validation = validateUpscaleBenchmarkRecord(record);
    const duplicate = typeof record?.fixtureId === "string" && seenFixtureIds.has(record.fixtureId);
    if (typeof record?.fixtureId === "string") seenFixtureIds.add(record.fixtureId);
    if (duplicate) validation.issues.push("fixtureId must be unique within a benchmark summary");
    if (validation.valid && !duplicate) {
      const identity = Object.fromEntries(identityKeys.map(key => [key, key.endsWith("Sha256") ? record[key].toLowerCase() : record[key]]));
      if (benchmarkIdentity === null) benchmarkIdentity = identity;
      else if (identityKeys.some(key => identity[key] !== benchmarkIdentity[key])) {
        validation.valid = false;
        validation.issues.push("all records in a benchmark summary must use the same model and pinned executable/model artifacts");
      }
    }
    if (validation.valid && !duplicate) validRecords.push(record);
    else invalidRecords.push({ fixtureId: record?.fixtureId || null, issues: validation.issues });
  }
  const executionPassed = validRecords.filter(record => record.executionStatus === "passed").length;
  const executionFailed = validRecords.filter(record => record.executionStatus === "failed").length;
  const qualityReviewed = validRecords.filter(record => record.qualityReview === "reviewed_pass").length;
  const qualityRejected = validRecords.filter(record => record.qualityReview === "reviewed_fail").length;
  const reviewedPassCategories = new Set(validRecords.filter(record => record.executionStatus === "passed" && record.qualityReview === "reviewed_pass").map(record => record.fixtureCategory));
  const missingCategories = REQUIRED_UPSCALE_FIXTURE_CATEGORIES.filter(category => !reviewedPassCategories.has(category));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    validRecordCount: validRecords.length,
    invalidRecords,
    execution: { passed: executionPassed, failed: executionFailed },
    quality: { reviewedPass: qualityReviewed, reviewedFail: qualityRejected, pendingReview: validRecords.filter(record => record.qualityReview === "not_reviewed").length },
    categoryCoverage: { required: [...REQUIRED_UPSCALE_FIXTURE_CATEGORIES], reviewedPass: [...reviewedPassCategories].sort(), missing: missingCategories },
    qualityVerified: validRecords.length > 0 && invalidRecords.length === 0 && qualityReviewed > 0 && qualityRejected === 0 && missingCategories.length === 0 &&
      validRecords.every(record => record.executionStatus === "passed" && record.qualityReview === "reviewed_pass"),
    records: validRecords
  };
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
