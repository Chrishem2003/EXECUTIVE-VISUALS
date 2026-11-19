import test from "node:test";
import assert from "node:assert/strict";
import { createNeonVideoWorkerContracts, createNeonCloudVideoWorker } from "../neon-cloud-video-worker.mjs";

const jobId = "123e4567-e89b-42d3-a456-426614174000";
const lease = "223e4567-e89b-42d3-a456-426614174000";
const workerId = "neon-worker";
const projectId = "323e4567-e89b-42d3-a456-426614174000";
function fixture() {
  const calls = [];
  const job = { id: jobId, owner_id: jobId, project_id: projectId, job_type: "video.generate", lease_token: lease };
  const runtime = {
    backend: "neon-postgres",
    queue: {
      async claim() { return job; },
      async renew() { return true; },
      async assertLease() { return true; },
      async defer(...args) { calls.push(["defer", ...args]); return true; },
      async quarantine(...args) { calls.push(["quarantine", ...args]); return true; },
      async recover(limit) { calls.push(["recover", limit]); return 2; }
    },
    submissions: { async prepare(){}, async begin(){}, async record(){}, async markUnknown(){} },
    financials: {
      async settleJob(){ return { balance: 100, adjustment: 0, replayed: false }; },
      async finishVideoJob(args) { calls.push(["finishVideoJob", args]); return true; }
    }
  };
  return { calls, job, runtime };
}

test("Neon worker quarantines a claimed job without an authenticated owner/project UUID scope", async () => {
  const f = fixture();
  f.job.project_id = null;
  const contracts = createNeonVideoWorkerContracts({ runtime: f.runtime, workerId });
  assert.equal(await contracts.queue.claim(workerId, 90, ["video.generate"]), null);
  assert.equal(f.calls[0][0], "quarantine");
  assert.equal(f.calls[0][1], jobId);
  assert.equal(f.calls[0][2], workerId);
  assert.equal(f.calls[0][3], lease);
  assert.equal(f.calls[0][4].code, "VIDEO_JOB_SCOPE_INVALID");
});
 
test("Neon worker contracts finalize success with measured credits and provider receipt evidence", async () => {
  const f = fixture();
  const contracts = createNeonVideoWorkerContracts({ runtime: f.runtime, workerId });
  const claimed = await contracts.queue.claim(workerId, 90, ["video.generate"]);
  assert.equal(claimed.id, jobId);
  const output = {
    provider: "runway", model: "gen4.5", providerTaskId: "task-1",
    assetIds: ["asset-1"], actualAmount: 2.5, actualCredits: 40,
    currency: "USD", costEvidenceReference: "provider-receipt-1"
  };
  assert.equal(await contracts.enqueue.finish({
    jobId, workerId, leaseToken: lease, status: "succeeded", output, actualAmount: 2.5
  }), true);
  const [, args] = f.calls[0];
  assert.equal(args.ownerId, jobId);
  assert.equal(args.actualCredits, 40);
  assert.equal(args.financialEvidence.evidenceId, "task-1");
  assert.equal(args.financialEvidence.evidenceReference, "provider-receipt-1");
});

test("Neon worker quarantines unverified failures rather than releasing customer credits", async () => {
  const f = fixture();
  const contracts = createNeonVideoWorkerContracts({ runtime: f.runtime, workerId });
  await contracts.queue.claim(workerId, 90, ["video.generate"]);
  const result = await contracts.enqueue.finish({
    jobId, workerId, leaseToken: lease, status: "failed",
    error: { code: "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN", message: "Submission may have reached provider." }
  });
  assert.deepEqual(result, { finished: true, status: "blocked" });
  assert.equal(f.calls[0][0], "quarantine");
  assert.equal(f.calls[0][4].code, "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN");
});

test("Neon worker maps provider polling, recovery and fenced lease operations", async () => {
  const f = fixture();
  const contracts = createNeonVideoWorkerContracts({ runtime: f.runtime, workerId });
  await contracts.queue.claim(workerId, 90, ["video.generate"]);
  assert.equal(await contracts.enqueue.defer({
    jobId, workerId, leaseToken: lease, delaySeconds: 30, reasonCode: "VIDEO_PROVIDER_POLL_DEFERRED"
  }), true);
  assert.equal(await contracts.enqueue.recoverExpiredVideo(25), 2);
  assert.deepEqual(f.calls[0].slice(0, 5), ["defer", jobId, workerId, lease, 30]);
});

test("Neon worker composition fails closed without staging, remote and authorization gates", () => {
  const f = fixture();
  const adapter = {
    provider: "runway", model: "gen4.5",
    async submit(){}, async getStatus(){}, async ingestOutputs(){ return { assetIds: ["asset-1"] }; },
    async resolveActualCost(){ return { amount: 1, actualCredits: 10, currency: "USD", evidenceReference: "receipt" }; }
  };
  assert.throws(() => createNeonCloudVideoWorker({ runtime: f.runtime, workerId, adapters: [adapter], authorizeJob: async()=>true, env: {} }), /staging runtime/);
  const env = { NEON_STAGING_RUNTIME_ENABLED: "true", NEON_STAGING_BRANCH_NAME: "executive-visuals-staging", CLOUD_VIDEO_WORKER_ENABLED: "true", VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true" };
  assert.throws(() => createNeonCloudVideoWorker({ runtime: f.runtime, workerId, adapters: [adapter], env }), /authorization callback/);
  const worker = createNeonCloudVideoWorker({ runtime: f.runtime, workerId, adapters: [adapter], authorizeJob: async()=>true, env });
  assert.deepEqual(worker.listSupported(), ["runway:gen4.5"]);
});
