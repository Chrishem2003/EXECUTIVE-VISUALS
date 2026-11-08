import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoEnqueue } from "../cloud-video-enqueue.mjs";
import { estimateVideoGenerationCost } from "../video-generation-cost-estimator.mjs";

const base = { url: "https://example.supabase.co", serviceRoleKey: "cloud-video-test-secret" };
const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "423e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);
const input = { projectId, provider: "runway", model: "gen4.5", requestHash, durationSeconds: 5, prompt: "A test scene" };
const approvalId = "523e4567-e89b-42d3-a456-426614174000";
const resultRow = {
  job_id: "623e4567-e89b-42d3-a456-426614174000",
  job_status: "queued",
  idempotent_replay: false,
  budget_reservation_id: "723e4567-e89b-42d3-a456-426614174000"
};
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}
function args(overrides = {}) {
  return {
    ownerId, projectId, idempotencyKey: "request-001", provider: "runway", model: "gen4.5",
    requestHash, input, budgetApprovalId: approvalId, reservedAmount: 1.25, currency: "USD", ...overrides
  };
}

test("cloud enqueue uses service-role credentials and the private schema", async () => {
  const calls = [];
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response([resultRow]);
    }
  });
  const result = await client.enqueue(args());
  assert.deepEqual(result, {
    jobId: resultRow.job_id, status: "queued", idempotentReplay: false,
    budgetReservationId: resultRow.budget_reservation_id
  });
  assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/rpc/enqueue_video_generation_job");
  assert.equal(calls[0].options.headers["accept-profile"], "executive_visuals");
  assert.equal(calls[0].options.headers["content-profile"], "executive_visuals");
  assert.equal(calls[0].options.headers.apikey, base.serviceRoleKey);
  assert.equal(calls[0].options.headers.authorization, "Bearer " + base.serviceRoleKey);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_owner_id: ownerId, p_project_id: projectId, p_idempotency_key: "request-001",
    p_provider: "runway", p_model: "gen4.5", p_request_hash: requestHash,
    p_input: input, p_budget_approval_id: approvalId, p_reserved_amount: 1.25, p_currency: "USD"
  });
});

test("enqueue preserves active-job idempotent replay and atomically finalizes budget with job", async () => {
  const calls = [];
  const replay = { ...resultRow, job_status: "processing", idempotent_replay: true };
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response(url.includes("/finish_video_generation_job") ? true : [replay]);
    }
  });
  const queued = await client.enqueue(args());
  assert.equal(queued.idempotentReplay, true);
  assert.equal(queued.status, "processing");
  assert.equal(await client.finish({
    jobId: resultRow.job_id, workerId: "video-worker-1", status: "succeeded",
    output: { assetIds: ["asset-1"], costEvidenceReference: "provider-invoice:line-9" }, actualAmount: 0.8
  }), true);
  assert.equal(await client.finish({
    jobId: resultRow.job_id, workerId: "video-worker-1", status: "failed",
    error: { code: "PROVIDER_FAILED" }
  }), true);
  assert.deepEqual(calls.map(call => call.url.split("/").pop()), [
    "enqueue_video_generation_job", "finish_video_generation_job_with_evidence", "finish_video_generation_job"
  ]);
  assert.deepEqual(calls[1].body, {
    p_job_id: resultRow.job_id, p_worker_id: "video-worker-1",
    p_output: { assetIds: ["asset-1"], costEvidenceReference: "provider-invoice:line-9" },
    p_actual_amount: 0.8, p_evidence_reference: "provider-invoice:line-9"
  });
  assert.equal(calls[2].body.p_actual_amount, null);
});

test("successful settlement requires an owner-reviewed evidence reference before network access", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({ ...base, fetchImpl: async () => { calls++; return response(true); } });
  await assert.rejects(() => client.finish({
    jobId: resultRow.job_id, workerId: "video-worker-1", status: "succeeded",
    output: { assetIds: ["asset-1"] }, actualAmount: 0.8
  }), /Reviewed cost evidence reference/);
  assert.equal(calls, 0);
});

