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
function fakeAdapter({ mismatch = false } = {}) {
  return {
    probe: async () => ({ available: true, executionEnabled: true }),
    selfTest: async () => ({ passed: true, executionVerified: true }),
    execute: async ({ inputPath, outputPath, model, scale }) => {
      const [width, height] = (await readFile(inputPath, "utf8")).split("x").map(Number);
      await writeFile(outputPath, Buffer.from("mock image derivative"));
      return {
        model,
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
  await writeFile(join(models, "realesrgan-x4plus.param"), "mock param");
  await writeFile(join(models, "realesrgan-x4plus.bin"), "mock weights");
  for (const category of categories) await writeFile(join(fixtures, category + ".png"), "320x240");
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest()));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, manifestPath, output, binaryPath: join(root, "realesrgan-ncnn-vulkan"), modelDirectory: models };
}

test("requires exactly one fixture from every required visual category", () => {
  const valid = manifest();
  assert.equal(validateUpscaleFixtureManifest(valid), true);
  assert.throws(() => validateUpscaleFixtureManifest({ fixtures: valid.fixtures.slice(0, 4) }), /exactly one fixture/);
  assert.throws(() => validateUpscaleFixtureManifest({ fixtures: [...valid.fixtures.slice(0, 4), { ...valid.fixtures[0], fixtureId: "duplicate-category" }] }), /exactly once/);
  assert.throws(() => validateUpscaleFixtureManifest({ fixtures: valid.fixtures.map((item, index) => index === 0 ? { ...item, path: "../outside.png" } : item) }), /traverse outside/);
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
  assert.ok(result.records.every(record => /^[a-f0-9]{64}$/.test(record.inputSha256) && /^[a-f0-9]{64}$/.test(record.outputSha256)));
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.qualityReviewRequired, true);
  assert.equal(report.records.length, 5);
  assert.equal((await readdir(env.output)).filter(name => name.endsWith(".png")).length, 5);
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
