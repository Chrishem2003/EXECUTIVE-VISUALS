import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpscaleBenchmark, validateUpscaleFixtureManifest } from "../upscale-benchmark-runner.mjs";

const categories = ["portrait", "fine_texture", "text", "animation", "low_light_noisy"];
function manifest() {
  return {
    fixtures: categories.map((fixtureCategory, index) => ({
      fixtureId: "fixture-" + fixtureCategory,
      fixtureCategory,
      path: "fixtures/" + fixtureCategory + ".png",
      scale: index % 2 ? 3 : 2
    }))
  };
}
function fakeAdapter({ mismatch = false, observed = {} } = {}) {
  return {
    probe: async () => ({ available: true, executionEnabled: true }),
    selfTest: async ({ tile }) => { observed.selfTestTile = tile; return { passed: true, executionVerified: true }; },
    execute: async ({ inputPath, outputPath, model, scale, tile }) => {
      const [width, height] = (await readFile(inputPath, "utf8")).split("x").map(Number);
      await writeFile(outputPath, Buffer.from("mock image derivative"));
      return {
        model,
        requestedTile: tile,
        tile,
        tileFallbackUsed: false,
        tileAttempts: [tile],
        inputDimensions: { width, height },
        outputDimensions: { width: width * scale, height: height * scale + (mismatch ? 1 : 0) }
      };
    }
  };
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "ev-upscale-runner-"));
  const fixtures = join(root, "fixtures");
  const models = join(root, "models");
  const output = join(root, "output");
  await mkdir(fixtures);
  await mkdir(models);
  await writeFile(join(root, "realesrgan-ncnn-vulkan"), "mock executable");
  for (const model of ["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3", "realesrnet-x4plus"]) {
    await writeFile(join(models, model + ".param"), "mock param");
    await writeFile(join(models, model + ".bin"), "mock weights");
  }
  for (const category of categories) await writeFile(join(fixtures, category + ".png"), "320x240");
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest()));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, manifestPath, output, outputDirectory: output, binaryPath: join(root, "realesrgan-ncnn-vulkan"), modelDirectory: models };
}

test("requires exactly one fixture from every required visual category", () => {
  const valid = manifest();
  assert.equal(validateUpscaleFixtureManifest(valid), true);
  assert.throws(() => validateUpscaleFixtureManifest({ fixtures: valid.fixtures.slice(0, 4) }), /exactly one fixture/);
  assert.throws(() => validateUpscaleFixtureManifest({ fixtures: [...valid.fixtures.slice(0, 4), { ...valid.fixtures[0], fixtureId: "duplicate-category" }] }), /exactly once/);
  assert.throws(() => validateUpscaleFixtureManifest({ fixtures: valid.fixtures.map((item, index) => index === 0 ? { ...item, path: "../outside.png" } : item) }), /traverse outside/);
});

test("supports the documented Real-ESRGAN NCNN general and anime model variants", async t => {
  const env = await setup(t);
  for (const model of ["realesrgan-x4plus-anime", "realesr-animevideov3", "realesrnet-x4plus"]) {
    const result = await runUpscaleBenchmark({ model, ...env, adapter: fakeAdapter() });
    assert.equal(result.records.length, 5);
    assert.ok(result.records.every(record => record.model === model));
  }
});

test("runs local fixtures and writes execution-only evidence that still requires human review", async t => {
  const env = await setup(t);
  const result = await runUpscaleBenchmark({
    model: "realesrgan-x4plus",
    ...env,
    adapter: fakeAdapter()
  });
  assert.equal(result.records.length, 5);
  assert.equal(result.summary.execution.passed, 5);
  assert.equal(result.summary.qualityVerified, false);
  assert.ok(result.records.every(record => record.qualityReview === "not_reviewed"));
  assert.ok(result.records.every(record => record.requestedTile === 128 && record.tile === 128 && record.tileFallbackUsed === false));
  assert.ok(result.records.every(record => JSON.stringify(record.tileAttempts) === "[128]"));
  assert.ok(result.records.every(record => /^[a-f0-9]{64}$/.test(record.inputSha256) && /^[a-f0-9]{64}$/.test(record.outputSha256)));
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.qualityReviewRequired, true);
  assert.equal(report.records.length, 5);
  const outputEntries = await readdir(env.output, { withFileTypes: true });
  const runDirectory = outputEntries.find(entry => entry.isDirectory() && entry.name.startsWith("run-"));
  assert.ok(runDirectory);
  assert.equal((await readdir(join(env.output, runDirectory.name))).filter(name => name.endsWith(".png")).length, 5);
});

