import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoEnqueue } from "../cloud-video-enqueue.mjs";

const base = { url: "https://example.supabase.co", serviceRoleKey: "cloud-video-test-secret" };
const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "423e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);
const input = { projectId, provider: "runway", model: "gen4.5", requestHash, prompt: "A test scene" };
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

test("enqueue preserves idempotent replay information and settles only through its RPC", async () => {
  const calls = [];
  const replay = { ...resultRow, job_status: "processing", idempotent_replay: true };
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response(url.endsWith("/settle_video_generation_budget_reservation") ? true : [replay]);
    }
  });
  const queued = await client.enqueue(args());
  assert.equal(queued.idempotentReplay, true);
  assert.equal(await client.settle({ jobId: resultRow.job_id, workerId: "video-worker-1", actualAmount: 0.8 }), true);
  assert.equal(await client.settle({ jobId: resultRow.job_id, workerId: "video-worker-1" }), true);
  assert.deepEqual(calls.map(call => call.url.split("/").pop()), [
    "enqueue_video_generation_job", "settle_video_generation_budget_reservation",
    "settle_video_generation_budget_reservation"
  ]);
  assert.deepEqual(calls[1].body, {
    p_job_id: resultRow.job_id, p_worker_id: "video-worker-1", p_actual_amount: 0.8
  });
  assert.equal(calls[2].body.p_actual_amount, null);
});

test("enqueue rejects mismatched request scope and invalid budget inputs before network access", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({ ...base, fetchImpl: async () => { calls++; return response([resultRow]); } });
  await assert.rejects(() => client.enqueue(args({ input: { ...input, requestHash: "b".repeat(64) } })), /does not match/);
  await assert.rejects(() => client.enqueue(args({ reservedAmount: 0 })), /positive bounded/);
  await assert.rejects(() => client.enqueue(args({ currency: "usd" })), /three-letter/);
  await assert.rejects(() => client.enqueue(args({ idempotencyKey: "bad key" })), /invalid format/);
  await assert.rejects(() => client.enqueue(args({ input: [] })), /must be an object/);
  await assert.rejects(() => client.settle({ jobId: resultRow.job_id, workerId: "worker", actualAmount: -1 }), /non-negative/);
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
