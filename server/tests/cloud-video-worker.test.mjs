import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoWorker, runCloudVideoWorkerCycle } from "../cloud-video-worker.mjs";

const job = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  owner_id: "223e4567-e89b-42d3-a456-426614174000",
  job_type: "video.generate"
};
function fixture({ execute = async () => ({
  provider: "runway", model: "gen4.5", providerTaskId: "runway-task",
  assetIds: ["323e4567-e89b-42d3-a456-426614174000"],
  usage: { outputCount: 1 }, actualAmount: 0.5, currency: "USD",
  costEvidenceReference: "invoice:1"
}) } = {}) {
  const calls = [];
  const queue = {
    async claim(workerId, lease, types) { calls.push(["claim", workerId, lease, types]); return job; },
    async renew(id, workerId, lease) { calls.push(["renew", id, workerId, lease]); return true; }
  };
  const enqueue = {
    async finish(value) { calls.push(["finish", value]); return true; },
    async defer(value) { calls.push(["defer", value]); return true; },
    async quarantine(value) { calls.push(["quarantine", value]); return true; },
    async recoverExpiredVideo(limit) { calls.push(["recoverExpiredVideo", limit]); return 0; }
  };
  return { calls, queue, enqueue, execute };
}

test("cloud video worker claims only video jobs and atomically finalizes successful generation", async () => {
  const f = fixture();
  const result = await runCloudVideoWorkerCycle({ ...f, workerId: "video-worker-1" });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(f.calls[0], ["claim", "video-worker-1", 90, ["video.generate"]]);
  const finalizer = f.calls.find(call => call[0] === "finish")[1];
  assert.equal(finalizer.status, "succeeded");
  assert.equal(finalizer.actualAmount, 0.5);
  assert.equal(finalizer.output.assetIds.length, 1);
  assert.equal(finalizer.output.actualAmount, undefined);
});

test("cloud video worker defers active provider polling without releasing budget", async () => {
  const f = fixture({ execute: async () => { throw Object.assign(new Error("poll later"), { code: "VIDEO_PROVIDER_POLL_DEFERRED" }); } });
  const result = await runCloudVideoWorkerCycle({ ...f, workerId: "video-worker-1", deferSeconds: 60 });
  assert.equal(result.status, "queued");
  assert.equal(f.calls.some(call => call[0] === "defer"), true);
  assert.equal(f.calls.some(call => call[0] === "finish"), false);
  assert.equal(f.calls.some(call => call[0] === "quarantine"), false);
});

test("cloud video worker quarantines ambiguous submissions and preserves reservations", async () => {
  const f = fixture({ execute: async () => { throw Object.assign(new Error("ambiguous"), { code: "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION" }); } });
  const result = await runCloudVideoWorkerCycle({ ...f, workerId: "video-worker-1" });
  assert.equal(result.status, "needs_input");
  assert.equal(f.calls.some(call => call[0] === "quarantine"), true);
  assert.equal(f.calls.some(call => call[0] === "finish"), false);
});

test("cloud video worker quarantines unverified costs and failed private ingestion", async () => {
  for (const code of ["VIDEO_BUDGET_COST_UNRESOLVED", "VIDEO_OUTPUT_INGESTION_REQUIRES_REVIEW"]) {
    const f = fixture({ execute: async () => { throw Object.assign(new Error("review required"), { code }); } });
    const result = await runCloudVideoWorkerCycle({ ...f, workerId: "video-worker-1" });
    assert.equal(result.status, "needs_input");
    assert.equal(f.calls.some(call => call[0] === "quarantine"), true);
    assert.equal(f.calls.some(call => call[0] === "finish"), false);
  }
});

test("confirmed provider terminal failure uses the atomic finalizer", async () => {
  const f = fixture({ execute: async () => { throw Object.assign(new Error("provider failed"), { code: "VIDEO_PROVIDER_FAILED" }); } });
  const result = await runCloudVideoWorkerCycle({ ...f, workerId: "video-worker-1" });
  assert.equal(result.status, "failed");
  const finalizer = f.calls.find(call => call[0] === "finish")[1];
  assert.equal(finalizer.status, "failed");
  assert.equal(finalizer.actualAmount, undefined);
});

test("cloud video worker validates recovery and finalizer dependencies", async () => {
  const f = fixture();
  await assert.rejects(runCloudVideoWorkerCycle({ ...f, workerId: "" }), /worker ID/);
  await assert.rejects(runCloudVideoWorkerCycle({ ...f, enqueue: {}, workerId: "worker" }), /atomic enqueue/);
});


