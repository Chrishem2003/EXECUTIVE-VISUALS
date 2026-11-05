import test from "node:test";
import assert from "node:assert/strict";
import { runCloudVideoWorkerCycle } from "../cloud-video-worker.mjs";

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

test("cloud video worker finalizes cancellation only before provider submission",async()=>{
 const f=fixture({execute:async()=>{throw Object.assign(new Error("cancelled before provider submission"),{code:"VIDEO_JOB_CANCELLED"});}});
 const result=await runCloudVideoWorkerCycle({...f,workerId:"video-worker-1"});
 assert.equal(result.status,"cancelled");
 const finish=f.calls.find(call=>call[0]==="finish")[1];
 assert.equal(finish.status,"cancelled");
 assert.equal(f.calls.some(call=>call[0]==="quarantine"),false);
});

test("cloud video worker quarantines provider cancellation until task and billing reconciliation",async()=>{
 const f=fixture({execute:async()=>{throw Object.assign(new Error("provider cancellation is best-effort"),{code:"VIDEO_CANCELLATION_REQUIRES_RECONCILIATION"});}});
 const result=await runCloudVideoWorkerCycle({...f,workerId:"video-worker-1"});
 assert.equal(result.status,"needs_input");
 assert.equal(f.calls.some(call=>call[0]==="quarantine"),true);
 assert.equal(f.calls.some(call=>call[0]==="finish"),false);
});
