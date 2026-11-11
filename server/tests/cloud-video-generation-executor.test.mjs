import test from "node:test";
import assert from "node:assert/strict";
import { executeCloudVideoGenerationJob } from "../cloud-video-generation-job-executor.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const jobId = "223e4567-e89b-42d3-a456-426614174000";
const taskId = "323e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);
const job = {
  id: jobId, owner_id: ownerId, project_id: null, job_type: "video.generate",
  lease_token: "923e4567-e89b-42d3-a456-426614174000",
  input: { provider: "runway", model: "gen4.5", requestHash, prompt: "Test prompt" },
  estimated_cost: { amount: 2, currency: "USD" }
};
const succeeded = { taskId, status: "succeeded", outputUrls: ["https://cdn.example.test/output.mp4"] };
function fixture({ state = "prepared", submitError = null, recordResult = true, status = succeeded,
  metadata = {}, submittedMetadata = {}, cost = { amount: 0.75, currency: "USD", evidenceReference: "provider-invoice:line-9", actualCredits: 12 },
  costError = null, ingestError = null, creditError = null } = {}) {
  const calls = [];
  let currentState = state;
  let currentTaskId = state === "submitted" ? taskId : null;
  let currentMetadata = metadata;
  const ledger = {
    async prepare(value) { calls.push(["prepare", value]); return { job_id: jobId, owner_id: ownerId, state: currentState, provider_task_id: currentTaskId, metadata: currentMetadata }; },
    async begin(id, worker) { calls.push(["begin", id, worker]); return true; },
    async record(id, worker, idValue, metadata) {
      calls.push(["record", id, worker, idValue, metadata]);
      if (recordResult) { currentState = "submitted"; currentTaskId = idValue; currentMetadata = metadata; }
      return recordResult;
    },
    async markUnknown(id, worker, code) { calls.push(["unknown", id, worker, code]); currentState = "unknown"; return true; }
  };
  const adapter = {
    provider: "runway", model: "gen4.5", minimumPollIntervalMs: 5000,
    async submit(input, context) { calls.push(["submit", input.requestHash, context?.job?.id, context?.job?.owner_id]); if (submitError) throw submitError; return { taskId, status: "queued", metadata: submittedMetadata }; },
    async getStatus(id, context) { calls.push(["poll", id, context?.job?.id, context?.workerId]); if (status instanceof Error) throw status; return status; }
  };
  return {
    calls, ledger, adapter,
    customerCredits: { async settleJob(value) { calls.push(["settleCredits", value]); if (creditError) throw creditError; return { balance: 40, adjustment: 2, replayed: false }; } },
    ingestOutputs: async value => { calls.push(["ingest", value.providerTaskId]); if (ingestError) throw ingestError; return { assetIds: ["423e4567-e89b-42d3-a456-426614174000"], usage: { outputCount: 1 } }; },
    resolveActualCost: async value => { calls.push(["cost", value.providerTaskId, value.submissionMetadata]); if (costError) throw costError; return cost; }
  };
}

test("cloud executor submits once, records task, verifies cost and ingests private outputs", async () => {
  const f = fixture();
  const result = await executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f, sleep: async () => {} });
  assert.equal(result.providerTaskId, taskId);
  assert.equal(result.actualAmount, 0.75);
  assert.equal(result.currency, "USD");
  assert.deepEqual(result.assetIds, ["423e4567-e89b-42d3-a456-426614174000"]);
  assert.deepEqual(f.calls.map(call => call[0]), ["prepare", "begin", "submit", "record", "poll", "cost", "ingest"]);
  const submission = f.calls.find(call => call[0] === "submit");
  assert.equal(submission[2], job.id);
  assert.equal(submission[3], ownerId);
});


test("workflow generation settles customer credits with provider task evidence before output ingestion", async () => {
  const f = fixture();
  const workflowJob = { ...job, input: { ...job.input, workflowQuoteId: "523e4567-e89b-42d3-a456-426614174000" } };
  const result = await executeCloudVideoGenerationJob({ job: workflowJob, workerId: "worker-1", ...f });
  assert.deepEqual(f.calls.map(call => call[0]), ["prepare", "begin", "submit", "record", "poll", "cost", "settleCredits", "ingest"]);
  const settlement = f.calls.find(call => call[0] === "settleCredits")[1];
  assert.equal(settlement.jobId, job.id);
  assert.equal(settlement.ownerId, ownerId);
  assert.equal(settlement.provider, "runway");
  assert.equal(settlement.actualCredits, 12);
  assert.equal(settlement.evidence.evidenceId, taskId);
  assert.equal(settlement.evidence.evidenceReference, "provider-invoice:line-9");
  assert.equal(result.customerCreditSettlement.balance, 40);
});

