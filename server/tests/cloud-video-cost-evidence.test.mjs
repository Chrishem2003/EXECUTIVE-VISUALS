import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoCostEvidenceResolver } from "../cloud-video-cost-evidence.mjs";

const url = "https://example.supabase.co";
const secret = "cost-evidence-test-secret";
const job = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  owner_id: "223e4567-e89b-42d3-a456-426614174000"
};
const taskId = "runway-task-001";
const row = {
  job_id: job.id,
  owner_id: job.owner_id,
  provider_task_id: taskId,
  actual_amount: "0.75",
  currency: "USD",
  evidence_reference: "provider-support://case/OPS-17",
  evidence_sha256: "a".repeat(64),
  reviewer_id: job.owner_id,
  reviewed_at: "2026-11-05T10:00:00.000Z",
  source_type: "provider_support"
};
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

test("cost evidence resolver reads the exact immutable reviewed receipt using service-role RPC", async () => {
  const calls = [];
  const resolve = createCloudVideoCostEvidenceResolver({
    url, serviceRoleKey: secret,
    fetchImpl: async (target, options) => {
      calls.push({ target, options });
      return response([row]);
    }
  });
  const result = await resolve({ job, providerTaskId: taskId, task: { status: "succeeded" } });
  assert.deepEqual(result, {
    amount: 0.75, currency: "USD",
    evidenceReference: row.evidence_reference,
    evidenceSha256: row.evidence_sha256,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at,
    sourceType: row.source_type
  });
  assert.equal(calls[0].target, url + "/rest/v1/rpc/get_video_generation_cost_evidence");
  assert.equal(calls[0].options.headers.apikey, secret);
  assert.equal(calls[0].options.headers.authorization, "Bearer " + secret);
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_job_id: job.id });
  assert.equal(calls[0].options.headers["accept-profile"], "executive_visuals");
});

test("cost evidence resolver rejects absent, duplicate, cross-owner and wrong-task receipts", async () => {
  for (const rows of [[], [row, row], [{ ...row, owner_id: "different-owner" }], [{ ...row, provider_task_id: "other-task" }]]) {
    const resolve = createCloudVideoCostEvidenceResolver({
      url, serviceRoleKey: secret, fetchImpl: async () => response(rows)
    });
    await assert.rejects(
      resolve({ job, providerTaskId: taskId, task: { status: "succeeded" } }),
      error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED"
    );
  }
});

test("cost evidence resolver rejects invalid amounts, missing digest and incomplete reviewer metadata", async () => {
  for (const patch of [
    { actual_amount: "-1" },
    { actual_amount: "NaN" },
    { evidence_sha256: "not-a-digest" },
    { reviewer_id: null },
    { reviewed_at: "not-a-date" }
  ]) {
    const resolve = createCloudVideoCostEvidenceResolver({
      url, serviceRoleKey: secret, fetchImpl: async () => response([{ ...row, ...patch }])
    });
    await assert.rejects(
      resolve({ job, providerTaskId: taskId, task: { status: "succeeded" } }),
      error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED"
    );
  }
});

test("cost evidence resolver requires an owned completed task and safe server endpoint", async () => {
  let calls = 0;
  const resolve = createCloudVideoCostEvidenceResolver({
    url, serviceRoleKey: secret, fetchImpl: async () => { calls++; return response([row]); }
  });
  await assert.rejects(resolve({ job, providerTaskId: taskId, task: { status: "running" } }), /completed owned provider task/);
  assert.throws(() => createCloudVideoCostEvidenceResolver({
    url: "http://remote.example", serviceRoleKey: secret
  }), /HTTPS/);
  assert.equal(calls, 0);
});
