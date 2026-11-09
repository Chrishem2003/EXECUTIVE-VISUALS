import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sha256Hex, summarizeUpscaleBenchmarks } from "./upscale-benchmark.mjs";

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_ARTIFACT_BYTES = 25 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isExplicitTimestamp(value) {
  return typeof value === "string" && RFC3339_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function reviewEvidenceValid(record) {
  const metrics = record?.metrics && typeof record.metrics === "object" && !Array.isArray(record.metrics) ? record.metrics : {};
  const normalizedMetricsValid = ["ssim", "lpips"].every(key => metrics[key] === undefined || (Number.isFinite(metrics[key]) && metrics[key] >= 0 && metrics[key] <= 1));
  const benchmarkAt = isExplicitTimestamp(record?.timestamp) ? Date.parse(record.timestamp) : NaN;
  const reviewedAt = isExplicitTimestamp(record?.qualityReviewedAt) ? Date.parse(record.qualityReviewedAt) : NaN;
  const reviewTimeValid = Number.isFinite(benchmarkAt) && Number.isFinite(reviewedAt) &&
    reviewedAt >= benchmarkAt && reviewedAt <= Date.now() + 5 * 60 * 1000;
  return normalizedMetricsValid && reviewTimeValid && record?.qualityReview === "reviewed_pass" &&
    typeof record.qualityReviewer === "string" && record.qualityReviewer.trim().length >= 2 &&
    typeof record.qualityReviewedAt === "string" && Number.isFinite(reviewedAt) &&
    typeof record.qualityReviewNotes === "string" && record.qualityReviewNotes.trim().length >= 20 &&
    typeof record.qualityReviewArtifactPath === "string" && record.qualityReviewArtifactPath.trim().length > 0 &&
    !isAbsolute(record.qualityReviewArtifactPath) && !record.qualityReviewArtifactPath.split(/[\\/]/).includes("..") &&
    typeof record.qualityReviewArtifactSha256 === "string" && SHA256.test(record.qualityReviewArtifactSha256);
}

async function verifyReviewArtifact(record, evidenceDirectory) {
  if (!reviewEvidenceValid(record)) return false;
  const root = await realpath(evidenceDirectory);
  const candidate = resolve(root, record.qualityReviewArtifactPath);
  const lexicalPath = relative(root, candidate);
  if (!lexicalPath || lexicalPath === ".." || lexicalPath.startsWith(".." + sep) || isAbsolute(lexicalPath)) return false;
  let handle;
  try {
    const linkInfo = await lstat(candidate);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return false;
    const actualPath = await realpath(candidate);
    const actualRelative = relative(root, actualPath);
    if (!actualRelative || actualRelative === ".." || actualRelative.startsWith(".." + sep) || isAbsolute(actualRelative)) return false;
    handle = await open(actualPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_REVIEW_ARTIFACT_BYTES) return false;
    const bytes = await handle.readFile();
    if (bytes.length < 1 || bytes.length > MAX_REVIEW_ARTIFACT_BYTES) return false;
    return sha256Hex(bytes) === record.qualityReviewArtifactSha256.toLowerCase();
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
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
    const artifactChecks = await Promise.all(records.map(record => verifyReviewArtifact(record, dirname(path))));
    const reviewed = records.length > 0 && records.every(reviewEvidenceValid) && artifactChecks.every(Boolean);
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
