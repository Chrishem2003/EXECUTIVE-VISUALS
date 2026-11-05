import test from "node:test";
import assert from "node:assert/strict";
import { executeCloudVideoGenerationJob } from "../cloud-video-generation-executor.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const jobId = "223e4567-e89b-42d3-a456-426614174000";
const taskId = "323e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);
const job = {
  id: jobId, owner_id: ownerId, project_id: null, job_type: "video.generate",
  input: { provider: "runway", model: "gen4.5", requestHash, prompt: "Test prompt" },
  estimated_cost: { amount: 2, currency: "USD" }
};
const succeeded = { taskId, status: "succeeded", outputUrls: ["https://cdn.example.test/output.mp4"] };
function fixture({ state = "prepared", submitError = null, recordResult = true, status = succeeded,
  cost = { amount: 0.75, currency: "USD", evidenceReference: "provider-invoice:line-9" },
  costError = null, ingestError = null, cancellationRequested = false, cancellationError = null } = {}) {
  const calls = [];
  let currentState = state;
  let currentTaskId = state === "submitted" ? taskId : null;
  const ledger = {
    async prepare(value) { calls.push(["prepare", value]); return { job_id: jobId, owner_id: ownerId, state: currentState, provider_task_id: currentTaskId }; },
    async begin(id, worker) { calls.push(["begin", id, worker]); return true; },
    async record(id, worker, idValue, metadata) {
      calls.push(["record", id, worker, idValue, metadata]);
      if (recordResult) { currentState = "submitted"; currentTaskId = idValue; }
      return recordResult;
    },
    async markUnknown(id, worker, code) { calls.push(["unknown", id, worker, code]); currentState = "unknown"; return true; }
  };
  const adapter = {
    provider: "runway", model: "gen4.5", minimumPollIntervalMs: 5000,
    async submit(input, context) { calls.push(["submit", input.requestHash, context?.job?.id, context?.job?.owner_id]); if (submitError) throw submitError; return { taskId, status: "queued" }; },
    async getStatus(id) { calls.push(["poll", id]); if (status instanceof Error) throw status; return status; },
    async cancel(id) { calls.push(["cancel", id]); return { taskId: id, status: "cancel_requested", cancelRequested: true }; }
  };
  return {
    calls, ledger, adapter,
    isCancellationRequested: async () => { calls.push(["cancellation-check"]); if (cancellationError) throw cancellationError; return cancellationRequested; },
    ingestOutputs: async value => { calls.push(["ingest", value.providerTaskId]); if (ingestError) throw ingestError; return { assetIds: ["423e4567-e89b-42d3-a456-426614174000"], usage: { outputCount: 1 } }; },
    resolveActualCost: async value => { calls.push(["cost", value.providerTaskId]); if (costError) throw costError; return cost; }
  };
}

test("cloud executor submits once, records task, verifies cost and ingests private outputs", async () => {
  const f = fixture();
  const result = await executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f, sleep: async () => {} });
  assert.equal(result.providerTaskId, taskId);
  assert.equal(result.actualAmount, 0.75);
  assert.equal(result.currency, "USD");
  assert.deepEqual(result.assetIds, ["423e4567-e89b-42d3-a456-426614174000"]);
  assert.deepEqual(f.calls.map(call => call[0]), ["prepare", "cancellation-check", "begin", "cancellation-check", "submit", "record", "poll", "cancellation-check", "cost", "ingest"]);
  const submission = f.calls.find(call => call[0] === "submit");
  assert.equal(submission[2], job.id);
  assert.equal(submission[3], ownerId);
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

test("cloud executor defers transient status lookup and polling exhaustion", async () => {
  const f = fixture({ state: "submitted", status: new Error("provider unavailable") });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...f }), error => error.code === "VIDEO_PROVIDER_POLL_DEFERRED");
  const running = fixture({ state: "submitted", status: { taskId, status: "running" } });
  await assert.rejects(executeCloudVideoGenerationJob({ job, workerId: "worker-1", ...running, maxPolls: 1 }), error => error.code === "VIDEO_PROVIDER_POLL_DEFERRED");
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
 assert.deepEqual(f.calls.map(call=>call[0]),["prepare","cancellation-check","prepareInput","begin","cancellation-check","submit","record","poll","cancellation-check","cost","ingest"]);
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

test("cloud executor cancels a prepared job before provider submission",async()=>{
 const f=fixture({cancellationRequested:true});
 await assert.rejects(
  executeCloudVideoGenerationJob({job,workerId:"worker-1",...f}),
  error=>error.code==="VIDEO_JOB_CANCELLED"
 );
 assert.equal(f.calls.some(call=>call[0]==="begin"),false);
 assert.equal(f.calls.some(call=>call[0]==="submit"),false);
});

test("cloud executor requests best-effort provider cancellation and quarantines submitted jobs for reconciliation",async()=>{
 const f=fixture({state:"submitted",status:{taskId,status:"running"},cancellationRequested:true});
 await assert.rejects(
  executeCloudVideoGenerationJob({job,workerId:"worker-1",...f}),
  error=>error.code==="VIDEO_CANCELLATION_REQUIRES_RECONCILIATION"
 );
 assert.equal(f.calls.some(call=>call[0]==="cancel"&&call[1]===taskId),true);
 assert.equal(f.calls.some(call=>call[0]==="ingest"),false);
});

test("cloud executor fails closed if cancellation state cannot be checked",async()=>{
 const f=fixture({cancellationError:new Error("database unavailable")});
 await assert.rejects(
  executeCloudVideoGenerationJob({job,workerId:"worker-1",...f}),
  error=>error.code==="VIDEO_CANCELLATION_STATE_UNAVAILABLE"
 );
 assert.equal(f.calls.some(call=>call[0]==="submit"),false);
});
