import test from "node:test";
import assert from "node:assert/strict";
import { analyzeUpscalePixels, createUpscaleVisualQualityAssessor } from "../upscale-visual-quality.mjs";
import { createLpipsPerceptualAssessor } from "../lpips-perceptual-assessor.mjs";

function solid(width, height, value = 100) {
  const rgb = Buffer.alloc(width * height * 3);
  rgb.fill(value);
  return rgb;
}

test("reports deterministic clean result for a uniform image", () => {
  const report = analyzeUpscalePixels({ rgb: solid(512, 512), width: 512, height: 512, tileSize: 256 });
  assert.equal(report.seamAnalysis.boundariesChecked, 2);
  assert.equal(report.seamAnalysis.flaggedBoundaries, 0);
  assert.equal(report.status, "no_seam_anomaly_detected");
  assert.equal(report.method, "pixel-gradient-seam-analysis");
  assert.equal(report.algorithmVersion, "1.0.0");
});

test("detects strong artificial vertical and horizontal tile-boundary discontinuities", () => {
  const rgb = solid(512, 512, 0);
  for (let i = 0; i < 512; i++) {
    let offset = (i * 512 + 256) * 3;
    rgb.fill(255, offset, offset + 3);
    offset = (256 * 512 + i) * 3;
    rgb.fill(255, offset, offset + 3);
  }
  const report = analyzeUpscalePixels({ rgb, width: 512, height: 512, tileSize: 256 });
  assert.equal(report.seamAnalysis.flaggedBoundaries, 2);
  assert.equal(report.status, "needs_review");
});

test("computes paired global SSIM and PSNR for identical reference pixels", () => {
  const pixels = solid(64, 64, 120);
  const report = analyzeUpscalePixels({ rgb: pixels, width: 64, height: 64, referenceRgb: pixels, referenceWidth: 64, referenceHeight: 64 });
  assert.equal(report.referenceMetrics.psnrDb, null);
  assert.equal(report.referenceMetrics.identical, true);
  assert.equal(report.referenceMetrics.ssimGlobal, 1);
  assert.equal(report.referenceMetrics.lpips, null);
});

test("rejects reference dimensions that do not align with candidate pixels", () => {
  assert.throws(() => analyzeUpscalePixels({
    rgb: solid(64, 64), width: 64, height: 64, referenceRgb: solid(32, 32), referenceWidth: 32, referenceHeight: 32
  }), /identical dimensions/);
});

test("rejects malformed pixel buffers and excessive image dimensions", () => {
  assert.throws(() => analyzeUpscalePixels({ rgb: Buffer.alloc(2), width: 64, height: 64 }), /byte length/);
  assert.throws(() => analyzeUpscalePixels({ rgb: Buffer.alloc(3), width: 50000, height: 50000 }), /pixel budget/);
  assert.throws(() => analyzeUpscalePixels({ rgb: solid(64, 64), width: 64, height: 64, tileSize: 4 }), /Tile size/);
});

test("assessor decodes candidate and optional reference through an injected bounded decoder", async () => {
  const pixels = solid(64, 64, 80);
  const paths = [];
  const assessor = createUpscaleVisualQualityAssessor({
    decoder: { async decode(path) { paths.push(path); return { rgb: pixels, width: 64, height: 64 }; } }
  });
  const report = await assessor.assess({ candidatePath: "/tmp/candidate.png", referencePath: "/tmp/reference.png" });
  assert.deepEqual(paths, ["/tmp/candidate.png", "/tmp/reference.png"]);
  assert.equal(report.referenceMetrics.identical, true);
});

test("reports paired LPIPS only when an optional assessor and aligned reference are supplied", async () => {
  const pixels = solid(64, 64, 80);
  const calls = [];
  const assessor = createUpscaleVisualQualityAssessor({
    decoder: { async decode(path) { calls.push(path); return { rgb: pixels, width: 64, height: 64 }; } },
    lpipsAssessor: { async assess(input) { return { version: "0.1", network: "alex", device: "cpu", distance: 0.125, ...input }; } }
  });
  const report = await assessor.assess({ candidatePath: "/tmp/candidate.png", referencePath: "/tmp/reference.png" });
  assert.equal(report.perceptualAssessment.status, "completed");
  assert.equal(report.perceptualAssessment.method, "LPIPS");
  assert.equal(report.perceptualAssessment.distance, 0.125);
  assert.equal(report.referenceMetrics.lpips, 0.125);
  assert.equal(report.referenceMetrics.lpipsNetwork, "alex");
  assert.deepEqual(calls, ["/tmp/candidate.png", "/tmp/reference.png"]);
});

