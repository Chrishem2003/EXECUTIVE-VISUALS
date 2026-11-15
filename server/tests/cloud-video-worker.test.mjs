import test from "node:test";
import assert from "node:assert/strict";
import { runCloudVideoWorkerCycle } from "../cloud-video-worker.mjs";

function fixture(retryAfterSeconds) {
  const calls = [];
  const job = {
    id: "job-1",
    lease_token: "923e4567-e89b-42d3-a456-426614174000"
  };
  const queue = {
    async claim() { return job; },
    async renew() { return true; },
    async assertLease() { return true; }
  };
  const enqueue = {
    async finish() { return true; },
    async defer(args) { calls.push(args); return true; },
    async quarantine() { return true; },
    async recoverExpiredVideo() { return 0; }
  };
  const execute = async () => {
    const error = Object.assign(new Error("provider is not ready"), {
      code: "VIDEO_PROVIDER_POLL_DEFERRED"
    });
    if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
    throw error;
  };
  return { calls, queue, enqueue, execute };
}

test("cloud video worker honors a bounded provider retry-after delay", async () => {
  const f = fixture(120);
  const result = await runCloudVideoWorkerCycle({
    ...f, workerId: "worker-1", heartbeatIntervalMs: 1000, execute: f.execute
  });
  assert.equal(result.status, "queued");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].delaySeconds, 120);
});

test("cloud video worker falls back to its safe default for invalid retry-after hints", async () => {
  const f = fixture(2);
  await runCloudVideoWorkerCycle({
    ...f, workerId: "worker-1", heartbeatIntervalMs: 1000, execute: f.execute
  });
  assert.equal(f.calls[0].delaySeconds, 30);
});

test("cloud video worker preserves the default delay when no provider hint is supplied", async () => {
  const f = fixture(undefined);
  await runCloudVideoWorkerCycle({
    ...f, workerId: "worker-1", heartbeatIntervalMs: 1000, execute: f.execute
  });
  assert.equal(f.calls[0].delaySeconds, 30);
});
