import test from "node:test";
import assert from "node:assert/strict";
import { createCloudMediaWorker } from "../cloud-media-worker.mjs";

test("cloud media worker composes the leased queue and injected media executor", async () => {
  const calls = [];
  let claimedTypes;
  const queue = {
    async claim(workerId, leaseSeconds, jobTypes) { calls.push("claim"); claimedTypes = jobTypes; return null; },
    async renew() { return true; },
    async assertLease() { return true; },
    async finish() { return true; },
    async recover(limit) { calls.push("recover:" + limit); return 2; }
  };
  const worker = createCloudMediaWorker({
    workerId: "media-worker-a",
    queue,
    assetService: { assets: {} },
    mediaIO: {},
    execute: async () => ({ ok: true })
  });
  assert.deepEqual(await worker.runCycle({ onEvent: event => calls.push(event.type) }), { claimed: false });
  assert.deepEqual(claimedTypes, ["media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean", "media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.ai-upscale", "media.transcode", "media.proxy"]);
  assert.equal(await worker.recoverExpired(25), 2);
  assert.deepEqual(calls, ["claim", "recover:25"]);
});

test("cloud media worker requires an explicit stable worker identity", () => {
  assert.throws(
    () => createCloudMediaWorker({ workerId: " " }),
    /worker ID/
  );
});
