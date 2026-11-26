import test from "node:test";
import assert from "node:assert/strict";
import { runCloudVideoWorkerCycle } from "../cloud-video-worker.mjs";

test("provider cancellation without verified refund is quarantined and keeps its budget reservation", async () => {
  const job = {
    id: "223e4567-e89b-42d3-a456-426614174000",
    owner_id: "123e4567-e89b-42d3-a456-426614174000",
    job_type: "video.generate",
    status: "processing", lease_token: "923e4567-e89b-42d3-a456-426614174000"
  };
  const calls = [];
  const queue = {
    async claim(workerId, leaseSeconds, jobTypes) {
      calls.push(["claim", workerId, leaseSeconds, jobTypes]);
      return job;
    },
    async renew() { return true; },
    async assertLease() { return true; }
  };
  const enqueue = {
    async finish(args) { calls.push(["finish", args]); return true; },
    async defer(args) { calls.push(["defer", args]); return true; },
    async quarantine(args) { calls.push(["quarantine", args]); return true; },
    async recoverExpiredVideo() { return 0; }
  };
  const result = await runCloudVideoWorkerCycle({
    queue, enqueue, workerId: "video-worker",
    leaseSeconds: 15, heartbeatIntervalMs: 1000,
    execute: async () => {
      throw Object.assign(new Error("Provider cancellation billing is not verified."), {
        code: "VIDEO_PROVIDER_CANCELLATION_COST_UNRESOLVED"
      });
    }
  });
  assert.equal(result.finished, true);
  assert.equal(result.status, "needs_input");
  assert.equal(result.reason, "VIDEO_PROVIDER_CANCELLATION_COST_UNRESOLVED");
  assert.deepEqual(calls.filter(call => call[0] === "quarantine").map(call => call[1]), [{
    jobId: job.id,
    workerId: "video-worker",
    leaseToken: "923e4567-e89b-42d3-a456-426614174000",
    reasonCode: "VIDEO_PROVIDER_CANCELLATION_COST_UNRESOLVED"
  }]);
  assert.equal(calls.some(call => call[0] === "finish"), false,
    "must not mark the job cancelled or release its reservation without refund evidence");
});

test("successful cloud video output persists authoritative actual cost and currency for client visibility", async () => {
  const job = {
    id: "323e4567-e89b-42d3-a456-426614174000",
    owner_id: "123e4567-e89b-42d3-a456-426614174000",
    job_type: "video.generate",
    status: "processing", lease_token: "923e4567-e89b-42d3-a456-426614174000"
  };
  const calls = [];
  const queue = {
    async claim() { return job; },
    async renew() { return true; },
    async assertLease() { return true; }
  };
  const enqueue = {
    async finish(args) { calls.push(args); return true; },
    async defer() { return true; },
    async quarantine() { return true; },
    async recoverExpiredVideo() { return 0; }
  };
  const result = await runCloudVideoWorkerCycle({
    queue, enqueue, workerId: "video-worker",
    leaseSeconds: 15, heartbeatIntervalMs: 1000,
    execute: async () => ({
      provider: "runway", model: "model-router", providerTaskId: "task-123",
      assetIds: ["823e4567-e89b-42d3-a456-426614174000"],
      usage: { seconds: 5 }, actualAmount: 0.72, currency: "USD",
      costEvidenceReference: "runway:model-router:task-123:task-cost-credits:72"
    })
  });
  assert.equal(result.finished, true);
  assert.equal(result.status, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actualAmount, 0.72);
  assert.equal(calls[0].output.actualAmount, 0.72);
  assert.equal(calls[0].output.currency, "USD");
  assert.equal(calls[0].output.costEvidenceReference, "runway:model-router:task-123:task-cost-credits:72");
});


test("owner cancellation is polled against the exact lease and prevents an unsubmitted paid generation", async () => {
  const job = {
    id: "423e4567-e89b-42d3-a456-426614174000",
    owner_id: "123e4567-e89b-42d3-a456-426614174000",
    job_type: "video.generate",
    status: "processing",
    lease_token: "923e4567-e89b-42d3-a456-426614174000"
  };
  const calls = [];
  const queue = {
    async claim() { return job; },
    async renew() { return true; },
    async assertLease() { return true; },
    async cancellationRequested(...args) { calls.push(["cancellationRequested", ...args]); return true; }
  };
  const enqueue = {
    async finish(args) { calls.push(["finish", args]); return true; },
    async defer() { throw new Error("must not defer"); },
    async quarantine() { throw new Error("must not quarantine"); },
    async recoverExpiredVideo() { return 0; }
  };
  const result = await runCloudVideoWorkerCycle({
    queue, enqueue, workerId: "video-worker",
    leaseSeconds: 15, heartbeatIntervalMs: 1000,
    execute: async ({ isCancellationRequested }) => {
      assert.equal(await isCancellationRequested(), true);
      throw Object.assign(new Error("cancelled before provider submission"), {
        code: "VIDEO_JOB_CANCELLED_BEFORE_SUBMISSION"
      });
    }
  });
  assert.equal(result.finished, true);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls.find(call => call[0] === "cancellationRequested"), [
    "cancellationRequested", job.id, "video-worker", job.lease_token
  ]);
  assert.equal(calls.find(call => call[0] === "finish")[1].status, "cancelled");
});
