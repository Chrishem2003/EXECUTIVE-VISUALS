import test from "node:test";
import assert from "node:assert/strict";
import { createUpscaleBatchProcessor } from "../upscale-batch.mjs";

function fakeAdapter({ failIds = [], delay = 0, active = { count: 0, peak: 0 }, calls = [] } = {}) {
  return {
    async execute(options) {
      active.count++;
      active.peak = Math.max(active.peak, active.count);
      calls.push(options);
      try {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (failIds.includes(options.inputPath)) throw Object.assign(new Error("synthetic inference failure"), { code: "AI_UPSCALE_PROCESS_FAILED" });
        return {
          path: options.outputPath,
          sourceSha256: "a".repeat(64),
          outputSha256: "b".repeat(64),
          inputDimensions: { width: 32, height: 24 },
          outputDimensions: { width: 128, height: 96 },
          model: options.model || "realesrgan-x4plus",
          scale: options.scale || 4,
          qualityAssessment: { status: "not_assessed", method: null },
          qualityReviewRequired: true
        };
      } finally {
        active.count--;
      }
    }
  };
}

const items = count => Array.from({ length: count }, (_, index) => ({
  id: "asset-" + (index + 1),
  inputPath: "/workspace/input-" + (index + 1) + ".png",
  outputPath: "/workspace/output-" + (index + 1) + ".png",
  model: "realesrgan-x4plus",
  scale: 4
}));

test("processes a batch through the existing adapter and preserves per-item provenance", async () => {
  const calls = [];
  const processor = createUpscaleBatchProcessor({ adapter: fakeAdapter({ calls }) });
  const result = await processor.process({ items: items(3), concurrency: 2 });
  assert.equal(result.status, "completed");
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.qualityReviewRequired, true);
  assert.equal(calls.length, 3);
  assert.ok(result.results.every(item => /^[a-f0-9]{64}$/.test(item.sourceSha256) && /^[a-f0-9]{64}$/.test(item.outputSha256)));
  assert.ok(result.results.every(item => item.qualityAssessment.status === "not_assessed" && item.qualityReviewRequired));
});

test("enforces the configured concurrency ceiling", async () => {
  const active = { count: 0, peak: 0 };
  const processor = createUpscaleBatchProcessor({ adapter: fakeAdapter({ delay: 8, active }) });
  const result = await processor.process({ items: items(8), concurrency: 3 });
  assert.equal(result.succeeded, 8);
  assert.equal(active.peak, 3);
});

test("isolates item failures and continues processing remaining assets", async () => {
  const badPath = "/workspace/input-2.png";
  const processor = createUpscaleBatchProcessor({ adapter: fakeAdapter({ failIds: [badPath] }) });
  const result = await processor.process({ items: items(3), concurrency: 2 });
  assert.equal(result.status, "partial");
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].code, "AI_UPSCALE_PROCESS_FAILED");
});

test("rejects duplicate outputs and cross-item source overwrites before execution", async () => {
  let calls = 0;
  const processor = createUpscaleBatchProcessor({ adapter: { execute: async () => { calls++; } } });
  const duplicate = items(2);
  duplicate[1].outputPath = duplicate[0].outputPath;
  await assert.rejects(processor.process({ items: duplicate }), /output paths must be unique/);
  const overwrite = items(2);
  overwrite[0].outputPath = overwrite[1].inputPath;
  await assert.rejects(processor.process({ items: overwrite }), /cannot overwrite any input/);
  assert.equal(calls, 0);
});

test("rejects invalid batch limits and duplicate item identities", async () => {
  const processor = createUpscaleBatchProcessor({ adapter: fakeAdapter() });
  await assert.rejects(processor.process({ items: [] }), /between 1 and/);
  await assert.rejects(processor.process({ items: items(2), concurrency: 5 }), /concurrency/);
  const duplicateIds = items(2);
  duplicateIds[1].id = duplicateIds[0].id;
  await assert.rejects(processor.process({ items: duplicateIds }), /safe and unique/);
});

test("cancellation prevents queued items from starting and marks in-flight work", async () => {
  const controller = new AbortController();
  const started = [];
  const adapter = {
    async execute({ inputPath }) {
      started.push(inputPath);
      await new Promise(resolve => setTimeout(resolve, 12));
      if (controller.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "JOB_CANCELLED" });
      return { path: "/unused" };
    }
  };
  const processor = createUpscaleBatchProcessor({ adapter });
  const pending = processor.process({ items: items(5), concurrency: 1, signal: controller.signal });
  setTimeout(() => controller.abort(), 2);
  const result = await pending;
  assert.ok(result.cancelled >= 1);
  assert.ok(started.length < 5);
  assert.equal(result.status, "cancelled");
});

test("batch orchestration keeps visual review mandatory even if an adapter clears the flag", async () => {
  const processor = createUpscaleBatchProcessor({
    adapter: { execute: async () => ({ qualityReviewRequired: false, path: "/workspace/result.png" }) }
  });
  const result = await processor.process({ items: items(1) });
  assert.equal(result.qualityReviewRequired, true);
  assert.equal(result.results[0].qualityReviewRequired, true);
  assert.deepEqual(result.results[0].qualityAssessment, { status: "not_assessed", method: null });
});

test("progress observer errors cannot fail a batch", async () => {
  const processor = createUpscaleBatchProcessor({ adapter: fakeAdapter() });
  const result = await processor.process({ items: items(2), onProgress() { throw new Error("observer failure"); } });
  assert.equal(result.succeeded, 2);
});
