import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Hex, summarizeUpscaleBenchmarks } from "./upscale-benchmark.mjs";

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;

function reviewEvidenceValid(record) {
  return record?.qualityReview === "reviewed_pass" &&
    typeof record.reviewerId === "string" && record.reviewerId.trim().length >= 2 &&
    typeof record.reviewedAt === "string" && Number.isFinite(Date.parse(record.reviewedAt)) &&
    typeof record.reviewNotes === "string" && record.reviewNotes.trim().length >= 20 &&
    typeof record.reviewArtifactSha256 === "string" && SHA256.test(record.reviewArtifactSha256);
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
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { configured: true, models: {}, reason: "The configured local benchmark evidence file is unavailable." };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { configured: true, models: {}, reason: "The benchmark evidence path must be a regular non-symlink file." };
  }
  if (info.size < 2 || info.size > MAX_EVIDENCE_BYTES) {
    return { configured: true, models: {}, reason: "The benchmark evidence file is empty or exceeds the 4 MiB safety limit." };
  }

  let payload;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { configured: true, models: {}, reason: "The benchmark evidence file is not valid JSON." };
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
    const reviewedAt = records.map(record => Date.parse(record.reviewedAt)).filter(Number.isFinite);
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
