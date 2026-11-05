import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayRouterWorkflow } from "../runway-router-workflow.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "423e4567-e89b-42d3-a456-426614174000";
const routerApprovalId = "823e4567-e89b-42d3-a456-426614174000";
const budgetApprovalId = "523e4567-e89b-42d3-a456-426614174000";
const hash = "a".repeat(64);
const decision = {
  status: "preflighted", dryRun: true, taskCreated: false, billed: false,
  provider: "runway", model: "gen4.5", configId: "creative_low_cost",
  estimatedCredits: 60, inputHash: "b".repeat(64),
  budgetCheck: "within_limit", maxEstimatedCredits: 80
};
function setup({ authorized = true, returnedDecision = decision } = {}) {
  const calls = [];
  const workflow = createRunwayRouterWorkflow({
    dryRun: { async preflight(input, options) { calls.push(["preflight", input, options]); return returnedDecision; } },
    approvals: {
      async recordPreflight(args) {
        calls.push(["record", args]);
        return { routerApprovalId, budgetApprovalId, expiresAt: "2026-11-05T12:15:00.000Z" };
      },
      async approve(args) { calls.push(["approve", args]); return true; }
    },
    enqueue: { async enqueue(args) { calls.push(["enqueue", args]); return { jobId: "job-1", status: "queued", idempotentReplay: false, budgetReservationId: "reservation-1" }; }, async getJobStatus(args) { calls.push(["status", args]); return { jobId: args.jobId, status: "processing" }; } },
    authorizeProject: async args => { calls.push(["authorize", args]); return authorized; }
  });
  return { workflow, calls };
}

test("preflight authorizes the project, performs a dry-run and persists the exact normalized enqueue payload", async () => {
  const { workflow, calls } = setup();
  const result = await workflow.preflight({
    ownerId, projectId, configId: "creative_low_cost",
    prompt: "A cinematic sunrise over the lake", durationSeconds: 5,
    aspectRatio: "16:9", maxEstimatedCredits: 80, approvedMaxAmount: 1.25
  });
  assert.equal(result.status, "pending_approval");
  assert.equal(result.provider, "runway");
  assert.equal(result.model, "gen4.5");
  assert.equal(result.routerApprovalId, routerApprovalId);
  assert.equal(result.budgetApprovalId, budgetApprovalId);
  assert.equal(result.jobInput.provider, "runway");
  assert.equal(result.jobInput.model, "gen4.5");
  assert.equal(result.jobInput.projectId, projectId);
  assert.equal(result.jobInput.requestHash, result.requestHash);
  assert.equal(result.jobInput.outputFormat, "mp4");
  assert.equal(calls.find(x => x[0] === "preflight")[2].maxEstimatedCredits, 80);
  const record = calls.find(x => x[0] === "record")[1];
  assert.deepEqual(record.jobInput, result.jobInput);
  assert.equal(record.requestHash, result.requestHash);
  assert.equal(record.decision.inputHash, result.routerInputHash);
});

test("preflight fails closed without project editor authorization or within-ceiling dry-run", async () => {
  const denied = setup({ authorized: false });
  await assert.rejects(() => denied.workflow.preflight({
    ownerId, projectId, configId: "creative_low_cost", prompt: "A cinematic sunrise",
    durationSeconds: 5, maxEstimatedCredits: 80, approvedMaxAmount: 1.25
  }), error => error.code === "RUNWAY_WORKFLOW_PROJECT_FORBIDDEN");
  assert.equal(denied.calls.some(x => x[0] === "preflight"), false);
  const wrongModel = setup({ returnedDecision: { ...decision, model: "seedance2_5" } });
  await assert.rejects(() => wrongModel.workflow.preflight({
    ownerId, projectId, configId: "creative_low_cost", prompt: "A cinematic sunrise",
    durationSeconds: 5, maxEstimatedCredits: 80, approvedMaxAmount: 1.25
  }), error => error.code === "RUNWAY_WORKFLOW_DECISION_INVALID");
  assert.equal(wrongModel.calls.some(x => x[0] === "record"), false);
});

test("human approval delegates the approval ID and user access token to PostgreSQL", async () => {
  const { workflow, calls } = setup();
  const result = await workflow.approve({
    routerApprovalId, accessToken: "user-access-token-with-sufficient-length"
  });
  assert.deepEqual(result, { approvalId: routerApprovalId, status: "approved" });
  assert.deepEqual(calls.find(x => x[0] === "approve")[1], {
    approvalId: routerApprovalId, accessToken: "user-access-token-with-sufficient-length"
  });
});

test("enqueue rejects a changed prompt before contacting the enqueue RPC", async () => {
  const { workflow, calls } = setup();
  const preflight = await workflow.preflight({
    ownerId, projectId, configId: "creative_low_cost",
    prompt: "A cinematic sunrise over the lake", durationSeconds: 5,
    maxEstimatedCredits: 80, approvedMaxAmount: 1.25
  });
  const changed = { ...preflight.jobInput, prompt: "A different scene" };
  await assert.rejects(() => workflow.enqueueApproved({
    ownerId, projectId, idempotencyKey: "runway-job-0001",
    receipt: preflight, jobInput: changed, reservedAmount: 1.25
  }), error => error.code === "RUNWAY_APPROVAL_PAYLOAD_MISMATCH");
  assert.equal(calls.some(x => x[0] === "enqueue"), false);
});

test("enqueue forwards the same approved payload and both approval IDs to the atomic database queue", async () => {
  const { workflow, calls } = setup();
  const preflight = await workflow.preflight({
    ownerId, projectId, configId: "creative_low_cost",
    prompt: "A cinematic sunrise over the lake", durationSeconds: 5,
    maxEstimatedCredits: 80, approvedMaxAmount: 1.25
  });
  const result = await workflow.enqueueApproved({
    ownerId, projectId, idempotencyKey: "runway-job-0001",
    receipt: preflight, jobInput: preflight.jobInput,
    reservedAmount: 1.25, currency: "USD"
  });
  assert.equal(result.jobId, "job-1");
  const call = calls.find(x => x[0] === "enqueue")[1];
  assert.deepEqual(call.input, preflight.jobInput);
  assert.equal(call.routerApprovalId, routerApprovalId);
  assert.equal(call.budgetApprovalId, budgetApprovalId);
  assert.equal(call.routerInputHash, decision.inputHash);
  assert.equal(call.routerConfigId, "creative_low_cost");
  assert.equal(call.requestHash, preflight.requestHash);
});


test("job status lookup validates the job and binds it to the verified owner",async()=>{
 const {workflow,calls}=setup();
 const result=await workflow.getJobStatus({ownerId,jobId:"623e4567-e89b-42d3-a456-426614174000"});
 assert.deepEqual(result,{jobId:"623e4567-e89b-42d3-a456-426614174000",status:"processing"});
 assert.deepEqual(calls.find(x=>x[0]==="status")[1],{ownerId,jobId:"623e4567-e89b-42d3-a456-426614174000"});
 await assert.rejects(()=>workflow.getJobStatus({ownerId,jobId:"bad"}),error=>error.code==="RUNWAY_WORKFLOW_JOB_INVALID");
});