test("workflow generation refuses to guess customer credits when provider evidence omits actual credits", async () => {
  const f = fixture({ cost: { amount: 0.75, currency: "USD", evidenceReference: "provider-invoice:line-9" } });
  const workflowJob = { ...job, input: { ...job.input, workflowQuoteId: "523e4567-e89b-42d3-a456-426614174000" } };
  await assert.rejects(
    executeCloudVideoGenerationJob({ job: workflowJob, workerId: "worker-1", ...f }),
    error => error.code === "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED"
  );
  assert.equal(f.calls.some(call => call[0] === "settleCredits"), false);
  assert.equal(f.calls.some(call => call[0] === "ingest"), false);
});

test("workflow generation quarantines settlement transport failures for idempotent reconciliation", async () => {
  const f = fixture({ creditError: new Error("temporary database outage") });
  const workflowJob = { ...job, input: { ...job.input, workflowQuoteId: "523e4567-e89b-42d3-a456-426614174000" } };
  await assert.rejects(
    executeCloudVideoGenerationJob({ job: workflowJob, workerId: "worker-1", ...f }),
    error => error.code === "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED"
  );
  assert.equal(f.calls.some(call => call[0] === "ingest"), false);
});

test("cloud executor runs non-billable provider preflight before the paid submission", async () => {
  const f = fixture();
  f.adapter.preflight = async input => {
    f.calls.push(["preflight", input.requestHash]);
    return { billable: false, estimatedUsd: 1.25, currency: "USD", model: "gen4.5" };
  };
  await executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f });
  assert.deepEqual(f.calls.map(call => call[0]), ["prepare", "preflight", "begin", "submit", "record", "poll", "cost", "ingest"]);
  const recorded = f.calls.find(call => call[0] === "record")[4];
  assert.equal(recorded.preflightQuote.estimatedUsd, 1.25);
});

test("cloud executor refuses provider quote above the approved reservation without submitting", async () => {
  const f = fixture();
  f.adapter.preflight = async () => ({
    billable: false, estimatedUsd: 2.01, currency: "USD", model: "gen4.5"
  });
  await assert.rejects(
    executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f }),
    error => error.code === "VIDEO_PREFLIGHT_REJECTED"
  );
  assert.equal(f.calls.some(call => call[0] === "begin"), false);
  assert.equal(f.calls.some(call => call[0] === "submit"), false);
});

test("cloud executor resumes submitted task without a second provider POST", async () => {
  const f = fixture({ state: "submitted" });
  const result = await executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f });
  assert.equal(result.providerTaskId, taskId);
  assert.equal(f.calls.some(call => call[0] === "submit"), false);
  assert.equal(f.calls.some(call => call[0] === "begin"), false);
});

test("ambiguous provider POST is quarantined and never repeated", async () => {
  const f = fixture({ submitError: new Error("network timeout") });
  const options = { job, workerId: "worker-1", ...f };
  await assert.rejects(executeCloudVideoGenerationJob(options), error => error.code === "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  await assert.rejects(executeCloudVideoGenerationJob(options), error => error.code === "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  assert.equal(f.calls.filter(call => call[0] === "submit").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "unknown").length, 1);
});

test("cloud executor defers transient or active status after exactly one check per lease", async () => {
  const f = fixture({ state: "submitted", status: new Error("provider unavailable") });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f }), error => error.code === "VIDEO_PROVIDER_POLL_DEFERRED");
  const running = fixture({ state: "submitted", status: { taskId, status: "running" } });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...running }), error => error.code === "VIDEO_PROVIDER_POLL_DEFERRED");
  assert.equal(running.calls.filter(call => call[0] === "poll").length, 1);
});

test("cloud executor quarantines provider-canceled tasks until cancellation billing is reconciled", async () => {
  const f = fixture({ state: "submitted", status: {
    taskId, status: "canceled", failure: "Runway task was canceled.",
    failureCode: "RUNWAY_TASK_CANCELED"
  }});
  await assert.rejects(
    executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f }),
    error => error.code === "VIDEO_PROVIDER_CANCELLATION_COST_UNRESOLVED"
  );
  assert.equal(f.calls.some(call => call[0] === "cost"), false,
    "canceled task cost must not be guessed from success-only billing evidence");
  assert.equal(f.calls.some(call => call[0] === "ingest"), false);
});

test("cloud executor holds reservation when actual cost is unknown or exceeds approval", async () => {
  const unknown = fixture({ costError: new Error("no invoice") });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...unknown }), error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED");
  const tooHigh = fixture({ cost: { amount: 2.01, currency: "USD", evidenceReference: "invoice:1" } });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...tooHigh }), error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED");
  const wrongCurrency = fixture({ cost: { amount: 0.5, currency: "EUR", evidenceReference: "invoice:1" } });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...wrongCurrency }), error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED");
});

