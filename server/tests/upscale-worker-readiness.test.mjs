import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";\nimport { createHash } from "node:crypto";
import { inspectUpscaleWorkerReadiness } from "../upscale-worker-readiness.mjs";

test("upscale worker preflight reports tools, model files, writable temp and atomic publication support without claiming quality", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-upscale-readiness-"));
  const binary = join(root, "realesrgan-ncnn-vulkan");
  const models = join(root, "models");
  const temp = join(root, "worker-temp");
  await import("node:fs/promises").then(fs => fs.mkdir(models));
  await import("node:fs/promises").then(fs => fs.mkdir(temp));
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await writeFile(join(models, "realesrgan-x4plus.param"), "fixture-param");
  await writeFile(join(models, "realesrgan-x4plus.bin"), "fixture-weights");
  try {
    const report = await inspectUpscaleWorkerReadiness({
      env: {
        REALESRGAN_NCNN_PATH: binary,
        REALESRGAN_MODEL_DIR: models,
        REALESRGAN_DEFAULT_MODEL: "realesrgan-x4plus",
        AI_UPSCALE_ENABLED: "true"
      },
      tempRoot: temp,
      checkExecutable: () => true
    });
    assert.equal(report.engine.available, true);
    assert.equal(report.engine.enabled, true);
    assert.equal(report.engine.executionVerified, false);
    assert.equal(report.engine.inferenceQualityVerified, false);
    assert.deepEqual(report.selfTest, { attempted: false, passed: false, reason: "UPSCALE_SELF_TEST_IMAGE is not configured." });
    assert.equal(report.filesystem.tempWritable, true);
    assert.equal(report.filesystem.hardLinks.supported, true);
    assert.equal(report.readyForQueuedUpscale, false);
    assert.ok(report.blockers.includes("ENGINE_SELF_TEST_REQUIRED"));
    assert.ok(report.blockers.includes("ATOMIC_HARDLINK_PUBLICATION_UNAVAILABLE") === false);
    assert.deepEqual(await readdir(temp), [], "preflight must remove its temporary probe directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upscale worker preflight fails closed when the engine and model are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-upscale-readiness-missing-"));
  try {
    const report = await inspectUpscaleWorkerReadiness({
      env: { AI_UPSCALE_ENABLED: "false" },
      tempRoot: root,
      checkExecutable: () => false
    });
    assert.equal(report.readyForQueuedUpscale, false);
    assert.ok(report.blockers.includes("FFMPEG_TOOLS_MISSING"));
    assert.ok(report.blockers.includes("REALESRGAN_EXECUTABLE_MISSING"));
    assert.ok(report.blockers.includes("REALESRGAN_MODEL_MISSING"));
    assert.ok(report.blockers.includes("AI_UPSCALE_DISABLED"));
    assert.equal(report.selfTest.attempted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upscale worker verifies manifest provenance against the exact installed executable and model hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-upscale-provenance-"));
  const binary = join(root, "realesrgan-ncnn-vulkan");
  const models = join(root, "models");
  const temp = join(root, "worker-temp");
  const manifestPath = join(root, "engine-manifest.json");
  const digest = value => createHash("sha256").update(value).digest("hex");
  const binaryContent = "#!/bin/sh\\nexit 0\\n";
  const paramContent = "approved-param";
  const weightsContent = "approved-weights";
  const binarySha256 = digest(binaryContent);
  const modelFilesSha256 = digest(digest(paramContent) + ":" + digest(weightsContent));
  await import("node:fs/promises").then(fs => fs.mkdir(models));
  await import("node:fs/promises").then(fs => fs.mkdir(temp));
  await writeFile(binary, binaryContent);
  await writeFile(join(models, "realesrgan-x4plus.param"), paramContent);
  await writeFile(join(models, "realesrgan-x4plus.bin"), weightsContent);
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    engine: "realesrgan-ncnn-vulkan",
    model: "realesrgan-x4plus",
    binarySha256,
    modelFilesSha256,
    source: "operator-approved release archive",
    release: "pinned-release-2026-01",
    license: "operator-verified license record"
  }));
  try {
    const report = await inspectUpscaleWorkerReadiness({
      env: {
        REALESRGAN_NCNN_PATH: binary,
        REALESRGAN_MODEL_DIR: models,
        REALESRGAN_DEFAULT_MODEL: "realesrgan-x4plus",
        AI_UPSCALE_ENABLED: "true",
        UPSCALE_ENGINE_MANIFEST: manifestPath
      },
      tempRoot: temp,
      checkExecutable: () => true
    });
    assert.equal(report.provenance.verified, true);
    assert.equal(report.provenance.release, "pinned-release-2026-01");
    assert.equal(report.blockers.includes("ENGINE_PROVENANCE_UNVERIFIED"), false);
    assert.equal(report.readyForQueuedUpscale, false, "provenance does not replace the required real inference self-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upscale worker rejects provenance manifests whose hashes do not match installed engine files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-upscale-provenance-mismatch-"));
  const binary = join(root, "engine");
  const models = join(root, "models");
  const manifestPath = join(root, "manifest.json");
  await import("node:fs/promises").then(fs => fs.mkdir(models));
  await writeFile(binary, "binary-content");
  await writeFile(join(models, "realesrgan-x4plus.param"), "model-param");
  await writeFile(join(models, "realesrgan-x4plus.bin"), "model-weights");
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    engine: "realesrgan-ncnn-vulkan",
    model: "realesrgan-x4plus",
    binarySha256: "0".repeat(64),
    modelFilesSha256: "1".repeat(64),
    source: "approved source",
    release: "approved release",
    license: "approved license"
  }));
  try {
    const report = await inspectUpscaleWorkerReadiness({
      env: {
        REALESRGAN_NCNN_PATH: binary,
        REALESRGAN_MODEL_DIR: models,
        REALESRGAN_DEFAULT_MODEL: "realesrgan-x4plus",
        AI_UPSCALE_ENABLED: "true",
        UPSCALE_ENGINE_MANIFEST: manifestPath
      },
      tempRoot: root,
      checkExecutable: () => true
    });
    assert.equal(report.provenance.verified, false);
    assert.equal(report.provenance.reason, "ENGINE_MANIFEST_HASH_MISMATCH");
    assert.ok(report.blockers.includes("ENGINE_PROVENANCE_UNVERIFIED"));
    assert.equal(report.readyForQueuedUpscale, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