test("cloud video deferral, quarantine and evidence-reconciled resume use dedicated RPCs", async () => {
  const calls = [];
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response(url.endsWith("/recover_expired_video_generation_jobs") ? 2 : true);
    }
  });
  assert.equal(await client.defer({
    jobId: resultRow.job_id, workerId: "video-worker-1", delaySeconds: 45
  }), true);
  assert.equal(await client.quarantine({
    jobId: resultRow.job_id, workerId: "video-worker-1"
  }), true);
  assert.equal(await client.resumeReconciled({
    jobId: resultRow.job_id, ownerId, evidenceReference: "review-ticket:OPS-17"
  }), true);
  assert.equal(await client.recoverExpiredVideo(25), 2);
  assert.deepEqual(calls.map(call => call.url.split("/").pop()), [
    "defer_video_generation_job", "quarantine_video_generation_job",
    "resume_reconciled_video_generation_job", "recover_expired_video_generation_jobs"
  ]);
  assert.deepEqual(calls[0].body, {
    p_job_id: resultRow.job_id, p_worker_id: "video-worker-1",
    p_delay_seconds: 45, p_reason_code: "VIDEO_PROVIDER_POLL_DEFERRED"
  });
  assert.deepEqual(calls[1].body, {
    p_job_id: resultRow.job_id, p_worker_id: "video-worker-1",
    p_reason_code: "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION"
  });
  assert.deepEqual(calls[2].body, {
    p_job_id: resultRow.job_id, p_owner_id: ownerId,
    p_evidence_reference: "review-ticket:OPS-17"
  });
  assert.deepEqual(calls[3].body, { p_limit: 25 });
});

test("cloud video deferral and quarantine reject invalid controls before network access", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({ ...base, fetchImpl: async () => { calls++; return response(true); } });
  await assert.rejects(() => client.defer({ jobId: resultRow.job_id, workerId: "worker", delaySeconds: 1 }), /between 5 and 900/);
  await assert.rejects(() => client.quarantine({ jobId: resultRow.job_id, workerId: "worker", reasonCode: "not safe" }), /reason code/);
  await assert.rejects(() => client.resumeReconciled({ jobId: resultRow.job_id, ownerId }), /Evidence reference/);
  assert.equal(calls, 0);
});

test("enqueue rejects mismatched request scope and invalid budget inputs before network access", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({ ...base, fetchImpl: async () => { calls++; return response([resultRow]); } });
  await assert.rejects(() => client.enqueue(args({ input: { ...input, requestHash: "b".repeat(64) } })), /does not match/);
  await assert.rejects(() => client.enqueue(args({ reservedAmount: 0 })), /positive bounded/);
  await assert.rejects(() => client.enqueue(args({ reservedAmount: 0.5 })), error =>
    error.code === "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE"
  );
  await assert.rejects(() => client.enqueue(args({ reservedAmount: 0.59 })), error =>
    error.code === "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE" && error.estimate.amount === 0.6
  );
  await assert.rejects(() => client.enqueue(args({ input: { ...input, outputFormat: "prores" } })), /MP4 output only/);
  await assert.rejects(() => client.enqueue(args({ input: { ...input, durationSeconds: 11 } })), /pricing bounds/);
  await assert.rejects(() => client.enqueue(args({ currency: "EUR" })), /must match the verified provider price/);
  await assert.rejects(() => client.enqueue(args({
    provider: "luma", model: "ray-3.2",
    input: { ...input, provider: "luma", model: "ray-3.2" }
  })), error => error.code === "VIDEO_PRICE_UNVERIFIED");
  await assert.rejects(() => client.enqueue(args({ currency: "usd" })), /three-letter/);
  await assert.rejects(() => client.enqueue(args({ idempotencyKey: "bad key" })), /invalid format/);
  await assert.rejects(() => client.enqueue(args({ input: [] })), /must be an object/);
  await assert.rejects(() => client.finish({ jobId: resultRow.job_id, workerId: "worker", status: "succeeded" }), /require a non-negative/);
  await assert.rejects(() => client.finish({ jobId: resultRow.job_id, workerId: "worker", status: "failed", actualAmount: 1 }), /must release their reservation/);
  assert.equal(calls, 0);
});