test("keeps LPIPS explicitly not-run without a paired reference", async () => {
  const pixels = solid(64, 64, 80);
  const assessor = createUpscaleVisualQualityAssessor({
    decoder: { async decode() { return { rgb: pixels, width: 64, height: 64 }; } },
    lpipsAssessor: { async assess() { throw new Error("must not run"); } }
  });
  const report = await assessor.assess({ candidatePath: "/tmp/candidate.png" });
  assert.equal(report.perceptualAssessment.status, "not_run");
  assert.equal(report.perceptualAssessment.reason, "paired_reference_and_configured_assessor_required");
});

test("records LPIPS unavailability without falsely approving perceptual quality", async () => {
  const pixels = solid(64, 64, 80);
  const assessor = createUpscaleVisualQualityAssessor({
    decoder: { async decode() { return { rgb: pixels, width: 64, height: 64 }; } },
    lpipsAssessor: { async assess() { throw Object.assign(new Error("weights missing"), { code: "AI_UPSCALE_LPIPS_UNAVAILABLE" }); } }
  });
  const report = await assessor.assess({ candidatePath: "/tmp/candidate.png", referencePath: "/tmp/reference.png" });
  assert.equal(report.perceptualAssessment.status, "unavailable");
  assert.equal(report.perceptualAssessment.code, "AI_UPSCALE_LPIPS_UNAVAILABLE");
  assert.equal(report.referenceMetrics.lpips, null);
});

test("LPIPS adapter validates worker output and enforces offline paired-image execution", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const root = await mkdtemp(join(tmpdir(), "ev-lpips-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidatePath = join(root, "candidate.png");
  const referencePath = join(root, "reference.png");
  await writeFile(candidatePath, "candidate");
  await writeFile(referencePath, "reference");
  const observed = {};
  const fakeSpawn = (binary, args, options) => {
    observed.binary = binary;
    observed.args = args;
    observed.options = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({
        ok: true, metric: "LPIPS", version: "0.1", network: "alex",
        device: "cpu", distance: 0.2, width: 64, height: 64,
        modelDownloadsAllowed: false
      }));
      child.emit("close", 0);
    });
    return child;
  };
  const assessor = createLpipsPerceptualAssessor({ pythonPath: "python3", spawnProcess: fakeSpawn });
  const result = await assessor.assess({ candidatePath, referencePath });
  assert.equal(result.distance, 0.2);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.env.HF_HUB_OFFLINE, "1");
  assert.ok(observed.args.includes("--candidate"));
  assert.ok(observed.args.includes("--reference"));
});

test("LPIPS adapter rejects missing references before launching Python", async () => {
  let calls = 0;
  const assessor = createLpipsPerceptualAssessor({ spawnProcess() { calls++; } });
  await assert.rejects(assessor.assess({ candidatePath: "/tmp/candidate.png" }), error => error.code === "AI_UPSCALE_LPIPS_REFERENCE_REQUIRED");
  assert.equal(calls, 0);
});

test("LPIPS adapter rejects malformed or download-enabled worker responses", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const root = await mkdtemp(join(tmpdir(), "ev-lpips-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidatePath = join(root, "candidate.png"), referencePath = join(root, "reference.png");
  await writeFile(candidatePath, "candidate"); await writeFile(referencePath, "reference");
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({
        ok: true, metric: "LPIPS", version: "0.1", network: "alex",
        device: "cpu", distance: 0.2, width: 64, height: 64,
        modelDownloadsAllowed: true
      }));
      child.emit("close", 0);
    });
    return child;
  };
  const assessor = createLpipsPerceptualAssessor({ spawnProcess: fakeSpawn });
  await assert.rejects(assessor.assess({ candidatePath, referencePath }), error => error.code === "AI_UPSCALE_LPIPS_PROTOCOL");
});

test("LPIPS adapter rejects unexpected device receipts", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const root = await mkdtemp(join(tmpdir(), "ev-lpips-device-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidatePath = join(root, "candidate.png"), referencePath = join(root, "reference.png");
  await writeFile(candidatePath, "candidate"); await writeFile(referencePath, "reference");
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({
        ok: true, metric: "LPIPS", version: "0.1", network: "alex",
        device: "remote-gpu", distance: 0.2, width: 64, height: 64,
        modelDownloadsAllowed: false
      }));
      child.emit("close", 0);
    });
    return child;
  };
  const assessor = createLpipsPerceptualAssessor({ spawnProcess: fakeSpawn });
  await assert.rejects(assessor.assess({ candidatePath, referencePath }), error => error.code === "AI_UPSCALE_LPIPS_PROTOCOL");
});
