import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
