import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { createRealEsrganAdapter } from "./ai-upscale-engine.mjs";
import { REQUIRED_UPSCALE_FIXTURE_CATEGORIES, summarizeUpscaleBenchmarks } from "./upscale-benchmark.mjs";

const ALLOWED_MODELS = new Set(["realesrgan-x4plus", "realesrgan-x4plus-anime"]);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FIXTURE_BYTES = 250 * 1024 * 1024;
const MAX_MODEL_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const SAFE_FIXTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const fail = (message, code = "AI_UPSCALE_BENCHMARK_INVALID") => Object.assign(new Error(message), { code });

function noFollowFlags() {
  return constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
}

async function readJsonFile(path, maxBytes, label) {
  const handle = await open(path, noFollowFlags());
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail(label + " must be a regular file.");
    if (info.size < 2 || info.size > maxBytes) throw fail(label + " is empty or exceeds its size limit.");
    const bytes = await handle.readFile();
    if (bytes.length < 2 || bytes.length > maxBytes) throw fail(label + " changed size or exceeds its size limit.");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw fail(label + " must contain valid UTF-8 JSON.");
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function sha256File(path, label, maxBytes) {
  const handle = await open(path, noFollowFlags());
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw fail(label + " is not a readable regular file within the size limit.");
    const digest = createHash("sha256");
    let byteCount = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      byteCount += chunk.length;
      if (byteCount > maxBytes) throw fail(label + " exceeded the size limit while being read.");
      digest.update(chunk);
    }
    if (byteCount !== info.size) throw fail(label + " changed while being hashed.");
    return digest.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

export function validateUpscaleFixtureManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Array.isArray(manifest.fixtures)) {
    throw fail("Benchmark manifest must contain a fixtures array.");
  }
  if (manifest.fixtures.length !== REQUIRED_UPSCALE_FIXTURE_CATEGORIES.length) {
    throw fail("Benchmark manifest must contain exactly one fixture for each of the five required categories.");
  }
  const ids = new Set();
  const categories = new Set();
  for (const fixture of manifest.fixtures) {
    if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) throw fail("Every benchmark fixture must be an object.");
    if (typeof fixture.fixtureId !== "string" || !SAFE_FIXTURE_ID.test(fixture.fixtureId)) throw fail("Every fixture needs a safe, unique fixtureId.");
    if (ids.has(fixture.fixtureId)) throw fail("Fixture IDs must be unique.");
    ids.add(fixture.fixtureId);
    if (!REQUIRED_UPSCALE_FIXTURE_CATEGORIES.includes(fixture.fixtureCategory)) throw fail("Fixture category is unsupported.");
    if (categories.has(fixture.fixtureCategory)) throw fail("Each required fixture category must appear exactly once.");
    categories.add(fixture.fixtureCategory);
    if (typeof fixture.path !== "string" || !fixture.path.trim() || isAbsolute(fixture.path)) throw fail("Fixture paths must be non-empty relative paths.");
    const normalized = resolve("/", fixture.path);
    if (normalized === "/" || fixture.path.split(/[\\/]/).includes("..")) throw fail("Fixture paths cannot traverse outside the manifest directory.");
    if (!Number.isInteger(fixture.scale) || ![2, 3, 4].includes(fixture.scale)) throw fail("Each fixture scale must be 2, 3 or 4.");
  }
  const missing = REQUIRED_UPSCALE_FIXTURE_CATEGORIES.filter(category => !categories.has(category));
  if (missing.length) throw fail("Missing required fixture categories: " + missing.join(", "));
  return true;
}

async function resolveFixturePath(root, relativePath) {
  const candidate = resolve(root, relativePath);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw fail("Benchmark fixtures must be regular, non-symlink files.");
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  const fromRoot = relative(realRoot, realCandidate);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot)) {
    throw fail("Benchmark fixture path resolves outside the manifest directory.");
  }
  return realCandidate;
}

