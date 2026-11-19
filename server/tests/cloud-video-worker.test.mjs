import test from "node:test";
import assert from "node:assert/strict";
import { runCloudVideoWorkerCycle } from "../cloud-video-worker.mjs";

function fixture(retryAfterSeconds, code = "VIDEO_PROVIDER_POLL_DEFERRED") {
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
    async quarantine(args) { calls.push({ type: "quarantine", ...args }); return true; },
    async recoverExpiredVideo() { return 0; }
  };
  const execute = async () => {
    const error = Object.assign(new Error("provider is not ready"), {
      code
    });
    if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
    throw error;
  };
  return { calls, queue, enqueue, execute };
}

test("cloud video worker quarantines potentially billable failed Veo tasks", async () => {
  const f = fixture(undefined, "VIDEO_PROVIDER_FAILURE_COST_UNRESOLVED");
  const result = await runCloudVideoWorkerCycle({
    ...f, workerId: "worker-1", heartbeatIntervalMs: 1000, execute: f.execute
  });
  assert.equal(result.status, "needs_input");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].type, "quarantine");
  assert.equal(f.calls[0].reasonCode, "VIDEO_PROVIDER_FAILURE_COST_UNRESOLVED");
});

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

test("cloud video worker preserves a durable blocked outcome from an accounting-aware backend", async () => {
  const f = fixture(undefined, "CLOUD_VIDEO_JOB_FAILED");
  f.enqueue.finish = async () => ({ finished: true, status: "blocked" });
  const events = [];
  const result = await runCloudVideoWorkerCycle({
    ...f, workerId: "worker-1", heartbeatIntervalMs: 1000,
    execute: f.execute, onEvent: event => events.push(event)
  });
  assert.equal(result.finished, true);
  assert.equal(result.status, "blocked");
  assert.equal(events.at(-1).type, "video.job.blocked");
});

test("cloud video worker preserves blocked status from backend-specific quarantine", async () => {
  const f = fixture(undefined, "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED");
  f.enqueue.quarantine = async () => ({ finished: true, status: "blocked" });
  const events = [];
  const result = await runCloudVideoWorkerCycle({
    ...f, workerId: "worker-1", heartbeatIntervalMs: 1000,
    execute: f.execute, onEvent: event => events.push(event)
  });
  assert.equal(result.finished, true);
  assert.equal(result.status, "blocked");
  assert.equal(events.at(-1).type, "video.job.blocked");
});