test("cloud executor holds completed provider task for review when private ingestion fails", async () => {
  const f = fixture({ ingestError: new Error("private bucket unavailable") });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f }), error => error.code === "VIDEO_OUTPUT_INGESTION_REQUIRES_REVIEW");
});

test("cloud executor refuses ambiguous ledger states and missing execution gates", async () => {
  const unknown = fixture({ state: "unknown" });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...unknown }), error => error.code === "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  const noGate = fixture();
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...noGate, resolveActualCost: null }), error => error.code === "VIDEO_EXECUTION_GATES_MISSING");
  assert.equal(unknown.calls.some(call => call[0] === "submit"), false);
});

test("cloud executor prepares private image inputs before beginning the one-shot provider transition",async()=>{
 const f=fixture();
 f.adapter.prepareInput=async(input,context)=>{
  f.calls.push(["prepareInput",context.job.id,context.job.owner_id]);
  return {...input,runwayPromptImage:"runway://uploads/private-frame"};
 };
 await executeCloudVideoGenerationJob({job,workerId:"worker-1",...f});
 assert.deepEqual(f.calls.map(call=>call[0]),["prepare","prepareInput","begin","submit","record","poll","cost","ingest"]);
 const prepared=f.calls.find(call=>call[0]==="prepareInput");
 assert.equal(prepared[1],job.id);
 assert.equal(prepared[2],ownerId);
});

test("cloud executor does not enter submitting state when private input preparation fails",async()=>{
 const f=fixture();
 f.adapter.prepareInput=async()=>{f.calls.push(["prepareInput"]);throw Object.assign(new Error("asset unavailable"),{code:"RUNWAY_IMAGE_ASSET_RESOLUTION_FAILED"});};
 await assert.rejects(
  executeCloudVideoGenerationJob({job,workerId:"worker-1",...f}),
  error=>error.code==="RUNWAY_IMAGE_ASSET_RESOLUTION_FAILED"
 );
 assert.deepEqual(f.calls.map(call=>call[0]),["prepare","prepareInput"]);
 assert.equal(f.calls.some(call=>call[0]==="begin"),false);
 assert.equal(f.calls.some(call=>call[0]==="submit"),false);
 assert.equal(f.calls.some(call=>call[0]==="unknown"),false);
});

test("cloud executor accepts an explicitly model-bound Luma adapter without changing its ledger gates", async () => {
  const f = fixture();
  f.adapter.provider = "luma";
  f.adapter.model = "ray-3.2";
  f.adapter.prepareInput = async input => { f.calls.push(["prepareInput"]); return { model: "ray-3.2", type: "video", prompt: input.prompt }; };
  const lumaJob = {
    ...job,
    input: { ...job.input, provider: "luma", model: "ray-3.2" }
  };
  const result = await executeCloudVideoGenerationJob({
    job: lumaJob, workerId: "worker-luma", ...f
  });
  assert.equal(result.provider, "luma");
  assert.equal(result.model, "ray-3.2");
  assert.equal(result.providerTaskId, taskId);
  assert.deepEqual(f.calls.map(call => call[0]), ["prepare", "prepareInput", "begin", "submit", "record", "poll", "cost", "ingest"]);
});

test("cloud executor passes the current leased job scope to provider status polling", async () => {
  const f = fixture({ state: "submitted" });
  await executeCloudVideoGenerationJob({ job, workerId: "worker-context", ...f });
  const poll = f.calls.find(call => call[0] === "poll");
  assert.equal(poll[2], job.id);
  assert.equal(poll[3], "worker-context");
});

test("persists provider routing metadata and reuses it after a worker restart", async () => {
  const routeEvidence = {
    routeType: "runway-model-router", configId: "production-video",
    routing: { configId: "production-video", model: "gen4.5", provider: "runway", realizedCost: { credits: 48 } }
  };
  const first = fixture({ submittedMetadata: routeEvidence });
  await executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...first });
  const recordCall = first.calls.find(call => call[0] === "record");
  assert.deepEqual(recordCall[4], { acceptedStatus: "queued", ...routeEvidence });

  const resumed = fixture({ state: "submitted", metadata: { acceptedStatus: "queued", ...routeEvidence } });
  const resolved = await executeCloudVideoGenerationJob({ job, workerId: "worker-2", ...resumed });
  const costCall = resumed.calls.find(call => call[0] === "cost");
  assert.deepEqual(costCall[2], { acceptedStatus: "queued", ...routeEvidence });
  assert.equal(resolved.providerTaskId, taskId);
  assert.equal(resumed.calls.some(call => call[0] === "submit"), false);
});