export async function runUpscaleBenchmark({
  model,
  manifestPath,
  outputDirectory,
  adapter = createRealEsrganAdapter(),
  binaryPath = process.env.REALESRGAN_NCNN_PATH || "",
  modelDirectory = process.env.REALESRGAN_MODEL_DIR || ""
} = {}) {
  if (!ALLOWED_MODELS.has(model)) throw fail("Select an allowlisted Real-ESRGAN model.");
  if (typeof manifestPath !== "string" || !manifestPath.trim()) throw fail("A benchmark manifest path is required.");
  if (typeof outputDirectory !== "string" || !outputDirectory.trim()) throw fail("An output directory is required.");

  const manifestFile = resolve(manifestPath);
  const manifest = await readJsonFile(manifestFile, MAX_MANIFEST_BYTES, "Benchmark manifest");
  validateUpscaleFixtureManifest(manifest);
  const fixtureRoot = dirname(await realpath(manifestFile));
  const fixtures = [];
  for (const fixture of manifest.fixtures) {
    fixtures.push({ ...fixture, inputPath: await resolveFixturePath(fixtureRoot, fixture.path) });
  }

  if (!binaryPath || !modelDirectory) throw fail("Configure the local NCNN executable and model directory before running a benchmark.", "AI_UPSCALE_ENGINE_UNAVAILABLE");
  const modelParam = resolve(modelDirectory, model + ".param");
  const modelBin = resolve(modelDirectory, model + ".bin");
  const [binarySha256, paramSha256, binSha256] = await Promise.all([
    sha256File(resolve(binaryPath), "NCNN executable", MAX_MODEL_ARTIFACT_BYTES),
    sha256File(modelParam, "Model parameter file", MAX_MODEL_ARTIFACT_BYTES),
    sha256File(modelBin, "Model weights file", MAX_MODEL_ARTIFACT_BYTES)
  ]);
  const modelFilesSha256 = createHash("sha256").update(paramSha256 + ":" + binSha256).digest("hex");
  const modelVersion = "sha256:" + modelFilesSha256;

  const readiness = await adapter.probe(model);
  if (!readiness.available || !readiness.executionEnabled) {
    throw fail(readiness.reason || "The selected model is not installed and explicitly enabled.", "AI_UPSCALE_ENGINE_UNAVAILABLE");
  }
  const selfTest = await adapter.selfTest({
    inputPath: fixtures[0].inputPath,
    model,
    scale: fixtures[0].scale,
    tile: 128,
    format: "png"
  });
  if (selfTest?.passed !== true || selfTest?.executionVerified !== true) {
    throw fail("The selected model did not pass its execution self-test.", "AI_UPSCALE_SELF_TEST_FAILED");
  }

  const outputRoot = resolve(outputDirectory);
  await mkdir(outputRoot, { recursive: true });
  const generatedOutputs = [];
  const records = [];
  try {
    for (const fixture of fixtures) {
      const inputSha256 = await sha256File(fixture.inputPath, "Input fixture", MAX_FIXTURE_BYTES);
      const outputPath = join(outputRoot, fixture.fixtureId + ".png");
      const started = performance.now();
      const result = await adapter.execute({
        inputPath: fixture.inputPath,
        outputPath,
        model,
        scale: fixture.scale,
        tile: 128,
        format: "png"
      });
      generatedOutputs.push(outputPath);
      if (result.model !== model ||
          result.outputDimensions?.width !== result.inputDimensions?.width * fixture.scale ||
          result.outputDimensions?.height !== result.inputDimensions?.height * fixture.scale) {
        throw fail("Benchmark output failed model or exact-dimension verification.", "AI_UPSCALE_OUTPUT_DIMENSIONS_MISMATCH");
      }
      const outputSha256 = await sha256File(outputPath, "Upscale output", MAX_FIXTURE_BYTES);
      records.push({
        fixtureId: fixture.fixtureId,
        fixtureCategory: fixture.fixtureCategory,
        model,
        modelVersion,
        binarySha256,
        modelFilesSha256,
        inputSha256,
        outputSha256,
        inputWidth: result.inputDimensions.width,
        inputHeight: result.inputDimensions.height,
        outputWidth: result.outputDimensions.width,
        outputHeight: result.outputDimensions.height,
        scale: fixture.scale,
        durationMs: Math.max(1, Math.round(performance.now() - started)),
        executionStatus: "passed",
        qualityReview: "not_reviewed",
        timestamp: new Date().toISOString()
      });
    }

    const summary = summarizeUpscaleBenchmarks(records);
    if (summary.invalidRecords.length || summary.execution.passed !== fixtures.length) {
      throw fail("The generated benchmark records did not pass structural validation.");
    }
    const reportPath = join(outputRoot, "upscale-benchmark-" + model + "-" + randomUUID() + ".json");
    const report = {
      schemaVersion: 1,
      model,
      modelVersion,
      generatedAt: new Date().toISOString(),
      executionSelfTest: { passed: true, executionVerified: true },
      qualityReviewRequired: true,
      qualityReviewNotice: "Execution and dimension checks do not establish perceptual quality. Every fixture must be reviewed by a human before this report can be used as quality evidence.",
      records
    };
    const reportHandle = await open(reportPath, "wx", 0o600);
    try {
      await reportHandle.writeFile(JSON.stringify(report, null, 2) + "\\n", "utf8");
    } finally {
      await reportHandle.close();
    }
    return { reportPath, records, summary, executionSelfTest: selfTest };
  } catch (error) {
    await Promise.all(generatedOutputs.map(path => rm(path, { force: true }).catch(() => {})));
    throw error;
  }
}
