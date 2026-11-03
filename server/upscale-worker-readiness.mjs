import { mkdtemp, writeFile, link, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { executableAvailable } from "./media.mjs";
import { createRealEsrganAdapter } from "./ai-upscale-engine.mjs";

const REQUIRED_MODELS = Object.freeze(["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3", "realesrgan-x2plus"]);

async function probeHardLinks(directory) {
  const source = join(directory, ".ev-hardlink-source-" + randomUUID());
  const target = join(directory, ".ev-hardlink-target-" + randomUUID());
  try {
    await writeFile(source, "executive-visuals-worker-preflight");
    await link(source, target);
    const [a, b] = await Promise.all([lstat(source), lstat(target)]);
    return { supported: a.isFile() && b.isFile() && a.ino === b.ino && a.dev === b.dev };
  } catch (error) {
    return { supported: false, reason: error?.code || "HARDLINK_PROBE_FAILED" };
  } finally {
    await rm(source, { force: true }).catch(() => {});
    await rm(target, { force: true }).catch(() => {});
  }
}

export async function inspectUpscaleWorkerReadiness({
  env = process.env,
  tempRoot = env.CLOUD_WORKER_TEMP_ROOT || tmpdir(),
  checkExecutable = executableAvailable
} = {}) {
  const selectedModel = String(env.REALESRGAN_DEFAULT_MODEL || "realesrgan-x4plus");
  const adapter = createRealEsrganAdapter({
    binaryPath: env.REALESRGAN_NCNN_PATH || "",
    modelDirectory: env.REALESRGAN_MODEL_DIR || "",
    enabled: env.AI_UPSCALE_ENABLED === "true"
  });
  const engine = await adapter.probe(selectedModel);
  const mediaTools = {
    ffmpeg: Boolean(checkExecutable("ffmpeg")),
    ffprobe: Boolean(checkExecutable("ffprobe"))
  };
  let tempDirectory = null;
  let tempWritable = false;
  let hardLinks = { supported: false, reason: "TEMP_DIRECTORY_UNAVAILABLE" };
  try {
    tempDirectory = await mkdtemp(join(resolve(tempRoot), "ev-upscale-preflight-"));
    tempWritable = true;
    hardLinks = await probeHardLinks(tempDirectory);
  } catch (error) {
    hardLinks = { supported: false, reason: error?.code || "TEMP_DIRECTORY_UNAVAILABLE" };
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
  const blockers = [];
  if (!mediaTools.ffmpeg || !mediaTools.ffprobe) blockers.push("FFMPEG_TOOLS_MISSING");
  if (!engine.binaryReady) blockers.push("REALESRGAN_EXECUTABLE_MISSING");
  if (!engine.modelReady) blockers.push("REALESRGAN_MODEL_MISSING");
  if (!engine.executionEnabled) blockers.push("AI_UPSCALE_DISABLED");
  if (!engine.executionVerified) blockers.push("ENGINE_SELF_TEST_REQUIRED");
  if (!tempWritable) blockers.push("WORKER_TEMP_DIRECTORY_NOT_WRITABLE");
  if (!hardLinks.supported) blockers.push("ATOMIC_HARDLINK_PUBLICATION_UNAVAILABLE");
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    readyForQueuedUpscale: blockers.length === 0,
    selectedModel,
    supportedModels: REQUIRED_MODELS,
    mediaTools,
    engine: {
      available: engine.available,
      enabled: engine.executionEnabled,
      executionVerified: engine.executionVerified,
      inferenceQualityVerified: false,
      binarySha256: engine.binarySha256,
      modelFilesSha256: engine.modelFilesSha256,
      reason: engine.reason
    },
    filesystem: { tempWritable, hardLinks },
    blockers
  };
}
