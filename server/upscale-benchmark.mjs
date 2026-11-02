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
  for (const record of records) {
    const validation = validateUpscaleBenchmarkRecord(record);
    const duplicate = typeof record?.fixtureId === "string" && seenFixtureIds.has(record.fixtureId);
    if (typeof record?.fixtureId === "string") seenFixtureIds.add(record.fixtureId);
    if (duplicate) validation.issues.push("fixtureId must be unique within a benchmark summary");
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

/**
 * Convert a completed AI-upscale derivative into benchmark evidence. Fixture
 * identity/category are supplied by the controlled fixture registry; hashes,
 * model build and measurements are taken from the persisted asset provenance.
 */
export function buildUpscaleBenchmarkRecordFromAsset({outputAsset,fixtureId,fixtureCategory,timestamp,metrics}={}) {
  const processing=outputAsset?.metadata?.processing;
  const record={
    fixtureId,
    fixtureCategory,
    model:processing?.model,
    modelVersion:processing?.modelVersion,
    binarySha256:processing?.binarySha256,
    modelFilesSha256:processing?.modelFilesSha256,
    inputSha256:processing?.inputSha256,
    outputSha256:outputAsset?.sha256,
    inputWidth:processing?.sourceWidth,
    inputHeight:processing?.sourceHeight,
    outputWidth:processing?.width,
    outputHeight:processing?.height,
    scale:processing?.scale,
    durationMs:processing?.durationMs,
    executionStatus:processing?.dimensionsVerified===true&&processing?.decoderVerified===true?"passed":"failed",
    qualityReview:processing?.qualityReview||"not_reviewed",
    timestamp:timestamp||outputAsset?.createdAt||new Date().toISOString(),
    ...(metrics?{metrics}:{})
  };
  const validation=validateUpscaleBenchmarkRecord(record);
  if(outputAsset?.mediaType&&!String(outputAsset.mediaType).startsWith("image/")) validation.issues.push("output asset must be an image");
  if(outputAsset?.derivativeOf!==undefined&&outputAsset.derivativeOf!==null&&processing?.sourceAssetId!==outputAsset.derivativeOf) validation.issues.push("processing source asset does not match derivative parent");
  if(outputAsset?.sha256!==processing?.outputSha256) validation.issues.push("processing output hash does not match persisted asset hash");
  if(validation.issues.length) throw Object.assign(new Error("Upscale asset cannot be registered as benchmark evidence: "+validation.issues.join("; ")),{code:"UPSCALE_BENCHMARK_EVIDENCE_INVALID",issues:validation.issues});
  return record;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Compare model builds only on validated benchmark records. Quality approval is
 * a hard eligibility gate; latency and metric summaries never promote an
 * unreviewed model to a production recommendation.
 */
export function compareUpscaleBenchmarkCandidates(records) {
  const valid = [];
  const invalid = [];
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    const result = validateUpscaleBenchmarkRecord(record);
    if (result.valid) valid.push(record);
    else invalid.push({ index, fixtureId: record?.fixtureId || null, issues: result.issues });
  }
  const groups = new Map();
  const seenFixtures = new Map();
  for (const record of valid) {
    const key = JSON.stringify([record.model, record.modelVersion, record.binarySha256, record.modelFilesSha256]);
    const fixtureKey = key + ":" + record.fixtureId;
    if (seenFixtures.has(fixtureKey)) {
      invalid.push({ fixtureId: record.fixtureId, issues: ["fixtureId must be unique within a pinned model build"] });
      continue;
    }
    seenFixtures.set(fixtureKey, true);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const percentile = (values, fraction) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  };
  const candidates = [...groups.values()].map(items => {
    const successful = items.filter(item => item.executionStatus === "passed");
    const reviewedPass = successful.filter(item => item.qualityReview === "reviewed_pass");
    const reviewedFail = items.filter(item => item.qualityReview === "reviewed_fail");
    const categories = [...new Set(reviewedPass.map(item => item.fixtureCategory))].sort();
    const missingCategories = REQUIRED_UPSCALE_FIXTURE_CATEGORIES.filter(category => !categories.includes(category));
    const qualityVerified = items.length > 0 && successful.length === items.length &&
      reviewedPass.length === items.length && reviewedFail.length === 0 && missingCategories.length === 0;
    const durations = successful.map(item => item.durationMs);
    const metricMedian = key => {
      const values = successful.map(item => item.metrics?.[key]).filter(Number.isFinite);
      return values.length ? percentile(values, 0.5) : null;
    };
    const first = items[0];
    return {
      model: first.model, modelVersion: first.modelVersion,
      binarySha256: first.binarySha256, modelFilesSha256: first.modelFilesSha256,
      records: items.length, executionPassed: successful.length,
      executionFailed: items.length - successful.length,
      reviewedPass: reviewedPass.length, reviewedFail: reviewedFail.length,
      missingCategories, qualityVerified,
      latencyMs: { median: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
      metrics: { psnrMedian: metricMedian("psnr"), ssimMedian: metricMedian("ssim"), lpipsMedian: metricMedian("lpips") }
    };
  });
  candidates.sort((a, b) => Number(b.qualityVerified) - Number(a.qualityVerified) ||
    (a.latencyMs.median ?? Number.POSITIVE_INFINITY) - (b.latencyMs.median ?? Number.POSITIVE_INFINITY) ||
    a.model.localeCompare(b.model));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    invalidRecords: invalid,
    recommended: candidates.find(candidate => candidate.qualityVerified) || null,
    candidates
  };
}