test("runs a reproducible benchmark with an operator-selected tile size", async t => {
  const env = await setup(t);
  const observed = {};
  const result = await runUpscaleBenchmark({
    model: "realesrgan-x4plus",
    ...env,
    tile: 256,
    adapter: fakeAdapter({ observed })
  });
  assert.equal(observed.selfTestTile, 256);
  assert.ok(result.records.every(record => record.requestedTile === 256 && record.tile === 256));
  assert.ok(result.records.every(record => record.tileFallbackUsed === false && JSON.stringify(record.tileAttempts) === "[256]"));
});

test("rejects unsupported benchmark tile sizes before model probing", async t => {
  const env = await setup(t);
  let probeCalls = 0;
  await assert.rejects(
    runUpscaleBenchmark({ model: "realesrgan-x4plus", ...env, tile: 24, adapter: { probe: async () => { probeCalls++; } } }),
    /Benchmark tile must be zero/
  );
  assert.equal(probeCalls, 0);
});

test("does not publish a benchmark report when any model output has incorrect dimensions", async t => {
  const env = await setup(t);
  await assert.rejects(
    runUpscaleBenchmark({ model: "realesrgan-x4plus", ...env, adapter: fakeAdapter({ mismatch: true }) }),
    /exact-dimension/
  );
  assert.deepEqual(await readdir(env.output), []);
});

test("rejects symlinked fixture inputs before starting the model", async t => {
  const env = await setup(t);
  const linked = join(env.root, "fixtures", "portrait-link.png");
  await symlink(join(env.root, "fixtures", "portrait.png"), linked);
  const payload = manifest();
  payload.fixtures[0].path = "fixtures/portrait-link.png";
  await writeFile(env.manifestPath, JSON.stringify(payload));
  let probed = false;
  const adapter = { probe: async () => { probed = true; return { available: true, executionEnabled: true }; } };
  await assert.rejects(runUpscaleBenchmark({ model: "realesrgan-x4plus", ...env, adapter }), /non-symlink/);
  assert.equal(probed, false);
});

test("fails closed when the local worker is not explicitly enabled", async t => {
  const env = await setup(t);
  const adapter = {
    probe: async () => ({ available: true, executionEnabled: false, reason: "Worker execution is disabled." }),
    selfTest: async () => { throw new Error("must not run"); }
  };
  await assert.rejects(runUpscaleBenchmark({ model: "realesrgan-x4plus", ...env, adapter }), /Worker execution is disabled/);
});


test("preflights every fixture's size and checksum before probing or self-testing the model", async t => {
  const env = await setup(t);
  const oversizedPath = join(env.root, "fixtures", "low_light_noisy.png");
  await writeFile(oversizedPath, Buffer.alloc(250 * 1024 * 1024 + 1, 1));
  let probeCalls = 0;
  let selfTestCalls = 0;
  let executeCalls = 0;
  const adapter = {
    probe: async () => { probeCalls++; return { available: true, executionEnabled: true }; },
    selfTest: async () => { selfTestCalls++; return { passed: true, executionVerified: true }; },
    execute: async () => { executeCalls++; throw new Error("must not execute"); }
  };
  await assert.rejects(runUpscaleBenchmark({ model: "realesrgan-x4plus", ...env, adapter }), /size limit/);
  assert.equal(probeCalls, 0);
  assert.equal(selfTestCalls, 0);
  assert.equal(executeCalls, 0);
  await assert.rejects(readdir(env.output), { code: "ENOENT" });
});

test("rejects a missing later fixture before the model self-test starts", async t => {
  const env = await setup(t);
  await rm(join(env.root, "fixtures", "low_light_noisy.png"));
  let probeCalls = 0;
  let selfTestCalls = 0;
  const adapter = {
    probe: async () => { probeCalls++; return { available: true, executionEnabled: true }; },
    selfTest: async () => { selfTestCalls++; return { passed: true, executionVerified: true }; }
  };
  await assert.rejects(runUpscaleBenchmark({ model: "realesrgan-x4plus", ...env, adapter }), /ENOENT/);
  assert.equal(probeCalls, 0);
  assert.equal(selfTestCalls, 0);
});
