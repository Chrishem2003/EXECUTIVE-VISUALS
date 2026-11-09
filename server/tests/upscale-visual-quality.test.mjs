import test from "node:test";
import assert from "node:assert/strict";
import { analyzeUpscalePixels, createUpscaleVisualQualityAssessor } from "../upscale-visual-quality.mjs";

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
