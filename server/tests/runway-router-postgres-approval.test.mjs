import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayRouterPostgresApprovalClient } from "../runway-router-postgres-approval.mjs";

const base = {
  url: "https://example.supabase.co",
  serviceRoleKey: "service-role-secret",
  anonKey: "public-anon-key"
};
const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "423e4567-e89b-42d3-a456-426614174000";
const routerApprovalId = "823e4567-e89b-42d3-a456-426614174000";
const budgetApprovalId = "523e4567-e89b-42d3-a456-426614174000";
const decision = {
  dryRun: true, taskCreated: false, billed: false, budgetCheck: "within_limit",
  provider: "runway", model: "gen4.5", configId: "creative_low_cost",
  inputHash: "b".repeat(64), estimatedCredits: 60, maxEstimatedCredits: 80
};
const jobInput = {
  projectId, provider: "runway", model: "gen4.5",
  requestHash: "a".repeat(64), durationSeconds: 5, prompt: "Approved scene"
};
const response = body => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });

test("records only a bounded non-billable Gen-4.5 preflight using service-role RPC", async () => {
  const calls = [];
  const client = createRunwayRouterPostgresApprovalClient({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response([{
        router_approval_id: routerApprovalId,
        budget_approval_id: budgetApprovalId,
        expires_at: "2026-11-05T12:15:00.000Z"
      }]);
    }
  });
  const result = await client.recordPreflight({
    ownerId, projectId, decision, requestHash: "a".repeat(64), jobInput,
    approvedMaxAmount: 1.25, currency: "USD", maxEstimatedCredits: 80
  });
  assert.equal(result.routerApprovalId, routerApprovalId);
  assert.equal(result.budgetApprovalId, budgetApprovalId);
  assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/rpc/record_runway_router_preflight");
  assert.equal(calls[0].options.headers.apikey, base.serviceRoleKey);
  assert.equal(calls[0].options.headers.authorization, "Bearer " + base.serviceRoleKey);
  assert.equal(calls[0].options.headers["content-profile"], "executive_visuals");
  assert.deepEqual(calls[0].body, {
    p_owner_id: ownerId, p_project_id: projectId, p_config_id: decision.configId,
    p_input_hash: decision.inputHash, p_request_hash: "a".repeat(64), p_job_input: jobInput,
    p_estimated_credits: 60, p_max_estimated_credits: 80,
    p_approved_max_amount: 1.25, p_currency: "USD", p_ttl_seconds: 900
  });
});

test("rejects provider tasks, billed decisions, mismatched ceilings and invalid request hashes", async () => {
  let calls = 0;
  const client = createRunwayRouterPostgresApprovalClient({
    ...base, fetchImpl: async () => { calls++; return response([]); }
  });
  const args = {
    ownerId, projectId, decision, requestHash: "a".repeat(64), jobInput,
    approvedMaxAmount: 1.25, maxEstimatedCredits: 80
  };
  await assert.rejects(() => client.recordPreflight({ ...args, decision: { ...decision, taskCreated: true } }), error => error.code === "RUNWAY_PREFLIGHT_DECISION_INVALID");
  await assert.rejects(() => client.recordPreflight({ ...args, decision: { ...decision, billed: true } }), error => error.code === "RUNWAY_PREFLIGHT_DECISION_INVALID");
  await assert.rejects(() => client.recordPreflight({ ...args, maxEstimatedCredits: 59 }), error => error.code === "RUNWAY_PREFLIGHT_BUDGET_INVALID");
  await assert.rejects(() => client.recordPreflight({ ...args, requestHash: "invalid" }), error => error.code === "RUNWAY_PREFLIGHT_BUDGET_INVALID");
  assert.equal(calls, 0);
});

test("human approval uses the approver access token, not the service-role credential", async () => {
  const calls = [];
  const client = createRunwayRouterPostgresApprovalClient({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return response(true);
    }
  });
  assert.equal(await client.approve({
    approvalId: routerApprovalId,
    accessToken: "user-access-token-with-sufficient-length"
  }), true);
  assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/rpc/approve_runway_router_preflight");
  assert.equal(calls[0].headers.apikey, base.anonKey);
  assert.equal(calls[0].headers.authorization, "Bearer user-access-token-with-sufficient-length");
  assert.notEqual(calls[0].headers.authorization, "Bearer " + base.serviceRoleKey);
  assert.deepEqual(calls[0].body, { p_approval_id: routerApprovalId });
});

test("approval actor requires a bounded approval ID and authenticated access token", async () => {
  let calls = 0;
  const client = createRunwayRouterPostgresApprovalClient({
    ...base, fetchImpl: async () => { calls++; return response(true); }
  });
  await assert.rejects(() => client.approve({ approvalId: "bad", accessToken: "user-access-token-with-sufficient-length" }), error => error.code === "RUNWAY_APPROVAL_ARGUMENT_INVALID");
  await assert.rejects(() => client.approve({ approvalId: routerApprovalId }), error => error.code === "RUNWAY_APPROVAL_AUTH_REQUIRED");
  assert.equal(calls, 0);
});

test("approval bridge refuses malformed RPC response and insecure endpoint", async () => {
  const client = createRunwayRouterPostgresApprovalClient({
    ...base, fetchImpl: async () => response([])
  });
  await assert.rejects(() => client.recordPreflight({
    ownerId, projectId, decision, requestHash: "a".repeat(64), jobInput,
    approvedMaxAmount: 1.25, maxEstimatedCredits: 80
  }), error => error.code === "RUNWAY_APPROVAL_RESPONSE_INVALID");
  assert.throws(() => createRunwayRouterPostgresApprovalClient({
    ...base, url: "http://remote.example"
  }), /HTTPS/);
});