test("integrated cloud video worker completes submit, poll, cost verification, private ingestion and atomic finalization", async () => {
  const calls = [];
  const providerTaskId = "323e4567-e89b-42d3-a456-426614174000";
  const assetId = "423e4567-e89b-42d3-a456-426614174000";
  const requestHash = "a".repeat(64);
  const leasedJob = {
    ...job,
    input: { provider: "runway", model: "gen4.5", requestHash, prompt: "Integration test" },
    estimated_cost: { amount: 2, currency: "USD" }
  };
  let submissionState = "prepared";
  const queue = {
    async claim(workerId, leaseSeconds, types) {
      calls.push(["claim", workerId, leaseSeconds, types]);
      return leasedJob;
    },
    async renew() { return true; }
  };
  const ledger = {
    async prepare(value) {
      calls.push(["prepare", value.jobId, value.ownerId]);
      return { job_id: job.id, owner_id: job.owner_id, state: submissionState, provider_task_id: null };
    },
    async begin(id, workerId) { calls.push(["begin", id, workerId]); return true; },
    async record(id, workerId, taskId) {
      calls.push(["record", id, workerId, taskId]);
      submissionState = "submitted";
      return true;
    },
    async markUnknown(id, workerId, reason) {
      calls.push(["unknown", id, workerId, reason]);
      submissionState = "unknown";
      return true;
    }
  };
  const adapter = {
    provider: "runway",
    model: "gen4.5",
    async submit(input, context) {
      calls.push(["submit", input.requestHash, context.job.id]);
      return { taskId: providerTaskId, status: "queued" };
    },
    async getStatus(taskId, context) {
      calls.push(["poll", taskId, context.job.id, context.workerId]);
      return { status: "succeeded", taskId, outputUrls: ["https://cdn.example.test/video.mp4"] };
    },
    async resolveActualCost(value) {
      calls.push(["cost", value.providerTaskId]);
      return { amount: 0.75, currency: "USD", evidenceReference: "test:verified-billing-event" };
    },
    async ingestOutputs(value) {
      calls.push(["ingest", value.providerTaskId]);
      return { assetIds: [assetId], usage: { outputCount: 1 } };
    }
  };
  const finalized = [];
  const enqueue = {
    async finish(value) { finalized.push(value); calls.push(["finish", value.status, value.actualAmount]); return true; },
    async defer(value) { calls.push(["defer", value.reasonCode]); return true; },
    async quarantine(value) { calls.push(["quarantine", value.reasonCode]); return true; },
    async recoverExpiredVideo() { return 0; }
  };
  const worker = createCloudVideoWorker({
    workerId: "integration-video-worker",
    queue, enqueue, ledger, adapter, deferSeconds: 30
  });
  const result = await worker.runCycle({ leaseSeconds: 90, heartbeatIntervalMs: 60000 });
  assert.equal(result.status, "succeeded");
  assert.equal(result.finished, true);
  assert.deepEqual(calls.map(call => call[0]), [
    "claim", "prepare", "begin", "submit", "record", "poll", "cost", "ingest", "finish"
  ]);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].status, "succeeded");
  assert.equal(finalized[0].actualAmount, 0.75);
  assert.deepEqual(finalized[0].output.assetIds, [assetId]);
  assert.equal(finalized[0].output.providerTaskId, providerTaskId);
});


test("integrated worker quarantines ambiguous submissions, unverified cost and failed cleanup without settlement", async () => {
  async function scenario(kind) {
    const calls = [];
    const jobId = job.id;
    const providerTaskId = "523e4567-e89b-42d3-a456-426614174000";
    const assetId = "623e4567-e89b-42d3-a456-426614174000";
    const leasedJob = {
      ...job,
      input: { provider: "runway", model: "gen4.5", requestHash: "b".repeat(64), prompt: "Failure-path test" },
      estimated_cost: { amount: 2, currency: "USD" }
    };
    let ledgerState = "prepared";
    const queue = {
      async claim(workerId, leaseSeconds, types) {
        calls.push(["claim", workerId, types]);
        return leasedJob;
      },
      async renew() { return true; }
    };
    const ledger = {
      async prepare() {
        calls.push(["prepare", ledgerState]);
        return { job_id: jobId, owner_id: job.owner_id, state: ledgerState, provider_task_id: ledgerState === "submitted" ? providerTaskId : null };
      },
      async begin() { calls.push(["begin"]); return ledgerState === "prepared"; },
      async record(_id, _worker, taskId) {
        calls.push(["record", taskId]);
        ledgerState = "submitted";
        return true;
      },
      async markUnknown() {
        calls.push(["markUnknown"]);
        ledgerState = "unknown";
        return true;
      }
    };
    const adapter = {
      provider: "runway",
      model: "gen4.5",
      async submit() {
        calls.push(["submit"]);
        if (kind === "ambiguous") throw new Error("provider response timed out");
        return { taskId: providerTaskId, status: "queued" };
      },
      async getStatus(taskId) {
        calls.push(["poll", taskId]);
        return { status: "succeeded", taskId, outputUrls: ["https://cdn.example.test/video.mp4"] };
      },
      async resolveActualCost() {
        calls.push(["resolveCost"]);
        return { amount: kind === "over-budget" ? 2.01 : 0.75, currency: "USD", evidenceReference: "test:verified-cost" };
      },
      async ingestOutputs() {
        calls.push(["ingest"]);
        if (kind === "cleanup-pending") throw Object.assign(new Error("rollback incomplete"), { cleanupPending: true });
        return { assetIds: [assetId], usage: { outputCount: 1 } };
      }
    };
    const enqueue = {
      async finish(value) { calls.push(["finish", value]); return true; },
      async defer(value) { calls.push(["defer", value]); return true; },
      async quarantine(value) { calls.push(["quarantine", value.reasonCode]); return true; },
      async recoverExpiredVideo() { return 0; }
    };
    const worker = createCloudVideoWorker({
      workerId: "failure-path-worker",
      queue, enqueue, ledger, adapter, deferSeconds: 30
    });
    const first = await worker.runCycle({ leaseSeconds: 90, heartbeatIntervalMs: 60000 });
    if (kind === "ambiguous") {
      const second = await worker.runCycle({ leaseSeconds: 90, heartbeatIntervalMs: 60000 });
      assert.equal(second.status, "needs_input");
      assert.equal(calls.filter(call => call[0] === "submit").length, 1);
      assert.equal(calls.filter(call => call[0] === "markUnknown").length, 1);
    }
    assert.equal(first.status, "needs_input");
    assert.equal(calls.some(call => call[0] === "finish"), false);
    assert.equal(calls.some(call => call[0] === "quarantine"), true);
    if (kind === "over-budget") assert.equal(calls.some(call => call[0] === "ingest"), false);
    if (kind === "cleanup-pending") assert.equal(calls.some(call => call[0] === "ingest"), true);
    return calls;
  }

  await scenario("ambiguous");
  await scenario("over-budget");
  await scenario("cleanup-pending");
});
