import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUpscaleQualityEvidence } from "../upscale-quality-evidence.mjs";

const digest = char => char.repeat(64);
const REVIEW_ARTIFACT = Buffer.from("Independent visual comparison report covering all five benchmark fixtures.");
const REVIEW_ARTIFACT_SHA256 = createHash("sha256").update(REVIEW_ARTIFACT).digest("hex");
async function writeEvidence(directory, path, records) {
  await writeFile(join(directory, "review-artifact.txt"), REVIEW_ARTIFACT);
  await writeFile(path, JSON.stringify({ records }));
}
const categories = ["portrait", "fine_texture", "text", "animation", "low_light_noisy"];
function recordsFor(model = "realesrgan-x4plus", overrides = {}) {
  return categories.map((fixtureCategory, index) => ({
    fixtureId: model + "-" + fixtureCategory,
    fixtureCategory,
    model,
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
    qualityReview: "reviewed_pass",
    timestamp: "2026-11-09T00:00:00.000Z",
    qualityReviewer: "reviewer-test",
    qualityReviewedAt: "2026-11-09T00:05:00.000Z",
    qualityReviewNotes: "Compared source and output; no visible artifacts or identity drift.",
    qualityReviewArtifactPath: "review-artifact.txt",
    qualityReviewArtifactSha256: REVIEW_ARTIFACT_SHA256,
    ...overrides
  }));
}

test("does not enable AI upscaling when no local evidence path is configured", async () => {
  const result = await loadUpscaleQualityEvidence({ filePath: "" });
  assert.equal(result.configured, false);
  assert.deepEqual(result.models, {});
});

test("accepts only complete model-specific human-reviewed fixture evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-evidence-"));
  const path = join(directory, "benchmarks.json");
  try {
    await writeEvidence(directory, path, recordsFor());
    const result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.configured, true);
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, true);
    assert.equal(result.models["realesrgan-x4plus"].qualityEvidence.model, "realesrgan-x4plus");
    assert.match(result.models["realesrgan-x4plus"].qualityEvidence.evidenceSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not let one model's review evidence approve a different model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-model-evidence-"));
  const path = join(directory, "benchmarks.json");
  try {
    await writeEvidence(directory, path, [...recordsFor("realesrgan-x4plus"), ...recordsFor("realesrgan-x4plus-anime", { qualityReview: "not_reviewed" })]);
    const result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, true);
    assert.equal(result.models["realesrgan-x4plus-anime"].qualityVerified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects incomplete category coverage and missing reviewer evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-incomplete-"));
  const path = join(directory, "benchmarks.json");
  try {
    const incomplete = recordsFor().slice(0, 4);
    incomplete[0].qualityReviewNotes = "short";
    await writeEvidence(directory, path, incomplete);
    const result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-normalized LPIPS metrics even when reviewer fields are present", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-metric-range-"));
  const path = join(directory, "benchmarks.json");
  try {
    await writeEvidence(directory, path, recordsFor("realesrgan-x4plus", { metrics: { lpips: 1.2 } }));
    const result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects evidence files that exceed the bounded read size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-oversized-"));
  const path = join(directory, "benchmarks.json");
  try {
    await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.deepEqual(result.models, {});
    assert.match(result.reason, /4 MiB/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed for invalid JSON and symlink evidence paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-invalid-"));
  const path = join(directory, "benchmarks.json");
  const link = join(directory, "link.json");
  try {
    await writeFile(path, "{invalid");
    assert.deepEqual((await loadUpscaleQualityEvidence({ filePath: path })).models, {});
    const { symlink } = await import("node:fs/promises");
    await writeEvidence(directory, path, recordsFor());
    await symlink(path, link);
    const linked = await loadUpscaleQualityEvidence({ filePath: link });
    assert.deepEqual(linked.models, {});
    assert.match(linked.reason, /symlink/);
    const directoryPath = await loadUpscaleQualityEvidence({ filePath: directory });
    assert.deepEqual(directoryPath.models, {});
    assert.match(directoryPath.reason, /regular non-symlink/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("rejects a model benchmark whose fixture records use different pinned model artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-mixed-artifacts-"));
  const path = join(directory, "benchmarks.json");
  try {
    const mixed = recordsFor();
    mixed[4].binarySha256 = digest("f");
    await writeEvidence(directory, path, mixed);
    const result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, false);
    assert.equal(result.models["realesrgan-x4plus"].qualityEvidence, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("requires the review artifact to exist and match its recorded SHA-256", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-review-artifact-"));
  const path = join(directory, "benchmarks.json");
  try {
    const records = recordsFor();
    await writeEvidence(directory, path, records);
    const accepted = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(accepted.models["realesrgan-x4plus"].qualityVerified, true);

    await writeFile(join(directory, "review-artifact.txt"), "changed after review");
    const changed = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(changed.models["realesrgan-x4plus"].qualityVerified, false);
    assert.equal(changed.models["realesrgan-x4plus"].qualityEvidence, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing, traversing and symlinked review artifact paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-upscale-review-path-"));
  const path = join(directory, "benchmarks.json");
  try {
    const records = recordsFor();
    await writeEvidence(directory, path, records);
    records[0].qualityReviewArtifactPath = "../outside.txt";
    await writeFile(path, JSON.stringify({ records }));
    let result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, false);

    records[0].qualityReviewArtifactPath = "missing.txt";
    await writeFile(path, JSON.stringify({ records }));
    result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, false);

    const { symlink } = await import("node:fs/promises");
    await symlink(join(directory, "review-artifact.txt"), join(directory, "linked-review.txt"));
    records[0].qualityReviewArtifactPath = "linked-review.txt";
    await writeFile(path, JSON.stringify({ records }));
    result = await loadUpscaleQualityEvidence({ filePath: path });
    assert.equal(result.models["realesrgan-x4plus"].qualityVerified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
