import test from "node:test";
import assert from "node:assert/strict";
import { createCloudMediaWorker } from "../cloud-media-worker.mjs";

test("cloud media worker composes the leased queue and injected media executor", async () => {
  const calls = [];
  let claimedTypes;
  const queue = {
    async claim(workerId, leaseSeconds, jobTypes) { calls.push("claim"); claimedTypes = jobTypes; return null; },
    async renew() { return true; },
    async finish() { return true; },
    async recover(...args) { calls.push("recover:" + args[0]); calls.push(args[1]); return 2; }
  };
  const worker = createCloudMediaWorker({
    workerId: "media-worker-a",
    queue,
    assetService: { assets: {} },
    mediaIO: {},
    execute: async () => ({ ok: true })
  });
  assert.deepEqual(await worker.runCycle({ onEvent: event => calls.push(event.type) }), { claimed: false });
  assert.deepEqual(claimedTypes, ["media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean", "media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.ai-upscale", "media.transcode", "media.proxy", "media.waveform"]);
  assert.equal(await worker.recoverExpired(25), 2);
  assert.deepEqual(calls, ["claim", "recover:25", ["media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean", "media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.ai-upscale", "media.transcode", "media.proxy", "media.waveform"]]);
});

test("cloud media worker requires an explicit stable worker identity", () => {
  assert.throws(
    () => createCloudMediaWorker({ workerId: " " }),
    /worker ID/
  );
});

test("media worker forwards lease-fenced progress and bounded retry to the shared queue", async () => {
  const calls = [];
  const queue = {
    async claim() { return { id: "job-progress", status: "processing", lease_owner: "media-worker-b", lease_expires_at: "2026-11-03T12:00:00Z", job_type: "media.thumbnail" }; },
    async renew() { return true; },
    async finish() { calls.push("finish"); return true; },
    async reportProgress(id, workerId, progress) { calls.push(["progress", id, workerId, progress]); return true; },
    async retry(id, workerId, error) { calls.push(["retry", id, workerId, error.code]); return { accepted: true, status: "queued", retryable: true, delaySeconds: 2, attempt: 1, maxAttempts: 3 }; },
    async recover() { return 0; }
  };
  const worker = createCloudMediaWorker({
    workerId: "media-worker-b", queue, assetService: { assets: {} }, mediaIO: {},
    execute: async ({ onProgress }) => { onProgress(42); throw Object.assign(new Error("temporary storage outage"), { code: "CLOUD_STORAGE_TIMEOUT" }); }
  });
  const result = await worker.runCycle();
  assert.equal(result.status, "queued");
  assert.equal(result.retryScheduled, true);
  assert.deepEqual(calls[0], ["progress", "job-progress", "media-worker-b", 42]);
  assert.deepEqual(calls[1], ["retry", "job-progress", "media-worker-b", "CLOUD_STORAGE_TIMEOUT"]);
  assert.equal(calls.includes("finish"), false);
});
