import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex, summarizeUpscaleBenchmarks } from "./upscale-benchmark.mjs";

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;

function reviewEvidenceValid(record) {
  const metrics = record?.metrics && typeof record.metrics === "object" && !Array.isArray(record.metrics) ? record.metrics : {};
  const normalizedMetricsValid = ["ssim", "lpips"].every(key => metrics[key] === undefined || (Number.isFinite(metrics[key]) && metrics[key] >= 0 && metrics[key] <= 1));
  return normalizedMetricsValid && record?.qualityReview === "reviewed_pass" &&
    typeof record.qualityReviewer === "string" && record.qualityReviewer.trim().length >= 2 &&
    typeof record.qualityReviewedAt === "string" && Number.isFinite(Date.parse(record.qualityReviewedAt)) &&
    typeof record.qualityReviewNotes === "string" && record.qualityReviewNotes.trim().length >= 20 &&
    typeof record.qualityReviewArtifactSha256 === "string" && SHA256.test(record.qualityReviewArtifactSha256);
}

/**
 * Load locally stored, model-specific benchmark evidence.
 * This reader is deliberately offline-only: it accepts a filesystem path,
 * rejects symlinks/non-files/oversized inputs, and never enables inference itself.
 */
export async function loadUpscaleQualityEvidence({ filePath = process.env.AI_UPSCALE_QUALITY_EVIDENCE_PATH } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { configured: false, models: {}, reason: "No local reviewed benchmark evidence file is configured." };
  }

  const path = resolve(filePath);
  let handle;
  try {
    // O_NOFOLLOW prevents a symlink swap between validation and opening on supported hosts.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch {
    return { configured: true, models: {}, reason: "The configured benchmark evidence file is unavailable or is a symlink." };
  }

  let payload;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return { configured: true, models: {}, reason: "The benchmark evidence path must be a regular non-symlink file." };
    }
    if (info.size < 2 || info.size > MAX_EVIDENCE_BYTES) {
      return { configured: true, models: {}, reason: "The benchmark evidence file is empty or exceeds the 4 MiB safety limit." };
    }
    const bytes = await handle.readFile();
    if (bytes.length < 2 || bytes.length > MAX_EVIDENCE_BYTES) {
      return { configured: true, models: {}, reason: "The benchmark evidence file changed size or exceeds the 4 MiB safety limit." };
    }
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { configured: true, models: {}, reason: "The benchmark evidence file is not valid UTF-8 JSON." };
    }
  } catch {
    return { configured: true, models: {}, reason: "The configured benchmark evidence file could not be read safely." };
  } finally {
    await handle.close().catch(() => {});
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.records)) {
    return { configured: true, models: {}, reason: "The benchmark evidence file must contain a records array." };
  }

  const modelIds = [...new Set(payload.records.map(record => record?.model).filter(value => typeof value === "string" && value.trim()))];
  const models = {};
  for (const model of modelIds) {
    const records = payload.records.filter(record => record?.model === model);
    const summary = summarizeUpscaleBenchmarks(records);
    const reviewed = records.length > 0 && records.every(reviewEvidenceValid);
    const qualityVerified = summary.qualityVerified === true && reviewed;
    const reviewedAt = records.map(record => Date.parse(record.qualityReviewedAt)).filter(Number.isFinite);
    const checkedAt = reviewedAt.length ? new Date(Math.max(...reviewedAt)).toISOString() : "";
    const fixtureId = qualityVerified
      ? sha256Hex(Buffer.from(records.map(record => record.fixtureId).sort().join("\\n")))
      : "";
    models[model] = {
      qualityVerified,
      qualityEvidence: qualityVerified ? {
        model,
        fixtureId,
        checkedAt,
        recordCount: records.length,
        evidenceSha256: sha256Hex(Buffer.from(JSON.stringify(records)))
      } : null,
      reason: qualityVerified
        ? "All required fixture categories have valid, model-specific human review evidence."
        : "This model does not yet have a complete, valid, model-specific human-reviewed benchmark."
    };
  }

  return {
    configured: true,
    models,
    reason: Object.values(models).some(model => model.qualityVerified)
      ? "Model-specific reviewed benchmark evidence was loaded."
      : "No model has passed the complete reviewed benchmark gate."
  };
}
