import test from "node:test";
import assert from "node:assert/strict";
import { runCloudVideoWorkerCycle } from "../cloud-video-worker.mjs";

test("provider cancellation without verified refund is quarantined and keeps its budget reservation", async () => {
  const job = {
    id: "223e4567-e89b-42d3-a456-426614174000",
    owner_id: "123e4567-e89b-42d3-a456-426614174000",
    job_type: "video.generate",
    status: "processing"
  };
  const calls = [];
  const queue = {
    async claim(workerId, leaseSeconds, jobTypes) {
      calls.push(["claim", workerId, leaseSeconds, jobTypes]);
      return job;
    },
    async renew() { return true; }
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
    reasonCode: "VIDEO_PROVIDER_CANCELLATION_COST_UNRESOLVED"
  }]);
  assert.equal(calls.some(call => call[0] === "finish"), false,
    "must not mark the job cancelled or release its reservation without refund evidence");
});