test("enqueue fails closed on malformed RPC results and redacts server credentials", async () => {
  const malformed = createCloudVideoEnqueue({ ...base, fetchImpl: async () => response([{ ...resultRow, job_status: "not-a-job-state" }]) });
  await assert.rejects(() => malformed.enqueue(args()), /invalid job\/reservation result/);
  const denied = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async () => response({ message: "permission denied " + base.serviceRoleKey }, 403)
  });
  await assert.rejects(() => denied.enqueue(args()), error =>
    error.code === "CLOUD_VIDEO_ENQUEUE_HTTP_403" && !error.message.includes(base.serviceRoleKey)
  );
});

test("cloud enqueue configuration rejects insecure remote endpoints", () => {
  assert.throws(() => createCloudVideoEnqueue({ url: "http://remote.example", serviceRoleKey: "secret" }), /HTTPS/);
  assert.throws(() => createCloudVideoEnqueue({ url: base.url }), /SUPABASE_SERVICE_ROLE_KEY/);
});

test("Runway Gen-4.5 estimate uses the documented credits-per-second rate", () => {
  assert.deepEqual(estimateVideoGenerationCost({
    provider: "runway", model: "gen4.5", durationSeconds: 5
  }), {
    provider: "runway", model: "gen4.5", durationSeconds: 5,
    outputFormat: "mp4", credits: 60, currency: "USD", amount: 0.6,
    basis: "provider_list_price_estimate", creditsPerSecond: 12,
    usdPerCredit: 0.01, pricingSource: "https://dev.runwayml.com/pricing"
  });
  assert.throws(() => estimateVideoGenerationCost({
    provider: "runway", model: "gen4.5", durationSeconds: 1
  }), error => error.code === "VIDEO_PRICE_DURATION_INVALID");
  assert.throws(() => estimateVideoGenerationCost({
    provider: "runway", model: "gen4.5", durationSeconds: 5, outputFormat: "prores"
  }), error => error.code === "VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED");
  assert.throws(() => estimateVideoGenerationCost({
    provider: "luma", model: "ray-3.2", durationSeconds: 5
  }), error => error.code === "VIDEO_PRICE_UNVERIFIED");
});

test("cloud video enqueue exposes cancellation RPCs with bounded worker scope",async()=>{
 const calls=[];
 const client=createCloudVideoEnqueue({
  ...base,
  fetchImpl:async(url,options)=>{
   calls.push({url,body:JSON.parse(options.body)});
   if(url.endsWith("/request_video_generation_cancellation"))return response([{
    job_id:resultRow.job_id,job_status:"processing",cancellation_requested:true,submission_state:"submitted"
   }]);
   return response(true);
  }
 });
 const requested=await client.requestCancellation({jobId:resultRow.job_id,ownerId});
 assert.deepEqual(requested,{
  jobId:resultRow.job_id,status:"processing",cancellationRequested:true,submissionState:"submitted"
 });
 assert.equal(await client.isCancellationRequested(resultRow.job_id,"video-worker-1"),true);
 assert.deepEqual(calls.map(call=>call.url.split("/").pop()),[
  "request_video_generation_cancellation","is_video_generation_cancellation_requested"
 ]);
 assert.deepEqual(calls[0].body,{p_job_id:resultRow.job_id,p_owner_id:ownerId});
 assert.deepEqual(calls[1].body,{p_job_id:resultRow.job_id,p_worker_id:"video-worker-1"});
});
