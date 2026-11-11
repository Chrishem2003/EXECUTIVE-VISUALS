import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoSubmissionLedger } from "../cloud-video-submissions.mjs";

const base = { url: "https://example.supabase.co", serviceRoleKey: "server-only-ledger-secret" };
const row = { job_id: "job-1", owner_id: "owner-1", provider: "runway", model: "gen4.5", request_hash: "a".repeat(64), state: "prepared" };
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

test("cloud submission ledger uses service credentials and the private schema", async () => {
  const requests = [];
  const ledger = createCloudVideoSubmissionLedger({ ...base, fetchImpl: async (url, options) => { requests.push({ url, options }); return response([row]); } });
  const result = await ledger.prepare({ jobId: "job-1", ownerId: "owner-1", provider: "runway", model: "gen4.5", requestHash: "a".repeat(64) });
  assert.equal(result.job_id, "job-1");
  assert.equal(requests[0].url, "https://example.supabase.co/rest/v1/rpc/prepare_video_generation_submission");
  assert.equal(requests[0].options.headers["accept-profile"], "executive_visuals");
  assert.equal(requests[0].options.headers["content-profile"], "executive_visuals");
  assert.equal(requests[0].options.headers.apikey, base.serviceRoleKey);
  assert.equal(requests[0].options.headers.authorization, "Bearer " + base.serviceRoleKey);
  assert.deepEqual(JSON.parse(requests[0].options.body), { p_job_id: "job-1", p_owner_id: "owner-1", p_provider: "runway", p_model: "gen4.5", p_request_hash: "a".repeat(64) });
});

test("submission lifecycle maps to server-only atomic RPCs", async () => {
  const requests = [];
  const results = [[row], true, true, true, true, true, [{ ...row, state: "unknown" }]];
  const ledger = createCloudVideoSubmissionLedger({ ...base, fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return response(results.shift()); } });
  assert.equal((await ledger.prepare({ jobId: "job-1", ownerId: "owner-1", provider: "runway", model: "gen4.5", requestHash: "a".repeat(64) })).state, "prepared");
  assert.equal(await ledger.begin("job-1", "worker-1", leaseToken), true);
  assert.equal(await ledger.record("job-1", "worker-1", "task-123", { region: "us" }, leaseToken), true);
  assert.equal(await ledger.markUnknown("job-1", "worker-1", "NETWORK_AMBIGUOUS", leaseToken), true);
  assert.equal(await ledger.reconcileUnknown("job-1", "task-123", "provider-console:case-42", { checkedBy: "operator" }), true);
  assert.equal(await ledger.finish("job-1", "worker-1", "succeeded", { registeredAssetIds: ["asset-1"] }, leaseToken), true);
  assert.equal((await ledger.get("job-1")).state, "unknown");
  assert.deepEqual(requests.map(x => x.url.split("/").pop()), ["prepare_video_generation_submission", "begin_video_generation_submission_v2", "record_video_generation_submission_v2", "mark_video_generation_submission_unknown_v2", "reconcile_unknown_video_generation_submission", "finish_video_generation_submission_v2", "get_video_generation_submission"]);
  assert.deepEqual(requests[1].body, { p_job_id: "job-1", p_worker_id: "worker-1", p_lease_token: leaseToken });
  assert.deepEqual(requests[2].body, { p_job_id: "job-1", p_worker_id: "worker-1", p_lease_token: leaseToken, p_provider_task_id: "task-123", p_metadata: { region: "us" } });
  assert.deepEqual(requests[4].body, { p_job_id: "job-1", p_provider_task_id: "task-123", p_evidence_reference: "provider-console:case-42", p_metadata: { checkedBy: "operator" } });
  assert.deepEqual(requests[5].body, { p_job_id: "job-1", p_worker_id: "worker-1", p_lease_token: leaseToken, p_state: "succeeded", p_metadata: { registeredAssetIds: ["asset-1"] } });
});

test("prepare and get reject mismatched rows; boolean RPCs reject non-booleans", async () => {
  const mismatch = createCloudVideoSubmissionLedger({ ...base, fetchImpl: async () => response([{ ...row, owner_id: "other-owner" }]) });
  await assert.rejects(() => mismatch.prepare({ jobId: "job-1", ownerId: "owner-1", provider: "runway", model: "gen4.5", requestHash: "a".repeat(64) }), /mismatched record/);
  const invalidBool = createCloudVideoSubmissionLedger({ ...base, fetchImpl: async () => response("true") });
  await assert.rejects(() => invalidBool.begin("job-1", "worker-1", leaseToken), /invalid result/);
  const invalidGet = createCloudVideoSubmissionLedger({ ...base, fetchImpl: async () => response([{ ...row, job_id: "job-2" }]) });
  await assert.rejects(() => invalidGet.get("job-1"), /invalid result/);
});

test("configuration, arguments and HTTP failures fail closed without leaking credentials", async () => {
  assert.throws(() => createCloudVideoSubmissionLedger({ url: "http://remote.example", serviceRoleKey: "secret" }), /HTTPS/);
  assert.throws(() => createCloudVideoSubmissionLedger({ url: base.url }), /SUPABASE_SERVICE_ROLE_KEY/);
  const ledger = createCloudVideoSubmissionLedger({ ...base, fetchImpl: async () => response({ message: "denied " + base.serviceRoleKey }, 403) });
  await assert.rejects(() => ledger.begin("job-1", "worker-1", leaseToken), error => error.code === "CLOUD_VIDEO_LEDGER_HTTP_403" && !error.message.includes(base.serviceRoleKey));
  await assert.rejects(() => ledger.prepare({ jobId: "job-1", ownerId: "owner-1", provider: "runway", model: "gen4.5", requestHash: "invalid" }), /SHA-256/);
  await assert.rejects(() => ledger.record("job-1", "worker-1", "task-1", []), /must be an object/);
  await assert.rejects(() => ledger.get(""), /Job ID/);
  await assert.rejects(() => ledger.finish("job-1", "worker-1", "processing", {}, leaseToken), /terminal state/);
});

test("ledger timeout is surfaced as an explicit ambiguous transport error", async () => {
  const ledger = createCloudVideoSubmissionLedger({ ...base, timeoutMs: 1000, fetchImpl: (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
  await assert.rejects(() => ledger.begin("job-1", "worker-1"), error => error.code === "CLOUD_VIDEO_LEDGER_TIMEOUT");
});